// The funnel. This is what keeps a multi-agent panel from costing $150/day.
//
//   every scan (free)      deterministic score for ~15-80 tokens
//         |                + baseline_rules prediction logged for all of them
//         v
//   PROMOTION GATE         composite >= threshold
//                          AND (never analysed
//                               OR its feature vector actually MOVED
//                               OR the last read is stale)
//                          AND under the per-scan / per-day spend cap
//         v
//   stage 1 (parallel)     microstructure | narrative | forensics
//         v
//   stage 2 (conditional)  red team - only when stage 1 DISAGREES or is confident
//         v
//   stage 3                arbiter - the single card, fed the agent scorecards
//
// The cache-on-delta rule does most of the work: between two scans five minutes
// apart, most tokens have not moved enough to change anyone's mind, so re-asking
// is pure spend. Only material movement buys a new opinion.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../config.mjs";
import { AGENTS, BY_ID } from "./roster.mjs";
import { runAgent, available } from "./client.mjs";
import * as ledger from "../ledger.mjs";
import * as scorecard from "../scorecard.mjs";

export { available };

const STATE = join(DATA_DIR, "agent_state.json");

function loadState() {
  if (!existsSync(STATE)) return { tokens: {}, spend: {} };
  try {
    return JSON.parse(readFileSync(STATE, "utf8"));
  } catch {
    return { tokens: {}, spend: {} };
  }
}
const saveState = (s) => writeFileSync(STATE, JSON.stringify(s, null, 2));
const today = () => new Date().toISOString().slice(0, 10);

/** Mean absolute change across the normalised feature vector. 0 = identical. */
function featureDelta(prev, cur) {
  if (!prev) return Infinity;
  const keys = Object.keys(cur).filter((k) => typeof cur[k] === "number" && typeof prev[k] === "number");
  if (!keys.length) return Infinity;
  return keys.reduce((a, k) => a + Math.abs(cur[k] - prev[k]), 0) / keys.length;
}

function promote(rows, cfg, state) {
  const a = cfg.agents;
  const now = Date.now() / 1000;
  const daySpend = state.spend?.[today()] || 0;
  if (daySpend >= a.maxSpendPerDayUsd) return { promoted: [], reason: "daily spend cap reached" };

  const scored = [];
  for (const r of rows) {
    if (r.score.composite < a.promoteScore) continue;
    if (r.score.hardAvoid && a.skipHardAvoid) continue; // forensics already settled it
    const prev = state.tokens[r.feat.mint];
    const delta = featureDelta(prev?.n, r.feat.n);
    const ageMin = prev ? (now - prev.ts) / 60 : Infinity;
    if (delta < a.deltaThreshold && ageMin < a.staleMinutes) continue;
    scored.push({ row: r, delta, ageMin, why: !prev ? "new" : delta >= a.deltaThreshold ? "moved" : "stale" });
  }

  scored.sort((x, y) => y.row.score.composite - x.row.score.composite);
  return { promoted: scored.slice(0, a.maxTokensPerScan), reason: null };
}

async function runStage(stage, feat, priorOutputs, budget) {
  const agents = AGENTS.filter((a) => a.stage === stage);
  const results = await Promise.all(
    agents.map(async (agent) => {
      if (budget.spent >= budget.cap) return { agent, res: { ok: false, error: "spend cap reached" } };
      const payload = { data: agent.select(feat), ...priorOutputs };
      const res = await runAgent(agent, payload);
      if (res.ok) budget.spent += res.cost;
      return { agent, res };
    })
  );
  return results;
}

/** Do stage-1 specialists disagree, or is anyone confident? Gate for red team. */
function needsRedTeam(stage1, cfg) {
  const calls = stage1.filter((r) => r.res.ok).map((r) => r.res.output.call);
  if (!calls.length) return false;
  const unanimous = new Set(calls).size === 1;
  const maxConv = Math.max(...stage1.filter((r) => r.res.ok).map((r) => r.res.output.conviction || 0));
  return !unanimous || maxConv >= cfg.agents.redTeamConvictionFloor;
}

