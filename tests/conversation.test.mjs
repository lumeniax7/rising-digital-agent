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
  assert.equal(classifyMessage("Combien d'habitants compte le Togo ?").intent, "question_generale");
  assert.equal(classifyMessage("Combien coûte un site web ?").intent, "prix_delai");
  assert.equal(classifyMessage("Quel budget faut-il pour ouvrir un restaurant ?").intent, "conseil");
  assert.equal(classifyMessage("Quel budget prévoir pour un site web ?").intent, "prix_delai");
  assert.equal(classifyMessage("Je veux savoir pourquoi le ciel est bleu.").intent, "conseil");
  assert.equal(classifyMessage("La météo demain sera-t-elle bonne ?").intent, "question_generale");
  assert.equal(classifyMessage("Je reviens vers vous plus tard.").intent, "report");
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
  // v4.3.2 : seule une rafale < 3 min est bloquée (anti-boucle) ; 5 min = réponse normale.
  assert.equal(shouldReply({ lastOutTs: now - 5 * 60_000, cooldownH: 6, intent: "prix_delai", hasNeed: true, now }), true);
  assert.equal(shouldReply({ lastOutTs: now - 60_000, cooldownH: 6, intent: "prix_delai", hasNeed: true, now }), false);
  // Bruit sans enjeu : ancien comportement (cooldown complet).
  assert.equal(shouldReply({ lastOutTs: now - 2 * HOUR, cooldownH: 6, intent: "autre_inconnu", hasNeed: false, now }), false);
  assert.equal(shouldReply({ lastOutTs: now - 7 * HOUR, cooldownH: 6, intent: "autre_inconnu", hasNeed: false, now }), true);
});

test("relances : jamais après un refus, délais calibrés, tous < 24 h (fenêtre Meta)", () => {
  assert.equal(nextFollowupDelayH("refus"), null);
  assert.equal(nextFollowupDelayH("salutation", false), null);
  assert.ok(nextFollowupDelayH("report") >= 12 && nextFollowupDelayH("report") <= 23);
  for (const i of ["prix_delai", "besoin_service"]) {
    const h = nextFollowupDelayH(i, true);
    assert.ok(h >= 4 && h <= 20, `${i} -> ${h}`);
  }
  assert.equal(nextFollowupDelayH("conseil"), null);
  assert.equal(nextFollowupDelayH("question_generale"), null);
});

