// Adaptateur Cloudflare Workers AI (offre gratuite, quota journalier limité — jamais illimité).
export async function run(env, p, { messages, prompt, max_tokens = 700 }) {
  const input = messages ?? [{ role: "user", content: prompt }];
  const r = await env.AI.run(p.model, { messages: input, max_tokens });
  const text = typeof r === "string" ? r : (r?.response ?? r?.result ?? "");
  if (!String(text).trim()) throw new Error("réponse IA vide");
  return String(text).trim();
}
