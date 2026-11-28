// TikTok — état HONNÊTE : la publication directe exige l'approbation de l'API Content Posting
// (voir docs/TIKTOK.md). Sans autorisation, l'agent produit un PAQUET PRÊT À PUBLIER et marque
// « publication manuelle requise ». Il n'indiquera JAMAIS qu'une vidéo a été publiée sans confirmation TikTok.
export async function prepareDraft(env, post, settings) {
  const hashtags = ["#RisingDigital", "#Togo", "#IA", "#Numerique"];
  return {
    status: "manual_required",
    external_id: null,
    draft: { title: post.title, text: post.text, hashtags, format: "9:16 vertical", note: "Exportez le visuel depuis la bibliothèque et publiez manuellement sur TikTok." },
  };
}
