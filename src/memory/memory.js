// Mémoire persistante PAR CLIENT : isolation stricte (toutes les requêtes filtrées par tenant_id).
export async function getMemory(env, tenantId, scope, key) {
  return (await env.DB.prepare("SELECT value FROM memory WHERE tenant_id=? AND scope=? AND key=?").bind(tenantId, scope, key).first())?.value ?? null;
}
export async function setMemory(env, tenantId, scope, key, value) {
  await env.DB.prepare("INSERT INTO memory(tenant_id,scope,key,value,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(tenant_id,scope,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at")
    .bind(tenantId, scope, key, value, new Date().toISOString()).run();
}
export async function listMemory(env, tenantId, scope = null) {
  return (await env.DB.prepare(scope ? "SELECT * FROM memory WHERE tenant_id=? AND scope=? ORDER BY scope,key" : "SELECT * FROM memory WHERE tenant_id=? ORDER BY scope,key")
    .bind(...(scope ? [tenantId, scope] : [tenantId])).all()).results;
}
export async function brandProfile(env, tenantId) {
  const rows = await listMemory(env, tenantId, "brand");
  return rows.map(r => `${r.key} : ${r.value}`).join("\n") || "Profil de marque non renseigné.";
}
