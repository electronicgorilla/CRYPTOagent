// One scan cycle:
//   discover -> hydrate -> filter -> risk -> social -> feature -> score -> advise
//   -> GRADE due predictions (free) -> AGENT PANEL on promoted tokens -> persist
import { loadConfig } from "./config.mjs";
import * as dex from "./dexscreener.mjs";
import * as rugcheck from "./rugcheck.mjs";
import * as twitter from "./twitter.mjs";
import { buildFeatures } from "./features.mjs";
import { scoreToken } from "./scoring.mjs";
import { generateAdvice } from "./advice.mjs";
import * as orchestrator from "./agents/orchestrator.mjs";
import { gradeDue } from "./grader.mjs";
import * as store from "./store.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function passesFilter(pair, cfg) {
  const s = cfg.scan;
  const liq = pair.liquidity?.usd || 0;
  if (liq < s.minLiquidityUsd || liq > s.maxLiquidityUsd) return false;
  const created = pair.pairCreatedAt || 0;
  if (!created) return false;
  const ageMin = (Date.now() - created) / 60000;
  return ageMin >= s.minPairAgeMinutes && ageMin <= s.maxPairAgeHours * 60;
}

export async function runScan({ cfg, verbose = true } = {}) {
  cfg = cfg || loadConfig();
  const t0 = Date.now();

  const mints = await dex.discoverCandidates(cfg);
  if (verbose) console.log(`[scan] ${mints.size} candidate mints`);
  let pairs = await dex.hydrate(mints, cfg);
  pairs = pairs.filter((p) => passesFilter(p, cfg));
  if (verbose) console.log(`[scan] ${pairs.length} pairs pass liquidity/age filter`);

  const rows = [];
  for (const p of pairs) {
    const mint = p.baseToken?.address;
    const risk = rugcheck.interpret(await rugcheck.getSummary(mint));
    const social = await twitter.getMetrics(p.baseToken?.symbol, mint);
    const feat = buildFeatures(p, risk, social);
    const score = scoreToken(feat, cfg);
    const advice = generateAdvice(feat, score);
    rows.push({ feat, score, advice, panel: null, note: store.getNote(mint) });
    await sleep(120);
  }
  rows.sort((a, b) => b.score.composite - a.score.composite);

  // Grade first: outcomes for past calls feed the scorecards the arbiter is
  // about to be handed. Free - one batched DEX Screener call, no tokens.
  let graded = { graded: 0 };
  try {
    graded = await gradeDue({ verbose });
  } catch (e) {
    console.warn(`[grader] failed: ${e.message}`);
  }

  // Then the panel, which mutates rows[].panel in place for the promoted ones.
  let agents = { ran: false, reason: "not attempted" };
  try {
    agents = await orchestrator.analyseScan(rows, cfg, { verbose });
  } catch (e) {
    console.warn(`[agents] failed: ${e.message}`);
    agents = { ran: false, reason: e.message };
  }

  const ts = store.saveScan(rows);
  if (verbose) console.log(`[scan] saved ${rows.length} tokens in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return { ts, tokens: rows, graded, agents };
}

export async function loop(cfg) {
  cfg = cfg || loadConfig();
  const interval = cfg.scan.intervalSeconds * 1000;
  for (;;) {
    try {
      await runScan({ cfg });
    } catch (e) {
      console.error("[loop] scan error:", e.message);
    }
    console.log(`[loop] sleeping ${cfg.scan.intervalSeconds}s`);
    await sleep(interval);
  }
}
