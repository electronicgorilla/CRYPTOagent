# CRYPTOagent

High-effort / low-cost copy of Bloomberg for crypto — starting with the degen end
of the market.

## degen-radar

A local dashboard that scores **trending Solana memecoins** by *attention*,
*momentum*, *liquidity health* and *risk*, then gives a rule-based read on each
one (lifecycle phase, thesis, risks, invalidation levels). Live data from the
free DEX Screener API + best-effort RugCheck. Zero npm dependencies — Node 20+
only.

On top of the deterministic scanner sits an optional **multi-agent panel** and,
more importantly, a **curation loop** that grades every call anyone makes and
weights the agents by their measured track record.

```bash
cd degen-radar
npm install            # one dependency: @anthropic-ai/sdk (only needed for the panel)
node run.mjs scan      # one scan, printed leaderboard
node run.mjs serve     # dashboard at http://127.0.0.1:8787
node run.mjs loop      # rescan every config.scan.intervalSeconds
node run.mjs grade     # grade any due predictions now (free)
node run.mjs scorecard # print agent track records
```

Optional config: `cp .env.example .env` and fill what you have. Nothing is
required — the scanner, the ledger and the grader all run fully on the free
endpoints. The agent panel activates only when `ANTHROPIC_API_KEY` is set.

---

## 1. What actually moves this market — the signal taxonomy

The core mechanism is **reflexivity**: price up -> attention up -> buys up ->
price up, until distribution. Every signal matters only relative to *where in
that loop the token is*.

### A. Liquidity & microstructure — sets how violent the moves are
| # | Signal | Wired? | Source |
|---|--------|--------|--------|
| 1 | LP depth (USD) | yes | DEX Screener `liquidity.usd` |
| 2 | Liquidity / MCap ratio | yes | derived |
| 3 | Market-cap tier | yes | DEX Screener |
| 4 | FDV vs circulating / unlock overhang | partial (FDV only) | DEX Screener |
| 5 | Turnover = volume / liquidity | yes | derived |
| 6 | Buy/sell tx & volume ratio (5m/1h) | yes | DEX Screener `txns` |
| 7 | Net volume delta (5m/1h/6h) | yes (via accel) | derived |
| 8 | Unique makers / traders + rate of change | proxy (tx count velocity) | needs Birdeye/GMGN |
| 9 | Trade-size distribution | no | needs on-chain |
| 10 | Pair age & decay curve | yes | DEX Screener `pairCreatedAt` |
| 11 | Venue & bonding-curve migration status | partial (dexId) | pump.fun API |
| 12 | CEX listing events | no | exchange announcements feed |

### B. Attention & social velocity — the actual driver
| # | Signal | Wired? |
|---|--------|--------|
| 13 | Mention volume (X, TG, TikTok, Farcaster) | **stub** — `src/twitter.mjs` |
| 14 | **Mention acceleration (2nd derivative)** | stub (contract defined) |
| 15 | Unique authors / mentions (spam ratio) | stub |
| 16 | Follower-weighted reach | stub |
| 17 | Tier-1 KOL involvement | stub + `kol_watchlist.json` |
| 18 | KOL entry vs exit / deleted call | stub (feeds a score cut) |
| 19 | Sentiment intensity & vocabulary | stub |
| 20 | Narrative / meta fit | manual (your notes) — needs X |
| 21 | Meme replicability | manual |
| 22 | Token's own Telegram growth & msg velocity | **not wired** — needs your TG session |
| 23 | Telegram call-channel signals + per-channel edge | **not wired** — `kol_watchlist.json.telegramChannels` |
| 24 | Cross-channel confirmation | not wired |
| 25 | Degen-tooling pickup (BONKbot/Photon/GMGN) | no |
| 26 | DEX Screener boosts / paid promo | yes | 
| 27 | Socials authenticity (real X history, site) | partial (presence only) |
| 28 | Google Trends breakout | no |

### C. Reflexivity, timing & regime
| # | Signal | Wired? |
|---|--------|--------|
| 30 | **Lifecycle phase** (stealth->discovery->FOMO->distribution->dead) | yes — heuristic in `src/advice.mjs` |
| 31 | Holder-cohort P&L: % underwater vs % in profit | no — needs on-chain |
| 32 | Early-cohort behaviour (diamond vs selling) | no — needs on-chain |
| 33 | Correlation / beta to SOL & BTC | **not wired** — add a macro strip |
| 34 | Macro risk regime (TOTAL3, funding, F&G) | not wired |
| 35 | Rotation flows (where cooling money goes) | not wired — planned "rotation radar" |
| 36 | Recent comparable winner priming the crowd | manual |
| 37 | Session / time-of-day | no |

