// Deterministic, rule-based read on a token. No LLM needed.
// Produces: lifecycle phase, thesis, risk flags, invalidation levels, framing,
// confidence. A momentum/attention read - not financial advice, not a valuation.

const usd = (n) =>
  n >= 1e6 ? "$" + (n / 1e6).toFixed(2) + "M"
  : n >= 1e3 ? "$" + (n / 1e3).toFixed(1) + "k"
  : "$" + Number(n).toFixed(n < 1 ? 6 : 2);
const pct = (n) => (n >= 0 ? "+" : "") + Number(n).toFixed(0) + "%";

function phase(feat) {
  const { priceChange: pc, ageH, volAccel, txVelocity } = feat;
  const { h1, h6, h24 } = pc;
  if (ageH < 1 && (volAccel > 1.2 || txVelocity > 1.3))
    return ["discovery", "Fresh pool, order flow picking up. Highest variance - most of these fade within the hour."];
  if (h1 > 15 && h6 > 45 && volAccel > 1.1)
    return ["markup / FOMO", "Price and volume both expanding. The crowd is arriving; you are not early, you are momentum."];
  if (h1 < 0 && h6 > 30)
    return ["distribution / cooling", "Up over 6h but rolling over on 1h - early buyers taking profit into the bids."];
  if (h24 < -35 && volAccel < 0.9)
    return ["post-peak / bleed", "Down hard over 24h with fading volume. Needs a fresh catalyst or it keeps bleeding."];
  if (h1 >= -10 && h1 <= 12 && h6 >= -20 && h6 <= 25)
    return ["base / accumulation", "Range-bound. Either building for a move or quietly dying - volume is the tell."];
  return ["mixed", "Signals do not line up cleanly into one phase."];
}

export function generateAdvice(feat, sc) {
  const [ph, phNote] = phase(feat);
  const { priceChange: pc, n, nRisk: nr, liqUsd: liq } = feat;
  const thesis = [], risks = [], invalidation = [];

  if (n.volumeAccel > 0.55) thesis.push(`Volume accelerating (~${feat.volAccel.toFixed(1)}x the prior-window rate).`);
  if (n.txnVelocity > 0.5) thesis.push(`Transaction count running ${feat.txVelocity.toFixed(1)}x its 6h average - participation widening.`);
  if (feat.buyRatioH1 > 0.58) thesis.push(`1h order flow buy-skewed (${(feat.buyRatioH1 * 100).toFixed(0)}% buys).`);
  if (n.liqMcapRatio > 0.5) thesis.push(`Liquidity is ${(feat.liqMcapRatio * 100).toFixed(1)}% of market cap - relatively deep for the tier.`);
  if (feat.hasBoost) thesis.push(`DEX Screener boost active (amount ${feat.boostAmount.toFixed(0)}) - someone is paying for visibility.`);
  if (feat.hasRecentProfile) thesis.push("Token profile just published/updated - the discovery surface is live.");
  const s = feat.socialRaw;
  if (s) {
    thesis.push(`Social: ${s.mentions1h || 0} mentions last hour (prev ${s.mentions1hPrev || 0}), reach ~${(s.followersReach24h || 0).toLocaleString()}.`);
    for (const h of s.kolHits || []) if (h.action !== "exit") thesis.push(`KOL @${h.handle} (w=${h.weight}) posted a call.`);
  }
  if (!thesis.length) thesis.push("No strong positive driver - this is a low-conviction row.");

  const rr = feat.riskRaw || {};
  risks.push(rr.norm != null ? `RugCheck normalised risk ${Number(rr.norm).toFixed(0)}/100.` : "No RugCheck data - contract safety unverified.");
  for (const f of (rr.flags || []).slice(0, 5)) risks.push("RugCheck flag: " + f);
  if (nr.mintAuthority >= 0.8) risks.push("Mint authority appears active - supply can be inflated.");
  if (nr.freezeAuthority >= 0.7) risks.push("Freeze authority appears active - your wallet can be frozen.");
  if (nr.lpLocked >= 0.6) risks.push("LP not confirmed locked/burned - liquidity pull risk.");
  if (liq < 20000) risks.push(`Thin liquidity (${usd(liq)}) - slippage and exit risk are high.`);
  if (feat.ageH < 1) risks.push("Under an hour old - no track record, snipers still positioned.");
  if (feat.turnoverH24 > 8) risks.push(`24h turnover ${feat.turnoverH24.toFixed(1)}x liquidity - possible wash volume.`);
  if (feat.kolExit) risks.push("A tracked KOL signalled an exit / deleted a call.");

  invalidation.push(`Liquidity falls below ${usd(liq * 0.6)} (now ${usd(liq)}).`);
  if (pc.h1 > 0) invalidation.push("1h return flips negative while volume stays high (distribution starting).");
  invalidation.push(`Price gives back the 6h move (${pct(pc.h6)}) - loses its trend.`);
  invalidation.push("Buy/sell flow flips to >55% sells on 1h.");
  invalidation.push("[needs on-chain wiring] dev or a top-5 wallet starts selling.");
  invalidation.push("[needs X wiring] the account that drove attention deletes the post or posts an exit.");

  const missingChecks = [
    "Holder concentration / top-10 % (needs Birdeye or Helius).",
    "Bundle / sniper capture at launch (needs on-chain).",
    "Deployer wallet history - recycled rugger? (needs on-chain).",
    "Narrative / meta fit vs what is hot right now (needs X + your read).",
    "SOL / BTC regime - are majors bid or dumping (add a macro strip).",
  ];

  let confidence = "low";
  if (sc.composite >= 76 && sc.risk < 45) confidence = "high";
  else if (sc.composite >= 60) confidence = "medium";
  if (sc.hardAvoid) confidence = "low";

  return {
    phase: ph,
    phaseNote: phNote,
    thesis, risks, invalidation, missingChecks,
    framing:
      "Momentum/attention read only. Size for a full loss - these round-trip fast. " +
      "Define the exit before entry; the invalidation list is your stop. Not financial advice.",
    confidence,
  };
}
