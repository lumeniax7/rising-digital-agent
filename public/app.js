// Tableau de bord Rising Digital Agent — SPA française, sans dépendance externe.
const $ = (s, r = document) => r.querySelector(s);
const state = { csrf: null, view: "home" };
const api = async (path, opts = {}) => {
  const r = await fetch(path, { headers: { ...(state.csrf ? { "x-csrf": state.csrf } : {}) }, ...opts });
  if (r.status === 401) { show("login"); throw new Error("Session expirée"); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
};
const toast = (msg, cls = "") => { const d = document.createElement("div"); d.className = cls; d.textContent = msg; $("#toast").append(d); setTimeout(() => d.remove(), 4000); };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = s => esc(s).replace(/\n/g, "<br>");

$("#login-form").addEventListener("submit", async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const r = await api("/api/login", { method: "POST", body: JSON.stringify({ username: f.get("username"), password: f.get("password") }) });
    state.csrf = r.csrf; enter(r.user);
  } catch (err) { $("#login-error").textContent = err.message; }
});
$("#logout").addEventListener("click", () => api("/api/logout", { method: "POST" }).finally(() => location.reload()));
document.getElementById("nav").addEventListener("click", e => {
  const a = e.target.closest("a"); if (!a) return;
  document.querySelectorAll("nav a").forEach(x => x.classList.remove("active"));
  a.classList.add("active"); state.view = a.dataset.view; render();
});

function enter(user) { $("#login").classList.add("hidden"); $("#app").classList.remove("hidden"); render(); setInterval(render, 60000); }
function show(id) { $(id === "login" ? "#login" : "#app").classList.remove("hidden"); if (id !== "login") $("#app").classList.remove("hidden"); }

async function render() {
  const m = $("#main");
  try {
    if (state.view === "home") return await viewHome(m);
    if (state.view === "calendar") return await viewCalendar(m);
    if (state.view === "posts") return await viewPosts(m);
    if (state.view === "whatsapp") return await viewWhatsApp(m);
    if (state.view === "crm") return await viewCrm(m);
    if (state.view === "media") return await viewMedia(m);
    if (state.view === "memory") return await viewMemory(m);
    if (state.view === "ai") return await viewAi(m);
    if (state.view === "reports") return await viewReports(m);
    if (state.view === "events") return await viewEvents(m);
    if (state.view === "settings") return await viewSettings(m);
  } catch (e) { m.innerHTML = `<div class="empty">Erreur : ${esc(e.message)}</div>`; }
}

async function viewHome(m) {
  const [s, ev] = await Promise.all([api("/api/state"), api("/api/events")]);
  $("#mode-badge").textContent = "mode : " + s.mode;
  const ch = Object.entries(s.channels).map(([k, v]) => `${v ? "🟢" : "⚪"} ${k}`).join(" · ");
  const miss = s.missing.length ? `<div class="card"><b>⚠️ Configuration incomplète</b><ul>${s.missing.map(x => `<li><code>${x.key}</code> — ${esc(x.usage)}</li>`).join("")}</ul></div>` : "";
  const alerts = ev.events.filter(e => e.level === "error").slice(0, 5);
  m.innerHTML = `<h2>Accueil</h2><p class="muted">${ch}</p>${miss}
    <div class="grid g2" style="margin:14px 0">
      <div class="card kpi"><b>${s.counts.published || 0}</b><span>publications confirmées</span></div>
      <div class="card kpi"><b>${s.counts.partial || 0}</b><span>publications partielles</span></div>
      <div class="card kpi"><b>${s.stats.prospects}</b><span>prospects en cours</span></div>
      <div class="card kpi"><b>${s.stats.transferts}</b><span>transferts à un humain</span></div>
    </div>
    <div class="card"><b>Post du jour</b><br>${s.today ? esc(s.today.title) + " — " + esc(s.today.status) : "pas encore généré"}
      <form id="gen" style="margin-top:10px"><button>Générer maintenant</button></form></div>
    ${alerts.length ? `<h3>Alertes récentes</h3><div class="card">${alerts.map(e => `<div class="err">${esc(e.ts)} — ${esc(e.type)} — ${esc(e.detail)}</div>`).join("")}</div>` : ""}`;
  $("#gen").addEventListener("submit", async e => { e.preventDefault(); try { await api("/api/posts/generate", { method: "POST" }); toast("Post généré ✓", "ok"); render(); } catch (err) { toast(err.message, "err"); } });
}

