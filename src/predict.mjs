// The prediction engine.
//
// Two sources shaped this file, and both are load-bearing rather than flavour.
//
// THE METHOD (Patrick Jane, from the scripts):
//   "Jane lets that hang, forcing Kurtik to step toward him, or risk appearing
//    to back off."                                        - 1x03, Red Tide
//   He does not wait for evidence to arrive. He applies pressure that FORCES a
//   reaction, and the reaction is the data. Here, the forecast is the pressure:
//   we commit to a falsifiable claim before anyone asks, and the market answers.
//
//   "He watched you hide the keys." / "From the men's room? Now that would be
//    a trick."                                            - 1x03, Red Tide
//   He refuses the mystical explanation. Every apparently uncanny read is
//   mundane observation stated in order. So no score here is unexplainable:
//   each prediction carries the chain of observations that produced it, and if
//   the chain cannot be written down, the prediction is not made.
//
// THE TECHNIQUE (bootstrapped ranking, from the LLM-ranking diagram):
//   Ranking a candidate list is unstable - under one fixed set of weights the
//   top of the list can be an artifact of the weights rather than the data. So
//   the ranking is run MANY times under perturbed weights and the rank
//   DISTRIBUTION is reported, not a point rank. A token that sits top-3 in 95%
//   of bootstraps is a real signal; one that does so in 30% is noise wearing a
//   number. When the LLM panel runs, the same trick handles position bias by
//   shuffling the candidate order per pass.
//
// WHAT IS ACTUALLY PREDICTED:
//   Direction is the obvious target and the weak one - over an hour, a memecoin's
//   direction is close to a coin flip. VOLATILITY is the tractable target: the
//   SIZE of the coming move is far more forecastable than its sign, and it is
//   what position sizing actually needs. So every forecast carries an expected
//   move band, and the ledger grades whether reality landed inside it.
import { scoreToken } from "./scoring.mjs";

const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const med = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const q = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

// Deterministic RNG so a scan is reproducible - a prediction you cannot
// reproduce is a prediction you cannot debug.
function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
}

/**
 * Re-rank the cohort under perturbed pillar weights, N times.
 * Returns per-mint rank statistics.
 */
export function bootstrapRanks(rows, cfg, { passes = 200, jitter = 0.35, seed = 42 } = {}) {
  const rand = rng(seed);
  const base = cfg.weights.composite;
  const keys = Object.keys(base);
  const ranksOf = new Map(rows.map((r) => [r.feat.mint, []]));
  const scoresOf = new Map(rows.map((r) => [r.feat.mint, []]));

  for (let p = 0; p < passes; p++) {
    // multiplicative jitter, renormalised - explores "what if I had weighted
    // this differently", which is the actual uncertainty in a hand-set model
    const w = {};
    let tot = 0;
    for (const k of keys) {
      w[k] = Math.max(0.01, base[k] * (1 + (rand() * 2 - 1) * jitter));
      tot += w[k];
    }
    for (const k of keys) w[k] /= tot;

    const scored = rows.map((r) => ({ mint: r.feat.mint, s: scoreToken(r.feat, cfg, w).composite }));
    scored.sort((a, b) => b.s - a.s);
    scored.forEach((x, i) => {
      ranksOf.get(x.mint).push(i + 1);
      scoresOf.get(x.mint).push(x.s);
    });
  }

  const out = new Map();
  for (const r of rows) {
    const rk = ranksOf.get(r.feat.mint);
    const sc = scoresOf.get(r.feat.mint);
    out.set(r.feat.mint, {
      median_rank: med(rk),
      rank_p10: q(rk, 0.1),
      rank_p90: q(rk, 0.9),
      // The headline stability number: how often does this survive re-weighting?
      p_top3: rk.filter((x) => x <= 3).length / rk.length,
      p_top5: rk.filter((x) => x <= 5).length / rk.length,
      score_p10: Math.round(q(sc, 0.1) * 10) / 10,
      score_p90: Math.round(q(sc, 0.9) * 10) / 10,
      passes: rk.length,
    });
  }
  return out;
}

/**
 * Expected absolute move over the horizon.
 *
 * Anchored on what the cohort's OWN tier actually did this hour, then adjusted
 * by the token's turnover, volume acceleration and age. No fitted constants
 * pretending to be physics - the fat-tail multiplier is an explicit prior that
 * the ledger recalibrates as forecasts get graded.
 */
