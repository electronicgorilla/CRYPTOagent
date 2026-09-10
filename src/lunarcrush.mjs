// LunarCrush v4 social collector.
//
// Docs: https://github.com/lunarcrush/api   Base: https://lunarcrush.com/api4
// Auth: Authorization: Bearer <LUNARCRUSH_API_KEY>
//
// Two hard constraints shape everything here:
//
//   1. RATE LIMITS. Plans start around 10 req/min. Three calls per token across
//      17 tokens is ~51 calls a scan - far over budget. So we enrich only the
//      top N by composite, cache per topic, and pace requests through a token
//      bucket.
//   2. COVERAGE. LunarCrush tracks *topics that already have social volume*. A
//      two-hour-old pump.fun token usually has none, so the honest answer for
//      most of this scanner's universe is "no data". We cache those misses hard
//      and report coverage rather than silently returning null forever.
import { loadWatchlist } from "./config.mjs";

const BASE = "https://lunarcrush.com/api4";

const cache = new Map();      // topic -> { t, data }
const missCache = new Map();  // topic -> t   (no coverage; retried far less often)
let bucket = { tokens: 0, last: Date.now() };
const stats = { hits: 0, misses: 0, errors: 0, calls: 0 };

export const enabled = () => !!process.env.LUNARCRUSH_API_KEY;
export const coverage = () => ({ ...stats });
export const resetStats = () => Object.keys(stats).forEach((k) => (stats[k] = 0));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Token-bucket pacer so we never blow the plan's per-minute cap. */
async function pace(rpm) {
  const refillMs = 60000 / rpm;
  for (;;) {
    const now = Date.now();
    bucket.tokens = Math.min(rpm, bucket.tokens + (now - bucket.last) / refillMs);
    bucket.last = now;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return;
    }
    await sleep(Math.ceil(refillMs * (1 - bucket.tokens)));
  }
}

async function get(path, params, rpm) {
  await pace(rpm);
  stats.calls++;
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${process.env.LUNARCRUSH_API_KEY}`,
      "User-Agent": "degen-radar/0.1",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (r.status === 404) return { notFound: true };
  if (r.status === 429) return { rateLimited: true };
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}

/** LunarCrush topics are lowercase; token tickers live under "$symbol". */
const topicFor = (symbol) =>
  "$" + String(symbol || "").toLowerCase().replace(/[^a-z0-9]/g, "");

function kolWatch() {
  const wl = loadWatchlist();
  const m = new Map();
  for (const k of wl.kols || []) m.set(String(k.handle).toLowerCase(), k.weight ?? 0.5);
  return m;
}

/**
 * Returns the shared social contract, or null when LunarCrush has no coverage:
 *   { mentions1h, mentions1hPrev, mentions24h, uniqueAuthors24h,
 *     followersReach24h, kolHits:[{handle,weight,action}], sentiment,
 *     _provider, _topic, _extra }
 */
export async function getMetrics(symbol, _mint, cfg = {}) {
  if (!enabled()) return null;
  const topic = topicFor(symbol);
  if (topic.length < 2) return null;

  const rpm = cfg.requestsPerMinute ?? 8;
  const ttl = (cfg.cacheMinutes ?? 15) * 60000;
  const missTtl = (cfg.missCacheMinutes ?? 120) * 60000;
  const now = Date.now();

  const miss = missCache.get(topic);
  if (miss && now - miss < missTtl) { stats.misses++; return null; }
  const hit = cache.get(topic);
  if (hit && now - hit.t < ttl) { stats.hits++; return hit.data; }

  try {
    const summary = await get(`/public/topic/${encodeURIComponent(topic)}/v1`, null, rpm);
    if (summary?.notFound || summary?.rateLimited || !summary?.data) {
      if (summary?.rateLimited) stats.errors++;
      else { missCache.set(topic, now); stats.misses++; }
      return null;
    }
    const d = summary.data;

    // Hourly buckets -> the acceleration signal (taxonomy #14, the one that
    // actually predicts rather than confirms).
    let mentions1h = null, mentions1hPrev = null, contributors1h = null;
    try {
      const ts = await get(
        `/public/topic/${encodeURIComponent(topic)}/time-series/v2`,
        { bucket: "hour", interval: "1w" },
        rpm
      );
      const pts = ts?.data;
      if (Array.isArray(pts) && pts.length >= 2) {
        const last = pts[pts.length - 1];
        const prev = pts[pts.length - 2];
        mentions1h = last.posts_created ?? last.posts_active ?? null;
        mentions1hPrev = prev.posts_created ?? prev.posts_active ?? null;
        contributors1h = last.contributors_active ?? null;
      }
    } catch { /* summary alone is still useful */ }

    // Creators -> follower-weighted reach and KOL matching (taxonomy #16/#17).
    let followersReach24h = null;
    const kolHits = [];
    if (cfg.fetchCreators !== false) {
      try {
        const cr = await get(`/public/topic/${encodeURIComponent(topic)}/creators/v1`, null, rpm);
        const list = cr?.data;
        if (Array.isArray(list) && list.length) {
          followersReach24h = list.reduce((a, c) => a + (c.creator_followers || 0), 0);
          const watch = kolWatch();
          for (const c of list) {
            const w = watch.get(String(c.creator_name || "").toLowerCase());
            // LunarCrush gives no exit signal, only presence.
            if (w) kolHits.push({ handle: c.creator_name, weight: w, action: "call" });
          }
        }
      } catch { /* optional */ }
    }

    const data = {
      // sentiment arrives 0..100; the feature layer wants -1..1
      sentiment: typeof d.sentiment === "number" ? (d.sentiment - 50) / 50 : null,
      mentions24h: d.num_posts ?? null,
      uniqueAuthors24h: d.num_contributors ?? null,
      mentions1h,
      mentions1hPrev,
      followersReach24h,
      kolHits,
      _provider: "lunarcrush",
      _topic: topic,
      _extra: {
        interactions_24h: d.interactions_24h ?? null,
        topic_rank: d.topic_rank ?? null,
        trend: d.trend ?? null,
        contributors_active_1h: contributors1h,
        types_sentiment: d.types_sentiment ?? null,
      },
    };
    cache.set(topic, { t: now, data });
    stats.hits++;
    return data;
  } catch (e) {
    stats.errors++;
    console.warn(`[lunarcrush] ${topic}: ${e.message}`);
    return null;
  }
}
