// LAYER 0 - macro regime.
//
// The slowest, widest layer. Solana memecoins are a leveraged bet on SOL being
// bid; when SOL bleeds, every chart below is a trap regardless of how good it
// looks in isolation. Without this the only regime signal was cohort breadth -
// the share of scanned tokens that were green - which is a proxy measured from
// inside the very cohort it is meant to contextualise.
//
// TWO PROVIDERS, and the key-less one is the DEFAULT on purpose.
//
//   coingecko (default) - no API key, no quota cliff, and it returns an
//     intraday price series, so realised range is MEASURED rather than
//     inferred from a single high/low pair.
//   eodhd (optional)    - only used if EODHD_API_KEY happens to be set.
//
// The first version of this file made EODHD mandatory, which meant Layer 0 sat
// dark unless a paid key was configured, and it was budgeted around a hard
// 20-calls-per-DAY free tier that bills per SYMBOL (measured: a 3-symbol batch
// consumed 3 calls). Depending on a rationed key for a number that gates every
// other score was the wrong dependency. A free source that answers every time
// is worth more than a better source that answers sixteen times a day.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.mjs";

const CACHE = join(DATA_DIR, "regime.json");
const CG = "https://api.coingecko.com/api/v3";
const EODHD = "https://eodhd.com/api/real-time";

/** Layer 0 is always available now - the default provider needs no key. */
export const enabled = () => true;
export const hasEodhdKey = () => !!process.env.EODHD_API_KEY;

const today = () => new Date().toISOString().slice(0, 10);

function loadCache() {
  if (!existsSync(CACHE)) return { data: null, fetchedAt: 0, spend: {} };
  try { return JSON.parse(readFileSync(CACHE, "utf8")); } catch { return { data: null, fetchedAt: 0, spend: {} }; }
}
const saveCache = (c) => writeFileSync(CACHE, JSON.stringify(c, null, 2));
export const quotaUsedToday = () => loadCache().spend?.[today()] || 0;

export async function getRegime(cfg) {
  const c = cfg?.regime || {};
  const floorMs = (c.refreshMinutes ?? 20) * 60000;
  const cache = loadCache();
  const age = Date.now() - (cache.fetchedAt || 0);

  if (cache.data && age < floorMs) {
    return { ...cache.data, available: true, cached: true, ageMinutes: Math.round(age / 60000) };
  }

  // Prefer the provider that always answers; fall back to whichever is left.
  const order = c.provider === "eodhd" && hasEodhdKey()
    ? ["eodhd", "coingecko"]
    : ["coingecko", ...(hasEodhdKey() ? ["eodhd"] : [])];

  for (const p of order) {
    try {
      const fetched = p === "coingecko" ? await viaCoinGecko(c) : await viaEodhd(c, cache);
      if (!fetched) continue;
      const data = { fetchedAt: Date.now() / 1000, provider: p, ...fetched, ...classify(fetched) };
      cache.data = data;
      cache.fetchedAt = Date.now();
      saveCache(cache);
      return { ...data, available: true, cached: false };
    } catch (e) {
      // try the next provider rather than going dark
      if (p === order[order.length - 1]) {
        return {
          ...(cache.data || {}), available: !!cache.data, cached: true, error: e.message,
          ageMinutes: cache.fetchedAt ? Math.round(age / 60000) : null,
        };
      }
    }
  }
  return { ...(cache.data || {}), available: !!cache.data, cached: true, reason: "all providers failed" };
}

// ---------------------------------------------------------------------------
async function viaCoinGecko(c) {
  const ids = (c.coins?.length ? c.coins : ["solana", "bitcoin"]).join(",");
  const r = await fetch(
    `${CG}/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true`,
    { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15000) }
  );
  if (!r.ok) throw new Error(`coingecko HTTP ${r.status}`);
  const js = await r.json();

  const quotes = {};
  for (const [id, v] of Object.entries(js)) {
    quotes[id] = {
      close: v.usd,
      change_pct: v.usd_24h_change ?? null,
      volume: v.usd_24h_vol ?? null,
    };
  }

  // Realised intraday range from the actual series - strictly better than a
  // single high/low pair, and it is what widens the expected-move bands below.
  let rangePct = null;
  try {
    const lead = c.coins?.[0] || "solana";
    const m = await fetch(`${CG}/coins/${lead}/market_chart?vs_currency=usd&days=1`,
      { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15000) });
    if (m.ok) {
      const mj = await m.json();
      const px = (mj.prices || []).map((p) => p[1]).filter((x) => x > 0);
      if (px.length > 10) {
        const hi = Math.max(...px), lo = Math.min(...px), last = px[px.length - 1];
        rangePct = last ? ((hi - lo) / last) * 100 : null;
        if (quotes[lead]) quotes[lead].range_pct = rangePct;
      }
    }
  } catch { /* the range is a refinement, not a requirement */ }

  return { quotes, lead_id: c.coins?.[0] || "solana", range_pct: rangePct };
}

