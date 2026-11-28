import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ADMIN_PASSWORD_MIN_LENGTH,
  ensureAdmin,
  isAdminPasswordConfigured,
  sessionCookie,
  validCsrfToken,
  validRequestOrigin,
} from "../src/web/auth.js";
import { pbkdf2 } from "../src/core/crypto.js";

function fakeDb(initialUser = null) {
  const state = { user: initialUser, sessionsDeleted: 0 };
  const DB = {
    state,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            first: async () => sql.includes("SELECT * FROM users WHERE username=?") ? state.user : null,
            run: async () => {
              if (sql.startsWith("INSERT INTO users")) {
                const [username, pass_hash, pass_salt, role, tenant_id] = args;
                state.user = { id: 1, username, pass_hash, pass_salt, role, tenant_id };
              } else if (sql.startsWith("UPDATE users SET pass_hash")) {
                const [pass_hash, pass_salt, tenant_id, id] = args;
                assert.equal(id, state.user.id);
                Object.assign(state.user, { pass_hash, pass_salt, tenant_id });
              } else if (sql.startsWith("DELETE FROM sessions")) state.sessionsDeleted++;
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
  return DB;
}

test("mot de passe admin : fail-closed et longueur minimale cohérente", () => {
  assert.equal(ADMIN_PASSWORD_MIN_LENGTH, 12);
  assert.equal(isAdminPasswordConfigured({}), false);
  assert.equal(isAdminPasswordConfigured({ ADMIN_PASSWORD: "court" }), false);
  assert.equal(isAdminPasswordConfigured({ ADMIN_PASSWORD: "correct-cheval" }), true);
});

test("le compte admin est initialisé depuis le secret opérateur", async () => {
  const DB = fakeDb();
  const ok = await ensureAdmin({ DB, ADMIN_PASSWORD: "correct-cheval" }, 9);
  assert.equal(ok, true);
  assert.equal(DB.state.user.username, "admin");
  assert.equal(DB.state.user.tenant_id, 9);
  assert.equal(await pbkdf2("correct-cheval", DB.state.user.pass_salt), DB.state.user.pass_hash);
});

test("rotation du secret met à jour le hash et révoque les sessions", async () => {
  const salt = "00".repeat(16);
  const DB = fakeDb({ id: 1, username: "admin", pass_hash: await pbkdf2("ancien-mot-de-passe", salt), pass_salt: salt, role: "admin", tenant_id: 1 });
  await ensureAdmin({ DB, ADMIN_PASSWORD: "nouveau-mot-de-passe" }, 1);
  assert.equal(DB.state.sessionsDeleted, 1);
  assert.equal(await pbkdf2("nouveau-mot-de-passe", DB.state.user.pass_salt), DB.state.user.pass_hash);
});

test("un secret insuffisant ne crée pas de compte", async () => {
  const DB = fakeDb();
  assert.equal(await ensureAdmin({ DB, ADMIN_PASSWORD: "trop-court" }, 1), false);
  assert.equal(DB.state.user, null);
});

test("le CSRF exige le jeton de session exact", () => {
  assert.equal(validCsrfToken("secret", "secret"), true);
  assert.equal(validCsrfToken("wrong", "secret"), false);
  assert.equal(validCsrfToken("", "secret"), false);
  assert.equal(validCsrfToken("secret", ""), false);
});

test("une mutation n’accepte qu’une origine identique ou explicitement autorisée", () => {
  assert.equal(validRequestOrigin("https://dashboard.example", "https://api.example", "https://dashboard.example"), true);
  assert.equal(validRequestOrigin("https://evil.example", "https://api.example", "https://dashboard.example"), false);
  assert.equal(validRequestOrigin(null, "https://api.example", "https://dashboard.example"), true);
});

test("le cookie de session reste HttpOnly et réduit le cross-site au strict nécessaire", () => {
  assert.match(sessionCookie("token"), /HttpOnly; Secure; SameSite=Strict/);
  assert.match(sessionCookie("token", true), /HttpOnly; Secure; SameSite=None/);
});