async function viewCalendar(m) {
  const { posts } = await api("/api/posts");
  const days = {}; for (const p of posts) (days[p.day.slice(0, 10)] ??= []).push(p);
  m.innerHTML = `<h2>Calendrier éditorial</h2><div class="card"><table><tr><th>Jour</th><th>Service</th><th>Statut</th></tr>${
    Object.entries(days).map(([d, ps]) => ps.map(p => `<tr><td>${esc(d)}</td><td>${esc(p.title)}</td><td><span class="pill ${p.status}">${esc(p.status)}</span></td></tr>`).join("")).join("") || '<tr><td colspan="3" class="empty">Aucune publication encore planifiée</td></tr>'}</table></div>`;
}

async function viewPosts(m) {
  const { posts } = await api("/api/posts");
  m.innerHTML = `<h2>Publications</h2>${posts.length ? "" : '<div class="empty">Aucune publication. Générez la première depuis l\'accueil.</div>'}` +
    posts.map(p => `<div class="card" style="margin:10px 0"><b>#${p.id} · ${esc(p.day)} · ${esc(p.title)}</b> <span class="pill ${p.status}">${esc(p.status)}</span> <small class="muted">moteur : ${esc(p.generator)}</small><br>
      <img class="aff" src="${esc(p.image)}" alt=""><p style="margin:8px 0">${fmt(p.text)}</p>
      <table><tr><th>Canal</th><th>Statut</th><th>Identifiant externe</th><th>Essais</th><th>Erreur</th></tr>
      ${p.channels.map(c => `<tr><td>${esc(c.channel)}</td><td><span class="pill ${c.status}">${esc(c.status)}</span></td><td>${esc(c.external_id || "—")}</td><td>${c.attempts}</td><td>${esc(c.last_error || "")}</td></tr>`).join("")}</table>
      ${["pending", "draft", "partial", "error"].includes(p.status) ? `<form data-id="${p.id}"><button name="a" value="approve">Approuver / publier</button> <button name="a" value="reject" class="ghost">Rejeter</button></form>` : ""}</div>`).join("");
  m.querySelectorAll("form[data-id]").forEach(f => f.addEventListener("submit", async e => {
    e.preventDefault();
    try { await api(`/api/posts/${f.dataset.id}/${e.submitter.value}`, { method: "POST" }); toast("Fait ✓", "ok"); render(); } catch (err) { toast(err.message, "err"); }
  }));
}

async function viewWhatsApp(m) {
  const { conversations } = await api("/api/conversations");
  m.innerHTML = `<h2>Centre WhatsApp</h2><div class="card"><table><tr><th>Contact</th><th>Nom</th><th>Dernier message</th><th>Transféré</th><th></th></tr>${
    conversations.map(c => `<tr><td>${esc(c.external_id)}</td><td>${esc(c.name || "—")}</td><td>${esc((c.last_msg || "").slice(0, 60))}</td><td>${c.handoff ? "👤 oui" : ""}</td><td><button class="small" data-c="${c.id}">Ouvrir</button></td></tr>`).join("") || '<tr><td colspan="5" class="empty">Aucune conversation — configurez le webhook WhatsApp (voir docs/META-WHATSAPP-SETUP.md)</td></tr>'}</table></div><div id="conv"></div>`;
  m.querySelectorAll("button[data-c]").forEach(b => b.addEventListener("click", () => openConv(b.dataset.c)));
}
async function openConv(id) {
  const { messages } = await api(`/api/conversations/${id}`);
  $("#conv").innerHTML = `<h3>Conversation #${id}</h3><div class="card chat">${messages.map(x => `<div class="msg ${x.direction}">${fmt(x.body)}</div>`).join("") || '<div class="empty">Aucun message</div>'}
    <form id="rp"><input name="body" placeholder="Votre réponse…" required><button>Envoyer</button></form></div>`;
  $("#rp").addEventListener("submit", async e => { e.preventDefault();
    try { await api(`/api/conversations/${id}/reply`, { method: "POST", body: JSON.stringify({ body: new FormData(e.target).get("body") }) }); toast("Envoyé ✓", "ok"); openConv(id); } catch (err) { toast(err.message, "err"); } });
}

