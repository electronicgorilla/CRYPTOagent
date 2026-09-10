// One scan cycle:
//   discover -> hydrate -> filter -> risk -> social -> feature -> score -> advise
//   -> GRADE due predictions (free) -> AGENT PANEL on promoted tokens -> persist
import { loadConfig } from "./config.mjs";
import * as dex from "./dexscreener.mjs";
import * as rugcheck from "./rugcheck.mjs";
import * as social from "./social.mjs";
import { buildCohort, buildFomo } from "./fomo.mjs";
import * as adapt from "./adapt.mjs";
import { pollChannels } from "./telegram/calls.mjs";
import { runPredictions } from "./predict.mjs";
import { buildFeatures } from "./features.mjs";
import { scoreToken, assignVerdicts } from "./scoring.mjs";
import { generateAdvice } from "./advice.mjs";
import * as orchestrator from "./agents/orchestrator.mjs";
import { gradeDue } from "./grader.mjs";
import * as store from "./store.mjs";
import * as ledger from "./ledger.mjs";

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

  // --- pass 1: score everything WITHOUT social data ---
  // Social providers are rate-limited (LunarCrush plans start ~10 req/min), so
  // a lookup per token is unaffordable. Score first, then spend the budget on
  // the tokens that actually matter.
  const rows = [];
  for (const p of pairs) {
    const mint = p.baseToken?.address;
    const risk = rugcheck.interpret(await rugcheck.getSummary(mint));
    const feat = buildFeatures(p, risk, null);
    const score = scoreToken(feat, cfg);
    rows.push({
      pair: p, risk,
      feat, score,
      advice: generateAdvice(feat, score),
      panel: null, note: store.getNote(mint),
    });
    await sleep(120);
  }
  rows.sort((a, b) => b.score.composite - a.score.composite);

  // --- pass 2: enrich the top N with social, then rescore just those ---
  const soc = social.active(cfg);
  if (soc) {
    social.resetStats(cfg);
    const topN = rows.slice(0, cfg.social?.enrichTopN ?? 10);
    let enriched = 0;
    for (const r of topN) {
      const s = await social.getMetrics(r.feat.symbol, r.feat.mint, cfg);
      if (!s) continue;
      r.feat = buildFeatures(r.pair, r.risk, s);
      r.score = scoreToken(r.feat, cfg);
      r.advice = generateAdvice(r.feat, r.score);
      enriched++;
    }
    rows.sort((a, b) => b.score.composite - a.score.composite);
    if (verbose) {
      const c = social.status(cfg);
      console.log(`[social] ${soc.name}: ${enriched}/${topN.length} enriched ` +
        `(${c.calls} calls, ${c.misses} no-coverage, ${c.errors} errors)`);
    }
  } else if (verbose) {
    console.log(`[social] ${social.status(cfg).reason} - attention from DEX proxies only`);
  }

  // --- pass 3: FOMO. Needs the whole cohort, because saturation, share of
  // attention and narrative crowding are only meaningful relative to the
  // rest of the field - and the session regime gates all of them.
  const cohort = buildCohort(rows.map((r) => r.feat));
  const compositeWeights = adapt.effectiveComposite(cfg);
  for (const r of rows) {
    r.feat.fomo = buildFomo(r.feat, cohort, store.history(r.feat.mint));
    r.score = scoreToken(r.feat, cfg, compositeWeights);
    r.advice = generateAdvice(r.feat, r.score);
  }
  assignVerdicts(rows, cfg);
  rows.sort((a, b) => b.score.composite - a.score.composite);
  if (verbose) console.log(`[fomo] session ${cohort.regime} (breadth ${(cohort.breadth*100).toFixed(0)}% green)`);

  // --- pass 4: prediction. Commit to a falsifiable claim BEFORE being asked,
  // then let the market answer it. Ranks are bootstrapped so an unstable top
  // slot is reported as unstable rather than dressed up as a call.
  if (cfg.predict?.enabled) {
    const { horizon } = runPredictions(rows, cfg);
    if (cfg.predict.logForecasts) {
      for (const r of rows) {
        const p = r.prediction;
        if (!p || p.call === 'pass') continue; // a non-call is not logged as a forecast
        ledger.record({
          agent: 'jane', model: 'deterministic-bootstrap', cost: 0,
          phase: r.advice.phase, feat: r.feat, score: r.score, pred: p,
          extra: { volatility: p.volatility, stability: p.stability, p_up: p.p_up },
        });
      }
    }
    if (verbose) {
      const calls = rows.filter((r) => r.prediction?.call !== 'pass');
      console.log(`[predict] ${calls.length}/${rows.length} directional, horizon ${horizon}m, ` +
        `median expected move ${rows.length ? rows[0].prediction?.volatility.expected_move_p50 : 0}%`);
    }
  }
  for (const r of rows) { delete r.pair; delete r.risk; }

  // Telegram channels are agents too - poll them BEFORE grading so a call made
  // this cycle is in the ledger, and an older one that just came due is graded.
  let telegram = { ran: false };
  try {
    telegram = await pollChannels(cfg, rows, { verbose });
  } catch (e) {
    console.warn(`[telegram] failed: ${e.message}`);
    telegram = { ran: false, reason: e.message };
  }

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
  return { ts, tokens: rows, graded, agents, telegram };
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
