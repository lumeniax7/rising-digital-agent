import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyMessage, detectTopic, buildSystemPrompt, shouldReply, nextFollowupDelayH, sanitizeReply, adjustToDaytime, mergeProfile } from "../src/social/conversation.js";

const HOUR = 3600_000;

test("classification : refus, report, prix, besoin, salutation, conseil", () => {
  assert.equal(classifyMessage("stop, ne m'écrivez plus").intent, "refus");
  assert.equal(classifyMessage("on reparle demain, merci").intent, "report");
  const p = classifyMessage("bonjour, combien coûte un site web pour ma boutique ?");
  assert.equal(p.intent, "prix_delai");
  assert.equal(p.service, "Création de site et application");
  const b = classifyMessage("je voudrais un logo pour mon église");
  assert.equal(b.intent, "besoin_service");
  assert.ok(["Création graphique et identité visuelle", "Solutions pour ONG, associations, églises et organisations"].includes(b.service));
  assert.equal(classifyMessage("bonjour").intent, "salutation");
  assert.equal(classifyMessage("peux-tu m'expliquer comment fonctionne un chatbot ?").intent, "conseil");
  assert.equal(classifyMessage("c'est quoi le nombre d'habitants du Togo ?").intent, "question_generale");
});

test("le pont vers un service ne cite que le catalogue réel", () => {
  for (const t of ["je veux vendre en ligne", "mon pc est en panne", "je cherche du travail", "impression de t-shirts"])
    assert.ok(detectTopic(t)?.service, t);
  assert.equal(detectTopic("quelle est la capitale du Japon ?"), null);
});

test("shouldReply : question réelle répondue rapidement, bruit toujours filtré par le cooldown", () => {
  const now = Date.now();
  assert.equal(shouldReply({ lastOutTs: null }), true);
  // Question réelle après 30 min : on répond même si le cooldown est de 6 h.
  assert.equal(shouldReply({ lastOutTs: now - 0.5 * HOUR, cooldownH: 6, intent: "prix_delai", hasNeed: false, now }), true);
  // Boucle à répétition (< 20 min) : bloquée.
  assert.equal(shouldReply({ lastOutTs: now - 5 * 60_000, cooldownH: 6, intent: "prix_delai", hasNeed: true, now }), false);
  // Bruit sans enjeu : ancien comportement (cooldown complet).
  assert.equal(shouldReply({ lastOutTs: now - 2 * HOUR, cooldownH: 6, intent: "autre_inconnu", hasNeed: false, now }), false);
  assert.equal(shouldReply({ lastOutTs: now - 7 * HOUR, cooldownH: 6, intent: "autre_inconnu", hasNeed: false, now }), true);
});

test("relances : jamais après un refus, délais calibrés, tous < 24 h (fenêtre Meta)", () => {
  assert.equal(nextFollowupDelayH("refus"), null);
  assert.equal(nextFollowupDelayH("salutation", false), null);
  assert.ok(nextFollowupDelayH("report") >= 12 && nextFollowupDelayH("report") <= 23);
  for (const i of ["prix_delai", "besoin_service", "conseil"]) {
    const h = nextFollowupDelayH(i, true);
    assert.ok(h >= 4 && h <= 20, `${i} -> ${h}`);
  }
});

test("prompt système : objectif de conversion, honnêteté, catalogue réel, prix officiels", () => {
  const p = buildSystemPrompt({
    brand: "ton : humain", services: ["Création de site et application", "Intelligence artificielle"],
    classification: classifyMessage("combien coûte un site web ?"), siteUrl: "https://risingdigitalsolutions.pages.dev",
  });
  assert.match(p, /AU MOINS UN service/i);
  assert.match(p, /n'invente JAMAIS/);
  assert.match(p, /Création de site et application/);
  assert.match(p, /25 000 à 350 000 F CFA/);           // repères officiels du site, jamais inventés
  assert.match(p, /indicatifs/);
  assert.match(p, /https:\/\/risingdigitalsolutions\.pages\.dev/);
});

test("filtre anti-hallucination : seuls les repères officiels passent", () => {
  assert.ok(sanitizeReply("Le site vitrine démarre à 25 000 F CFA, à titre indicatif."));
  assert.ok(sanitizeReply("Les repères vont de 25 000 à 350 000 F CFA et de 75 000 à 250 000 F CFA."));
  assert.ok(sanitizeReply("Je ne sais pas exactement, l'équipe précisera le devis."));
  assert.ok(!sanitizeReply("Ça coûte 40 000 F CFA, c'est promis."));       // prix inventé
  assert.ok(!sanitizeReply("Résultat garanti en 3 jours !"));              // promesse interdite
  assert.ok(!sanitizeReply("Voir https://exemple.com pour détails"));      // lien externe
  assert.ok(!sanitizeReply(""));                                           // vide
});

test("relances jamais la nuit (22h-7h à Lomé = UTC)", () => {
  assert.equal(adjustToDaytime("2026-11-28T02:30:00Z"), "2026-11-28T09:00:00.000Z");   // nuit -> 9h
  assert.equal(adjustToDaytime("2026-11-28T23:15:00Z"), "2026-11-29T09:00:00.000Z");   // tard -> lendemain 9h
  assert.equal(adjustToDaytime("2026-11-28T14:00:00Z"), "2026-11-28T14:00:00Z");       // jour : inchangé
});

test("mémoire par contact : fusion des sujets et du dernier besoin", () => {
  const p1 = mergeProfile(null, { intent: "prix_delai", topic: "site_web", service: "Création de site et application" }, "un site pour ma boutique");
  assert.ok(p1.sujets.includes("site_web") && p1.sujets.includes("Création de site et application"));
  assert.equal(p1.dernier_besoin, "un site pour ma boutique");
  const p2 = mergeProfile(p1, { intent: "conseil", topic: "ia", service: null });
  assert.ok(p2.sujets.includes("ia"));
  assert.equal(p2.dernier_service, "Création de site et application");
  assert.ok(p2.sujets.length <= 5);
});

test("rapport v4.3.1 : ligne publications par canal sans double comptage", async () => {
  const { publicationLine } = await import("../src/reports/reports.js");
  const a = { facebook: { ok: 1, echecs: 2, dernier_erreur: "HTTP 190 : jeton expiré" }, instagram: { ok: 3, echecs: 0, dernier_erreur: null } };
  const line = publicationLine("Publications —", a);
  assert.match(line, /Facebook : 1 OK \/ 2 échec\(s\)/);
  assert.match(line, /Instagram : 3 OK \/ 0 échec\(s\)/);
  assert.match(line, /jeton expiré/);           // l'erreur brute est citée : actionnable
  const clean = publicationLine("Publications —", { facebook: { ok: 2, echecs: 0, dernier_erreur: null }, instagram: { ok: 2, echecs: 0, dernier_erreur: null } });
  assert.ok(!clean.includes("dernier échec"));  // pas d'alerte quand tout va bien
});