async function viewCrm(m) {
  const { leads } = await api("/api/leads");
  m.innerHTML = `<h2>CRM — prospects</h2>${leads.length ? `<div class="card"><table><tr><th>#</th><th>Contact</th><th>Service</th><th>Besoin</th><th>Urgence</th><th>Statut</th></tr>
    ${leads.map(l => `<tr><td>${l.id}</td><td>${esc(l.name || l.external_id)}</td><td>${esc(l.service || "—")}</td><td>${esc((l.need || "").slice(0, 80))}</td><td>${esc(l.urgency || "—")}</td>
      <td><select data-id="${l.id}">${["nouveau", "en discussion", "devis envoyé", "gagné", "perdu", "à traiter par un humain"].map(s => `<option ${l.status === s ? "selected" : ""}>${s}</option>`).join("")}</select></td></tr>`).join("")}</table></div>`
    : '<div class="empty">Aucun prospect pour le moment — ils apparaissent dès que WhatsApp reçoit des demandes.</div>'}`;
  m.querySelectorAll("select[data-id]").forEach(s => s.addEventListener("change", async () =>
    { await api(`/api/leads/${s.dataset.id}`, { method: "PUT", body: JSON.stringify({ status: s.value }) }); toast("Prospect mis à jour ✓", "ok"); }));
}

async function viewMedia(m) {
  const { media } = await api("/api/media");
  m.innerHTML = `<h2>Bibliothèque de créations</h2><div class="grid g2">${media.map(x =>
    `<div class="card"><img class="aff" src="${esc(x.url)}" alt=""><br><b>${esc(x.title)}</b><br><small class="muted">${esc(x.file)} · ${esc(x.status)}</small></div>`).join("") || '<div class="empty">Bibliothèque vide</div>'}</div>`;
}

async function viewMemory(m) {
  const { memory } = await api("/api/memory");
  m.innerHTML = `<h2>Mémoire</h2><p class="muted">Mémoire isolée par client : portée « brand » (identité de marque), « whatsapp » (consignes conversation), « notes ».</p>
    <div class="card"><table><tr><th>Portée</th><th>Clé</th><th>Valeur</th></tr>${memory.map(x => `<tr><td>${esc(x.scope)}</td><td>${esc(x.key)}</td><td>${esc(x.value)}</td></tr>`).join("") || '<tr><td colspan=3 class="empty">Mémoire vide — ajoutez vos consignes</td></tr>'}</table>
    <form id="mem" style="margin-top:10px"><div class="grid g2"><select name="scope">${["brand", "whatsapp", "notes"].map(s => `<option>${s}</option>`).join("")}</select><input name="key" placeholder="clé (ex. ton_de_voix)" required></div><textarea name="value" placeholder="valeur"></textarea><button>Ajouter</button></form></div>`;
  $("#mem").addEventListener("submit", async e => { e.preventDefault(); const f = new FormData(e.target);
    await api("/api/memory", { method: "PUT", body: JSON.stringify({ scope: f.get("scope"), key: f.get("key"), value: f.get("value") }) });
    toast("Mémoire mise à jour ✓", "ok"); render(); });
}

