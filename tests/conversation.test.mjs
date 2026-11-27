import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyMessage, detectTopic, buildSystemPrompt, shouldReply, nextFollowupDelayH } from "../src/social/conversation.js";

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
