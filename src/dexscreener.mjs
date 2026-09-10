// DEX Screener collector - the only fully-live data source in this prototype.
// Free API, no key. https://docs.dexscreener.com/api/reference
const BASE = "https://api.dexscreener.com";
const UA = { "User-Agent": "degen-radar/0.1" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path, params) {
  const url = new URL(BASE + path);
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(12000) });
      if (r.status === 429) { await sleep(2000 + attempt * 3000); continue; }
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } catch (e) {
      if (attempt === 2) { console.warn(`[dexscreener] GET ${path}: ${e.message}`); return null; }
      await sleep(1000 + attempt * 1000);
    }
  }
  return null;
}

const isSol = (o) => o && o.chainId === "solana";

export async function discoverCandidates(cfg) {
  const d = cfg.scan.discovery;
  const mints = new Map(); // addr -> { boost, profile }
  const bump = (addr, boost = 0, profile = false) => {
    if (!addr) return;
    const m = mints.get(addr) || { boost: 0, profile: false };
    m.boost = Math.max(m.boost, Number(boost) || 0);
    m.profile = m.profile || profile;
    mints.set(addr, m);
  };

  if (d.useTopBoosts)
    for (const it of (await get("/token-boosts/top/v1")) || [])
      if (isSol(it)) bump(it.tokenAddress, it.totalAmount ?? it.amount);
  if (d.useLatestBoosts)
    for (const it of (await get("/token-boosts/latest/v1")) || [])
      if (isSol(it)) bump(it.tokenAddress, it.totalAmount ?? it.amount);
  if (d.useLatestProfiles)
    for (const it of (await get("/token-profiles/latest/v1")) || [])
      if (isSol(it)) bump(it.tokenAddress, 0, true);
  for (const term of d.searchTerms || []) {
    const js = await get("/latest/dex/search", { q: term });
    for (const p of (js?.pairs || []).slice(0, 40))
      if (p.chainId === "solana") bump(p.baseToken?.address, 0);
    await sleep(400);
  }
  return mints;
}

export async function hydrate(mints, cfg) {
  const addrs = [...mints.keys()].slice(0, cfg.scan.maxCandidates);
  const best = new Map();
  for (let i = 0; i < addrs.length; i += 30) {
    const chunk = addrs.slice(i, i + 30);
    const js = await get("/latest/dex/tokens/" + chunk.join(","));
    for (const p of js?.pairs || []) {
      if (p.chainId !== "solana") continue;
      const addr = p.baseToken?.address;
      const liq = p.liquidity?.usd || 0;
      const cur = best.get(addr);
      if (!cur || liq > (cur.liquidity?.usd || 0)) best.set(addr, p);
    }
    await sleep(300);
  }
  const out = [];
  for (const [addr, p] of best) {
    p._meta = mints.get(addr) || { boost: 0, profile: false };
    out.push(p);
  }
  return out;
}