### D. Adversarial / risk — what zeroes you
| # | Signal | Wired? |
|---|--------|--------|
| 38 | Honeypot / can't-sell | partial — RugCheck |
| 39 | Sell tax / transfer hooks / blacklist | partial — RugCheck |
| 40 | Mint & freeze authority active | yes — RugCheck |
| 41 | LP locked / burned; dev holds LP | partial — RugCheck |
| 42 | Top-10 holder concentration, sniper/bundle capture | **no** — needs Birdeye/Helius (biggest gap) |
| 43 | Deployer address history (recycled rugger) | no — needs on-chain |
| 44 | Wash trading (turnover w/o price discovery) | proxy — 24h turnover flag |
| 45 | Insider dump in progress | no — needs on-chain |
| 46 | Ticker impersonation / clones | no — planned (dedupe by symbol) |

**Synthesis — what persuades people to buy:** accelerating attention x credible
sources x legible narrative that fits the meta x a chart already moving x MCap
low enough that 10x feels plausible x not an obvious rug x risk-on macro. Remove
any one and the move usually fails.

---

## 2. How the score is built

```
per token:
  attention        = f(boost, profile recency, socials, tx-count velocity [, real social velocity])
  momentum         = f(price 5m/1h/6h, volume acceleration)
  liquidity_health = f(liq/mcap, turnover, absolute liquidity)
  risk             = f(rugcheck norm, LP lock, mint auth, freeze auth)      # higher = worse

  base      = weighted(attention, momentum, liquidity_health)              # config.weights.composite
  composite = base * (1 - riskCutMax * risk)  * (0.6 if KOL exit)          # 0..100
  verdict   = AVOID | STRONG | WATCH | NEUTRAL                             # config.thresholds
```

All weights, thresholds and scan filters live in **`config.json`** — tune without
touching code. Normalisation curves are in `src/features.mjs` (log for money
amounts, `tanh` for ratios, sigmoid for signed price moves).

Every raw signal -> normalised feature mapping is commented against the taxonomy
numbers above.

---

## 3. The multi-agent panel

### What "multi-agent" has to mean here

Five models that all see the same momentum data will all agree with the
momentum. That is an expensive way to buy one opinion. So the panel is built on
three rules:

1. **Specialists see different slices.** Each agent gets only its own data (via
   `select()` in `src/agents/roster.mjs`) and is told to say "I can't see that"
   rather than speculate. Different inputs → genuinely different failure modes.
2. **It's a pipeline, not a fan-out.** Stage 2 sees stage 1; stage 3 sees
   everything. There is a dedicated **red team** whose only job is the bear case
   and naming the panel's blind spot — the highest-value agent, because every
   other signal in this system is momentum-biased.
3. **Disagreement is the product.** Unanimity among momentum-biased specialists
   is weak evidence. The dashboard flags a SPLIT panel and tells you to read the
   dissent.

| Stage | Agent | Model | Effort | Sees |
|---|---|---|---|---|
| 1 | `microstructure` | Sonnet 5 | low | liquidity, flow, turnover, acceleration (taxonomy A) |
| 1 | `narrative` | Opus 5 | medium | name/ticker/socials + X data (taxonomy B) — the semantic call, hence the top model |
| 1 | `forensics` | Sonnet 5 | low | RugCheck, authorities, LP, age (taxonomy D) |
| 2 | `redteam` | Opus 5 | medium | everything **+ stage 1's calls** |
| 3 | `arbiter` | Opus 5 | high | everything + red team + rule score + **the scorecards** |

Only the arbiter's output becomes "the read" on the card.

### The funnel — why this doesn't cost $150/day

```
every scan (free)   deterministic score for 15-80 tokens
      |             + a baseline_rules prediction logged for ALL of them
      v
PROMOTION GATE      composite >= promoteScore
                    AND (never analysed OR the feature vector actually MOVED
                         OR the last read is stale)
                    AND under the per-scan / per-day spend cap
      v
stage 1 (parallel) -> stage 2 (only if stage 1 disagrees or is confident) -> stage 3
```

The **cache-on-delta** rule does most of the work: between two scans five minutes
apart most tokens have not moved enough to change anyone's mind, so re-asking is
pure spend. Only material movement (mean absolute change across the normalised
feature vector > `deltaThreshold`) buys a new opinion.

Two more cost levers are in `src/agents/client.mjs`:

