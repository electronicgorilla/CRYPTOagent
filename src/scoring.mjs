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

export function scoreToken(feat, cfg) {
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

  const cw = w.composite;
  const cwt = cw.attention + cw.momentum + cw.liquidityHealth || 1;
  const baseScore =
    (cw.attention * attention + cw.momentum * momentum + cw.liquidityHealth * liqHealth) / cwt;

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
    risk: round1(risk * 100),
    verdict, hardAvoid, components,
  };
}
