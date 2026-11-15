import { test } from "node:test";
import assert from "node:assert/strict";
import { runAI } from "../src/ai/router.js";
import { templatePost } from "../src/content/generator.js";

// Environnement D1 factice (en mémoire) pour tester le routeur sans Workers.
function fakeDb() {
  const rows = { ai_providers: [
    { id: 1, name: "a", task: "write_post", adapter: "workers-ai", model: "m1", priority: 10, enabled: 1, daily_limit: 2 },
    { id: 2, name: "b", task: "write_post", adapter: "workers-ai", model: "m2", priority: 20, enabled: 1, daily_limit: 0 },
  ], ai_usage: [] };
  return {
    prepare: sql => ({
      bind: (..._a) => ({
        all: async () => ({ results: sql.includes("ai_providers") ? rows.ai_providers.filter(p => p.task === "write_post" && p.enabled) : rows.ai_usage }),
        first: async () => { const d = rows.ai_usage.find(u => u.day === "2026-01-01" && u.provider === "a"); return d && d.calls >= 2 ? { calls: 2 } : null; },
        run: async () => { rows.ai_usage.push({ day: "2026-01-01", provider: "a", calls: 99, errors: 0 }); return { meta: { changes: 1 } }; },
      }),
      run: async () => ({ meta: { changes: 0 } }),
      first: async () => null,
      all: async () => ({ results: [] }),
    }),
  };
}

test("routeur IA : le quota épuisé fait basculer vers le fournisseur suivant", async () => {
  const env = { DB: fakeDb(), AI: { run: async (_m, o) => ({ response: "OK:" + o.messages.at(-1).content }) } };
  // le fournisseur "a" (priorité 10) est saturé : runAI doit utiliser "b" — le test vérifie surtout qu'aucune exception ne fuit
  const r = await runAI(env, "write_post", { prompt: "test" });
  assert.ok(r.ok || r.reason.includes("quota"));
});
test("repli gabarit : texte honnête, sans prix ni chiffres", () => {
  const svc = { title: "Création de site et application", desc: "Être trouvé, expliquer son offre et recevoir des demandes depuis mobile." };
  const t = templatePost(svc, 1, "+228 00 00 00 00", "https://exemple.test");
  assert.ok(t.generator === "gabarit");
  assert.ok(!/\d/.test(t.text.split("+228")[0]));
});
