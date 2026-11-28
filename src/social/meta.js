// Client Graph API Meta — jeton TOUJOURS dans l'en-tête Authorization (jamais dans l'URL ni les logs).
function accessToken(value) {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("Jeton Meta invalide");
  const token = value.trim();
  if (!token || /\s/.test(token)) throw new Error("Jeton Meta invalide");
  return token;
}

function withoutToken(text, token) {
  return String(text ?? "").split(token).join("[masqué]").replace(/Bearer\s+[^\s,;]+/gi, "Bearer [masqué]").slice(0, 500);
}

export async function graph(env, method, path, body, rawToken) {
  const token = accessToken(rawToken);
  const v = env.GRAPH_VERSION || "v23.0";
  let r;
  try {
    r = await fetch(`https://graph.facebook.com/${v}${path}`, {
      method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(25000),
    });
  } catch {
    throw new Error("Erreur réseau Meta");
  }
  let j;
  try { j = JSON.parse(await r.text()); }
  catch { throw new Error(`HTTP ${r.status} : réponse non JSON`); }
  if (!r.ok || j.error) {
    const detail = withoutToken(j.error?.message ?? "erreur API", token);
    const e = new Error(`HTTP ${r.status} code ${j.error?.code ?? "?"} : ${detail}`);
    e.code = j.error?.code;
    throw e;
  }
  return j;
}
