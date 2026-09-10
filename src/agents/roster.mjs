import { promptFragment } from "../doctrine.mjs";
// The agent roster.
//
// Design rule: an agent that cannot be SCORED does not belong on the dashboard.
// Every agent therefore emits the same falsifiable, time-boxed prediction
// envelope - a direction, a horizon, a conviction, and an invalidation level.
// src/grader.mjs revisits each one when its horizon elapses and marks it
// hit/miss; src/scorecard.mjs turns that into per-agent realised edge, which is
// fed back to the arbiter so persistently-wrong agents get discounted.
//
// Stages run in order. Stage 2+ agents see the outputs of earlier stages, so
// this is a pipeline with an adversarial step - not a flat fan-out where five
// models independently agree with the momentum they were shown.

/** Fields every agent must return. Shared so the grader can score uniformly. */
const PREDICTION_FIELDS = {
  call: { type: "string", enum: ["long", "pass", "avoid"] },
  predicted_direction: { type: "string", enum: ["up", "down", "flat"] },
  horizon_minutes: { type: "integer", enum: [15, 60, 360] },
  conviction: { type: "number", description: "0..1. Be calibrated - this is scored." },
  invalidation_pct: {
    type: "number",
    description: "Signed % move from the current price that would prove this call wrong.",
  },
  reasoning: { type: "string", description: "2-4 sentences. The strongest reason only." },
  key_risk: { type: "string", description: "The single thing most likely to kill this." },
};
const PREDICTION_REQUIRED = Object.keys(PREDICTION_FIELDS);

function schema(extraProps = {}) {
  return {
    type: "object",
    properties: { ...PREDICTION_FIELDS, ...extraProps },
    required: [...PREDICTION_REQUIRED, ...Object.keys(extraProps)],
    additionalProperties: false,
  };
}

const SHARED_RULES = promptFragment() + `
You are one specialist in a panel analysing Solana memecoins. You see only your
slice of the data on purpose - do not speculate about signals you were not given,
say you cannot see them.

The market mechanism is reflexivity: price up -> attention up -> buys up -> price
up, until distribution. The same reading means different things depending on
where in that loop the token sits (stealth -> discovery -> retail FOMO ->
distribution -> dead).

Your output is SCORED against what actually happens. Be calibrated, not
agreeable: conviction 0.9 must mean you are right ~90% of the time. "pass" is a
respectable answer and costs you nothing; a confident wrong call costs you your
weight in the panel. Most memecoins go to zero - a bearish or passing read is
usually the correct one.

This is decision support for one person's own screen. It never executes trades.
`.trim();

