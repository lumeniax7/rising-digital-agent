// File de travaux : idempotence (dedupe_key), tentatives limitées avec backoff, jamais de faux succès.
import { nowISO, backoffMs, redact } from "../core/util.js";
import { log } from "../core/log.js";
import { publishDue } from "../social/publish.js";
import { dailyReport, weeklyReport } from "../reports/reports.js";

export async function enqueue(env, type, payload = {}, dedupeKey = null, maxAttempts = 5) {
  const r = await env.DB.prepare("INSERT OR IGNORE INTO jobs(type,payload,next_attempt_at,dedupe_key,max_attempts) VALUES(?,?,?,?,?)")
    .bind(type, JSON.stringify(payload), nowISO(), dedupeKey, maxAttempts).run();
  return r.meta.changes > 0;
}

const HANDLERS = {
  publish_posts: env => publishDue(env, 1, 3),
  daily_report: env => dailyReport(env),
  weekly_report: env => weeklyReport(env),
};

export async function runDue(env, limit = 5) {
  const due = (await env.DB.prepare(
    "SELECT * FROM jobs WHERE status='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY id LIMIT ?").bind(nowISO(), limit).all()).results;
  for (const j of due) {
    const claim = await env.DB.prepare("UPDATE jobs SET status='running', attempts=attempts+1, updated_at=? WHERE id=? AND status='pending'").bind(nowISO(), j.id).run();
    if (!claim.meta.changes) continue;
    try {
      await (HANDLERS[j.type] || (async () => { throw new Error(`type de job inconnu : ${j.type}`); }))(env, JSON.parse(j.payload || "{}"));
      await env.DB.prepare("UPDATE jobs SET status='done', updated_at=? WHERE id=?").bind(nowISO(), j.id).run();
    } catch (e) {
      const failed = j.attempts + 1 >= j.max_attempts;
      await env.DB.prepare("UPDATE jobs SET status=?, last_error=?, next_attempt_at=?, updated_at=? WHERE id=?")
        .bind(failed ? "failed" : "pending", redact(e.message, env).slice(0, 500),
          failed ? null : new Date(Date.now() + backoffMs(j.attempts)).toISOString(), nowISO(), j.id).run();
      await log(env, "error", `job_${failed ? "echec_definitif" : "retente"}`, `${j.type} : ${e.message}`);
    }
  }
}