export function forecastVolatility(feat, rows, horizonMinutes = 60) {
  const tier = tierOf(feat.mcap);
  const peers = rows.filter((r) => tierOf(r.feat.mcap) === tier);
  const peerAbs = peers.map((r) => Math.abs(r.feat.priceChange?.h1 || 0)).filter((x) => x > 0);
  // fall back to the whole cohort when a tier is thin
  const anchorPool = peerAbs.length >= 4
    ? peerAbs
    : rows.map((r) => Math.abs(r.feat.priceChange?.h1 || 0)).filter((x) => x > 0);
  const anchor = med(anchorPool) ?? 15;

  const tierMedTurnover = med(peers.map((r) => r.feat.turnoverH1 || 0)) || 0.2;
  const turnoverAdj = clamp(Math.sqrt((feat.turnoverH1 || 0) / Math.max(tierMedTurnover, 0.01)), 0.5, 2.5);
  const accelAdj = clamp(0.8 + 0.35 * Math.log10(1 + Math.max(0, feat.volAccel || 0)), 0.7, 1.8);
  // A pool minutes old has no price memory and moves violently.
  const ageAdj = feat.ageH < 2 ? 1.6 : feat.ageH < 12 ? 1.2 : feat.ageH < 72 ? 1.0 : 0.85;

  // volatility scales roughly with sqrt(time) - explicit, so it can be argued with
  const timeAdj = Math.sqrt(horizonMinutes / 60);

  const p50 = anchor * turnoverAdj * accelAdj * ageAdj * timeAdj;
  // Fat-tail multiplier. A NORMAL distribution would put p90 at ~2.1x the
  // median absolute move; memecoin returns are far heavier, so this starts at
  // 3.0 and is the first thing the ledger should recalibrate.
  const p90 = p50 * 3.0;

  return {
    horizon_minutes: horizonMinutes,
    expected_move_p50: Math.round(p50 * 10) / 10,
    expected_move_p90: Math.round(p90 * 10) / 10,
    anchor_pct: Math.round(anchor * 10) / 10,
    tier,
    adjustments: {
      turnover: Math.round(turnoverAdj * 100) / 100,
      accel: Math.round(accelAdj * 100) / 100,
      age: ageAdj,
    },
  };
}

function tierOf(mcap) {
  if (!mcap) return "unknown";
  if (mcap < 100_000) return "<100k";
  if (mcap < 1_000_000) return "100k-1M";
  if (mcap < 10_000_000) return "1M-10M";
  return ">10M";
}

/**
 * The full read on one token: direction, size, stability, and the chain of
 * observations behind it. Stated flatly first, explained second.
 */
export function predict(row, rows, stability, cfg, horizonMinutes = 60) {
  const { feat: f, score: s } = row;
  const vol = forecastVolatility(f, rows, horizonMinutes);
  const st = stability.get(f.mint) || {};
  const fo = f.fomo;

  // Direction. Deliberately conservative: over an hour this is near a coin
  // flip, and pretending otherwise is how a scorecard fills with confident
  // wrong answers. Only a genuinely lopsided read earns a directional call.
  const bull =
    0.4 * (fo ? fo.fomo : 0.4) +
    0.25 * clamp((s.momentum || 0) / 100) +
    0.2 * clamp((f.buyRatioH1 - 0.45) / 0.2) +
    0.15 * clamp((s.liquidityHealth || 0) / 100);
  const risk = clamp((s.risk || 0) / 100);
  const pUp = clamp(0.5 + (bull - 0.5) * 0.75 - risk * 0.15, 0.1, 0.9);

  // Stability gates the call. A top rank that only survives a third of the
  // re-weightings is the weights talking, not the token.
  const stable = (st.p_top5 ?? 0) >= 0.5;
  const call = !stable ? "pass" : pUp >= 0.6 ? "long" : pUp <= 0.4 ? "avoid" : "pass";
  const direction = call === "long" ? "up" : call === "avoid" ? "down" : "flat";

  // The observation chain. If this list is empty, we do not have a read - and
  // saying so is the honest output, not a number.
  const chain = [];
  if (fo?.reasons?.length) chain.push(...fo.reasons);
  if (f.buyRatioH1 > 0.58) chain.push(`1h flow ${(f.buyRatioH1 * 100).toFixed(0)}% buys`);
  else if (f.buyRatioH1 < 0.42) chain.push(`1h flow ${((1 - f.buyRatioH1) * 100).toFixed(0)}% sells`);
  if (f.volAccel > 1.3) chain.push(`volume ${f.volAccel.toFixed(1)}x its prior-window rate`);
  if (st.p_top5 != null)
    chain.push(`survives re-weighting in ${(st.p_top5 * 100).toFixed(0)}% of ${st.passes} bootstraps (median rank ${st.median_rank})`);
  if (s.risk > 45) chain.push(`elevated contract risk (${s.risk.toFixed(0)}/100)`);
  if (vol.adjustments.age > 1.2) chain.push(`young pool — expect wider swings`);

  return {
    call,
    predicted_direction: direction,
    horizon_minutes: horizonMinutes,
    // Conviction is distance from a coin flip, damped by rank instability.
    conviction: Math.round(clamp(Math.abs(pUp - 0.5) * 2 * (stable ? 1 : 0.5), 0.05, 0.95) * 100) / 100,
    p_up: Math.round(pUp * 100) / 100,
    invalidation_pct: call === "avoid" ? vol.expected_move_p50 : -vol.expected_move_p50,
    reasoning: chain.length
      ? chain.slice(0, 3).join("; ")
      : "no observable driver — declining to read this one",
    key_risk: s.risk > 45 ? "contract risk unresolved" : `a ${vol.expected_move_p90.toFixed(0)}% swing is within the expected tail`,
    volatility: vol,
    stability: st,
    chain,
  };
}

/** Run the engine over a whole scan. */
export function runPredictions(rows, cfg) {
  const horizon = cfg.predict?.horizonMinutes ?? 60;
  const stability = bootstrapRanks(rows, cfg, {
    passes: cfg.predict?.bootstrapPasses ?? 200,
    jitter: cfg.predict?.weightJitter ?? 0.35,
  });
  for (const r of rows) {
    r.stability = stability.get(r.feat.mint);
    r.prediction = predict(r, rows, stability, cfg, horizon);
  }
  return { stability, horizon };
}
