// X / Twitter collector - STUB with a defined contract.
//
// You said you have X access. Wire ONE path below and the attention pillar
// starts using real social velocity instead of the DEX-Screener boost proxy.
//
// getMetrics(symbol, mint) must return null OR:
//   {
//     mentions1h, mentions1hPrev, mentions24h,
//     uniqueAuthors24h, followersReach24h,
//     kolHits: [ { handle, weight, action: "call" | "exit" } ],
//     sentiment            // -1..1
//   }
// The feature layer derives acceleration, spam ratio, reach weighting and the
// KOL catalyst/exit signal from this (taxonomy #13-#19).

export function enabled() {
  return !!(process.env.TWITTER_BEARER_TOKEN || process.env.SOCIAL_API_BASE);
}

export async function getMetrics(symbol, mint) {
  if (process.env.TWITTER_BEARER_TOKEN) return viaXApi(symbol, mint);
  if (process.env.SOCIAL_API_BASE) return viaProvider(symbol, mint);
  return null;
}

async function viaXApi(symbol, mint) {
  // TODO X API v2:
  //  GET /2/tweets/counts/recent?query=($SYM OR <mint>)&granularity=hour  -> mentions series
  //  GET /2/tweets/search/recent (expansions=author_id, user.fields=public_metrics) -> reach, authors
  //  match author handles against kol_watchlist.json                     -> kolHits
  // Only query the top ~40 scored tokens per scan to stay under rate limits.
  return null;
}

async function viaProvider(symbol, mint) {
  // TODO: map your provider's response into the contract above.
  return null;
}
