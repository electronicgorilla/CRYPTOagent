// Telegram channels as agents.
//
// A call channel makes falsifiable, time-boxed predictions: "$X, buy now". That
// is exactly the contract every other agent in this system already emits, so a
// channel goes into the SAME ledger as `tg:<channel>`, is graded by the SAME
// grader, and appears in the SAME scorecard next to baseline_rules and the LLM
// panel.
//
// The consequence is the point: after a few dozen calls you stop guessing which
// channels are worth reading. You know the hit rate, the expectancy, and how
// much of it was survivorship. Channels that cannot beat the free deterministic
// score are noise you can mute with evidence rather than vibes.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../config.mjs";
import * as ledger from "../ledger.mjs";
import * as scorecard from "../scorecard.mjs";
import { hydrate } from "../dexscreener.mjs";
import { buildFeatures } from "../features.mjs";
import { fetchMessages, mode, enabled } from "./index.mjs";
import { extractCall } from "./extract.mjs";

const STATE = join(DATA_DIR, "telegram_state.json");
const SEEN_TTL = 7 * 24 * 3600; // forget message ids after a week

const loadState = () => {
  if (!existsSync(STATE)) return { seen: {}, lastRun: 0 };
  try { return JSON.parse(readFileSync(STATE, "utf8")); } catch { return { seen: {}, lastRun: 0 }; }
};
const saveState = (s) => writeFileSync(STATE, JSON.stringify(s, null, 2));

/** A channel's realised edge, straight from the scorecard it earned. */
function channelEdge(channel) {
  const sc = scorecard.build();
  const a = sc.agents[`tg:${channel}`];
  if (!a || !a.n_directional) return { conviction: 0.5, proven: false, hit_rate: null, n: 0 };
  // Conviction IS the measured hit rate once there is enough of a sample.
  // Before that it stays at the uninformative 0.5 - a new channel does not get
  // to sound confident just because it sounds confident.
  return {
    conviction: a.unproven ? 0.5 : Math.max(0.15, Math.min(0.9, a.hit_rate)),
    proven: !a.unproven,
    hit_rate: a.hit_rate,
    n: a.n_directional,
  };
}

/**
 * Poll every configured channel, log new calls, return what happened.
 * `cohort` is the current scan's rows, used to resolve ticker-only calls.
 */
