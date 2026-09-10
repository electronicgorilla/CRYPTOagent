// THE RUG CLOCK.
//
// Origin: a live observation. APEZCAT was captured in this system's own ledger
// climbing $28,175 -> $32,808 of liquidity across five minutes while price ran
// +94% in eleven, scoring a placid 59-66 the entire way. Minutes later it was
// pulled. The scanner watched it happen and said nothing, because every risk
// signal it had was STATIC - RugCheck read once and cached for thirty minutes.
//
// The correction: rug risk is not a property of a token, it is a COUNTDOWN.
// The stated mechanism is
//
//     attention arrives -> liquidity is ATTRACTED -> once the pool is worth
//     stealing, it is pulled
//
// which means the tell is in the liquidity TRAJECTORY, not in the contract and
// not in the price. A pool being loaded with other people's money is a pool
// being prepared for harvest.
//
// FIVE COMPONENTS, and each one is necessary rather than decorative:
//   capability   - can they even rug? no unlocked LP, no rug. This GATES the
//                  rest: without capability the clock does not run at all.
//   harvestValue - is the pool worth the effort yet? too small is not worth
//                  burning a wallet for; too large is usually watched. The
//                  danger is a band, not a threshold.
//   inflow       - is LP accumulating right now? this is the bait loading.
//   chase        - price outrunning liquidity means buyers are crowding a thin
//                  pool, which is what makes the harvest fat.
//   youth        - the overwhelming majority of pulls happen in the first hours.
//
// HONESTY ABOUT WHAT THIS IS. This is a hypothesis derived from one observed
// case plus a well-known mechanism - it is NOT a validated model. In this
// system's own ledger only 7 of 237 graded rows ended in liquidity collapse,
// about 3%. Predicting a 3% event is unforgiving: a detector that fires freely
// will be wrong most times it speaks. So the clock logs itself to the ledger as
// its own agent and gets graded like everything else. If it cannot beat the
// base rate, that will show up in the scorecard and it should be switched off.

const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const num = (v) => (typeof v === "number" && isFinite(v) ? v : 0);

/** Inverted-U on log liquidity: too small to bother, too large to be quiet. */
function harvestValue(liq, lo, hi) {
  if (!liq || liq <= 0) return 0;
  if (liq < lo) return clamp(liq / lo) * 0.35;          // not worth it yet
  if (liq > hi) return clamp(hi / liq) * 0.5;            // big enough to be watched
  const t = (Math.log10(liq) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo));
  return clamp(0.55 + 0.45 * Math.sin(Math.PI * t));     // peak mid-band
}

