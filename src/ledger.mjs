// The prediction ledger - the spine of the curation loop.
//
// Every call any agent makes (and the deterministic rule-based verdict, logged
// as the `baseline_rules` pseudo-agent) is written here the moment it is made,
// together with the entry price and the feature snapshot that produced it.
// Nothing on this dashboard gets to be an opinion: it gets to be a record.
//
// src/grader.mjs fills in `outcome` once the horizon elapses.
// src/scorecard.mjs turns graded records into per-agent realised edge.
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_DIR } from "./config.mjs";

// Bump whenever the feature set or scoring changes shape. The scorecard can
// then segment, instead of silently mixing calls made by two different models.
export const MODEL_VERSION = "2026-09-11.fomo";

const LEDGER = join(DATA_DIR, "ledger.json");
const MAX_ROWS = 20000;

// Moves smaller than this count as "flat". It MUST scale with the horizon and
// with how violent the asset class is: the observed median 60-minute move on
// this scanner's universe is ~18%, so a fixed +/-5% band made "flat" almost
// never correct and quietly turned the hit rate into noise.
const FLAT_BANDS = { 15: 8, 60: 18, 360: 35, 1440: 60, 14400: 120 };
export function flatBandFor(horizonMinutes) {
  return FLAT_BANDS[horizonMinutes] ?? 18;
}

export function load() {
  if (!existsSync(LEDGER)) return [];
  try {
    return JSON.parse(readFileSync(LEDGER, "utf8"));
  } catch {
    return [];
  }
}

export function save(rows) {
  const trimmed = rows.slice(-MAX_ROWS);
  // write-then-rename so a crash mid-write can't truncate the ledger
  const tmp = LEDGER + ".tmp";
  writeFileSync(tmp, JSON.stringify(trimmed, null, 2));
  renameSync(tmp, LEDGER);
}

/**
 * Record one prediction. `pred` is the agent's structured output; `feat`/`score`
 * are the snapshot it was made from.
 */
export function record({ agent, model, pred, feat, score, cost = 0, phase = null, extra = null }) {
  const rows = load();
  const row = {
    id: randomUUID(),
    ts: Date.now() / 1000,
    mint: feat.mint,
    symbol: feat.symbol,
    agent,
    model,
    call: pred.call,
    predicted_direction: pred.predicted_direction,
    horizon_minutes: pred.horizon_minutes,
    conviction: pred.conviction,
    invalidation_pct: pred.invalidation_pct,
    reasoning: pred.reasoning,
    key_risk: pred.key_risk ?? null,
    phase: phase ?? pred.phase ?? null,
    entry_price: feat.priceUsd,
    entry_liq: feat.liqUsd,
    entry_mcap: feat.mcap,
    composite: score?.composite ?? null,
    mcap_tier: tierOf(feat.mcap),
    model_version: MODEL_VERSION,
    features: feat.n ? { ...feat.n } : null,
    fomo: feat.fomo ? { score: feat.fomo.fomo, ...feat.fomo.components } : null,
    cost,
    // Anything the agent forecast beyond direction - notably the expected
    // move band, which the grader scores separately from the sign.
    ...(extra || {}),
    outcome: null,
  };
  rows.push(row);
  save(rows);
  return row;
}

/**
 * The deterministic score, logged as a competitor. This is the benchmark every
 * paid agent has to beat - if they can't, stop paying for them.
 */
export function recordBaseline({ feat, score, advice }) {
  const call = score.verdict === "STRONG" ? "long" : score.verdict === "AVOID" ? "avoid" : "pass";
  const direction = call === "long" ? "up" : call === "avoid" ? "down" : "flat";

  // Conviction must mean "confidence in the DIRECTION I just stated", or the
  // calibration column is meaningless. Reusing the composite here would claim
  // 73% confidence in a *flat* outcome just because the momentum score was 73.
  const conviction =
    call === "long"
      ? Math.max(0, Math.min(1, score.composite / 100)) // composite IS the up-confidence
      : call === "avoid"
        ? 0.65 // rug-flagged: fairly confident it does not go up
        : 0.5; // pass: genuinely uncertain, and scored as such

  return record({
    agent: "baseline_rules",
    model: "deterministic",
    cost: 0,
    phase: advice.phase,
    feat,
    score,
    pred: {
      call,
      predicted_direction: direction,
      horizon_minutes: 60,
      conviction,
      invalidation_pct: -25,
      reasoning: advice.thesis?.[0] ?? "rule-based composite",
      key_risk: advice.risks?.[0] ?? null,
    },
  });
}

export function tierOf(mcap) {
  if (!mcap) return "unknown";
  if (mcap < 100_000) return "<100k";
  if (mcap < 1_000_000) return "100k-1M";
  if (mcap < 10_000_000) return "1M-10M";
  return ">10M";
}

/** Predictions whose horizon has elapsed but that have not been graded. */
export function due(now = Date.now() / 1000) {
  return load().filter((r) => !r.outcome && now >= r.ts + r.horizon_minutes * 60);
}

/** Predictions still in flight. */
export function open(now = Date.now() / 1000) {
  return load()
    .filter((r) => !r.outcome && now < r.ts + r.horizon_minutes * 60)
    .map((r) => ({ ...r, seconds_left: Math.round(r.ts + r.horizon_minutes * 60 - now) }));
}

export function applyOutcomes(outcomes) {
  const byId = new Map(outcomes.map((o) => [o.id, o]));
  const rows = load();
  let n = 0;
  for (const r of rows) {
    const o = byId.get(r.id);
    if (o) {
      r.outcome = o.outcome;
      n++;
    }
  }
  save(rows);
  return n;
}

/** Most recent prediction per (mint, agent) - used to show the live panel. */
export function latestByToken(mint) {
  const out = {};
  for (const r of load()) {
    if (r.mint !== mint) continue;
    if (!out[r.agent] || r.ts > out[r.agent].ts) out[r.agent] = r;
  }
  return out;
}
