// Rising Digital Agent v4 — point d'entrée.
// Routes : /webhook (WhatsApp), /api/* (tableau de bord authentifié), / (SPA statique), /health.
import { handleWhatsApp, processPendingWhatsApp } from "./social/whatsapp.js";
import { processWhatsAppTemplateQueue } from "./social/whatsapp-template-queue.js";
import { handleApi } from "./web/router.js";
import { ensure } from "./core/db.js";
import { log } from "./core/log.js";
import { generatePost } from "./content/generator.js";
import { runDue, enqueue } from "./tasks/queue.js";
import { dailyReport, monitorWhatsAppQueue } from "./reports/reports.js";
import { getMode } from "./core/config.js";
import { nowISO } from "./core/util.js";
import { publishDue } from "./social/publish.js";

const SEC = { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY",
  "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" };

export default {
  async fetch(req, env, ctx) {
    try {
      const u = new URL(req.url);
      if (u.pathname === "/webhook") { await ensure(env); return await handleWhatsApp(req, env, ctx); }
      if (u.pathname === "/health") return new Response("ok", { headers: SEC });
      if (u.pathname.startsWith("/api/")) return await handleApi(req, env, ctx);
      if (req.method === "GET" || req.method === "HEAD") {
        await ensure(env);
        await env.DB.prepare("INSERT OR REPLACE INTO meta(k,v) VALUES('origin',?)").bind(u.origin).run().catch(() => {});
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
        if (event.cron === "*/15 * * * *") {
          await processPendingWhatsApp(env, 20);
          await processWhatsAppTemplateQueue(env, 20);
          await monitorWhatsAppQueue(env);
          await publishDue(env, tid, 3);
          return;
        }
        if (event.cron === "30 7 * * *") {           // 07h30 Lomé : rapport quotidien (et hebdo le lundi)
          await dailyReport(env);
          return;
        }
        // 07h00 Lomé : génération du post du jour + publication + reprise des travaux en attente
        try { await generatePost(env, tid); } catch (e) { await log(env, "error", "generation_echec", e.message, tid); }
        await enqueue(env, "publish_posts", {}, `publish_${nowISO().slice(0, 13)}`);
        try { await runDue(env); } catch (e) { await log(env, "error", "publication_cron_echec", e.message, tid); }
        await env.DB.prepare("DELETE FROM events WHERE ts<datetime('now','-30 days')").run();
        await env.DB.prepare("DELETE FROM wa_seen WHERE ts<datetime('now','-7 days')").run();
        await env.DB.prepare("DELETE FROM rate_limit WHERE window_start<datetime('now','-1 day')").run();
        if (getMode(env) === "test") await log(env, "info", "mode_test", "aucune publication réelle en mode test", tid);
      } catch (e) { await log(env, "error", "cron_erreur", e.message).catch(() => {}); }
    })());
  },
};
