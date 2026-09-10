// One scan cycle:
//   discover -> hydrate -> filter -> risk -> social -> feature -> score -> advise
//   -> GRADE due predictions (free) -> AGENT PANEL on promoted tokens -> persist
import { loadConfig } from "./config.mjs";
import * as dex from "./dexscreener.mjs";
import * as gt from "./geckodiscovery.mjs";
import * as rugcheck from "./rugcheck.mjs";
import * as social from "./social.mjs";
import { buildCohort, buildFomo } from "./fomo.mjs";
import * as adapt from "./adapt.mjs";
import { pollChannels } from "./telegram/calls.mjs";
import { runPredictions } from "./predict.mjs";
import * as regime from "./regime.mjs";
import { sourceStamp, restartIfSourceChanged } from "./reload.mjs";
import * as ohlcv from "./ohlcv.mjs";
import { computeAura, auraPrediction } from "./aura.mjs";
import { rugClock, rugPrediction } from "./rugclock.mjs";
import { buildBoard } from "./horizons.mjs";
import * as briefs from "./briefs.mjs";
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
  // Merge the unbiased pool feed in. DEX Screener finds what is advertised;
  // GeckoTerminal finds what is actually trading.
  const gtMints = await gt.discover(cfg);
  let added = 0;
  for (const [mint, meta] of gtMints) if (!mints.has(mint)) { mints.set(mint, meta); added++; }
  if (verbose && added) console.log(`[discovery] +${added} from GeckoTerminal pool feeds`);
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
  // LAYER 0 first: the macro tape gates everything measured inside the cohort.
  let macro = { available: false };
  if (cfg.regime?.enabled) {
    try { macro = await regime.getRegime(cfg); } catch (e) { macro = { available: false, error: e.message }; }
  }
  const cohort = buildCohort(rows.map((r) => r.feat));
  const compositeWeights = adapt.effectiveComposite(cfg);
  for (const r of rows) {
    r.feat.fomo = buildFomo(r.feat, cohort, store.history(r.feat.mint));
    // Scale crowd psychology by the macro tape. A perfect setup in a bleeding
    // chain is still a bad trade - the buyers are simply not there.
    if (macro.available && cfg.regime?.applyMultiplier && macro.multiplier) {
      r.feat.fomo.fomo = Math.max(0, Math.min(1, r.feat.fomo.fomo * macro.multiplier));
      r.feat.fomo.macro = { regime: macro.regime, multiplier: macro.multiplier, note: macro.note };
    }
    r.score = scoreToken(r.feat, cfg, compositeWeights);
    r.advice = generateAdvice(r.feat, r.score);
  }
  assignVerdicts(rows, cfg);
  rows.sort((a, b) => b.score.composite - a.score.composite);
  if (verbose) console.log(`[fomo] session ${cohort.regime} (breadth ${(cohort.breadth*100).toFixed(0)}% green)`);
  if (verbose && macro.available) console.log(`[regime] ${macro.regime} \u2014 ${macro.note}` +
    (macro.cached ? ` (cached ${macro.ageMinutes}m)` : ` (${macro.callsToday}/${macro.budget} calls today)`));

  // --- pass 4: prediction. Commit to a falsifiable claim BEFORE being asked,
  // then let the market answer it. Ranks are bootstrapped so an unstable top
  // slot is reported as unstable rather than dressed up as a call.
  // --- AURA: durability, from real candles rather than summary windows. ---
  if (cfg.aura?.enabled) {
    const top = rows.slice(0, cfg.aura.candleTopN ?? 12).filter((r) => r.feat.pairAddress);
    ohlcv.resetStats();
    const candles = await ohlcv.getMany(top.map((r) => r.feat.pairAddress), {
      aggregate: cfg.aura.candleAggregateMinutes ?? 15, limit: cfg.aura.candleLimit ?? 24 });
    for (const r of rows) {
      const cs = ohlcv.analyse(candles.get(r.feat.pairAddress));
      r.feat.candles = cs ? { ...cs, closes: undefined } : null;
      r.aura = computeAura(r.feat, cs);
      if (cfg.aura.logPredictions) {
        const ap = auraPrediction(r.feat, r.aura);
        if (ap) ledger.record({ agent: 'aura', model: 'candle-structure', cost: 0,
          phase: r.advice.phase, feat: r.feat, score: r.score, pred: ap,
          extra: { aura: r.aura.points, aura_components: r.aura.components } });
      }
    }
    if (verbose) {
      const c = ohlcv.coverage();
      const enduring = rows.filter((r) => r.aura?.points >= 65).length;
      console.log(`[aura] ${enduring}/${rows.length} enduring (candles: ${c.calls} fetched, ${c.misses} unavailable)`);
    }
  }

  // --- RUG CLOCK: pressure over time, from the liquidity curve. ---
  if (cfg.rugclock?.enabled) {
    for (const r of rows) r.rug = rugClock(r.feat, store.history(r.feat.mint), cfg);
    // Log the warning so the hypothesis is GRADED, not believed.
    for (const r of rows) {
      const rp = rugPrediction(r.feat, r.rug, cfg);
      if (rp) ledger.record({ agent: 'rugclock', model: 'liquidity-trajectory', cost: 0,
        phase: r.advice.phase, feat: r.feat, score: r.score, pred: rp,
        extra: { rug_pressure: r.rug.pressure, rug_components: r.rug.components } });
    }
    if (verbose) {
      const hot = rows.filter((r) => r.rug && r.rug.pressure >= (cfg.rugclock.alertAt ?? 60));
      if (hot.length) console.log(`[rugclock] ${hot.length} in the harvest band: ` +
        hot.map((r) => `${r.feat.symbol}(${r.rug.pressure})`).join(', '));
      else console.log('[rugclock] none in the harvest band');
    }
  }

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

  // --- THE HORIZON BOARD: one read per timescale, archived as a brief. ---
  let board = null;
  if (cfg.horizons?.enabled !== false) {
    board = buildBoard(rows, { minScore: cfg.horizons?.minScore ?? 0.42 });
    briefs.archive(board);
    for (const h of board.horizons) {
      // Screens are not forecasts and are not logged as if they were.
      if (h.kind !== 'forecast') continue;
      for (const p of h.picks.slice(0, 1)) {
        const row = rows.find((r) => r.feat.mint === p.mint);
        if (!row) continue;
        ledger.record({ agent: `board:${h.id}`, model: 'horizon-board', cost: 0,
          phase: row.advice.phase, feat: row.feat, score: row.score,
          pred: { call: 'long', predicted_direction: 'up', horizon_minutes: h.horizonMinutes,
            conviction: Math.round(p.score) / 100, invalidation_pct: -30,
            reasoning: p.why.join('; ') || `board pick for ${h.label}`,
            key_risk: p.rug != null ? `rug pressure ${p.rug}` : 'memecoin base rate' } });
      }
    }
    if (verbose) console.log('[board] ' + board.horizons.map((h) =>
      `${h.id}:${h.empty ? 'none' : h.picks[0].symbol}`).join(' | '));
  }

  const ts = store.saveScan(rows);
  if (verbose) console.log(`[scan] saved ${rows.length} tokens in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return { ts, tokens: rows, graded, agents, telegram, macro, board };
}

export async function loop(cfg) {
  cfg = cfg || loadConfig();
  const interval = cfg.scan.intervalSeconds * 1000;
  const stamp = sourceStamp();
  for (;;) {
    try {
      await runScan({ cfg });
    } catch (e) {
      console.error("[loop] scan error:", e.message);
    }
    console.log(`[loop] sleeping ${cfg.scan.intervalSeconds}s`);
    await sleep(interval);
    // Pick up edits without a manual restart. A loop running cached modules
    // silently overwrites newer scans with stale output.
    restartIfSourceChanged(stamp);
  }
}
