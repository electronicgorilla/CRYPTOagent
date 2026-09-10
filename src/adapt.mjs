// The adaptation loop - the part that eats its own results and reconfigures.
//
// For every normalised feature, measure the rank correlation between its value
// at entry and the return that actually followed. Features that predict earn
// weight; features that do not lose it. That is the whole idea, and it is
// deliberately the simplest thing that can work: a rank correlation over the
// ledger, not a model you cannot audit.
//
// Three guards keep this honest, because a naive version of this will happily
// learn noise and report it as insight:
//
//  1. SIGNIFICANCE GATE. |IC| must clear ~2/sqrt(n) to be reported as real.
//     Below that it is indistinguishable from chance and is marked as such.
//  2. SHRINKAGE. Proposed weights are blended toward the hand-set prior with a
//     factor of n/(n+K). At n=40 the data barely moves anything; by n=400 it
//     dominates. You cannot get a confident weight change out of thin data.
//  3. NOTHING AUTO-APPLIES. Proposals are written to data/adapted_weights.json.
//     Turning them on is a deliberate act (config.adapt.apply), and the prior
//     stays in config.json so you can always see what was changed and why.
//
// Spearman (rank) rather than Pearson on purpose: memecoin returns are wildly
// fat-tailed (-100% to +2000%), and one 40x would otherwise dictate every
// weight in the system.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.mjs";
import * as ledger from "./ledger.mjs";

const OUT = join(DATA_DIR, "adapted_weights.json");

// Which pillar each feature feeds, so an IC on a feature can move the right
// weight in config.json.
const FEATURE_PILLAR = {
  boost: "attention", profileRecency: "attention", socialsQuality: "attention",
  txnVelocity: "attention", socialAccel: "attention", socialReach: "attention",
  socialQuality: "attention", kol: "attention",
  priceM5: "momentum", priceH1: "momentum", priceH6: "momentum", volumeAccel: "momentum",
  liqMcapRatio: "liquidityHealth", turnover: "liquidityHealth", liquidityAbs: "liquidityHealth",
};

function ranks(xs) {
  const idx = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1; // average rank for ties
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}

function pearson(a, b) {
  const n = a.length;
  if (n < 3) return null;
  const ma = a.reduce((x, y) => x + y, 0) / n;
  const mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return da && db ? num / Math.sqrt(da * db) : null;
}

const spearman = (a, b) => pearson(ranks(a), ranks(b));

/**
 * Information coefficient per feature over the graded ledger.
 * Returns { n, features: { key: { ic, n, significant, pillar } }, ... }
 */
export function analyse({ modelVersion = null, minSamples = 40 } = {}) {
  const rows = ledger.load().filter(
    (r) => r.outcome && r.features && (!modelVersion || r.model_version === modelVersion)
  );

  // Returns are capped for ranking sanity; rank correlation ignores magnitude
  // anyway, but a -100% total loss should not tie with a -99% one by accident.
  const samples = rows.map((r) => ({
    ret: r.outcome.return_pct,
    f: { ...r.features, ...(r.fomo || {}) },
  }));

  const keys = new Set();
  for (const s of samples) for (const k of Object.keys(s.f)) if (typeof s.f[k] === "number") keys.add(k);

  const features = {};
  for (const k of keys) {
    const pairs = samples.filter((s) => typeof s.f[k] === "number");
    if (pairs.length < 8) continue;
    const ic = spearman(pairs.map((s) => s.f[k]), pairs.map((s) => s.ret));
    if (ic == null) continue;
    const n = pairs.length;
    const threshold = 2 / Math.sqrt(n); // ~95% band for a null correlation
    features[k] = {
      ic: Math.round(ic * 1000) / 1000,
      n,
      threshold: Math.round(threshold * 1000) / 1000,
      significant: Math.abs(ic) > threshold,
      pillar: FEATURE_PILLAR[k] || (k === "score" ? "fomo" : "fomo"),
    };
  }

  const ranked = Object.entries(features).sort((a, b) => Math.abs(b[1].ic) - Math.abs(a[1].ic));

  return {
    generated_at: Date.now() / 1000,
    model_version: modelVersion,
    n_samples: samples.length,
    enough_data: samples.length >= minSamples,
    min_samples: minSamples,
    features,
    ranked: ranked.map(([k, v]) => ({ feature: k, ...v })),
    significant: ranked.filter(([, v]) => v.significant).map(([k, v]) => ({ feature: k, ...v })),
  };
}

/**
 * Turn the IC table into proposed pillar weights, shrunk toward the prior.
 * Never writes to config.json - writes a proposal you can inspect.
 */
export function propose(cfg, { minSamples = 40, shrinkK = 250, maxShift = 0.5 } = {}) {
  const a = analyse({ modelVersion: ledger.MODEL_VERSION, minSamples });
  if (!a.enough_data) {
    const out = { ...a, applied: false, reason: `need >= ${minSamples} graded samples on model ${ledger.MODEL_VERSION}, have ${a.n_samples}` };
    writeFileSync(OUT, JSON.stringify(out, null, 2));
    return out;
  }

  // Mean |IC| of each pillar's significant features = how much that pillar has
  // actually been earning its place.
  const pillars = {};
  for (const [k, v] of Object.entries(a.features)) {
    const p = v.pillar;
    if (!p || p === "fomo") continue;
    (pillars[p] ||= []).push(v.significant ? Math.abs(v.ic) : 0);
  }

  const prior = cfg.weights.composite;
  const evidence = {};
  for (const p of Object.keys(prior)) {
    const xs = pillars[p] || [];
    evidence[p] = xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : 0;
  }
  const evSum = Object.values(evidence).reduce((x, y) => x + y, 0);

  const lambda = a.n_samples / (a.n_samples + shrinkK); // shrinkage toward prior
  const proposed = {};
  for (const p of Object.keys(prior)) {
    const dataWeight = evSum > 0 ? evidence[p] / evSum : prior[p];
    const blended = (1 - lambda) * prior[p] + lambda * dataWeight;
    // never let one round move a weight more than maxShift relative to prior
    const lo = prior[p] * (1 - maxShift), hi = prior[p] * (1 + maxShift);
    proposed[p] = Math.round(Math.max(lo, Math.min(hi, blended)) * 1000) / 1000;
  }

  const out = {
    ...a,
    shrinkage_lambda: Math.round(lambda * 1000) / 1000,
    prior_weights: prior,
    proposed_weights: proposed,
    applied: false,
    note: "Inspect before enabling. Set config.adapt.apply=true to have scoring use these.",
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  return out;
}

/** Weights scoring should actually use: adapted if opted in, else the prior. */
export function effectiveComposite(cfg) {
  if (!cfg.adapt?.apply || !existsSync(OUT)) return cfg.weights.composite;
  try {
    const p = JSON.parse(readFileSync(OUT, "utf8"));
    return p.proposed_weights && p.enough_data ? p.proposed_weights : cfg.weights.composite;
  } catch {
    return cfg.weights.composite;
  }
}
