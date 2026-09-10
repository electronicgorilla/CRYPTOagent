// Turn a raw DEX Screener pair (+ risk + social context) into normalised 0..1
// signals. Every `n[...]` key maps to an entry in the taxonomy (see README).

const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));

function logNorm(x, lo, hi) {
  if (!x || x <= 0) return 0;
  return clamp((Math.log10(x) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo)));
}
const linNorm = (x, lo, hi) => (x == null ? 0 : clamp((x - lo) / (hi - lo)));
// signed move -> 0..1 centred on 0.5
const updown = (x, scale) => (x == null ? 0.5 : clamp(0.5 + 0.5 * Math.tanh(x / scale)));
const ratioPos = (x, scale) => (!x || x <= 0 ? 0 : clamp(Math.tanh(x / scale)));
const num = (v) => (typeof v === "number" && isFinite(v) ? v : 0);

export function buildFeatures(pair, risk = {}, social = null) {
  const meta = pair._meta || {};
  const now = Date.now() / 1000;

  const liq = num(pair.liquidity?.usd);
  const mcap = num(pair.marketCap) || num(pair.fdv) || 0;
  const fdv = num(pair.fdv);
  const createdMs = pair.pairCreatedAt || 0;
  const ageMin = createdMs ? (now - createdMs / 1000) / 60 : 1e9;

  const pc = {};
  for (const k of ["m5", "h1", "h6", "h24"]) pc[k] = num(pair.priceChange?.[k]);
  const vol = {};
  for (const k of ["m5", "h1", "h6", "h24"]) vol[k] = num(pair.volume?.[k]);
  const tx = {};
  for (const k of ["m5", "h1", "h6", "h24"])
    tx[k] = num(pair.txns?.[k]?.buys) + num(pair.txns?.[k]?.sells);
  const buysH1 = num(pair.txns?.h1?.buys), sellsH1 = num(pair.txns?.h1?.sells);
  const buyRatioH1 = buysH1 + sellsH1 ? buysH1 / (buysH1 + sellsH1) : 0.5;

  const accA = vol.h1 ? (vol.m5 * 12) / vol.h1 : 0;
  const accB = vol.h6 ? (vol.h1 * 6) / vol.h6 : 0;
  const volAccel = Math.max(accA, accB);
  const txVelocity = tx.h6 ? tx.h1 / (tx.h6 / 6) : 0;

  const turnoverH1 = liq ? vol.h1 / liq : 0;
  const turnoverH24 = liq ? vol.h24 / liq : 0;
  const liqMcap = mcap ? liq / mcap : 0;

  const info = pair.info || {};
  const socials = info.socials || [];
  const websites = info.websites || [];
  const socialsQuality = clamp(
    0.35 * (info.imageUrl ? 1 : 0) +
    0.30 * (websites.length ? 1 : 0) +
    0.12 * Math.min(socials.length, 3)
  );

  // --- social (present only once the X collector is wired) ---
  let sAccel = null, sReach = null, sSpam = null, sSent = null, sKol = null, kolExit = false;
  if (social) {
    const m1 = social.mentions1h || 0, m0 = social.mentions1hPrev || 0;
    sAccel = (m1 + 1) / (m0 + 1);
    const auth = social.uniqueAuthors24h || 0, m24 = social.mentions24h || 1;
    sSpam = 1 - clamp(auth / m24);
    sReach = social.followersReach24h ?? null;
    sSent = social.sentiment ?? null;
    const hits = social.kolHits || [];
    sKol = hits.filter((h) => h.action !== "exit").reduce((a, h) => a + (h.weight || 0), 0);
    kolExit = hits.some((h) => h.action === "exit");
  }

  const n = {
    liquidityAbs: logNorm(liq, 5000, 1_500_000),
    liqMcapRatio: linNorm(liqMcap, 0.01, 0.18),
    turnover: ratioPos(turnoverH1, 0.6),
    priceM5: updown(pc.m5, 8),
    priceH1: updown(pc.h1, 25),
    priceH6: updown(pc.h6, 70),
    volumeAccel: clamp(Math.tanh(Math.max(0, volAccel - 1) / 1.3)),
    boost: meta.boost ? logNorm(meta.boost, 10, 1000) : 0,
    profileRecency: meta.profile ? 1 : 0,
    socialsQuality,
    txnVelocity: clamp(Math.tanh(Math.max(0, txVelocity - 1) / 1.5)),
    socialAccel: sAccel != null ? clamp(Math.tanh(Math.max(0, sAccel - 1) / 1.2)) : null,
    socialReach: sReach != null ? logNorm(sReach, 5000, 5_000_000) : null,
    socialQuality: sSpam != null ? 1 - sSpam : null,
    socialSentiment: sSent != null ? updown(sSent, 0.5) : null,
    kol: sKol != null ? clamp(sKol / 2) : null,
  };

  const rnorm = risk.norm;
  const nRisk = {
    rugcheck: rnorm != null ? clamp(rnorm / 100) : 0.4,
    lpLocked: risk.lpLocked ? 0 : risk.lpLocked === false ? 0.6 : 0.4,
    mintAuthority: risk.mintAuthorityActive === false ? 0 : risk.mintAuthorityActive ? 0.85 : 0.4,
    freezeAuthority: risk.freezeAuthorityActive === false ? 0 : risk.freezeAuthorityActive ? 0.7 : 0.3,
  };

  const base = pair.baseToken || {};
  return {
    mint: base.address, symbol: base.symbol, name: base.name,
    url: pair.url, dex: pair.dexId, pairAddress: pair.pairAddress,
    priceUsd: Number(pair.priceUsd || 0),
    liqUsd: liq, mcap, fdv,
    ageMin, ageH: ageMin / 60,
    priceChange: pc, volume: vol, txns: tx,
    buyRatioH1, volAccel, txVelocity, turnoverH1, turnoverH24, liqMcapRatio: liqMcap,
    socials: socials.map((s) => s.type),
    hasBoost: !!meta.boost, boostAmount: meta.boost || 0,
    hasRecentProfile: !!meta.profile,
    riskRaw: risk, socialRaw: social, kolExit,
    n, nRisk,
  };
}