async function viewAi(m) {
  const d = await api("/api/ai");
  m.innerHTML = `<h2>Intelligence IA</h2><p class="muted">${d.ai_enabled ? "Workers AI actif (quota gratuit journalier — jamais illimité)" : "⚠️ Liaison AI absente"}</p>
    <div class="card"><table><tr><th>Tâche</th><th>Fournisseur</th><th>Modèle</th><th>Priorité</th><th>Quota/jour (0=aucun)</th><th>Activé</th></tr>
    ${d.providers.map(p => `<tr><td>${esc(p.task)}</td><td>${esc(p.name)}</td><td><input data-f="model" data-id="${p.id}" value="${esc(p.model)}"></td>
      <td><input data-f="priority" data-id="${p.id}" value="${p.priority}" size="2"></td>
      <td><input data-f="daily_limit" data-id="${p.id}" value="${p.daily_limit}" size="4"></td>
      <td><input data-f="enabled" data-id="${p.id}" type="checkbox" ${p.enabled ? "checked" : ""}></td></tr>`).join("")}</table><button id="saveai">Enregistrer</button></div>
    <h3>Consommation du jour</h3><div class="card">${d.usage.length ? d.usage.map(u => `${esc(u.provider)} / ${esc(u.task)} : ${u.calls} appels, ${u.errors} erreurs`).join("<br>") : "aucun appel aujourd'hui"}</div>`;
  $("#saveai").addEventListener("click", async () => {
    for (const i of m.querySelectorAll("input[data-f]")) {
      const b = { [i.dataset.f]: i.type === "checkbox" ? (i.checked ? 1 : 0) : (isNaN(Number(i.value)) ? i.value : Number(i.value)) };
      await api(`/api/ai/providers/${i.dataset.id}`, { method: "PUT", body: JSON.stringify(b) });
    }
    toast("Fournisseurs IA enregistrés ✓", "ok");
  });
}

async function viewReports(m) {
  const { reports } = await api("/api/reports");
  m.innerHTML = `<h2>Rapports (07h30, heure de Lomé)</h2>${reports.map(r => `<div class="card"><b>${esc(r.kind)} · ${esc(r.day)}</b><pre style="white-space:pre-wrap;font:inherit">${fmt(r.content)}</pre></div>`).join("") || '<div class="empty">Aucun rapport — le premier arrive demain à 07h30.</div>'}`;
}

async function viewEvents(m) {
  const { events } = await api("/api/events");
  m.innerHTML = `<h2>Journal des événements</h2><div class="card"><table><tr><th>Date</th><th>Niveau</th><th>Événement</th><th>Détail</th></tr>
  ${events.map(e => `<tr><td>${esc(e.ts)}</td><td class="${e.level === "error" ? "err" : e.level === "warn" ? "warn" : ""}">${esc(e.level)}</td><td>${esc(e.type)}</td><td>${esc(e.detail || "")}</td></tr>`).join("")}</table></div>`;
}

async function viewSettings(m) {
  const s = await api("/api/state");
  const f = s.settings;
  m.innerHTML = `<h2>Paramètres</h2><div class="card"><form id="st">
    <div class="grid g2">
      <label>Site web <input name="site_url" value="${esc(f.site_url)}"></label>
      <label>E-mail <input name="email" value="${esc(f.email)}"></label>
      <label>Localisation <input name="location" value="${esc(f.location)}"></label>
      <label>Délai anti-spam WhatsApp (h) <input name="wa_cooldown_hours" value="${esc(f.wa_cooldown_hours)}"></label>
    </div>
    <label style="margin-top:10px">Numéros WhatsApp (un par ligne)<textarea name="phones">${f.contact_phones.join("\n")}</textarea></label>
    <label>Webhook de notification des rapports (optionnel, https, ex. https://ntfy.sh/votre-canal)<input name="report_webhook_url" value="${esc(f.report_webhook_url)}"></label>
    <p class="muted">Mode actuel : ${s.mode} (changez la variable MODE dans Cloudflare : test → approval → auto). Les secrets se configurent dans Cloudflare > Settings > Variables and secrets — jamais ici.</p>
    <button>Enregistrer</button></form></div>`;
  $("#st").addEventListener("submit", async e => { e.preventDefault(); const fd = new FormData(e.target);
    await api("/api/settings", { method: "PUT", body: JSON.stringify({
      site_url: fd.get("site_url"), email: fd.get("email"), location: fd.get("location"), wa_cooldown_hours: fd.get("wa_cooldown_hours"),
      report_webhook_url: fd.get("report_webhook_url"), contact_phones: fd.get("phones").split("\n").map(x => x.trim()).filter(Boolean) }) });
    toast("Paramètres enregistrés ✓", "ok"); });
}

// reprise de session existante au chargement
fetch("/api/state").then(r => { if (r.ok) { r.json().then(() => { $("#app").classList.remove("hidden"); render(); }); } else $("#login").classList.remove("hidden"); }).catch(() => $("#login").classList.remove("hidden"));
