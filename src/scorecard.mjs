// Agent scorecards - graded predictions turned into realised edge.
//
// This is what "curating" the panel actually means: agents earn or lose their
// place by measured performance, and the arbiter is HANDED these numbers so it
// discounts the ones that have been wrong. `baseline_rules` (the free
// deterministic score) sits in the same table as the benchmark - any paid agent
// that does not beat it is costing money for nothing.
import * as ledger from "./ledger.mjs";

const CONVICTION_BUCKETS = [
  [0.0, 0.4, "0.0-0.4"],
  [0.4, 0.6, "0.4-0.6"],
  [0.6, 0.8, "0.6-0.8"],
  [0.8, 1.01, "0.8-1.0"],
];

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);

function groupEdge(rows, keyFn) {
  const out = {};
  for (const r of rows) {
    const k = keyFn(r) || "unknown";
    (out[k] ||= []).push(r);
  }
  return Object.fromEntries(
    Object.entries(out).map(([k, v]) => [
      k,
      { n: v.length, hit_rate: r3(v.filter((x) => x.outcome.correct).length / v.length) },
    ])
  );
}

function scoreAgent(rows) {
  const graded = rows.filter((r) => r.outcome);
  const n = graded.length;
  if (!n) {
    return { n_calls: rows.length, n_graded: 0, unproven: true };
  }

  const correct = graded.filter((r) => r.outcome.correct);
  const longs = graded.filter((r) => r.call === "long");
  const longReturns = longs.map((r) => r.outcome.return_pct);
  const avoids = graded.filter((r) => r.call === "avoid");

  // Brier score over the directional claim: 0 is perfect, 0.25 is a coin flip
  // asserted at 50%, 1.0 is confidently wrong every time. Lower is better.
  const brier = mean(
    graded.map((r) => (r.conviction - (r.outcome.correct ? 1 : 0)) ** 2)
  );

  // Calibration: does higher stated conviction actually produce more hits?
  const calibration = CONVICTION_BUCKETS.map(([lo, hi, label]) => {
    const b = graded.filter((r) => r.conviction >= lo && r.conviction < hi);
    return {
      bucket: label,
      n: b.length,
      stated: r3(mean(b.map((r) => r.conviction))),
      actual: b.length ? r3(b.filter((r) => r.outcome.correct).length / b.length) : null,
    };
  });

  const cost = graded.reduce((a, r) => a + (r.cost || 0), 0);

  return {
    n_calls: rows.length,
    n_graded: n,
    unproven: n < 10, // fewer than 10 graded calls: no signal, don't trust it
    hit_rate: r3(correct.length / n),
    brier: r3(brier),
    calibration,
    longs: {
      n: longs.length,
      mean_return_pct: r1(mean(longReturns)),
      median_return_pct: r1(median(longReturns)),
      win_rate: longs.length ? r3(longs.filter((r) => r.outcome.return_pct > 0).length / longs.length) : null,
      // the number that actually matters: would blindly following the longs pay?
      expectancy_pct: r1(mean(longReturns)),
      rugged: longs.filter((r) => r.outcome.dead).length,
    },
    avoids: {
      n: avoids.length,
      // an "avoid" is right when the thing did NOT go up
      vindicated: avoids.length ? r3(avoids.filter((r) => r.outcome.return_pct <= 0).length / avoids.length) : null,
    },
    invalidation_respected: r3(
      mean(graded.filter((r) => r.outcome.invalidated != null).map((r) => (r.outcome.invalidated ? 0 : 1)))
    ),
    cost_usd: Math.round(cost * 10000) / 10000,
    cost_per_correct_usd: correct.length ? Math.round((cost / correct.length) * 10000) / 10000 : null,
    edge_by_phase: groupEdge(graded, (r) => r.phase),
    edge_by_tier: groupEdge(graded, (r) => r.mcap_tier),
    edge_by_horizon: groupEdge(graded, (r) => `${r.horizon_minutes}m`),
  };
}

/** Full scorecard for every agent that has ever made a call. */
export function build() {
  const rows = ledger.load();
  const byAgent = {};
  for (const r of rows) (byAgent[r.agent] ||= []).push(r);

  const agents = Object.fromEntries(
    Object.entries(byAgent).map(([id, rs]) => [id, scoreAgent(rs)])
  );

  const graded = rows.filter((r) => r.outcome);
  const baseline = agents.baseline_rules;

  // Does each paid agent beat the free deterministic score?
  const vsBaseline = {};
  if (baseline?.hit_rate != null) {
    for (const [id, a] of Object.entries(agents)) {
      if (id === "baseline_rules" || a.hit_rate == null) continue;
      vsBaseline[id] = {
        hit_rate_delta: r3(a.hit_rate - baseline.hit_rate),
        beats_baseline: a.hit_rate > baseline.hit_rate,
        proven: !a.unproven,
      };
    }
  }

  return {
    generated_at: Date.now() / 1000,
    totals: {
      predictions: rows.length,
      graded: graded.length,
      open: rows.length - graded.length,
      spend_usd: Math.round(rows.reduce((a, r) => a + (r.cost || 0), 0) * 10000) / 10000,
    },
    agents,
    vs_baseline: vsBaseline,
  };
}

/**
 * The compact form handed to the arbiter inside its prompt. Kept small on
 * purpose - it sits in the volatile part of the request, so every token here is
 * paid for on every call.
 */
export function forArbiter() {
  const sc = build();
  const out = {};
  for (const [id, a] of Object.entries(sc.agents)) {
    if (id === "arbiter") continue;
    out[id] = a.n_graded
      ? {
          graded: a.n_graded,
          hit_rate: a.hit_rate,
          brier: a.brier,
          long_expectancy_pct: a.longs?.expectancy_pct ?? null,
          status: a.unproven ? "UNPROVEN (<10 graded calls)" : "proven",
        }
      : { graded: 0, status: "no track record yet" };
  }
  return out;
}