- **Prompt caching.** Each agent's system prompt (role + rubric) is frozen and
  cached with a 1h TTL, so it stays warm across 5-minute scans. Caching is a
  *prefix* match, so the volatile per-token feature JSON goes in the user
  message — putting it in `system` would invalidate the cache every call.
- **Structured outputs.** `output_config.format` with a JSON schema: no retry
  loop for malformed JSON, no wasted prose tokens.

Rough per-call cost at ~2k in / 500 out (Opus 5 $5/$25 per MTok, Sonnet 5
$2/$10): ~$0.023 Opus, ~$0.009 Sonnet, and much less once the cached prefix is
being read at ~0.1x. With the shipped defaults (`promoteScore` 62,
`maxTokensPerScan` 3) a typical scan promotes 0–3 tokens, and `maxSpendPerScanUsd`
/ `maxSpendPerDayUsd` are hard stops. Live spend shows in the dashboard header.

---

## 4. Curating it — the part that makes any of this real

**An agent that cannot be scored does not belong on the dashboard.** So every
agent — and the free deterministic score, logged as the `baseline_rules`
pseudo-agent — must emit the same falsifiable, time-boxed envelope:

```json
{ "call": "long|pass|avoid", "predicted_direction": "up|down|flat",
  "horizon_minutes": 15|60|360, "conviction": 0.0-1.0,
  "invalidation_pct": -25, "reasoning": "...", "key_risk": "..." }
```

The loop:

| File | Job |
|---|---|
| `src/ledger.mjs` | Writes every call the moment it's made, with entry price, liquidity, mcap tier, phase, cost, and the feature snapshot that produced it. |
| `src/grader.mjs` | Runs each scan (free). Finds predictions whose horizon elapsed, prices them in one batched DEX Screener call, reconstructs max favourable/adverse excursion from the price history, and marks hit/miss. **A pair that stopped trading grades as −100%, not as missing data.** |
| `src/scorecard.mjs` | Turns graded calls into hit rate, **Brier score**, a **calibration curve** (does stated conviction actually predict being right?), long expectancy, rug count, cost per correct call, and edge broken down by phase / mcap tier / horizon. |

Two design choices carry the weight:

- **The arbiter is handed the scorecards inside its prompt.** An agent with a 30%
  hit rate over 40 calls is explicitly told to be discounted; one with fewer than
  10 graded calls is marked `UNPROVEN` rather than good. That is the self-curating
  loop — the panel reweights itself on measured performance, exactly the way you
  should weight your Telegram call channels by their realised edge (taxonomy #23).
- **`baseline_rules` is in the same table as the benchmark.** The `vs base` column
  shows whether each paid agent beats the free deterministic score. **If it
  doesn't, turn it off** — that's the whole point of measuring.

Guardrails so the numbers mean something: a ±5% dead band (`FLAT_BAND_PCT`) stops
an agent being credited for calling a 0.4% drift; conviction must mean confidence
in the *stated direction*, not a recycled momentum score; and hit rate is only
shown alongside `n_graded` so you can see when it's noise.

Read it at the **Scorecard** tab, or `node run.mjs scorecard`.

### What this deliberately does not do

It does not execute. No keys, no wallet, no order routing — it produces a card
and a track record, and you decide. Adding execution to a system whose agents
have not yet earned a measured edge is how people lose money quickly.

---

## 6. Wiring the missing sources

| Source | File | What to do |
|--------|------|-----------|
| **X / Twitter** | `src/twitter.mjs` | Implement `viaXApi` or `viaProvider` to return the documented contract (mentions 1h + prev, unique authors, follower reach, KOL hits, sentiment). Set `TWITTER_BEARER_TOKEN` or `SOCIAL_API_BASE`/`SOCIAL_API_KEY`. The feature + score layers already consume it. |
| **Telegram** | new `src/telegram.mjs` | Use your session (GramJS string session in `.env`, never in a committed file). Read the channels you're in; emit per-token: first-seen channel, cross-channel count, message velocity, admin/call text. Feed into `buildFeatures` like `social`. Weight each channel by `kol_watchlist.json.telegramChannels[].edge` (your own backtest of that channel's hit-rate). |
| **On-chain holders / authorities / LP** | new `src/onchain.mjs` | Birdeye or Helius: top-10 concentration, bundle/sniper capture at launch, deployer history, real unique makers. This is the biggest accuracy gap — closes taxonomy #8, #9, #31, #32, #42, #43, #45. |
| **Macro strip** | new `src/macro.mjs` | CoinGecko / a funding-rate API: SOL & BTC 24h, TOTAL3, Fear & Greed. Apply as a global multiplier on every `composite` (risk-off => haircut everything). Taxonomy #33, #34. |
| **Rotation radar** | dashboard panel | Diff consecutive scans: which tokens are losing composite while others in the same narrative gain — that's where the money is going (#35). |

