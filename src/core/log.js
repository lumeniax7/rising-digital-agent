// Journal structuré + table `events` (console + base). Les secrets sont masqués systématiquement.
import { redact, nowISO } from "./util.js";
export async function log(env, level, type, detail = "", tenantId = null) {
  const d = redact(detail, env);
  console.log(JSON.stringify({ ts: nowISO(), level, type, detail: d, tenant: tenantId }));
  await env.DB.prepare("INSERT INTO events(level,type,detail,tenant_id) VALUES(?,?,?,?)").bind(level, type, d, tenantId).run().catch(() => {});
}
