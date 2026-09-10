// FOMO modelling - the crowd-psychology layer.
//
// The rest of the scanner measures MECHANICS (liquidity, flow, turnover). This
// file measures the thing that actually moves a memecoin: what makes a human
// feel they are missing something right now.
//
// Four ideas do the work, and each corrects a specific error in a naive
// momentum model:
//
//  1. RATE BEATS SIZE. +200% over six hours does not induce FOMO; +200% in
//     twenty minutes does. The derivative is the trigger, not the level.
//  2. THE SECOND CHANCE IS THE STRONGEST SETUP. Peak buying pressure is not at
//     the top - it is when someone WATCHED a coin run, missed it, saw it dip,
//     and now sees it turning back up. Regret plus a perceived discount.
//  3. ATTENTION IS AN INVERTED U, NOT A LINE. Unknown = no bid. Everyone knows
//     = already priced, and you are the exit liquidity. The money is in the
//     band between. A model that treats more attention as monotonically better
//     is buying tops by construction.
//  4. FOMO IS RELATIVE, NOT ABSOLUTE. A coin running alone in a quiet session
//     captures the whole crowd; the same chart with five rivals running splits
//     it. Share of attention matters more than attention.
//
// Everything here is computed from data already on hand (DEX Screener windows,
// our own stored price history, and the rest of the scanned cohort). Nothing is
// invented, and anything that needs history we do not have returns null rather
// than a fabricated number.

const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const num = (v) => (typeof v === "number" && isFinite(v) ? v : 0);

/** Bell curve peaking at `peak`. The inverted-U in idea 3. */
function invertedU(x, peak = 0.68, width = 0.34) {
  if (x == null) return null;
  return clamp(Math.exp(-((x - peak) ** 2) / (2 * width ** 2)));
}

// Round market-cap numbers act as Schelling points: attention, screenshots and
// "next stop $1M" posts cluster there. pump.fun's bonding-curve graduation is
// the same phenomenon with a hard gate attached.
const MILESTONES = [
  100_000, 250_000, 500_000, 1_000_000, 2_500_000,
  5_000_000, 10_000_000, 25_000_000, 50_000_000, 100_000_000,
];

// Meme families. Used to measure how crowded a narrative already is - the
// seventh cat coin of the day has less headroom than the first.
const NARRATIVE_TOKENS = [
  "cat", "dog", "shib", "inu", "pepe", "frog", "wif", "bonk", "moon", "pump",
  "ai", "agent", "gpt", "grok", "trump", "elon", "musk", "baby", "gold",
  "chill", "retard", "gay", "test", "coin", "sol", "eth", "btc",
];

/**
 * Cohort-level context. Computed once per scan over every scored token, because
 * ideas 3 and 4 are only meaningful relative to the rest of the field.
 */
export function buildCohort(feats) {
  const totalVolH1 = feats.reduce((a, f) => a + num(f.volume?.h1), 0);
  const green = feats.filter((f) => num(f.priceChange?.h1) > 0).length;
  const breadth = feats.length ? green / feats.length : 0.5;

  // How many tokens share each narrative family right now.
  const families = new Map();
  for (const f of feats) {
    for (const fam of familiesOf(f)) families.set(fam, (families.get(fam) || 0) + 1);
  }

  // Median transaction count per mcap tier, so "unusually talked about for its
  // size" is measured against the field rather than a hard-coded guess.
  const byTier = new Map();
  for (const f of feats) {
    const t = tierOf(f.mcap);
    if (!byTier.has(t)) byTier.set(t, []);
    byTier.get(t).push(num(f.txns?.h1));
  }
  const tierMedianTx = new Map();
  for (const [t, xs] of byTier) {
    const s = xs.sort((a, b) => a - b);
    tierMedianTx.set(t, s[s.length >> 1] || 1);
  }

  return {
    n: feats.length,
    totalVolH1,
    breadth,
    families,
    tierMedianTx,
    // Risk-on sessions amplify every FOMO signal; risk-off sessions mute them
    // no matter how good an individual chart looks.
    regime: breadth > 0.6 ? "risk-on" : breadth < 0.35 ? "risk-off" : "mixed",
  };
}

function tierOf(mcap) {
  if (!mcap) return "unknown";
  if (mcap < 100_000) return "<100k";
  if (mcap < 1_000_000) return "100k-1M";
  if (mcap < 10_000_000) return "1M-10M";
  return ">10M";
}

function familiesOf(f) {
  const hay = `${f.symbol || ""} ${f.name || ""}`.toLowerCase();
  return NARRATIVE_TOKENS.filter((t) => hay.includes(t));
}

/**
 * Per-token FOMO features. `history` is this token's stored price series
 * (from store.history) and may be empty on first sight.
 */