The `cse_...` string you mentioned looks like an external service session token —
keep it in `.env` only, never in a file that gets shared or published.

---

## 5. Data on disk (`data/`)

- `latest.json` — full result of the most recent scan (what the dashboard reads)
- `history/<mint>.json` — append-only score + price time-series per token
- `scans/<ts>.json` — raw snapshot of every scan (last 200 kept)
- `notes.json` — your per-token notes (fed into the arbiter's prompt)
- `ledger.json` — **every prediction ever made, with its graded outcome**
- `agent_state.json` — last-analysed feature vector per token (the delta gate) + daily spend

`ledger.json` is the file worth backing up. It is your entire evidence base:
point a notebook at it and you can ask questions the dashboard doesn't — which
phase your edge actually lives in, whether your hit rate decays with market cap,
whether the panel is worth its cost.

Point your own scripts / notebooks straight at these.

---

## 7. FOMO modelling (`src/fomo.mjs`)

The scanner's other pillars measure *mechanics*. This one measures the thing that
actually moves a memecoin: what makes a person feel they are missing something
right now. Four ideas, each correcting a specific error in naive momentum:

1. **Rate beats size.** +200% over six hours induces nothing; +200% in twenty
   minutes induces panic buying. The derivative is the trigger.
2. **The second chance is the strongest setup.** Peak buying pressure is not at
   the top — it is when someone *watched* a coin run, missed it, saw it dip, and
   now sees it turning back up. Regret plus a perceived discount.
3. **Attention is an inverted U, not a line.** Unknown = no bid. Everyone knows =
   already priced, and you are the exit liquidity. A model that treats more
   attention as monotonically better buys tops by construction. Measured against
   the *tier median* transaction count, on a log scale, peaking at ~3×.
4. **FOMO is relative.** A coin running alone in a quiet session captures the
   whole crowd; the same chart with five rivals splits it. Cohort share, session
   breadth, and narrative crowding all gate the score.

Plus Schelling points (round market caps) and distance from the highest price we
have actually observed. Anything needing history we do not have returns `null`
and renormalises — never a fabricated number.

## 8. Percentile verdicts

Absolute thresholds were why this system logged 77 predictions and **zero
directional calls**: a fixed `STRONG >= 76` never fires once the distribution
sits below the guess that set it, so the ledger fills with passes and the
curation loop has nothing to learn from. **A system that never commits cannot be
measured.** Verdicts are now percentile-based per scan, with `absoluteFloor` as
the safety valve so the best of a bad field still does not earn a long.

## 9. Adaptation (`src/adapt.mjs`)

`node run.mjs adapt` regresses graded outcomes against the feature vector each
call was made from — Spearman rank, not Pearson, because one 40× would otherwise
set every weight. Three guards keep it honest:

- **Significance gate:** |IC| must clear ±2/√n or it is reported as noise.
- **Shrinkage:** proposals blend toward the hand-set prior by n/(n+K). Thin data
  cannot move anything.
- **Nothing auto-applies.** Proposals land in `data/adapted_weights.json`;
  `adapt.apply` in config.json is a deliberate switch.

Feature vectors and a `model_version` are stamped on every ledger row, so a
scoring change can be segmented out instead of silently mixing two models.


## 10. Limitations (be honest with yourself)

- Discovery is boost/profile/search biased — it is **not** a true "everything
  trending" feed. Widen `config.scan.discovery.searchTerms` and raise
  `maxCandidates`, or add a proper trending source.
- No holder/insider data yet => risk score is contract-safety only, not
  distribution risk. Treat every STRONG as "worth a look", never "safe".
- Momentum signals are backward-looking. The lifecycle phase is a heuristic.
- **The panel starts with zero track record.** Until you have 30–50 graded calls
  per agent, the scorecard is noise and the arbiter is told so. Run it in
  `loop` mode for a few days before you believe any of it — and if the agents
  never beat `baseline_rules`, the honest conclusion is to switch them off.
- Grading uses the *terminal* price at the horizon plus MFE/MAE reconstructed
  from scan samples. A 5-minute scan interval means the excursion figures are
  coarse; they are not tick data.
- This is a momentum/attention scanner. **Not financial advice, not a valuation.**
