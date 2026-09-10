// AURA POINTS - will this still be running in two to three hours?
//
// This is a DIFFERENT question from the rest of the system, and the distinction
// is the whole point:
//
//   FOMO  = ignition. Will the crowd arrive in the next few minutes?
//   AURA  = fuel.     Will it still be burning in two to three hours?
//
// The two come apart constantly, and that is what makes the pair useful. A
// token can carry high FOMO and low Aura - a spike about to exhaust itself,
// which is exactly the thing that fills a scorecard with confident losses. Or
// low FOMO and high Aura: grinding quietly, no crowd yet, structure intact.
// Ranking on FOMO alone systematically buys the first kind.
//
// Aura is scored from CANDLE STRUCTURE (via ohlcv.mjs) rather than from the
// summary windows DEX Screener reports, because durability is a question about
// shape over time, and a single 6-hour percentage cannot express shape.
//
// Seven components, each answering "does this run have fuel left":
//   1. Trend alignment      - do the timeframes agree, or is this one spike?
//   2. Structure            - are lows rising (absorption) or is it retracing?
//   3. Pullback discipline  - shallow dips mean holders are buying them
//   4. Volume sustain       - is volume building or was it one candle?
//   5. Participation growth - are more wallets arriving, or the same few?
//   6. Attention headroom   - saturated means no fuel left to recruit
//   7. Age band             - past the launch chaos, short of exhaustion
//
// Anything requiring candles we do not have returns null and renormalises. Aura
// is deliberately unavailable rather than guessed.

const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const num = (v) => (typeof v === "number" && isFinite(v) ? v : 0);

export const HORIZON_MINUTES = 180; // the question is explicitly 2-3 hours

