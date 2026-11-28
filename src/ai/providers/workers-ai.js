// Adaptateur Cloudflare Workers AI (offre gratuite, quota journalier limité — jamais illimité).
export async function run(env, p, { messages, prompt, audio, max_tokens = 700 }) {
  // v4.3.2 : transcription vocale (tâche "transcribe") — l'audio binaire est passé tel quel.
  if (audio) {
    const r = await env.AI.run(p.model, { audio });
    const text = typeof r === "string" ? r : (r?.text ?? "");
    if (!String(text).trim()) throw new Error("transcription vide");
    return String(text).trim();
  }
  const input = messages ?? [{ role: "user", content: prompt }];
  const r = await env.AI.run(p.model, { messages: input, max_tokens });
  const text = typeof r === "string" ? r : (r?.response ?? r?.result ?? "");
  if (!String(text).trim()) throw new Error("réponse IA vide");
  return String(text).trim();
}
