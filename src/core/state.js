// Machine à états par canal. Statut GLOBAL du post = dérivé des canaux, jamais inventé.
// Canal : pending -> queued -> publishing -> published | manual_required | error | unconfigured
export function derivePostStatus(channels) {
  if (!channels.length) return "error";
  const sts = channels.map(c => c.status);
  if (sts.includes("publishing")) return "publishing";
  if (sts.every(s => s === "published")) return "published";
  if (sts.every(s => ["unconfigured"].includes(s))) return "unconfigured";
  if (sts.every(s => ["manual_required"].includes(s))) return "manual_required";
  if (sts.every(s => ["error"].includes(s))) return "error";
  const ok = sts.filter(s => s === "published").length;
  if (ok > 0) return "partial";                    // au moins un confirmé + au moins un non-abouti
  if (sts.includes("queued") || sts.includes("pending")) return sts.includes("queued") ? "queued" : "pending";
  return "partial";
}

export const STATUS_LABEL = {
  draft: "🧪 brouillon (mode test)", pending: "⏳ à approuver", approved: "🟡 approuvé",
  queued: "📋 en file", publishing: "🔄 publication en cours", published: "✅ publié (confirmé)",
  partial: "⚠️ partiel", error: "❌ échec", manual_required: "✍️ publication manuelle requise",
  unconfigured: "🔌 canal non configuré", rejected: "🚫 rejeté",
};