export const AGENTS = [
  {
    id: "microstructure",
    stage: 1,
    label: "Microstructure",
    model: "claude-sonnet-5",
    effort: "low",
    // Taxonomy A: liquidity, order flow, turnover, acceleration.
    system: `${SHARED_RULES}

YOUR SLICE: market microstructure only. Liquidity depth, liquidity/mcap ratio,
turnover, buy/sell flow imbalance, transaction velocity, volume acceleration,
pair age. You are the one who knows whether a move is mechanically supported or
is a thin pool being pushed around.

Weigh: is volume ACCELERATING or just high? Is flow buy-skewed on a widening
number of transactions (real participation) or on a shrinking one (a few wallets)?
Is liquidity deep enough that the move survives someone taking profit? Turnover
far above liquidity with no price discovery is wash volume, not demand.`,
    schema: schema({
      flow_quality: { type: "string", enum: ["real", "thin", "wash", "unclear"] },
      phase: { type: "string", description: "Lifecycle phase from microstructure alone." },
    }),
    select: (f) => ({
      symbol: f.symbol,
      age_hours: round(f.ageH, 2),
      liquidity_usd: f.liqUsd,
      market_cap: f.mcap,
      liq_mcap_ratio: round(f.liqMcapRatio, 4),
      price_change_pct: f.priceChange,
      volume_usd: f.volume,
      txn_counts: f.txns,
      buy_ratio_1h: round(f.buyRatioH1, 3),
      volume_accel_x: round(f.volAccel, 2),
      tx_velocity_x: round(f.txVelocity, 2),
      turnover_1h_x: round(f.turnoverH1, 2),
      turnover_24h_x: round(f.turnoverH24, 2),
    }),
  },

  {
    id: "narrative",
    stage: 1,
    label: "Narrative & attention",
    model: "claude-opus-5",
    effort: "medium",
    // Taxonomy B: this is the genuinely semantic judgement, hence the top model.
    system: `${SHARED_RULES}

YOUR SLICE: narrative and attention. The name, ticker, imagery, socials, and
(when wired) X mention velocity, unique authors, follower reach and KOL activity.

Weigh: is the meme LEGIBLE and remixable, or an in-joke nobody can retell? Does
it fit a meta that is hot right now, or one that died months ago? Is the
attention ACCELERATING and broad (many unique authors) or manufactured (high
mention count from few accounts, i.e. bots)? A ticker that clones something
already trending is usually a trap, not the trade.

If no social data is present, say so and lower your conviction accordingly -
judging attention from a token name alone is weak evidence and you should
usually "pass".`,
    schema: schema({
      narrative_strength: { type: "string", enum: ["strong", "moderate", "weak", "none"] },
      attention_is_organic: { type: "string", enum: ["yes", "no", "unknown"] },
      meta_fit: { type: "string", description: "Which current meta this fits, or 'none'." },
    }),
    select: (f) => ({
      symbol: f.symbol,
      name: f.name,
      age_hours: round(f.ageH, 2),
      market_cap: f.mcap,
      socials_present: f.socials,
      has_dexscreener_boost: f.hasBoost,
      boost_amount: f.boostAmount,
      has_recent_token_profile: f.hasRecentProfile,
      social_data: f.socialRaw ?? "NOT WIRED - no X/Telegram data available",
      normalised_attention_signals: pick(f.n, [
        "boost", "profileRecency", "socialsQuality", "txnVelocity",
        "socialAccel", "socialReach", "socialQuality", "kol",
      ]),
    }),
  },

  {
    id: "forensics",
    stage: 1,
    label: "Contract forensics",
    model: "claude-sonnet-5",
    effort: "low",
    // Taxonomy D: rug / adversarial risk.
    system: `${SHARED_RULES}

YOUR SLICE: contract and rug forensics. RugCheck findings, mint and freeze
authority, LP lock status, pair age, and turnover anomalies.

Your job is to find the reason NOT to touch this. Active mint authority, active
freeze authority, unlocked LP, or a very young pool are each sufficient to
justify "avoid" on their own. Absence of data is not safety - if RugCheck
returned nothing, say the contract is UNVERIFIED and treat that as a risk, not
a neutral.

You cannot see holder concentration, sniper bundles, or deployer history. Name
those as unchecked rather than assuming they are clean.`,
    schema: schema({
      rug_probability: { type: "number", description: "0..1 estimate of a rug/honeypot outcome." },
      blocking_flags: { type: "array", items: { type: "string" } },
      unchecked: { type: "array", items: { type: "string" } },
    }),
    select: (f) => ({
      symbol: f.symbol,
      age_hours: round(f.ageH, 2),
      liquidity_usd: f.liqUsd,
      turnover_24h_x: round(f.turnoverH24, 2),
      rugcheck: f.riskRaw,
      normalised_risk: f.nRisk,
    }),
  },

  {
    id: "redteam",
    stage: 2,
    label: "Red team",
    model: "claude-opus-5",
    effort: "medium",
    // Stage 2: sees stage 1. The highest-value agent, because every other
    // signal in this system is momentum-biased.
    system: `${SHARED_RULES}

YOUR ROLE: red team. You see the full data AND the stage-1 specialists' calls.
Your job is to argue the BEAR case as strongly as the evidence allows and to
name what the panel is collectively missing.

Assume the specialists have been fooled unless the evidence is strong. Ask: who
is on the other side of this trade and why are they selling to us? Is the panel
mistaking a distribution top for a breakout? Are they reading manufactured
attention as organic? Is the "acceleration" just the 5-minute window catching a
single large buy?

If after genuinely trying you cannot build a bear case, say so plainly - a red
team that cries wolf every time is as useless as one that never does.`,
    schema: schema({
      bear_case: { type: "string" },
      panel_blindspot: { type: "string", description: "What the other agents missed." },
      disagrees_with: { type: "array", items: { type: "string" }, description: "Agent ids you think are wrong." },
    }),
    select: (f) => fullSlice(f),
  },

  {
    id: "arbiter",
    stage: 3,
    label: "Arbiter",
    model: "claude-opus-5",
    effort: "high",
    // Stage 3: the only output that becomes "the read" on the dashboard.
    system: `${SHARED_RULES}

YOUR ROLE: arbiter / portfolio manager. You see the full data, every specialist's
call, the red team, the deterministic rule-based score, and each agent's REALISED
TRACK RECORD from the scorecard.

Use the scorecard. An agent with a 30% hit rate over 40 calls should barely move
you no matter how confident it sounds; an agent with a demonstrated edge in this
exact phase should. If an agent has fewer than 10 graded calls, treat its record
as unproven rather than good.

Weigh DISAGREEMENT as information. Unanimity among momentum-biased specialists is
weak evidence; a specialist dissenting against the crowd is strong evidence.

Your output is the single card the user reads. Give the position framing an
actual human needs: what would make this worth taking, what size posture the
uncertainty justifies, and the concrete observable that means get out.`,
    schema: schema({
      one_liner: { type: "string", description: "The single sentence the user reads first." },
      phase: { type: "string" },
      position_framing: { type: "string", description: "Size posture the uncertainty justifies." },
      exit_trigger: { type: "string", description: "The concrete observable that means get out." },
      panel_agreement: { type: "string", enum: ["unanimous", "majority", "split", "contested"] },
      weighted_agents: {
        type: "array",
        items: { type: "string" },
        description: "Agent ids you actually leaned on, and why in a few words each.",
      },
    }),
    select: (f) => fullSlice(f),
  },
];

export const BY_ID = Object.fromEntries(AGENTS.map((a) => [a.id, a]));
export const STAGES = [...new Set(AGENTS.map((a) => a.stage))].sort();

// ---------- helpers ----------

function round(x, d) {
  return typeof x === "number" && isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : x;
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj?.[k] != null) out[k] = obj[k];
  return out;
}

function fullSlice(f) {
  return {
    symbol: f.symbol,
    name: f.name,
    age_hours: round(f.ageH, 2),
    price_usd: f.priceUsd,
    liquidity_usd: f.liqUsd,
    market_cap: f.mcap,
    liq_mcap_ratio: round(f.liqMcapRatio, 4),
    price_change_pct: f.priceChange,
    volume_usd: f.volume,
    txn_counts: f.txns,
    buy_ratio_1h: round(f.buyRatioH1, 3),
    volume_accel_x: round(f.volAccel, 2),
    tx_velocity_x: round(f.txVelocity, 2),
    turnover_24h_x: round(f.turnoverH24, 2),
    socials_present: f.socials,
    has_dexscreener_boost: f.hasBoost,
    social_data: f.socialRaw ?? "NOT WIRED",
    rugcheck: f.riskRaw,
    normalised_signals: f.n,
    normalised_risk: f.nRisk,
  };
}
