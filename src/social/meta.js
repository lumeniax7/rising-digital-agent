// Client Graph API Meta — jeton TOUJOURS dans l'en-tête Authorization (jamais dans l'URL ni les logs).
export async function graph(env, method, path, body, token) {
  const v = env.GRAPH_VERSION || "v23.0";
  const r = await fetch(`https://graph.facebook.com/${v}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(25000),
  });
  let j; try { j = JSON.parse(await r.text()); } catch { throw new Error(`HTTP ${r.status} : réponse non JSON`); }
  if (!r.ok || j.error) {
    const e = new Error(`HTTP ${r.status} code ${j.error?.code ?? "?"} : ${j.error?.message ?? "erreur API"}`);
    e.code = j.error?.code; throw e;
  }
  return j;
}