async function viaEodhd(c, cache) {
  const symbols = c.symbols?.length ? c.symbols : ["SOL-USD.CC"];
  const budget = c.dailyCallBudget ?? 16;
  const spent = cache.spend?.[today()] || 0;
  // Batching bills per SYMBOL, so the cost of a refresh is the symbol count.
  if (spent + symbols.length > budget) throw new Error(`eodhd daily budget spent (${spent}/${budget})`);

  const [primary, ...rest] = symbols;
  const url = new URL(`${EODHD}/${encodeURIComponent(primary)}`);
  url.searchParams.set("api_token", process.env.EODHD_API_KEY);
  url.searchParams.set("fmt", "json");
  if (rest.length) url.searchParams.set("s", rest.join(","));
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`eodhd HTTP ${r.status}`);
  const rows = await r.json().then((j) => (Array.isArray(j) ? j : [j]));

  const quotes = {};
  for (const q of rows) {
    if (!q?.code) continue;
    quotes[q.code] = {
      close: q.close, change_pct: q.change_p, volume: q.volume,
      range_pct: q.close ? ((q.high - q.low) / q.close) * 100 : null,
    };
  }
  cache.spend = cache.spend || {};
  cache.spend[today()] = spent + symbols.length;
  return { quotes, lead_id: primary, range_pct: quotes[primary]?.range_pct ?? null };
}

// ---------------------------------------------------------------------------
/**
 * Turn the majors into a regime and a multiplier. Deliberately blunt: this
 * gates other scores, so a subtle model here would be false precision layered
 * on a quote that may be twenty minutes old.
 */
function classify({ quotes, lead_id, range_pct }) {
  const lead = quotes?.[lead_id] || Object.values(quotes || {})[0];
  const change = lead?.change_pct;
  // CoinGecko uses slugs ("solana"); EODHD uses tickers ("SOL-USD.CC").
  // Display a ticker either way.
  const TICKER = { solana: "SOL", bitcoin: "BTC", ethereum: "ETH" };
  const name = TICKER[String(lead_id || "").toLowerCase()] ||
    String(lead_id || "").replace(/-USD\.CC$/i, "").toUpperCase();
  if (change == null) return { regime: "unknown", multiplier: 1, note: "no major quote available" };

  let regime, multiplier, note;
  if (change <= -4) {
    regime = "risk-off"; multiplier = 0.6;
    note = `${name} ${change.toFixed(1)}% — the chain is bleeding. Memecoin bids vanish first in this tape; treat every long as fighting the current.`;
  } else if (change <= -1) {
    regime = "soft"; multiplier = 0.85;
    note = `${name} ${change.toFixed(1)}% — mildly offered. Rotations still work but less new money is arriving.`;
  } else if (change >= 4) {
    regime = "risk-on"; multiplier = 1.15;
    note = `${name} +${change.toFixed(1)}% — the chain is bid and attention follows price. FOMO signals carry further here.`;
  } else {
    regime = "neutral"; multiplier = 1;
    note = `${name} ${change >= 0 ? "+" : ""}${change.toFixed(1)}% — no strong macro push either way; cohort breadth is the better read.`;
  }

  // A major printing a wide intraday range means volatility is elevated
  // system-wide, so expected-move bands downstream should widen with it.
  const volMult = range_pct != null ? Math.max(1, Math.min(1.8, range_pct / 4)) : 1;

  return {
    regime, multiplier, note,
    lead_symbol: name,
    lead_change_pct: change,
    volatility_multiplier: Math.round(volMult * 100) / 100,
  };
}