export function rugClock(feat, history = [], cfg = {}) {
  const c = cfg.rugclock || {};
  const lo = c.harvestBandLow ?? 12000;
  const hi = c.harvestBandHigh ?? 250000;
  const win = (c.inflowWindowMinutes ?? 30) * 60;

  const liq = num(feat.liqUsd);
  const nr = feat.nRisk || {};
  const reasons = [];

  // --- capability. This gates everything: no capability, no countdown. ---
  // Unknown counts as partial, not clean - absence of evidence is not safety.
  const capability = clamp(0.45 * num(nr.lpLocked) / 0.6 + 0.35 * num(nr.mintAuthority) / 0.85 + 0.2 * num(nr.freezeAuthority) / 0.7);
  if (nr.lpLocked >= 0.6) reasons.push("LP is not confirmed locked — the pool can be withdrawn");
  if (nr.mintAuthority >= 0.8) reasons.push("mint authority still live — supply can be inflated into the bid");

  // --- harvest value ---
  const value = harvestValue(liq, lo, hi);
  if (liq >= lo && liq <= hi)
    reasons.push(`liquidity $${Math.round(liq).toLocaleString()} sits inside the harvest band ($${(lo/1000)}k–$${(hi/1000)}k)`);

  // --- inflow: the bait loading ---
  const now = Date.now() / 1000;
  const recent = history.filter((h) => h.liq > 0 && now - h.ts <= win).sort((a, b) => a.ts - b.ts);
  let inflow = 0, inflowPct = null, minutes = null;
  if (recent.length >= 2) {
    const first = recent[0], last = recent[recent.length - 1];
    minutes = (last.ts - first.ts) / 60;
    if (minutes >= 1 && first.liq > 0) {
      inflowPct = ((last.liq - first.liq) / first.liq) * 100;
      const perHour = (inflowPct / minutes) * 60;
      inflow = clamp(Math.tanh(Math.max(0, perHour) / 90));
      if (perHour > 40)
        reasons.push(`LP growing ${perHour.toFixed(0)}%/hr (+${inflowPct.toFixed(0)}% over ${minutes.toFixed(0)}m) — deposits are arriving`);
      else if (perHour < -25)
        reasons.push(`LP SHRINKING ${perHour.toFixed(0)}%/hr — withdrawal may already be underway`);
    }
  }
  // Liquidity actively draining is the most acute state there is.
  const draining = inflowPct != null && inflowPct < -12;

  // --- chase: price outrunning the pool ---
  const pxH1 = num(feat.priceChange?.h1);
  const chase = clamp((pxH1 - (inflowPct ?? 0)) / 120);
  if (pxH1 > 40 && (inflowPct == null || pxH1 > inflowPct * 2))
    reasons.push(`price +${pxH1.toFixed(0)}% on a pool that is not deepening in step — buyers are crowding thin liquidity`);

  // --- youth ---
  const ageH = num(feat.ageH);
  const youth = ageH < 1 ? 1 : ageH < 6 ? 0.85 : ageH < 24 ? 0.55 : ageH < 72 ? 0.3 : 0.12;
  if (ageH < 6) reasons.push(`pool is ${ageH < 1 ? Math.round(ageH * 60) + " minutes" : ageH.toFixed(1) + " hours"} old`);

  const W = { capability: 0.30, value: 0.22, inflow: 0.22, chase: 0.14, youth: 0.12 };
  const parts = { capability, value, inflow, chase, youth };
  let raw = 0;
  for (const [k, w] of Object.entries(W)) raw += parts[k] * w;

  // Capability is a gate, not a term: a locked pool with renounced authorities
  // cannot be pulled no matter how attractive it looks.
  const gated = raw * (0.35 + 0.65 * capability);
  let pressure = Math.round(clamp(gated) * 100);
  if (draining) pressure = Math.min(100, pressure + 20);

  const band = pressure >= 75 ? "critical" : pressure >= 60 ? "elevated"
             : pressure >= 40 ? "watch" : "low";

  return {
    pressure,
    band,
    draining,
    components: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Math.round(v * 100)])),
    liq_change_pct: inflowPct == null ? null : Math.round(inflowPct * 10) / 10,
    window_minutes: minutes == null ? null : Math.round(minutes),
    samples: recent.length,
    reasons: reasons.slice(0, 4),
    // Stated plainly so it is never mistaken for a validated probability.
    caveat: "Hypothesis under test. Liquidity collapse is ~3% of graded rows here, so most high readings will be wrong; the scorecard decides whether this earns its place.",
  };
}

/** Gradeable form, so the hypothesis is tested rather than believed. */
export function rugPrediction(feat, rug, cfg = {}) {
  const alertAt = cfg.rugclock?.alertAt ?? 60;
  if (!rug || rug.pressure < alertAt) return null;
  return {
    call: "avoid",
    predicted_direction: "down",
    horizon_minutes: 60,
    conviction: Math.round(clamp((rug.pressure - alertAt) / (100 - alertAt)) * 100) / 100,
    invalidation_pct: 25,
    reasoning: rug.reasons.slice(0, 2).join("; ") || `rug pressure ${rug.pressure}`,
    key_risk: "base rate for liquidity collapse is ~3% — this fires on a rare event and will often be wrong",
  };
}