export function computeAura(feat, candleStats) {
  const pc = feat.priceChange || {};
  const parts = {};
  const notes = [];

  // --- 1. trend alignment across timeframes ---
  // A real trend shows the same sign at 1h and 6h. Disagreement means the move
  // is either brand new or already unwinding.
  const h1 = num(pc.h1), h6 = num(pc.h6), h24 = num(pc.h24);
  const agree = (h1 > 0 ? 1 : -1) === (h6 > 0 ? 1 : -1);
  const alignMag = clamp((Math.min(Math.abs(h1), Math.abs(h6)) - 2) / 40);
  parts.trendAlignment = agree && h6 > 0 ? clamp(0.35 + alignMag * 0.65) : agree && h6 < 0 ? 0.05 : 0.25;
  if (agree && h6 > 0) notes.push(`1h and 6h both positive (${h1.toFixed(0)}% / ${h6.toFixed(0)}%) — timeframes agree`);
  else if (!agree) notes.push(`1h and 6h disagree (${h1.toFixed(0)}% vs ${h6.toFixed(0)}%) — the move is not settled`);

  // --- 2-4. structure, from candles ---
  if (candleStats) {
    parts.structure = clamp(candleStats.higher_lows_ratio * 1.4);
    if (candleStats.higher_lows_ratio >= 0.55)
      notes.push(`${Math.round(candleStats.higher_lows_ratio * 100)}% of bars made higher lows — supply is being absorbed`);
    else if (candleStats.lower_highs_ratio >= 0.55)
      notes.push(`${Math.round(candleStats.lower_highs_ratio * 100)}% of bars made lower highs — distribution, not accumulation`);

    // A shallow pullback inside a run means dips are being bought.
    parts.pullback = clamp(1 - candleStats.max_drawdown_pct / 45);
    if (candleStats.max_drawdown_pct > 40)
      notes.push(`${candleStats.max_drawdown_pct.toFixed(0)}% deepest pullback in-window — holders are not defending it`);

    // Volume building beats volume fading; one dominant candle is a red flag.
    const vt = candleStats.vol_trend;
    parts.volumeSustain = vt == null ? null : clamp(Math.tanh(vt / 1.6));
    if (candleStats.vol_concentration > 0.5)
      notes.push(`${Math.round(candleStats.vol_concentration * 100)}% of window volume came from ONE bar — a spike, not a trend`);
    else if (vt != null && vt > 1.2)
      notes.push(`volume building (${vt.toFixed(1)}x versus the start of the window)`);
  } else {
    parts.structure = null;
    parts.pullback = null;
    parts.volumeSustain = null;
    notes.push("no candles available — structure unscored rather than assumed");
  }

  // --- 5. participation growth ---
  // Rising transaction count across widening windows means new wallets, not the
  // same handful recycling.
  const tx = feat.txns || {};
  const rate1h = num(tx.h1);
  const rate6h = num(tx.h6) / 6;
  const growth = rate6h > 0 ? rate1h / rate6h : 0;
  parts.participation = clamp(Math.tanh(Math.max(0, growth - 0.8) / 1.2));
  if (growth > 1.4) notes.push(`transactions running ${growth.toFixed(1)}x the 6h pace — participation still widening`);
  else if (growth < 0.6 && growth > 0) notes.push(`transactions at ${growth.toFixed(1)}x the 6h pace — the crowd is leaving`);

  // --- 6. attention headroom (the inverse of FOMO's saturation term) ---
  // Fuel is unrecruited attention. Saturated means everyone who was going to
  // hear about it already has.
  const sat = feat.fomo?.saturation;
  parts.headroom = sat == null ? null : clamp(1 - Math.log10(1 + sat) / Math.log10(1 + 25));
  if (sat != null && sat > 8) notes.push(`attention already ${sat.toFixed(1)}x tier median — little recruitment left`);

  // --- 7. age band ---
  const ageH = num(feat.ageH);
  parts.ageBand = ageH < 0.5 ? 0.2 : ageH < 2 ? 0.7 : ageH < 24 ? 1 : ageH < 72 ? 0.7 : 0.35;
  if (ageH < 0.5) notes.push("under 30 minutes old — too early to call a trend durable");
  else if (ageH > 72) notes.push(`${(ageH / 24).toFixed(1)} days old — most of the story is behind it`);

  const W = {
    trendAlignment: 0.22, structure: 0.20, pullback: 0.13,
    volumeSustain: 0.16, participation: 0.15, headroom: 0.09, ageBand: 0.05,
  };
  let acc = 0, wsum = 0;
  for (const [k, w] of Object.entries(W)) {
    if (parts[k] == null) continue;
    acc += parts[k] * w; wsum += w;
  }
  const raw = wsum ? acc / wsum : 0;

  // Macro gates durability harder than it gates ignition: a bleeding chain does
  // not sustain three-hour trends in anything.
  const macroMult = feat.fomo?.macro?.multiplier ?? 1;
  const aura = clamp(raw * (0.7 + 0.3 * macroMult));

  const points = Math.round(aura * 100);
  return {
    points,
    band: points >= 70 ? "enduring" : points >= 50 ? "holding" : points >= 30 ? "fading" : "spent",
    horizon_minutes: HORIZON_MINUTES,
    components: Object.fromEntries(
      Object.entries(parts).map(([k, v]) => [k, v == null ? null : Math.round(v * 100)])
    ),
    coverage: wsum ? Math.round((wsum / Object.values(W).reduce((a, b) => a + b, 0)) * 100) : 0,
    realised_vol_60m_pct: candleStats?.realised_vol_60m_pct ?? null,
    notes: notes.slice(0, 4),
  };
}

/**
 * Aura as a gradeable prediction: "still trending in 3 hours".
 * Only tokens with real fuel make a claim; the rest decline.
 */
export function auraPrediction(feat, aura) {
  if (!aura || aura.coverage < 50) return null;
  const call = aura.points >= 65 ? "long" : aura.points <= 25 ? "avoid" : "pass";
  if (call === "pass") return null;
  return {
    call,
    predicted_direction: call === "long" ? "up" : "down",
    horizon_minutes: HORIZON_MINUTES,
    conviction: Math.round(Math.abs(aura.points - 50) / 50 * 100) / 100,
    invalidation_pct: call === "long" ? -30 : 30,
    reasoning: aura.notes.slice(0, 2).join("; ") || `aura ${aura.points} (${aura.band})`,
    key_risk: aura.realised_vol_60m_pct
      ? `realised vol ${aura.realised_vol_60m_pct.toFixed(0)}%/hr — a 3h hold sits through several of those`
      : "three hours is a long time in this market",
  };
}