test("prompt système : conseiller d'abord, vente uniquement si pertinente", () => {
  const p = buildSystemPrompt({
    brand: "ton : humain", services: ["Création de site et application", "Intelligence artificielle"],
    classification: classifyMessage("combien coûte un site web ?"), siteUrl: "https://risingdigitalsolutions.pages.dev",
  });
  assert.match(p, /conseiller compétent/i);
  assert.match(p, /Ne propose un service.*que si ce service répond réellement au besoin/i);
  assert.doesNotMatch(p, /AU MOINS UN service/i);
  assert.doesNotMatch(p, /100 mots/i);
  assert.match(p, /N'invente aucun fait/i);
  assert.match(p, /Création de site et application/);
  assert.match(p, /25 000 à 350 000 F CFA/);           // repères officiels, uniquement sur demande tarifaire
  assert.match(p, /indicatifs/);
  assert.match(p, /https:\/\/risingdigitalsolutions\.pages\.dev/);
});

test("question générale : aucun argumentaire commercial ni prix du catalogue", () => {
  const p = buildSystemPrompt({
    brand: "Rising Digital Solutions",
    services: ["Création de site et application"],
    classification: classifyMessage("Quelle est la capitale du Japon ?"),
  });
  assert.match(p, /question générale n'est pas une occasion obligatoire de vendre/i);
  assert.doesNotMatch(p, /25 000 à 350 000 F CFA/);
  assert.doesNotMatch(p, /Un service du catalogue semble éventuellement lié/);
});

test("filtre de sortie : les réponses générales ne sont pas rejetées pour un montant", () => {
  assert.ok(sanitizeReply("Le site vitrine démarre à 25 000 F CFA, à titre indicatif.", { strictPrices: true }));
  assert.ok(sanitizeReply("Les repères vont de 25 000 à 350 000 F CFA et de 75 000 à 250 000 F CFA.", { strictPrices: true }));
  assert.ok(sanitizeReply("Le budget national est de 40 000 milliards de francs selon le scénario cité."));
  assert.ok(!sanitizeReply("Le devis est de 40 000 F CFA.", { strictPrices: true }));
  assert.ok(!sanitizeReply("Résultat garanti en 3 jours !", { strictPrices: true }));
  assert.ok(sanitizeReply("Consultez https://exemple.com pour la documentation officielle."));
  assert.ok(!sanitizeReply("javascript:alert(1)"));
  assert.ok(!sanitizeReply(""));
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

test("BUG v4.2 corrigé : un client revenant après 24h+ reçoit une réponse", () => {
  const now = Date.now();
  // Avant le correctif, gapH < 24 rendait le bot muet — interdit désormais.
  assert.equal(shouldReply({ lastOutTs: now - 30 * 3600_000, cooldownH: 6, intent: "prix_delai", now }), true);
  assert.equal(shouldReply({ lastOutTs: now - 3 * 24 * 3600_000, cooldownH: 6, intent: "question_generale", now }), true);
  // Boucle instantanée toujours bloquée (3 min d'écart minimal).
  assert.equal(shouldReply({ lastOutTs: now - 60_000, cooldownH: 6, intent: "prix_delai", now }), false);
});

test("digest individuel : format par numéro, action suggérée, jamais de fabrication", async () => {
  const { buildDigestBlock } = await import("../src/reports/reports.js");
  const rows = [
    { external_id: "22896449300", recv: 3, sent: 0, last_msg: "je veux un site pour ma boutique", lead_status: "nouveau", lead_service: "Création de site et application", handoff: 0 },
    { external_id: "22890000001", recv: 1, sent: 1, last_msg: "parler à un humain", lead_status: "à traiter par un humain", lead_service: null, handoff: 1 },
  ];
  const block = buildDigestBlock(rows);
  assert.match(block, /\+22896449300/);
  assert.match(block, /3 reçu\(s\) \/ 0 envoyé\(s\)/);
  assert.match(block, /Création de site et application/);
  assert.match(block, /à recontacter/);
  assert.match(block, /traiter en priorité/);
  assert.match(block, /je veux un site pour ma boutique/);
  assert.equal(buildDigestBlock([]), null);
});

test("commande admin : variantes reconnues, autres messages ignorés", () => {
  const norm = t => t.trim().replace(/^envoi[ez]?[\s-]+(le\s+|moi\s+(?:le\s+)?|le\s+)?/i, "");
  const ADMIN_CMD = /(résum[ée]|resume)(\s+(maintenant|de\s+la\s+semaine|du\s+jour)|z|z\s+maintenant)?$/i;
  for (const t of ["résumé maintenant", "resume maintenant", "Résumé", "RESUME", " résumé ", "resumez", "Résumé de la semaine", "envoie le résumé", "envoie-moi le résumé", "resume du jour"])
    assert.ok(ADMIN_CMD.test(norm(t)), t);
  for (const t of ["bonjour", "combien coûte un site ?", ""])
    assert.ok(!ADMIN_CMD.test(norm(t)), t);
});

test("numéro admin : comparaison insensible au format", () => {
  const normPhone = v => { const d = String(v ?? "").replace(/\D/g, ""); return d.startsWith("00228") ? d.slice(5) : d.startsWith("228") && d.length > 8 ? d.slice(3) : d; };
  const pairs = [["22890681092", "+228 90 68 10 92"], ["22890681092", "90681092"], ["+22890681092", "0022890681092"]];
  for (const [a, b] of pairs) assert.equal(normPhone(a), normPhone(b), `${a} vs ${b}`);
});
