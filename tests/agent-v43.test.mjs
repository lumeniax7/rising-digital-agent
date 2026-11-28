import { test } from "node:test";
import assert from "node:assert/strict";
import { faqKey, sameQuestion, hashtagsForService } from "../src/social/conversation.js";
import { buildStatusPackages } from "../src/content/statuts.js";
import { parseBriefing } from "../src/content/briefing.js";

test("FAQ : clé déterministe, questions quasi identiques reconnues", () => {
  assert.equal(faqKey("Combien coûte un site web ?"), faqKey("combien coute un site web"));
  assert.ok(sameQuestion("combien coûte un site web pour une boutique", "combien coute un site web pour ma boutique"));
  assert.ok(!sameQuestion("combien coûte un site web", "quelle heure est-il à Lomé ?"));
});

test("hashtags Facebook : dérivés du service, jamais en double avec un texte déjà taggué", () => {
  const h = hashtagsForService("Création de site et application");
  assert.ok(h.includes("#RisingDigital") && h.includes("#SiteWeb"));
  assert.ok(hashtagsForService("Intelligence artificielle").includes("#IA"));
  assert.ok(hashtagsForService("Service inconnu xyz").includes("#Togo")); // socle minimum
});

test("statuts WhatsApp : 3 paquets prêts à publier avec visuelle et texte", () => {
  const packs = buildStatusPackages([
    { title: "E-commerce", file: "e-commerce.jpg", descr: "Présenter un catalogue." },
    { title: "Formation et transmission", file: "formation.jpg", descr: "Apprendre une compétence utile." },
    { title: "Intelligence artificielle", file: "ia.jpg", descr: "Identifier les usages utiles." },
    { title: "Quatrième ignoré", file: "x.jpg", descr: "Ne doit pas apparaître." },
  ]);
  assert.equal(packs.length, 3);
  assert.ok(packs.every(p => p.file && p.text.includes("https://risingdigitalsolutions.pages.dev")));
  assert.ok(!JSON.stringify(packs).includes("Quatrième"));
});

test("briefing : uniquement celui du jour est injecté dans les prompts", () => {
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(parseBriefing(`${today}|• ligne une\n• ligne deux`), "• ligne une\n• ligne deux");
  assert.equal(parseBriefing("2020-01-01|• vieux briefing"), null);
  assert.equal(parseBriefing("0"), null);          // valeur FakeD1 par défaut : jamais injectée
  assert.equal(parseBriefing(null), null);
});
