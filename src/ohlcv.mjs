// GeckoTerminal candles - free, no key, verified working.
//
// This closes a real gap. Until now volatility was ESTIMATED from what the
// token's market-cap tier happened to do in the last hour; now it can be
// MEASURED from the token's own candles. Estimation was defensible when there
// was no alternative - it is not defensible now that there is.
//
// Endpoint (verified):
//   /networks/solana/pools/{pool}/ohlcv/minute?aggregate=15&limit=N
//   -> attributes.ohlcv_list = [[ts, open, high, low, close, volume], ...]
//
// Free tier is roughly 30 calls/minute, so this is fetched only for the tokens
// actually being scored, cached, and never per-tick.
const BASE = "https://api.geckoterminal.com/api/v2";
const cache = new Map(); // pool -> { t, candles }
const TTL = 4 * 60 * 1000;
const stats = { calls: 0, hits: 0, misses: 0, errors: 0 };

export const coverage = () => ({ ...stats });
export const resetStats = () => Object.keys(stats).forEach((k) => (stats[k] = 0));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @returns {Array<{ts,o,h,l,c,v}>} oldest-first, or [] when unavailable. */
export async function getCandles(pool, { aggregate = 15, limit = 24 } = {}) {
  if (!pool) return [];
  const hit = cache.get(pool);
  if (hit && Date.now() - hit.t < TTL) { stats.hits++; return hit.candles; }

  try {
    stats.calls++;
    const url = `${BASE}/networks/solana/pools/${encodeURIComponent(pool)}/ohlcv/minute` +
      `?aggregate=${aggregate}&limit=${limit}`;
    const r = await fetch(url, {
      headers: { accept: "application/json", "User-Agent": "degen-radar/0.1" },
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) { stats.misses++; cache.set(pool, { t: Date.now(), candles: [] }); return []; }
    const js = await r.json();
    const list = js?.data?.attributes?.ohlcv_list || [];
    const candles = list
      .map(([ts, o, h, l, c, v]) => ({ ts, o: +o, h: +h, l: +l, c: +c, v: +v }))
      .filter((x) => isFinite(x.c) && x.c > 0)
      .sort((a, b) => a.ts - b.ts);
    cache.set(pool, { t: Date.now(), candles });
    return candles;
  } catch {
    stats.errors++;
    return [];
  }
}

/** Fetch for many pools, paced under the free-tier limit. */
export async function getMany(pools, opts = {}) {
  const out = new Map();
  for (const p of pools) {
    out.set(p, await getCandles(p, opts));
    await sleep(120); // ~8/s worst case, comfortably under 30/min sustained
  }
  return out;
}

/**
 * Structure derived from candles. Everything here is MEASURED - if there are
 * too few candles the field is null rather than a guess.
 */
export function analyse(candles) {
  if (!candles || candles.length < 4) return null;
  const closes = candles.map((c) => c.c);
  const n = closes.length;

  // Realised volatility: stdev of log returns, scaled to a 60-minute horizon.
  const rets = [];
  for (let i = 1; i < n; i++) if (closes[i - 1] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const varr = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length || 1);
  const perCandle = Math.sqrt(varr);
  const barMinutes = candles.length > 1 ? (candles[1].ts - candles[0].ts) / 60 : 15;
  const realisedVol60 = perCandle * Math.sqrt(60 / barMinutes) * 100; // % over 60m

  // Structure: are lows rising? That is the difference between a trend and a
  // spike that has not finished unwinding yet.
  let higherLows = 0, lowerHighs = 0;
  for (let i = 1; i < n; i++) {
    if (candles[i].l > candles[i - 1].l) higherLows++;
    if (candles[i].h < candles[i - 1].h) lowerHighs++;
  }

  // Deepest pullback inside the window - shallow pullbacks mean holders are
  // absorbing supply rather than fleeing it.
  let peak = closes[0], maxDD = 0;
  for (const c of closes) { peak = Math.max(peak, c); maxDD = Math.max(maxDD, (peak - c) / peak); }

  // Is volume sustaining or was it one candle?
  const vols = candles.map((c) => c.v);
  const recentVol = vols.slice(-Math.ceil(n / 3)).reduce((a, b) => a + b, 0);
  const earlyVol = vols.slice(0, Math.ceil(n / 3)).reduce((a, b) => a + b, 0);
  const volTrend = earlyVol > 0 ? recentVol / earlyVol : null;
  const volConcentration = Math.max(...vols) / (vols.reduce((a, b) => a + b, 0) || 1);

  return {
    bars: n,
    barMinutes,
    realised_vol_60m_pct: Math.round(realisedVol60 * 10) / 10,
    higher_lows_ratio: Math.round((higherLows / (n - 1)) * 100) / 100,
    lower_highs_ratio: Math.round((lowerHighs / (n - 1)) * 100) / 100,
    max_drawdown_pct: Math.round(maxDD * 1000) / 10,
    vol_trend: volTrend == null ? null : Math.round(volTrend * 100) / 100,
    // 1.0 means every unit of volume came from a single bar - a one-candle pump
    vol_concentration: Math.round(volConcentration * 100) / 100,
    window_return_pct: Math.round(((closes[n - 1] - closes[0]) / closes[0]) * 1000) / 10,
    closes,
  };
}
