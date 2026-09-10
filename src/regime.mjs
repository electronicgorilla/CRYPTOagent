// LAYER 0 - macro regime.
//
// The slowest, widest layer. Solana memecoins are a leveraged bet on SOL being
// bid; when SOL is bleeding, every chart below is a trap regardless of how good
// it looks in isolation. Until now the only regime signal was cohort breadth -
// the share of scanned tokens that were green - which is a proxy measured from
// inside the very cohort it is meant to contextualise. This replaces it with
// the actual majors.
//
// HARD CONSTRAINT, measured not assumed: the EODHD free plan allows 20 API
// calls PER DAY, and batching bills per SYMBOL, not per request (verified: a
// 3-symbol batch consumed 3 calls). So this layer:
//
//   - defaults to SOL alone (1 call per refresh)
//   - refreshes on a 90-minute floor -> ~16 calls/day, leaving headroom
//   - persists its cache to disk so restarts do not re-spend quota
//   - tracks its own spend and REFUSES to call once the daily budget is gone
//
// A poller that ignores this would exhaust the quota before mid-morning and
// then silently serve stale data, which is worse than serving none.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.mjs";

const CACHE = join(DATA_DIR, "regime.json");
const BASE = "https://eodhd.com/api/real-time";

export const enabled = () => !!process.env.EODHD_API_KEY;

const today = () => new Date().toISOString().slice(0, 10);

function loadCache() {
  if (!existsSync(CACHE)) return { data: null, fetchedAt: 0, spend: {} };
  try { return JSON.parse(readFileSync(CACHE, "utf8")); } catch { return { data: null, fetchedAt: 0, spend: {} }; }
}
const saveCache = (c) => writeFileSync(CACHE, JSON.stringify(c, null, 2));

export function quotaUsedToday() {
  return loadCache().spend?.[today()] || 0;
}

/**
 * Fetch the majors. Returns the cached snapshot when inside the refresh floor
 * or when the daily budget is spent - never a fabricated number, and the
 * returned object always says how old it is.
 */
export async function getRegime(cfg) {
  const c = cfg?.regime || {};
  const symbols = c.symbols?.length ? c.symbols : ["SOL-USD.CC"];
  const floorMs = (c.refreshMinutes ?? 90) * 60000;
  const budget = c.dailyCallBudget ?? 16;

  const cache = loadCache();
  const age = Date.now() - (cache.fetchedAt || 0);
  const spent = cache.spend?.[today()] || 0;

  if (!enabled()) {
    return { ...(cache.data || {}), available: false, reason: "EODHD_API_KEY not set", stale: true };
  }
  if (cache.data && age < floorMs) {
    return { ...cache.data, available: true, ageMinutes: Math.round(age / 60000), cached: true };
  }
  // Batching bills per symbol, so the cost of a refresh IS the symbol count.
  if (spent + symbols.length > budget) {
    return {
      ...(cache.data || {}), available: true, cached: true, budgetExhausted: true,
      ageMinutes: Math.round(age / 60000),
      reason: `daily budget spent (${spent}/${budget} calls) - serving cache`,
    };
  }

  try {
    const [primary, ...rest] = symbols;
    const url = new URL(`${BASE}/${encodeURIComponent(primary)}`);
    url.searchParams.set("api_token", process.env.EODHD_API_KEY);
    url.searchParams.set("fmt", "json");
    if (rest.length) url.searchParams.set("s", rest.join(","));

    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const js = await r.json();
    const rows = Array.isArray(js) ? js : [js];

    const quotes = {};
    for (const q of rows) {
      if (!q?.code) continue;
      quotes[q.code] = {
        close: q.close, change_pct: q.change_p,
        high: q.high, low: q.low, volume: q.volume,
        // Intraday range as a share of price - a cheap realised-volatility read
        // on the major itself, which sets the ceiling for everything below.
        range_pct: q.close ? ((q.high - q.low) / q.close) * 100 : null,
      };
    }

    const data = { fetchedAt: Date.now() / 1000, quotes, ...classify(quotes, symbols) };
    cache.data = data;
    cache.fetchedAt = Date.now();
    cache.spend = cache.spend || {};
    cache.spend[today()] = spent + symbols.length;
    saveCache(cache);
    return { ...data, available: true, cached: false, callsToday: cache.spend[today()], budget };
  } catch (e) {
    return {
      ...(cache.data || {}), available: true, cached: true, error: e.message,
      ageMinutes: cache.fetchedAt ? Math.round(age / 60000) : null,
    };
  }
}

/**
 * Turn the majors into a regime and a multiplier.
 *
 * Deliberately blunt: this gates other scores, so a subtle model here would be
 * false precision on top of a 90-minute-old quote.
 */
function classify(quotes, symbols) {
  const chain = symbols.find((s) => s.startsWith("SOL")) || symbols[0];
  const sol = quotes[chain];
  const btc = quotes["BTC-USD.CC"];
  const lead = sol?.change_pct ?? btc?.change_pct ?? null;
  if (lead == null) return { regime: "unknown", multiplier: 1, note: "no major quote available" };

  let regime, multiplier, note;
  if (lead <= -4) {
    regime = "risk-off";
    multiplier = 0.6;
    note = `${chain.split("-")[0]} ${lead.toFixed(1)}% — the chain is bleeding. Memecoin bids vanish first in this tape; treat every long as fighting the current.`;
  } else if (lead <= -1) {
    regime = "soft";
    multiplier = 0.85;
    note = `${chain.split("-")[0]} ${lead.toFixed(1)}% — mildly offered. Rotations still work but there is less new money arriving.`;
  } else if (lead >= 4) {
    regime = "risk-on";
    multiplier = 1.15;
    note = `${chain.split("-")[0]} +${lead.toFixed(1)}% — the chain is bid and attention follows price. FOMO signals carry further here.`;
  } else {
    regime = "neutral";
    multiplier = 1;
    note = `${chain.split("-")[0]} ${lead >= 0 ? "+" : ""}${lead.toFixed(1)}% — no strong macro push either way; the cohort's own breadth is the better read.`;
  }

  // A major printing a wide intraday range means volatility is elevated
  // system-wide - the expected-move bands downstream should widen with it.
  const volMult = sol?.range_pct != null ? Math.max(1, Math.min(1.8, sol.range_pct / 4)) : 1;

  return {
    regime, multiplier, note,
    lead_symbol: chain,
    lead_change_pct: lead,
    volatility_multiplier: Math.round(volMult * 100) / 100,
  };
}
