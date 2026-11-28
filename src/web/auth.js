// Authentification : PBKDF2, sessions en base, cookie HttpOnly, CSRF et limitation de débit.
import { pbkdf2, randomHex } from "../core/crypto.js";
import { nowISO, safeEq } from "../core/util.js";

const SESSION_DAYS = 30;
export const ADMIN_PASSWORD_MIN_LENGTH = 12;

export function isAdminPasswordConfigured(env) {
  return typeof env?.ADMIN_PASSWORD === "string" && env.ADMIN_PASSWORD.length >= ADMIN_PASSWORD_MIN_LENGTH;
}

export function validCsrfToken(supplied, expected) {
  return typeof expected === "string" && expected.length > 0 && safeEq(String(supplied || ""), expected);
}

export function validRequestOrigin(origin, requestOrigin, allowedOrigin) {
  return !origin || origin === requestOrigin || origin === allowedOrigin;
}

export async function ensureAdmin(env, tenantId) {
  if (!isAdminPasswordConfigured(env)) return false;
  const current = await env.DB.prepare("SELECT * FROM users WHERE username=?").bind("admin").first();
  if (!current) {
    const salt = randomHex(16);
    await env.DB.prepare("INSERT INTO users(username,pass_hash,pass_salt,role,tenant_id) VALUES(?,?,?,?,?)")
      .bind("admin", await pbkdf2(env.ADMIN_PASSWORD, salt), salt, "admin", tenantId)
      .run().catch(async error => {
        // Une autre instance peut avoir créé le compte entre le SELECT et l'INSERT.
        const raced = await env.DB.prepare("SELECT id FROM users WHERE username=?").bind("admin").first();
        if (!raced) throw error;
      });
    return true;
  }

  // ADMIN_PASSWORD est la source de vérité opérateur. Une rotation du secret met à jour
  // le compte admin et invalide ses sessions existantes au prochain démarrage de l’isolate.
  const currentHash = await pbkdf2(env.ADMIN_PASSWORD, current.pass_salt);
  if (!safeEq(currentHash, current.pass_hash)) {
    const salt = randomHex(16);
    await env.DB.prepare("UPDATE users SET pass_hash=?, pass_salt=?, tenant_id=? WHERE id=?")
      .bind(await pbkdf2(env.ADMIN_PASSWORD, salt), salt, tenantId, current.id).run();
    await env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(current.id).run();
  }
  return true;
}

export async function rateLimit(env, bucket, max, windowSec) {
  const w = new Date(Math.floor(Date.now() / (windowSec * 1000)) * windowSec * 1000).toISOString();
  await env.DB.prepare("INSERT INTO rate_limit(bucket,window_start,count) VALUES(?,?,1) ON CONFLICT(bucket,window_start) DO UPDATE SET count=count+1").bind(bucket, w).run();
  const cur = (await env.DB.prepare("SELECT count FROM rate_limit WHERE bucket=? AND window_start=?").bind(bucket, w).first())?.count ?? 1;
  if (cur > max) {
    await env.DB.prepare("DELETE FROM rate_limit WHERE window_start<datetime('now','-1 day')").run().catch(() => {});
    return false;
  }
  return true;
}

export async function login(env, username, password, ip) {
  if (!(await rateLimit(env, `login:${ip}`, 10, 600))) return { error: "Trop de tentatives. Réessayez dans 10 minutes." };
  const u = await env.DB.prepare("SELECT * FROM users WHERE username=?").bind(String(username || "")).first();
  if (u) {
    const h = await pbkdf2(String(password || ""), u.pass_salt);
    if (safeEq(h, u.pass_hash)) {
      const token = randomHex(32), csrf = randomHex(16);
      const exp = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
      await env.DB.prepare("INSERT INTO sessions(token,user_id,csrf,ip,expires_at) VALUES(?,?,?,?,?)").bind(token, u.id, csrf, ip || "", exp).run();
      return { user: { id: u.id, username: u.username, role: u.role, tenant_id: u.tenant_id }, token, csrf };
    }
  }
  await new Promise(r => setTimeout(r, 800));
  return { error: "Identifiants invalides." };
}

export async function requireAuth(req, env) {
  const cookie = req.headers.get("cookie") || "";
  const token = /(?:^|;\s*)rda_session=([^;]+)/.exec(cookie)?.[1];
  if (!token) return null;
  const s = await env.DB.prepare("SELECT s.*, u.username, u.role, u.tenant_id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?").bind(token).first();
  if (!s || s.expires_at < nowISO()) {
    await env.DB.prepare("DELETE FROM sessions WHERE token=?").bind(token).run().catch(() => {});
    return null;
  }
  return { user: s, csrf: s.csrf, token };
}

export function sessionCookie(token, crossSite = false) {
  const same = crossSite ? "None" : "Strict";
  return `rda_session=${token}; Path=/; HttpOnly; Secure; SameSite=${same}; Max-Age=${SESSION_DAYS * 86400}`;
}
export function logoutCookie() { return "rda_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0"; }