export async function pollChannels(cfg, cohort = [], { verbose = true } = {}) {
  if (!enabled(cfg)) return { ran: false, reason: "telegram disabled or no channels configured" };

  const { m, note } = mode(cfg);
  if (note && verbose) console.log(`[telegram] ${note}`);

  const state = loadState();
  const now = Date.now() / 1000;
  for (const [k, t] of Object.entries(state.seen)) if (now - t > SEEN_TTL) delete state.seen[k];

  const maxAge = (cfg.telegram.maxMessageAgeMinutes ?? 90) * 60;
  const horizon = cfg.telegram.horizonMinutes ?? 60;
  const bySymbol = new Map(cohort.map((r) => [String(r.feat.symbol || "").toUpperCase(), r]));

  const fresh = [];   // {channel, msg, call}
  const errors = [];

  for (const ch of cfg.telegram.channels) {
    const name = String(ch).replace(/^@/, "");
    const res = await fetchMessages(name, cfg);
    if (!res.ok) { errors.push(`${name}: ${res.reason}`); continue; }
    for (const msg of res.messages) {
      if (state.seen[msg.id]) continue;
      state.seen[msg.id] = now;
      // Stale posts are recorded as seen but never logged as calls - grading a
      // three-day-old message against today's price is meaningless.
      if (msg.ts && now - msg.ts > maxAge) continue;
      const call = extractCall(msg.text);
      if (!call || call.kind === "mention") continue;
      fresh.push({ channel: name, msg, call });
    }
  }

  // Resolve every mint referenced across all channels in ONE batched lookup.
  const mints = [...new Set(fresh.flatMap((f) => f.call.mints))];
  const resolved = new Map();
  if (mints.length) {
    try {
      const pairs = await hydrate(
        new Map(mints.map((a) => [a, { boost: 0, profile: false }])),
        { scan: { maxCandidates: 30 } }
      );
      for (const p of pairs) resolved.set(p.baseToken?.address, buildFeatures(p, {}, null));
    } catch (e) {
      errors.push(`mint resolution: ${e.message}`);
    }
  }

  // Cross-channel confirmation (taxonomy #24): the same token called by several
  // independent channels inside one window is a materially stronger signal than
  // any one of them alone.
  const mentionCount = new Map();
  for (const f of fresh) {
    for (const key of [...f.call.mints, ...f.call.tickers]) {
      const s = mentionCount.get(key) || new Set();
      s.add(f.channel);
      mentionCount.set(key, s);
    }
  }

  const logged = [];
  for (const f of fresh) {
    const { channel, msg, call } = f;
    // Prefer the mint: a ticker alone is ambiguous and often wrong.
    let feat = null, ref = null, confidence = call.confidence;
    for (const mint of call.mints) {
      if (resolved.has(mint)) { feat = resolved.get(mint); ref = mint; break; }
    }
    if (!feat) {
      for (const t of call.tickers) {
        const row = bySymbol.get(t);
        if (row) { feat = row.feat; ref = "$" + t; confidence = "low"; break; }
      }
    }
    if (!feat) continue; // named something we cannot price - nothing to grade

    const confirms = mentionCount.get(ref) || mentionCount.get(ref?.replace("$", "")) || new Set([channel]);
    const edge = channelEdge(channel);

    const row = ledger.record({
      agent: `tg:${channel}`,
      model: `telegram-${m}`,
      cost: 0,
      phase: null,
      feat,
      score: { composite: null },
      pred: {
        call: call.kind === "exit" ? "avoid" : "long",
        predicted_direction: call.kind === "exit" ? "down" : "up",
        horizon_minutes: horizon,
        // Conviction is the channel's MEASURED hit rate, not its tone.
        conviction: confidence === "low" ? edge.conviction * 0.7 : edge.conviction,
        invalidation_pct: call.kind === "exit" ? 20 : -30,
        reasoning: msg.text.slice(0, 280),
        key_risk: confidence === "low"
          ? "ticker-only reference - could be a different token with the same ticker"
          : null,
      },
    });
    // Provenance, so a call can always be traced back to the actual message.
    logged.push({
      id: row.id, channel, ref, kind: call.kind, confidence,
      symbol: feat.symbol, url: msg.url, views: msg.views,
      confirmedBy: [...confirms], edge,
    });
  }

  state.lastRun = now;
  saveState(state);

  if (verbose) {
    if (logged.length) {
      for (const l of logged) {
        console.log(`[telegram] ${l.channel} ${l.kind.toUpperCase()} ${l.symbol} (${l.confidence}` +
          `${l.confirmedBy.length > 1 ? `, confirmed by ${l.confirmedBy.length} channels` : ""}` +
          `${l.edge.proven ? `, channel hit rate ${Math.round(l.edge.hit_rate * 100)}%` : ", unproven channel"})`);
      }
    } else {
      console.log(`[telegram] ${cfg.telegram.channels.length} channel(s), no new calls`);
    }
    for (const e of errors) console.warn(`[telegram] ${e}`);
  }

  return { ran: true, mode: m, logged, errors, checked: cfg.telegram.channels.length };
}

/** Recent Telegram calls, for the dashboard feed. */
export function recentCalls(limit = 40) {
  return ledger.load()
    .filter((r) => r.agent?.startsWith("tg:"))
    .slice(-limit)
    .reverse()
    .map((r) => ({
      id: r.id, channel: r.agent.slice(3), symbol: r.symbol, mint: r.mint,
      call: r.call, ts: r.ts, conviction: r.conviction,
      text: r.reasoning, outcome: r.outcome,
    }));
}
