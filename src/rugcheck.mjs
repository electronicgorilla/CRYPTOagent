// RugCheck collector - best-effort Solana risk summary (public endpoint, no key).
const BASE = "https://api.rugcheck.xyz/v1";
const CACHE = new Map(); // mint -> { t, data }
const TTL = 30 * 60 * 1000;

export async function getSummary(mint) {
  if (process.env.DISABLE_RUGCHECK === "1" || !mint) return null;
  const hit = CACHE.get(mint);
  if (hit && Date.now() - hit.t < TTL) return hit.data;
  let data = null;
  try {
    const r = await fetch(`${BASE}/tokens/${mint}/report/summary`, {
      headers: { "User-Agent": "degen-radar/0.1" },
      signal: AbortSignal.timeout(10000),
    });
    if (r.ok) data = await r.json();
  } catch { /* offline / rate-limited - degrade gracefully */ }
  CACHE.set(mint, { t: Date.now(), data });
  return data;
}

/** Normalise the parts we score on. Defensive - RugCheck's shape drifts. */
export function interpret(summary) {
  if (!summary)
    return { norm: null, flags: [], lpLocked: null, mintAuthorityActive: null, freezeAuthorityActive: null };

  let norm = summary.score_normalised;
  if (norm == null && typeof summary.score === "number")
    norm = Math.min(100, Math.max(0, summary.score / 100));

  const flags = [];
  let lpLocked = null, mintAuth = null, freezeAuth = null;
  for (const risk of summary.risks || []) {
    const name = (risk.name || "").toLowerCase();
    if (risk.name) flags.push(risk.name);
    if (name.includes("mint authority")) mintAuth = true;
    if (name.includes("freeze authority")) freezeAuth = true;
    if (name.includes("lp") && (name.includes("unlocked") || name.includes("not locked"))) lpLocked = false;
    if (name.includes("liquidity") && name.includes("locked")) lpLocked = true;
  }
  return { norm, flags, lpLocked, mintAuthorityActive: mintAuth, freezeAuthorityActive: freezeAuth };
}
