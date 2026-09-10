// Social provider dispatcher.
//
// Every provider maps into ONE contract, so the feature layer and the
// `narrative` agent never learn which vendor you're on:
//
//   {
//     mentions1h, mentions1hPrev, mentions24h,   // volume + acceleration (#13/#14)
//     uniqueAuthors24h,                          // spam ratio (#15)
//     followersReach24h,                         // reach weighting (#16)
//     kolHits: [{handle, weight, action}],       // catalyst / exit (#17/#18)
//     sentiment,                                 // -1..1 (#19)
//   }
//
// Returning null means "no coverage" - the scoring layer drops the social
// signals and renormalises the remaining weights rather than scoring a zero.
import * as lunarcrush from "./lunarcrush.mjs";

const PROVIDERS = { lunarcrush };

export function active(cfg) {
  const name = cfg?.social?.provider;
  const p = PROVIDERS[name];
  return p && p.enabled() ? { name, provider: p } : null;
}

export function status(cfg) {
  const a = active(cfg);
  if (!a) {
    const name = cfg?.social?.provider ?? "none";
    return { enabled: false, provider: name, reason: PROVIDERS[name] ? "no API key set" : "no provider configured" };
  }
  return { enabled: true, provider: a.name, ...a.provider.coverage() };
}

export async function getMetrics(symbol, mint, cfg) {
  const a = active(cfg);
  if (!a) return null;
  return a.provider.getMetrics(symbol, mint, cfg.social);
}

export function resetStats(cfg) {
  const a = active(cfg);
  a?.provider.resetStats?.();
}
