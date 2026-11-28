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
    // Migration douce AVANT le seed : évite de créer un doublon lorsqu'une ancienne
    // ligne est renommée. Les quotas et l'état enabled de chaque fournisseur sont conservés.
    const legacy = [
      ["llama-3.1-8b", "gemma-4-26b-a4b", "@cf/google/gemma-4-26b-a4b-it", 10],
      ["llama-3.3-70b", "glm-4.7-flash", "@cf/zai-org/glm-4.7-flash", 15],
    ];
    for (const task of ["chat_reply", "write_post", "idea", "summarize"]) {
      const [oldName, newName, model, priority] = legacy[0];
      const current = await env.DB.prepare("SELECT id FROM ai_providers WHERE task=? AND name=?").bind(task, newName).first();
      if (current) {
        await env.DB.prepare("DELETE FROM ai_providers WHERE task=? AND name=? AND model LIKE '@cf/meta/llama-%'").bind(task, oldName).run();
      } else {
        await env.DB.prepare(`UPDATE ai_providers SET name=?, adapter='workers-ai', model=?, priority=?
          WHERE task=? AND name=? AND model LIKE '@cf/meta/llama-%'`).bind(newName, model, priority, task, oldName).run();
      }
    }
    for (const task of ["chat_reply", "write_post"]) {
      const [oldName, newName, model, priority] = legacy[1];
      const current = await env.DB.prepare("SELECT id FROM ai_providers WHERE task=? AND name=?").bind(task, newName).first();
      if (current) {
        await env.DB.prepare("DELETE FROM ai_providers WHERE task=? AND name=? AND model LIKE '@cf/meta/llama-%'").bind(task, oldName).run();
      } else {
        await env.DB.prepare(`UPDATE ai_providers SET name=?, adapter='workers-ai', model=?, priority=?
          WHERE task=? AND name=? AND model LIKE '@cf/meta/llama-%'`).bind(newName, model, priority, task, oldName).run();
      }
    }
    const whisper = await env.DB.prepare("SELECT id FROM ai_providers WHERE task='transcribe' AND name='whisper-large-v3-turbo'").first();
    if (whisper) {
      await env.DB.prepare("DELETE FROM ai_providers WHERE task='transcribe' AND name='whisper' AND model='@cf/openai/whisper'").run();
    } else {
      await env.DB.prepare(`UPDATE ai_providers SET name='whisper-large-v3-turbo', model='@cf/openai/whisper-large-v3-turbo'
        WHERE task='transcribe' AND name='whisper' AND model='@cf/openai/whisper'`).run();
    }

    const provs = [
      ["write_post", "gemma-4-26b-a4b", "workers-ai", "@cf/google/gemma-4-26b-a4b-it", 10],
      ["chat_reply", "gemma-4-26b-a4b", "workers-ai", "@cf/google/gemma-4-26b-a4b-it", 10],
      ["idea", "gemma-4-26b-a4b", "workers-ai", "@cf/google/gemma-4-26b-a4b-it", 20],
      ["summarize", "gemma-4-26b-a4b", "workers-ai", "@cf/google/gemma-4-26b-a4b-it", 20],
      ["write_post", "glm-4.7-flash", "workers-ai", "@cf/zai-org/glm-4.7-flash", 15],
      ["chat_reply", "glm-4.7-flash", "workers-ai", "@cf/zai-org/glm-4.7-flash", 15],
      ["transcribe", "whisper-large-v3-turbo", "workers-ai", "@cf/openai/whisper-large-v3-turbo", 5],
    ];
    for (const [task, name, adapter, model, prio] of provs)
      await env.DB.prepare("INSERT OR IGNORE INTO ai_providers(task,name,adapter,model,priority,daily_limit) VALUES(?,?,?,?,?,?)")
        .bind(task, name, adapter, model, prio, 0).run();
    await env.DB.prepare("INSERT OR IGNORE INTO meta(k,v) VALUES('wa_cooldown_hours',?)").bind(String(env.WA_COOLDOWN_H ?? 6)).run();
    // Numéro admin destinataire des alertes et des rapports individuels matin/soir (v4.3.2).
    await env.DB.prepare("INSERT OR IGNORE INTO meta(k,v) VALUES('admin_whatsapp',?)").bind(String(env.ADMIN_WHATSAPP || "22890681092")).run();
    await ensureAdmin(env, tid);
    return tid;
  })().catch(e => { ready = undefined; throw e; });
}
