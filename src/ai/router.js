// Routeur IA multi-fournisseurs : choix par tâche, quotas quotidiens atomiques, repli automatique.
// Changer de modèle = 1 ligne dans la table ai_providers (via le tableau de bord), pas de code à réécrire.
import { utcDay } from "../core/util.js";

const GLOBAL_LIMIT_DEFAULT = 200;

function globalDailyLimit(env) {
  const raw = env.AI_DAILY_LIMIT;
  if (raw === undefined || raw === null || String(raw).trim() === "") return GLOBAL_LIMIT_DEFAULT;
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) return GLOBAL_LIMIT_DEFAULT;
  const value = Number(text);
  return Number.isSafeInteger(value) && value > 0 ? value : GLOBAL_LIMIT_DEFAULT;
}

async function providersForTask(env, task) {
  return (await env.DB.prepare(
    "SELECT * FROM ai_providers WHERE task=? AND enabled=1 ORDER BY priority"
  ).bind(task).all()).results || [];
}

export async function pickProvider(env, task, skip = []) {
  const day = utcDay();
  const provs = await providersForTask(env, task);
  for (const p of provs) {
    if (skip.includes(p.name)) continue;
    if (Number(p.daily_limit) > 0) {
      const u = await env.DB.prepare("SELECT calls FROM ai_usage WHERE day=? AND provider=? AND task=?")
        .bind(day, p.name, task).first();
      if (u && u.calls >= p.daily_limit) continue;
    }
    return p;
  }
  return null;
}

// Les deux compteurs sont réservés avant l'appel réseau. Les écritures conditionnelles
// rendent les plafonds sûrs face à plusieurs exécutions concurrentes sur D1/SQLite.
async function reserveProvider(env, p, day) {
  const limit = Number(p.daily_limit) || 0;
  const result = await env.DB.prepare(`INSERT INTO ai_usage(day,provider,task,calls,errors) VALUES(?,?,?,1,0)
    ON CONFLICT(day,provider,task) DO UPDATE SET calls=ai_usage.calls+1
    WHERE ?<=0 OR ai_usage.calls<?`).bind(day, p.name, p.task, limit, limit).run();
  return (result.meta?.changes ?? 0) > 0;
}

async function undoProviderReservation(env, p, day) {
  await env.DB.prepare(`UPDATE ai_usage SET calls=CASE WHEN calls>0 THEN calls-1 ELSE 0 END
    WHERE day=? AND provider=? AND task=?`).bind(day, p.name, p.task).run();
}

async function reserveGlobal(env, day, limit) {
  const key = `ai_daily_calls:${day}`;
  const result = await env.DB.prepare(`INSERT INTO meta(k,v) VALUES(?,'1')
    ON CONFLICT(k) DO UPDATE SET v=CAST(meta.v AS INTEGER)+1
    WHERE CAST(meta.v AS INTEGER)<?`).bind(key, limit).run();
  return (result.meta?.changes ?? 0) > 0;
}

async function recordProviderError(env, p, day) {
  await env.DB.prepare("UPDATE ai_usage SET errors=errors+1 WHERE day=? AND provider=? AND task=?")
    .bind(day, p.name, p.task).run();
}

function addSkip(options, name) {
  if (!Array.isArray(options.skip)) return;
  if (!options.skip.includes(name)) options.skip.push(name);
}

// Renvoie { ok, text?, provider?, reason? } — NE JAMAIS présenter un échec comme un succès.
export async function runAI(env, task, options = {}) {
  const day = utcDay();
  const limit = globalDailyLimit(env);
  const skipped = new Set(options.skip || []);
  const provs = await providersForTask(env, task);
  const failures = [];
  let quotaSkipped = 0;

  for (const p of provs) {
    if (skipped.has(p.name)) continue;

    // Réserver d'abord le quota fournisseur; le compteur global est libéré si cette
    // réservation n'aboutit pas. Aucun compteur d'appel n'est gardé sans appel externe.
    if (!(await reserveProvider(env, p, day))) {
      quotaSkipped++;
      skipped.add(p.name);
      addSkip(options, p.name);
      continue;
    }
    if (!(await reserveGlobal(env, day, limit))) {
      await undoProviderReservation(env, p, day);
      return {
        ok: false,
        reason: `quota: plafond IA quotidien global atteint (${limit})`,
        provider: null,
      };
    }

    try {
      const mod = await import(`./providers/${p.adapter}.js`);
      const out = await mod.run(env, p, options);
      return { ok: true, text: out, provider: `${p.name} (${p.model})` };
    } catch (e) {
      await recordProviderError(env, p, day);
      const reason = `${p.name} : ${e.message || e}`;
      failures.push(reason);
      skipped.add(p.name);
      addSkip(options, p.name);
    }
  }

  if (failures.length) {
    return { ok: false, reason: `Fournisseurs IA indisponibles : ${failures.join("; ")}`, provider: null };
  }
  const detail = quotaSkipped ? "quota fournisseur atteint" : "aucun fournisseur activé";
  return { ok: false, reason: `quota: ${detail} (aucun fournisseur IA disponible)`, provider: null };
}
