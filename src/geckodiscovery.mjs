// Second discovery source: GeckoTerminal pool feeds.
//
// DEX Screener discovery is skewed toward tokens that have PAID for visibility -
// boosts and token profiles are promotional surfaces. That is useful signal in
// its own right, but it means the universe was systematically biased toward
// projects with a marketing budget, and a scanner that only sees advertised
// tokens has an obvious blind spot.
//
// GeckoTerminal indexes pools directly, so its feeds are unbiased by promotion:
//   trending_pools - what is actually being traded hardest right now
//   new_pools      - freshly created pools, the earliest possible look
//   pools          - the deepest pools on the chain
//
// Verified: 20 pools per page, pagination works, and the base-token mint comes
// out of relationships cleanly, so results feed the existing DEX Screener
// hydration path rather than creating a second feature pipeline.
//
// Free tier is roughly 30 calls/minute and this shares that budget with the
// candle fetcher, so page counts are deliberately conservative.
const BASE = "https://api.geckoterminal.com/api/v2/networks/solana";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FEEDS = {
  trending: "trending_pools",
  fresh: "new_pools",
  deep: "pools",
};

async function page(feed, n) {
  try {
    const r = await fetch(`${BASE}/${feed}?page=${n}`, {
      headers: { accept: "application/json", "User-Agent": "degen-radar/0.1" },
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) return [];
    const js = await r.json();
    return (js?.data || []).map((p) => ({
      mint: String(p.relationships?.base_token?.data?.id || "").replace(/^solana_/, ""),
      name: p.attributes?.name,
      reserve: Number(p.attributes?.reserve_in_usd || 0),
      created: p.attributes?.pool_created_at,
    })).filter((x) => x.mint);
  } catch {
    return [];
  }
}

/**
 * @returns {Map<mint, {boost:number, profile:boolean, source:string}>}
 * Shaped to merge straight into the DEX Screener candidate map.
 */
export async function discover(cfg) {
  const c = cfg?.scan?.geckoDiscovery || {};
  if (c.enabled === false) return new Map();
  const pagesPer = Math.max(1, c.pagesPerFeed ?? 2);
  const feeds = c.feeds?.length ? c.feeds : ["trending", "fresh", "deep"];

  const out = new Map();
  for (const f of feeds) {
    const path = FEEDS[f];
    if (!path) continue;
    for (let n = 1; n <= pagesPer; n++) {
      const rows = await page(path, n);
      for (const r of rows) {
        if (!out.has(r.mint)) out.set(r.mint, { boost: 0, profile: false, source: `gt:${f}` });
      }
      await sleep(250); // stay well inside the shared free-tier budget
      if (!rows.length) break; // no more pages
    }
  }
  return out;
}
