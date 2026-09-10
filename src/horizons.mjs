// THE HORIZON BOARD - one read per timescale, because they are different questions.
//
// A single "best token" list is incoherent: the thing most likely to move in the
// next eight minutes is rarely the thing most likely to survive the week, and
// merging them produces a ranking that answers neither question.
//
//   FLASH    5-10 min   ignition. Order flow and acceleration right now.
//   SESSION  1-5 hours  durability. Aura, structure, whether the trend has fuel.
//   POSITION 1-10 days  survival. A SCREEN, not a forecast - see the warning.
//
// A NOTE ON THE LONG HORIZON, stated plainly because it would be dishonest to
// present three tiers as equally solid. This system has no validated multi-day
// signal. Its longest graded horizon is six hours, and the assets involved are
// sub-$10M memecoins, most of which do not exist in ten days. So POSITION does
// not forecast returns. It screens for the handful of traits that correlate
// with still being tradeable later - real liquidity depth, a locked pool, age
// past the launch window, low rug pressure - and it is labelled a screen
// wherever it appears. Treating it as a prediction would be inventing
// confidence the data does not support.
//
// Everything here is logged to the ledger at its own horizon, so each tier
// accumulates its own track record and the board can eventually say which of
// its three voices is worth listening to.
import { HORIZON_MINUTES as AURA_H } from "./aura.mjs";

const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const num = (v) => (typeof v === "number" && isFinite(v) ? v : 0);

export const HORIZONS = [
  { id: "flash",    label: "5–10 minutes", horizonMinutes: 15,    kind: "forecast" },
  { id: "session",  label: "1–5 hours",    horizonMinutes: 360,   kind: "forecast" },
  { id: "position", label: "1–10 days",    horizonMinutes: 14400, kind: "screen" },
];

/** Ignition: what is moving RIGHT NOW and still has somewhere to go. */
function flashScore(t) {
  const f = t.feat, fo = f.fomo, why = [];
  const m5 = num(f.priceChange?.m5), accel = num(f.volAccel);
  const flow = num(f.buyRatioH1);

  const parts = {
    velocity: fo ? num(fo.components?.gainVelocity) : clamp(m5 / 8),
    accel: clamp(Math.tanh(Math.max(0, accel - 1) / 1.3)),
    flow: clamp((flow - 0.45) / 0.2),
    crowd: fo ? num(fo.fomo) : 0,
    // Ignition dies instantly in a pool that cannot absorb a buy.
    depth: clamp(Math.log10(Math.max(1, num(f.liqUsd))) / Math.log10(200000)),
  };
  const W = { velocity: 0.28, accel: 0.24, flow: 0.16, crowd: 0.24, depth: 0.08 };
  let s = 0; for (const [k, w] of Object.entries(W)) s += parts[k] * w;

  if (m5 > 2) why.push(`+${m5.toFixed(1)}% in the last 5 minutes`);
  if (accel > 1.3) why.push(`volume ${accel.toFixed(1)}× its prior-window rate`);
  if (flow > 0.58) why.push(`${(flow * 100).toFixed(0)}% of 1h transactions are buys`);
  if (fo?.reasons?.length) why.push(fo.reasons[0]);

  // Rug pressure is disqualifying at this timescale: you would be buying the
  // exact moment the pool is most attractive to pull.
  const rug = t.rug?.pressure ?? 0;
  return { score: clamp(s) * (rug >= 60 ? 0.35 : 1), why: why.slice(0, 3), penalised: rug >= 60 };
}

/** Durability: does the trend have fuel for the session? Aura already asks this. */
function sessionScore(t) {
  const au = t.aura, why = [];
  if (!au || au.coverage < 50) return { score: 0, why: ["insufficient candle coverage to judge durability"], thin: true };
  const rug = t.rug?.pressure ?? 0;
  const s = clamp(au.points / 100) * (rug >= 60 ? 0.4 : 1);
  why.push(...(au.notes || []).slice(0, 3));
  return { score: s, why, penalised: rug >= 60 };
}

/** Survival screen. Explicitly not a return forecast. */
function positionScore(t) {
  const f = t.feat, why = [];
  const liq = num(f.liqUsd), ageH = num(f.ageH), lm = num(f.liqMcapRatio);
  const nr = f.nRisk || {};

  const parts = {
    // Depth is the single best predictor of still being tradeable later.
    depth: clamp(Math.log10(Math.max(1, liq)) / Math.log10(500000)),
    ratio: clamp(lm / 0.15),
    survived: ageH < 24 ? 0.15 : ageH < 72 ? 0.5 : ageH < 336 ? 0.9 : 1,
    safety: clamp(1 - (num(nr.lpLocked) + num(nr.mintAuthority) + num(nr.freezeAuthority)) / 2.15),
    calm: clamp(1 - (t.rug?.pressure ?? 50) / 100),
  };
  const W = { depth: 0.30, ratio: 0.18, survived: 0.26, safety: 0.18, calm: 0.08 };
  let s = 0; for (const [k, w] of Object.entries(W)) s += parts[k] * w;

  if (ageH > 72) why.push(`has survived ${(ageH / 24).toFixed(1)} days — most do not`);
  else why.push(`only ${ageH.toFixed(1)}h old — far too young to judge on this timescale`);
  if (liq > 100000) why.push(`$${Math.round(liq).toLocaleString()} liquidity — deep enough to exit`);
  if (lm > 0.1) why.push(`liquidity is ${(lm * 100).toFixed(0)}% of market cap`);
  if (nr.lpLocked === 0) why.push("LP confirmed locked");

  return { score: clamp(s), why: why.slice(0, 3) };
}

const SCORERS = { flash: flashScore, session: sessionScore, position: positionScore };

/**
 * Build the board. Returns one entry per horizon (or null when nothing clears
 * the bar — an empty tier is a real answer and better than a filler pick).
 */
export function buildBoard(tokens, { minScore = 0.42 } = {}) {
  const out = [];
  for (const h of HORIZONS) {
    const ranked = tokens
      .map((t) => ({ t, ...SCORERS[h.id](t) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);

    const top = ranked[0];
    const picks = ranked.filter((x) => x.score >= minScore).slice(0, 3).map((x) => ({
      symbol: x.t.feat.symbol,
      name: x.t.feat.name,
      mint: x.t.feat.mint,
      url: x.t.feat.url,
      score: Math.round(x.score * 100),
      price: x.t.feat.priceUsd,
      mcap: x.t.feat.mcap,
      liq: x.t.feat.liqUsd,
      rug: x.t.rug?.pressure ?? null,
      why: x.why,
      penalised: !!x.penalised,
    }));

    out.push({
      ...h,
      picks,
      // An honest empty tier rather than promoting the least-bad candidate.
      empty: picks.length === 0,
      best_rejected: picks.length === 0 && top
        ? { symbol: top.t.feat.symbol, score: Math.round(top.score * 100) } : null,
    });
  }
  return { ts: Date.now() / 1000, horizons: out };
}