export function buildFomo(f, cohort, history = []) {
  const pc = f.priceChange || {};
  const vol = f.volume || {};
  const reasons = [];

  // --- 1. gain velocity: how fast the visible gain is accruing RIGHT NOW ---
  // The 5m move scaled to an hourly rate, against what the last hour actually
  // did. >1 means the tape is faster now than it has been.
  const m5Hourly = num(pc.m5) * 12;
  const velocityRatio = Math.abs(num(pc.h1)) > 1 ? m5Hourly / Math.abs(num(pc.h1)) : 0;
  const gainVelocity = num(pc.m5) > 0 ? clamp(Math.tanh(velocityRatio / 1.5)) : 0;
  if (gainVelocity > 0.5) reasons.push(`accelerating now (5m pace ${velocityRatio.toFixed(1)}x the last hour)`);

  // --- 2. the second chance ---
  // Ran hard over 6h, cooled or paused on 1h, turning back up on 5m. This is
  // the regret-plus-discount setup, and it is where retail buys hardest.
  const ran = clamp((num(pc.h6) - 25) / 75);            // needed a real run
  const cooled = clamp((10 - num(pc.h1)) / 25);          // then paused/dipped
  const turning = clamp(num(pc.m5) / 6);                 // now ticking up
  const secondChance = ran * cooled * turning;
  if (secondChance > 0.25)
    reasons.push(`second-chance setup: +${num(pc.h6).toFixed(0)}% 6h, cooled to ${num(pc.h1).toFixed(0)}% 1h, turning up`);

  // --- 3. attention saturation (the inverted U) ---
  // Transaction count vs what is typical for this market-cap tier. Low = nobody
  // knows yet (no bid). High = everyone knows (you are the exit). Peak is
  // between - known enough to have a bid, not so known it is priced.
  const tierMed = cohort.tierMedianTx.get(tierOf(f.mcap)) || 1;
  const saturationRaw = num(f.txns?.h1) / Math.max(tierMed, 1);
  // Log scale, NOT clamped: saturation ranges over orders of magnitude here
  // (0.2x to 40x tier median is normal), and clamping before the curve made a
  // 39x-saturated token score the same as a 3x one. 3x tier median is the peak
  // - known enough to have a bid, not so known that it is already priced.
  const satX = Math.log10(1 + saturationRaw) / Math.log10(7);
  const attentionSweet = invertedU(satX);
  if (saturationRaw > 3.5) reasons.push(`attention saturated (${saturationRaw.toFixed(1)}x tier median tx) - likely already priced`);
  else if (saturationRaw < 0.4) reasons.push(`barely discovered (${saturationRaw.toFixed(1)}x tier median tx) - no bid yet`);

  // --- 4. share of the crowd ---
  const attentionShare = cohort.totalVolH1
    ? clamp(num(vol.h1) / cohort.totalVolH1 / 0.25) // 25% of field volume = max
    : 0;
  if (attentionShare > 0.5) reasons.push(`capturing ${((num(vol.h1) / cohort.totalVolH1) * 100).toFixed(0)}% of cohort volume`);

  // --- 5. distance from the high we have actually observed ---
  // At highs, the story is "it keeps going". Well off highs, the story is
  // "I missed it" and the bid is thinner. Null when we lack history rather
  // than pretending the current price is the high.
  const prices = history.map((h) => h.price).filter((p) => p > 0);
  let athProximity = null, drawdown = null;
  if (prices.length >= 3) {
    const max = Math.max(...prices, f.priceUsd);
    drawdown = max > 0 ? (max - f.priceUsd) / max : 0;
    athProximity = clamp(1 - drawdown / 0.5); // 50% off the high => 0
    if (drawdown > 0.35) reasons.push(`${(drawdown * 100).toFixed(0)}% off its observed high - the "missed it" zone`);
    else if (drawdown < 0.05) reasons.push("at/near its observed high");
  }

  // --- 6. milestone proximity (Schelling points) ---
  let milestone = 0, milestoneLabel = null;
  const mc = num(f.mcap);
  if (mc > 0) {
    const next = MILESTONES.find((m) => m > mc);
    if (next) {
      const ratio = mc / next;
      // within ~20% below a round number is where "next stop $Xm" posting starts
      milestone = clamp((ratio - 0.78) / 0.22);
      if (milestone > 0.45) {
        milestoneLabel = `$${next >= 1e6 ? next / 1e6 + "M" : next / 1e3 + "k"}`;
        reasons.push(`approaching ${milestoneLabel} market cap`);
      }
    }
  }

  // --- 7. narrative crowding ---
  const fams = familiesOf(f);
  const crowdCount = fams.length ? Math.max(...fams.map((x) => cohort.families.get(x) || 1)) : 1;
  const narrativeRoom = clamp(1 - (crowdCount - 1) / 6);
  if (crowdCount >= 4) reasons.push(`crowded narrative - ${crowdCount} similar tickers in this scan`);

  // --- composite ---
  // Weighted blend, then scaled by the session regime. A perfect chart in a
  // risk-off tape is still a bad trade: the crowd is not there to buy it.
  const parts = {
    gainVelocity: { v: gainVelocity, w: 0.2 },
    secondChance: { v: secondChance, w: 0.24 },
    attentionSweet: { v: attentionSweet, w: 0.2 },
    attentionShare: { v: attentionShare, w: 0.14 },
    athProximity: { v: athProximity, w: 0.1 },
    milestone: { v: milestone, w: 0.06 },
    narrativeRoom: { v: narrativeRoom, w: 0.06 },
  };
  let sum = 0, wsum = 0;
  for (const p of Object.values(parts)) {
    if (p.v == null) continue; // missing history renormalises rather than scoring 0
    sum += p.v * p.w;
    wsum += p.w;
  }
  const base = wsum ? sum / wsum : 0;
  const regimeMult = cohort.breadth > 0.6 ? 1.1 : cohort.breadth < 0.35 ? 0.75 : 1.0;
  const fomo = clamp(base * regimeMult);

  return {
    fomo,
    regime: cohort.regime,
    breadth: cohort.breadth,
    components: Object.fromEntries(
      Object.entries(parts).map(([k, p]) => [k, p.v == null ? null : Math.round(p.v * 1000) / 1000])
    ),
    drawdown: drawdown == null ? null : Math.round(drawdown * 1000) / 1000,
    saturation: Math.round(saturationRaw * 100) / 100,
    milestoneLabel,
    narrativeCrowd: crowdCount,
    reasons,
  };
}