/**
 * Run the panel over one scan's rows. Always logs the free baseline prediction;
 * runs paid agents only on promoted tokens.
 */
export async function analyseScan(rows, cfg, { verbose = true } = {}) {
  // 1. The free benchmark, for every token, every scan.
  for (const r of rows) {
    try {
      ledger.recordBaseline({ feat: r.feat, score: r.score, advice: r.advice });
    } catch (e) {
      console.warn(`[agents] baseline log failed for ${r.feat.symbol}: ${e.message}`);
    }
  }

  const a = cfg.agents;
  if (!a?.enabled) return { ran: false, reason: "agents disabled in config" };
  if (!available()) return { ran: false, reason: "no ANTHROPIC_API_KEY - rule-based only" };

  const state = loadState();
  const { promoted, reason } = promote(rows, cfg, state);
  if (reason) return { ran: false, reason };
  if (!promoted.length) return { ran: true, analysed: 0, spend: 0, note: "nothing crossed the promotion gate" };

  const budget = { spent: 0, cap: a.maxSpendPerScanUsd };
  const cards = scorecard.forArbiter();
  const analysed = [];

  for (const { row, why } of promoted) {
    if (budget.spent >= budget.cap) break;
    const { feat, score, advice } = row;
    const panel = {};

    // --- stage 1: independent specialists, in parallel ---
    const stage1 = await runStage(1, feat, {}, budget);
    for (const { agent, res } of stage1) {
      panel[agent.id] = res.ok ? res.output : { error: res.error };
      if (res.ok) {
        ledger.record({ agent: agent.id, model: res.model, pred: res.output, feat, score, cost: res.cost, phase: advice.phase });
      }
    }

    // --- stage 2: red team, only when it can add something ---
    if (needsRedTeam(stage1, cfg)) {
      const [rt] = await runStage(2, feat, { panel_stage1: panel }, budget);
      panel[rt.agent.id] = rt.res.ok ? rt.res.output : { error: rt.res.error };
      if (rt.res.ok) {
        ledger.record({ agent: rt.agent.id, model: rt.res.model, pred: rt.res.output, feat, score, cost: rt.res.cost, phase: advice.phase });
      }
    } else {
      panel.redteam = { skipped: "stage-1 unanimous and low conviction" };
    }

    // --- stage 3: arbiter, handed the panel AND the track records ---
    const [arb] = await runStage(
      3,
      feat,
      { panel, rule_based_score: score, agent_scorecards: cards, user_notes: row.note || "" },
      budget
    );
    panel[arb.agent.id] = arb.res.ok ? arb.res.output : { error: arb.res.error };
    if (arb.res.ok) {
      ledger.record({ agent: arb.agent.id, model: arb.res.model, pred: arb.res.output, feat, score, cost: arb.res.cost, phase: advice.phase });
    }

    row.panel = { promotedBecause: why, agents: panel, cost: round4(budget.spent) };
    state.tokens[feat.mint] = { ts: Date.now() / 1000, n: feat.n };
    analysed.push(feat.symbol);
    if (verbose) console.log(`[agents] ${feat.symbol} (${why}) -> ${arb.res.ok ? arb.res.output.call : "error"}`);
  }

  state.spend = state.spend || {};
  state.spend[today()] = round4((state.spend[today()] || 0) + budget.spent);
  saveState(state);

  if (verbose) console.log(`[agents] analysed ${analysed.length} tokens for $${budget.spent.toFixed(4)}`);
  return { ran: true, analysed: analysed.length, symbols: analysed, spend: round4(budget.spent), daySpend: state.spend[today()] };
}

const round4 = (x) => Math.round(x * 10000) / 10000;

/** Spend so far today, for the dashboard header. */
export function spendToday() {
  return loadState().spend?.[today()] || 0;
}
