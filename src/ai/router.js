// Routeur IA multi-fournisseurs : choix par tâche, quotas quotidiens, repli automatique.
// Changer de modèle = 1 ligne dans la table ai_providers (via le tableau de bord), pas de code à réécrire.
import { utcDay } from "../core/util.js";

export async function pickProvider(env, task, skip = []) {
  const day = utcDay();
  const provs = (await env.DB.prepare("SELECT * FROM ai_providers WHERE task=? AND enabled=1 ORDER BY priority").bind(task).all()).results;
  for (const p of provs) {
    if (skip.includes(p.name)) continue; // fournisseur déjà en échec dans ce cycle : passer au suivant
    if (p.daily_limit > 0) {
      const u = await env.DB.prepare("SELECT calls FROM ai_usage WHERE day=? AND provider=? AND task=?").bind(day, p.name, task).first();
      if (u && u.calls >= p.daily_limit) continue;
    }
    return p;
  }
  return null;
}

async function bump(env, p, isErr) {
  const day = utcDay();
  await env.DB.prepare(`INSERT INTO ai_usage(day,provider,task,calls,errors) VALUES(?,?,?,?,?)
    ON CONFLICT(day,provider,task) DO UPDATE SET calls=calls+1, errors=errors+?`).bind(day, p.name, p.task, 1, isErr ? 1 : 0, isErr ? 1 : 0).run();
}

// Renvoie { ok, text?, provider?, reason? } — NE JAMAIS présenter un échec comme un succès.
export async function runAI(env, task, options = {}) {
  const p = await pickProvider(env, task, options.skip || []);
  if (!p) return { ok: false, reason: "quota: aucun fournisseur IA disponible (quota atteint ou désactivé)", provider: null };
  try {
    const mod = await import(`./providers/${p.adapter}.js`);
    const out = await mod.run(env, p, options);
    await bump(env, p, false);
    return { ok: true, text: out, provider: `${p.name} (${p.model})` };
  } catch (e) {
    await bump(env, p, true);
    return { ok: false, reason: `${p.name} : ${e.message || e}`, provider: p.name };
  }
}
