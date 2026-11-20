export async function readJsonBody(req, maxBytes = 65536) {
  const length = req.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > maxBytes) throw Object.assign(new Error("Corps trop volumineux"), { status: 413 });
  if (!req.body) return {};
  const reader = req.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel().catch(() => {}); throw Object.assign(new Error("Corps trop volumineux"), { status: 413 }); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let value;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw Object.assign(new Error("JSON invalide"), { status: 400 }); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Object.assign(new Error("Objet JSON requis"), { status: 400 });
  return value;
}

export function validPublicHttpsUrl(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return false;
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (!host || host.includes(":") || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
    const ip = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)?.slice(1).map(Number);
    if (ip) {
      const [a, b, c] = ip;
      if (ip.some(n => n > 255) || a === 0 || a === 10 || a === 127 || a >= 224 ||
          (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
          (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) ||
          (a === 198 && (b === 18 || b === 19)) || (a === 203 && b === 0 && c === 113)) return false;
    }
    return true;
  } catch { return false; }
}
