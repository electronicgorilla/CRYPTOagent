// Composite score = weighted positive pillars, discounted by a risk cut.
// Pillars 0..100: attention, momentum, liquidityHealth, risk (higher = worse).
// All weights come from config.json.

function wsum(weights, values) {
  let tot = Object.values(weights).reduce((a, b) => a + b, 0) || 1;
  let s = 0;
  for (const [k, w] of Object.entries(weights)) {
    const v = values[k];
    if (v == null) { tot -= w; continue; } // drop missing, renormalise
    s += w * v;
  }
  return tot > 0 ? s / tot : 0;
}

export function scoreToken(feat, cfg, compositeWeights = null) {
  const w = cfg.weights;
  const n = feat.n, nr = feat.nRisk;

  let attention = wsum(w.attention, {
    boost: n.boost, profileRecency: n.profileRecency,
    socialsQuality: n.socialsQuality, txnVelocity: n.txnVelocity,
  });
  const socialBits = ["socialAccel", "socialReach", "socialQuality", "kol"]
    .map((k) => n[k]).filter((v) => v != null);
  if (socialBits.length)
    attention = 0.45 * attention + 0.55 * (socialBits.reduce((a, b) => a + b, 0) / socialBits.length);

  const momentum = wsum(w.momentum, {
    priceM5: n.priceM5, priceH1: n.priceH1, priceH6: n.priceH6, volumeAccel: n.volumeAccel,
  });
  const liqHealth = wsum(w.liquidityHealth, {
    liqMcapRatio: n.liqMcapRatio, turnover: n.turnover, liquidityAbs: n.liquidityAbs,
  });
  const risk = wsum(w.risk, {
    rugcheck: nr.rugcheck, lpLocked: nr.lpLocked,
    mintAuthority: nr.mintAuthority, freezeAuthority: nr.freezeAuthority,
  });

  // FOMO is a first-class pillar, not a decoration: in this market the crowd's
  // emotional state IS the mechanism, and the mechanics only set how violently
  // it expresses itself. A null (no cohort context yet) renormalises the
  // remaining pillars rather than scoring a zero.
  const fomo = feat.fomo ? feat.fomo.fomo : null;

  const cw = compositeWeights || w.composite;
  const pillars = [
    ["attention", attention], ["momentum", momentum],
    ["liquidityHealth", liqHealth], ["fomo", fomo],
  ];
  let acc = 0, cwt = 0;
  for (const [k, v] of pillars) {
    const weight = cw[k];
    if (v == null || !weight) continue;
    acc += weight * v; cwt += weight;
  }
  const baseScore = cwt ? acc / cwt : 0;

  let composite = baseScore * (1 - w.riskCutMax * risk);
  if (feat.kolExit) composite *= 0.6;
  composite *= 100;

  const th = cfg.thresholds;
  const rnorm = feat.riskRaw?.norm;
  const hardAvoid = rnorm != null && rnorm >= th.hardAvoidRugcheckNorm;
  let verdict;
  if (hardAvoid) { composite = Math.min(composite, 22); verdict = "AVOID"; }
  else if (composite >= th.strong) verdict = "STRONG";
  else if (composite >= th.watch) verdict = "WATCH";
  else verdict = "NEUTRAL";

  const round1 = (x) => Math.round(x * 10) / 10;
  const components = {};
  for (const [k, v] of Object.entries(n)) if (v != null) components[k] = Math.round(v * 1000) / 1000;
  for (const [k, v] of Object.entries(nr)) components["risk_" + k] = Math.round(v * 1000) / 1000;

  return {
    composite: round1(composite),
    attention: round1(attention * 100),
    momentum: round1(momentum * 100),
    liquidityHealth: round1(liqHealth * 100),
    fomo: fomo == null ? null : round1(fomo * 100),
    risk: round1(risk * 100),
    verdict, hardAvoid, components,
  };
}


/**
 * Assign verdicts across a whole scan.
 *
 * Absolute thresholds were the reason this system logged 77 predictions and
 * ZERO directional calls: a fixed "STRONG >= 76" never fires once the score
 * distribution sits lower than the guess that set it, so the ledger fills with
 * passes and the curation loop has nothing to learn from. A system that never
 * commits cannot be measured, and cannot improve.
 *
 * Percentile thresholds self-calibrate: the top slice of each cohort gets a
 * directional call regardless of where the distribution sits. `absoluteFloor`
 * is the safety valve - in a genuinely bad field, the best of a bad lot still
 * does not earn a long.
 */
export function assignVerdicts(rows, cfg) {
  const th = cfg.thresholds;
  if (th.mode !== "percentile") return rows;

  const sorted = [...rows].sort((a, b) => a.score.composite - b.score.composite);
  const n = sorted.length || 1;
  const rank = new Map();
  sorted.forEach((r, i) => rank.set(r, n === 1 ? 1 : i / (n - 1)));

  for (const r of rows) {
    const p = rank.get(r);
    const c = r.score.composite;
    r.score.percentile = Math.round(p * 100);
    if (r.score.hardAvoid) { r.score.verdict = "AVOID"; continue; }
    if (p >= th.strongPercentile && c >= th.absoluteFloor) r.score.verdict = "STRONG";
    else if (p >= th.watchPercentile && c >= th.absoluteFloor * 0.75) r.score.verdict = "WATCH";
    else r.score.verdict = "NEUTRAL";
  }
  return rows;
}
