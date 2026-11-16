// Migrations idempotentes + amorçage (tenant par défaut, catalogue de 27 services, fournisseurs IA).
import { SCHEMA } from "./schema.js";
import SERVICES from "../content/services.json";
import { ensureAdmin } from "../web/auth.js";

let ready;
export function ensure(env) {
  return ready ??= (async () => {
    for (const s of SCHEMA) await env.DB.prepare(s).run();
    if (!(await env.DB.prepare("SELECT 1 FROM tenants LIMIT 1").first()))
      await env.DB.prepare("INSERT INTO tenants(name,slug) VALUES(?,?)").bind("Rising Digital Solutions", "rds").run();
    const t = await env.DB.prepare("SELECT id FROM tenants WHERE slug='rds'").first();
    const tid = t.id;
    for (const s of SERVICES)
      await env.DB.prepare("INSERT OR IGNORE INTO services(tenant_id,slug,title,file,descr) VALUES(?,?,?,?,?)")
        .bind(tid, s.file.replace(".jpg", ""), s.title, s.file, s.desc).run();
    const provs = [
      ["write_post", "llama-3.1-8b", "workers-ai", "@cf/meta/llama-3.1-8b-instruct", 10],
      ["chat_reply", "llama-3.1-8b", "workers-ai", "@cf/meta/llama-3.1-8b-instruct", 10],
      ["idea", "llama-3.1-8b", "workers-ai", "@cf/meta/llama-3.1-8b-instruct", 20],
      ["summarize", "llama-3.1-8b", "workers-ai", "@cf/meta/llama-3.1-8b-instruct", 20],
      ["write_post", "llama-3.3-70b", "workers-ai", "@cf/meta/llama-3.3-70b-instruct-fp8-fast", 15],
      ["chat_reply", "llama-3.3-70b", "workers-ai", "@cf/meta/llama-3.3-70b-instruct-fp8-fast", 15],
    ];
    for (const [task, name, adapter, model, prio] of provs)
      await env.DB.prepare("INSERT OR IGNORE INTO ai_providers(task,name,adapter,model,priority,daily_limit) VALUES(?,?,?,?,?,?)")
        .bind(task, name, adapter, model, prio, 0).run();
    await env.DB.prepare("INSERT OR IGNORE INTO meta(k,v) VALUES('wa_cooldown_hours',?)").bind(String(env.WA_COOLDOWN_H ?? 6)).run();
    await ensureAdmin(env, tid);
    return tid;
  })().catch(e => { ready = undefined; throw e; });
}
