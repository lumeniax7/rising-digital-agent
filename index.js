// Rising Digital Agent v4 — point d'entrée.
// Routes : /webhook (WhatsApp), /api/* (tableau de bord authentifié), / (SPA statique), /health.
import { handleWhatsApp } from "./social/whatsapp.js";
import { handleApi } from "./web/router.js";
import { ensure } from "./core/db.js";
import { log } from "./core/log.js";
import { generatePost } from "./content/generator.js";
import { runDue, enqueue } from "./tasks/queue.js";
import { dailyReport, conversationDigest } from "./reports/reports.js";
import { processDueFollowups } from "./social/conversation.js";
import { generateBriefing } from "./content/briefing.js";
import { prepareDailyStatuses } from "./content/statuts.js";
import { getMode } from "./core/config.js";
import { nowISO } from "./core/util.js";

const SEC = { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY",
  "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" };

export default {
  async fetch(req, env, ctx) {
    try {
      const u = new URL(req.url);
      if (u.pathname === "/webhook") return await handleWhatsApp(req, env, ctx);
      if (u.pathname === "/health") return new Response(JSON.stringify({ ok: true, version: "v4.3.8", build: "2026-11-28" }), { headers: { ...SEC, "content-type": "application/json" } });
      if (u.pathname.startsWith("/api/")) return await handleApi(req, env, ctx);
      if (req.method === "GET" || req.method === "HEAD") {
        await ensure(env);
        await env.DB.prepare("INSERT OR IGNORE INTO meta(k,v) VALUES('origin',?)").bind(u.origin).run().catch(() => {});
        const r = await env.ASSETS.fetch(req);
        const h = new Headers(r.headers);
        for (const [k, v] of Object.entries(SEC)) h.set(k, v);
        return new Response(r.body, { status: r.status, headers: h });
      }
      return new Response("méthode refusée", { status: 405, headers: SEC });
    } catch (e) {
      await log(env, "error", "worker_erreur", e.message).catch(() => {});
      return new Response("Erreur interne : consultez le journal.", { status: 500, headers: SEC });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        const tid = await ensure(env);
        await log(env, "info", "cron_debut", `cron=${event.cron}`, tid);
        if (event.cron === "30 7 * * *") {           // 07h30 Lomé : rapport quotidien + digest individuel du matin (24 h)
          await dailyReport(env);
          try { await conversationDigest(env, tid, 24, "Résumé du matin (24 h)"); } catch (e) { await log(env, "error", "digest_matin_echec", e.message, tid); }
          return;
        }
        if (event.cron === "0 19 * * *") {           // 19h00 Lomé : digest individuel du soir (12 h)
          try { await conversationDigest(env, tid, 12, "Résumé du soir (12 h)"); } catch (e) { await log(env, "error", "digest_soir_echec", e.message, tid); }
          return;
        }
        if (event.cron === "0 16 * * *") {           // 16h00 Lomé : second post quotidien (visibilité doublée)
          try { await generatePost(env, tid, { manual: true }); } catch (e) { await log(env, "error", "generation_16h_echec", e.message, tid); }
          await enqueue(env, "publish_posts", {}, `publish16_${nowISO().slice(0, 13)}`);
          try { await runDue(env); } catch (e) { await log(env, "error", "publication_16h_echec", e.message, tid); }
          try { await processDueFollowups(env); } catch (e) { await log(env, "error", "relances_cron_echec", e.message, tid); }
          return;
        }
        // 07h00 Lomé : briefing du jour, 3 statuts WhatsApp prêts à publier, génération du post + publication
        try { await generateBriefing(env, tid); } catch (e) { await log(env, "error", "briefing_cron_echec", e.message, tid); }
        try { await prepareDailyStatuses(env, tid); } catch (e) { await log(env, "error", "statuts_cron_echec", e.message, tid); }
        try { await generatePost(env, tid); } catch (e) { await log(env, "error", "generation_echec", e.message, tid); }
        await enqueue(env, "publish_posts", {}, `publish_${nowISO().slice(0, 13)}`);
        try { await runDue(env); } catch (e) { await log(env, "error", "publication_cron_echec", e.message, tid); }
        // Relances WhatsApp arrivées à échéance (fenêtre 24 h respectée, jamais d'envoi libre au-delà).
        try { await processDueFollowups(env); } catch (e) { await log(env, "error", "relances_cron_echec", e.message, tid); }
        await env.DB.prepare("DELETE FROM events WHERE ts<datetime('now','-30 days')").run();
        await env.DB.prepare("DELETE FROM wa_seen WHERE ts<datetime('now','-7 days')").run();
        await env.DB.prepare("DELETE FROM rate_limit WHERE window_start<datetime('now','-1 day')").run();
        if (getMode(env) === "test") await log(env, "info", "mode_test", "aucune publication réelle en mode test", tid);
      } catch (e) { console.log("cron_erreur", e.message); }
    })());
  },
};
