import { test } from "node:test";
import assert from "node:assert/strict";
import { publishChannel, publishDue } from "../src/social/publish.js";

function recordingDb() {
  const statements = [];
  return {
    statements,
    prepare(sql) {
      const item = { sql, args: [] };
      statements.push(item);
      return {
        bind(...args) { item.args = args; return this; },
        run: async () => ({ meta: { changes: 0 } }),
        first: async () => null,
        all: async () => ({ results: [] }),
      };
    },
  };
}

test("publishChannel refuse draft/pending et le statut absent sans effet DB/externe", async () => {
  const DB = recordingDb();
  let fetches = 0;
  const env = { DB, FB_PAGE_ID: "page", FB_PAGE_TOKEN: "token", fetch: async () => { fetches++; throw new Error("ne doit pas être appelé"); } };
  const post = { id: 12, text: "post", image: "https://example.test/image.jpg" };
  const channel = { id: 4, channel: "facebook", attempts: 0 };
  assert.equal((await publishChannel(env, post, channel)).ok, false);
  assert.equal((await publishChannel(env, post, channel, "draft")).ok, false);
  assert.equal((await publishChannel(env, post, channel, "pending")).ok, false);
  assert.equal(DB.statements.length, 0);
  assert.equal(fetches, 0);
});

test("publishChannel arrête une ligne ayant atteint MAX_ATTEMPTS sans réclamation ni effet externe", async () => {
  const DB = recordingDb();
  let fetches = 0;
  const env = { DB, FB_PAGE_ID: "page", FB_PAGE_TOKEN: "token", fetch: async () => { fetches++; throw new Error("ne doit pas être appelé"); } };
  const r = await publishChannel(env, { id: 12, text: "post", image: "https://example.test/image.jpg" },
    { id: 4, channel: "facebook", attempts: 5 }, "approved");
  assert.equal(r.ok, false);
  assert.match(r.reason, /limite de tentatives/);
  assert.equal(DB.statements.length, 0);
  assert.equal(fetches, 0);
});

test("publishDue ne sélectionne que les posts approuvés et les tentatives sous le plafond", async () => {
  const DB = recordingDb();
  await publishDue({ DB }, 7);
  const dueQuery = DB.statements.find(s => s.sql.includes("SELECT pc.*"));
  assert.ok(dueQuery, "la requête des canaux dus est exécutée");
  assert.match(dueQuery.sql, /JOIN posts p ON p\.id=pc\.post_id/);
  assert.match(dueQuery.sql, /p\.status='approved'/);
  assert.match(dueQuery.sql, /pc\.attempts<\?/);
  assert.match(dueQuery.sql, /pc\.next_attempt_at<=\?/);
  const claimDb = recordingDb();
  await publishChannel({ DB: claimDb }, { id: 12 }, { id: 4, channel: "facebook", attempts: 1 }, "approved");
  const claim = claimDb.statements[0].sql;
  assert.match(claim, /next_attempt_at<=\?/);
  assert.ok(!/SET[^\n]*next_attempt_at\s*=/.test(claim), "la réclamation conserve l’échéance déjà planifiée");
});
