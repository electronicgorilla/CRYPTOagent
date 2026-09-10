// Outcome grader. Revisits every prediction whose horizon has elapsed, prices
// it, and marks it hit or miss. Runs on every scan - it is cheap (one batched
// DEX Screener call) and costs nothing in API tokens.
//
// Without this file the agents are astrology.
import * as ledger from "./ledger.mjs";
import * as store from "./store.mjs";

const BASE = "https://api.dexscreener.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pricesFor(mints) {
  const out = new Map();
  for (let i = 0; i < mints.length; i += 30) {
    const chunk = mints.slice(i, i + 30);
    try {
      const r = await fetch(`${BASE}/latest/dex/tokens/${chunk.join(",")}`, {
        headers: { "User-Agent": "degen-radar/0.1" },
        signal: AbortSignal.timeout(12000),
      });
      const js = r.ok ? await r.json() : null;
      for (const p of js?.pairs || []) {
        if (p.chainId !== "solana") continue;
        const addr = p.baseToken?.address;
        const liq = p.liquidity?.usd || 0;
        const cur = out.get(addr);
        if (!cur || liq > cur.liq) out.set(addr, { price: Number(p.priceUsd || 0), liq });
      }
    } catch {
      /* leave missing - handled as `dead` below */
    }
    await sleep(300);
  }
  return out;
}

/**
 * Max favourable / adverse excursion inside the horizon, reconstructed from the
 * per-token price history the scanner already writes each scan.
 */
function excursion(mint, entryPrice, fromTs, toTs) {
  if (!entryPrice) return { mfe: null, mae: null, samples: 0 };
  const pts = store
    .history(mint)
    .filter((h) => h.ts >= fromTs && h.ts <= toTs && h.price > 0)
    .map((h) => ((h.price - entryPrice) / entryPrice) * 100);
  if (!pts.length) return { mfe: null, mae: null, samples: 0 };
  return {
    mfe: Math.round(Math.max(...pts) * 10) / 10,
    mae: Math.round(Math.min(...pts) * 10) / 10,
    samples: pts.length,
  };
}

const realisedDirection = (pct, horizonMinutes) => {
  const band = ledger.flatBandFor(horizonMinutes);
  return pct > band ? "up" : pct < -band ? "down" : "flat";
};

export async function gradeDue({ verbose = true } = {}) {
  const rows = ledger.due();
  if (!rows.length) return { graded: 0 };

  const prices = await pricesFor([...new Set(rows.map((r) => r.mint))]);
  const outcomes = [];

  for (const r of rows) {
    const now = Date.now() / 1000;
    const p = prices.get(r.mint);
    const horizonEnd = r.ts + r.horizon_minutes * 60;

    // No pair, no price, or liquidity gone => treat as a total loss, which is
    // the honest outcome for a memecoin that stopped trading.
    const dead = !p || !p.price || p.liq < Math.max(1000, r.entry_liq * 0.15);
    const exitPrice = dead ? 0 : p.price;
    const returnPct = r.entry_price
      ? dead
        ? -100
        : ((exitPrice - r.entry_price) / r.entry_price) * 100
      : 0;

    const { mfe, mae, samples } = excursion(r.mint, r.entry_price, r.ts, horizonEnd);
    const realised = realisedDirection(returnPct, r.horizon_minutes);
    const correct = r.predicted_direction === realised;

    // Did the agent's own stated invalidation level get hit inside the horizon?
    const inv = r.invalidation_pct;
    const invalidated =
      mae != null && inv != null ? (inv < 0 ? mae <= inv : mfe != null && mfe >= inv) : null;

    outcomes.push({
      id: r.id,
      outcome: {
        graded_at: now,
        exit_price: exitPrice,
        exit_liq: dead ? 0 : p.liq,
        return_pct: Math.round(returnPct * 10) / 10,
        realised_direction: realised,
        // Size, graded separately from sign. Direction over an hour is near a
        // coin flip; the magnitude is the forecastable part and the one that
        // position sizing actually depends on.
        abs_move_pct: Math.round(Math.abs(returnPct) * 10) / 10,
        vol_in_p50: r.volatility ? Math.abs(returnPct) <= r.volatility.expected_move_p50 : null,
        vol_in_p90: r.volatility ? Math.abs(returnPct) <= r.volatility.expected_move_p90 : null,
        flat_band_pct: ledger.flatBandFor(r.horizon_minutes),
        correct,
        invalidated,
        mfe_pct: mfe,
        mae_pct: mae,
        samples,
        dead,
      },
    });
  }

  const n = ledger.applyOutcomes(outcomes);
  if (verbose) {
    const hits = outcomes.filter((o) => o.outcome.correct).length;
    console.log(`[grader] graded ${n} predictions (${hits} correct)`);
  }
  return { graded: n };
}
