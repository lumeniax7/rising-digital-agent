import { test } from "node:test";
import assert from "node:assert/strict";
import { runAI } from "../src/ai/router.js";
import { templatePost } from "../src/content/generator.js";
import { utcDay } from "../src/core/util.js";

function fakeDb({ providers, usage = [], meta = [] }) {
  const usageRows = new Map(usage.map(x => [`${x.day}/${x.provider}/${x.task}`, { ...x }]));
  const metaRows = new Map(meta.map(x => [x.k, String(x.v)]));
  const db = {
    usageRows,
    metaRows,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            all: async () => {
              if (sql.includes("FROM ai_providers")) {
                const task = args[0];
                return { results: providers.filter(p => p.task === task && p.enabled).sort((a, b) => a.priority - b.priority) };
              }
              return { results: [] };
            },
            first: async () => {
              if (sql.includes("SELECT calls,errors FROM ai_usage")) {
                const [day, provider, task] = args;
                const row = usageRows.get(`${day}/${provider}/${task}`);
                return row ? { calls: row.calls, errors: row.errors } : null;
              }
              return null;
            },
            run: async () => {
              if (sql.includes("INSERT INTO ai_usage")) {
                const [day, provider, task, limit] = args;
                const key = `${day}/${provider}/${task}`;
                const row = usageRows.get(key);
                if (!row) usageRows.set(key, { day, provider, task, calls: 1, errors: 0 });
                else if (!(Number(limit) > 0) || row.calls < Number(limit)) row.calls++;
                else return { meta: { changes: 0 } };
                return { meta: { changes: 1 } };
              }
              if (sql.includes("UPDATE ai_usage SET calls=CASE")) {
                const [day, provider, task] = args;
                const row = usageRows.get(`${day}/${provider}/${task}`);
                if (row) row.calls = Math.max(0, row.calls - 1);
                return { meta: { changes: row ? 1 : 0 } };
              }
              if (sql.includes("UPDATE ai_usage SET errors=errors+1")) {
                const [day, provider, task] = args;
                const row = usageRows.get(`${day}/${provider}/${task}`);
                if (row) row.errors++;
                return { meta: { changes: row ? 1 : 0 } };
              }
              if (sql.includes("INSERT INTO meta")) {
                const [key, limit] = args;
                const current = Number(metaRows.get(key) || 0);
                if (current >= Number(limit)) return { meta: { changes: 0 } };
                metaRows.set(key, String(current + 1));
                return { meta: { changes: 1 } };
              }
              return { meta: { changes: 0 } };
            },
          };
        },
      };
    },
  };
  return db;
}

const providers = [
  { id: 1, name: "a", task: "write_post", adapter: "workers-ai", model: "m1", priority: 10, enabled: 1, daily_limit: 2 },
  { id: 2, name: "b", task: "write_post", adapter: "workers-ai", model: "m2", priority: 20, enabled: 1, daily_limit: 0 },
];

test("quota global quotidien atteint : aucun nouvel appel externe n'est lancé", async () => {
  const DB = fakeDb({ providers });
  let calls = 0;
  const env = { DB, AI_DAILY_LIMIT: "1", AI: { run: async () => { calls++; return { response: "Texte valide" }; } } };
  const [first, second] = await Promise.all([
    runAI(env, "write_post", { prompt: "test" }),
    runAI(env, "write_post", { prompt: "test" }),
  ]);
  assert.equal([first, second].filter(r => r.ok).length, 1);
  const rejected = [first, second].find(r => !r.ok);
  assert.match(rejected.reason, /plafond IA quotidien global atteint/);
  assert.equal(calls, 1);
  assert.equal(DB.metaRows.get(`ai_daily_calls:${utcDay()}`), "1");
  assert.equal(DB.usageRows.get(`${utcDay()}/a/write_post`).calls, 1);
});

test("échec du premier fournisseur : cascade vers le suivant et erreurs comptées", async () => {
  const DB = fakeDb({ providers });
  let calls = 0;
  const env = {
    DB,
    AI_DAILY_LIMIT: "10",
    AI: { run: async () => { calls++; if (calls === 1) throw new Error("panne amont"); return { response: "Réponse du second fournisseur" }; } },
  };
  const r = await runAI(env, "write_post", { prompt: "test" });
  assert.equal(r.ok, true);
  assert.match(r.provider, /^b /);
  assert.equal(calls, 2);
  assert.deepEqual(DB.usageRows.get(`${utcDay()}/a/write_post`), { day: utcDay(), provider: "a", task: "write_post", calls: 1, errors: 1 });
  assert.deepEqual(DB.usageRows.get(`${utcDay()}/b/write_post`), { day: utcDay(), provider: "b", task: "write_post", calls: 1, errors: 0 });
  assert.equal(DB.metaRows.get(`ai_daily_calls:${utcDay()}`), "2");
});

test("coupe-circuit saute un fournisseur qui échoue régulièrement", async () => {
  const DB = fakeDb({ providers, usage: [{ day: utcDay(), provider: "a", task: "write_post", calls: 99, errors: 99 }] });
  let calls = 0;
  const env = { DB, AI_DAILY_LIMIT: "10", AI: { run: async model => { calls++; assert.equal(model, "m2"); return { response: "Réponse du fournisseur sain" }; } } };
  const r = await runAI(env, "write_post", { prompt: "test" });
  assert.equal(r.ok, true);
  assert.match(r.provider, /^b /);
  assert.equal(calls, 1);
  assert.equal(DB.metaRows.get(`ai_daily_calls:${utcDay()}`), "1");
  assert.equal(DB.usageRows.get(`${utcDay()}/a/write_post`).calls, 99);
});

test("quota quotidien fournisseur : bascule vers un fournisseur disponible", async () => {
  const DB = fakeDb({ providers, usage: [{ day: utcDay(), provider: "a", task: "write_post", calls: 2, errors: 0 }] });
  let selectedModel;
  const env = { DB, AI_DAILY_LIMIT: "10", AI: { run: async model => { selectedModel = model; return { response: "OK" }; } } };
  const r = await runAI(env, "write_post", { prompt: "test" });
  assert.equal(r.ok, true);
  assert.equal(selectedModel, "m2");
  assert.equal(DB.usageRows.get(`${utcDay()}/a/write_post`).calls, 2);
  assert.equal(DB.metaRows.get(`ai_daily_calls:${utcDay()}`), "1");
});

test("repli gabarit : texte honnête, sans prix ni chiffres", () => {
  const svc = { title: "Création de site et application", desc: "Être trouvé, expliquer son offre et recevoir des demandes depuis mobile." };
  const t = templatePost(svc, 1, "+228 00 00 00 00", "https://exemple.test");
  assert.ok(t.generator === "gabarit");
  assert.ok(!/\d/.test(t.text.split("+228")[0]));
});
