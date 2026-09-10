// Zero-dependency HTTP server: static dashboard + JSON API.
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { ROOT, loadConfig, loadEnv } from "./config.mjs";
import * as store from "./store.mjs";
import * as orchestrator from "./agents/orchestrator.mjs";
import * as scorecard from "./scorecard.mjs";
import * as ledger from "./ledger.mjs";
import { gradeDue } from "./grader.mjs";
import * as adapt from "./adapt.mjs";
import { runScan } from "./pipeline.mjs";

loadEnv();
const DASH = join(ROOT, "dashboard");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

const scanState = { running: false, lastError: null, lastAgents: null, lastGraded: null };

function send(res, code, body, type = "application/json") {
  const data = type === "application/json" ? JSON.stringify(body) : body;
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(data);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { return {}; }
}

function startScan() {
  if (scanState.running) return;
  scanState.running = true;
  scanState.lastError = null;
  runScan({ cfg: loadConfig() })
    .then((r) => { scanState.lastAgents = r.agents; scanState.lastGraded = r.graded; })
    .catch((e) => { scanState.lastError = e.message; })
    .finally(() => { scanState.running = false; });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;

  try {
    if (p === "/api/tokens") return send(res, 200, store.latestScan());
    if (p.startsWith("/api/history/")) return send(res, 200, store.history(decodeURIComponent(p.slice(13))));

    if (p === "/api/status") {
      const cfg = loadConfig();
      return send(res, 200, {
        ...scanState,
        agentsEnabled: cfg.agents?.enabled && orchestrator.available(),
        agentsConfigured: orchestrator.available(),
        spendToday: orchestrator.spendToday(),
        spendCapDay: cfg.agents?.maxSpendPerDayUsd ?? null,
      });
    }

    // --- curation loop ---
    if (p === "/api/scorecard") return send(res, 200, scorecard.build());
    // The LIVE layer. Deliberately NOT a scan: it re-prices only the tokens
    // already on screen in one batched DEX Screener call (~1 call per tick,
    // against a 300/min ceiling), so the interface can move every 10s
    // without multiplying discovery load or touching the ledger.
    if (p === "/api/board") {
      const briefs = await import("./briefs.mjs");
      return send(res, 200, briefs.latest() || { ts: null, horizons: [] });
    }
    if (p === "/api/briefs") {
      const briefs = await import("./briefs.mjs");
      const rows = ledger.load();
      const list = briefs.list(Number(url.searchParams.get("limit")) || 30);
      // Attach outcomes so an archived brief shows what actually happened.
      for (const b of list) for (const h of b.horizons) for (const pk of h.picks) {
        const led = rows.filter((r) => r.mint === pk.mint && r.agent === `board:${h.id}` &&
          Math.abs(r.ts - b.ts) < 120);
        const g = led.find((r) => r.outcome);
        pk.outcome = g ? g.outcome : null;
      }
      return send(res, 200, list);
    }

    if (p === "/api/observations") {
      const obs = await import("./observations.mjs");
      const m = url.searchParams.get("mint");
      return send(res, 200, m ? obs.forToken(m) : obs.recent());
    }
    if (p === "/api/observe" && req.method === "POST") {
      const obs = await import("./observations.mjs");
      const body = await readBody(req);
      if (!body.text) return send(res, 400, { ok: false, error: "text required" });
      return send(res, 200, { ok: true, row: obs.record(body) });
    }

    if (p === "/api/tick") {
      const snap = store.latestScan();
      const mints = (snap.tokens || []).map((t) => t.feat.mint).filter(Boolean).slice(0, 30);
      if (!mints.length) return send(res, 200, { ts: Date.now() / 1000, quotes: {} });
      try {
        const r = await fetch("https://api.dexscreener.com/latest/dex/tokens/" + mints.join(","),
          { headers: { "User-Agent": "degen-radar/0.1" }, signal: AbortSignal.timeout(9000) });
        const js = r.ok ? await r.json() : null;
        const quotes = {};
        for (const pr of js?.pairs || []) {
          if (pr.chainId !== "solana") continue;
          const a = pr.baseToken?.address;
          const liq = pr.liquidity?.usd || 0;
          if (!a || (quotes[a] && quotes[a].liq > liq)) continue;
          quotes[a] = {
            price: Number(pr.priceUsd || 0), liq, mcap: pr.marketCap || pr.fdv || 0,
            m5: pr.priceChange?.m5 ?? 0, h1: pr.priceChange?.h1 ?? 0, h6: pr.priceChange?.h6 ?? 0,
            volH1: pr.volume?.h1 || 0,
            buys: pr.txns?.m5?.buys || 0, sells: pr.txns?.m5?.sells || 0,
          };
        }
        return send(res, 200, { ts: Date.now() / 1000, quotes });
      } catch (e) {
        return send(res, 200, { ts: Date.now() / 1000, quotes: {}, error: e.message });
      }
    }

    if (p === "/api/regime") {
      const regime = await import("./regime.mjs");
      return send(res, 200, await regime.getRegime(loadConfig()));
    }

    // Live push. The scan loop is a SEPARATE PROCESS, so in-process events
    // are not available - the server watches the data file the loop writes
    // and pushes when it actually changes. Works whether the scan came from
    // the loop, the CLI, or the dashboard button.
    if (p === "/api/stream") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const push = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      push("hello", { ts: Date.now() / 1000 });
      let last = 0;
      const tick = setInterval(() => {
        try {
          const f = join(ROOT, "data", "latest.json");
          const m = existsSync(f) ? statSync(f).mtimeMs : 0;
          if (m && m !== last) { last = m; push("scan", { mtime: m }); }
          else push("beat", { ts: Date.now() / 1000, running: scanState.running });
        } catch { /* keep the stream alive regardless */ }
      }, 2000);
      req.on("close", () => clearInterval(tick));
      return;
    }
    if (p === "/api/edge") {
      const { channelEdgeSources } = await import("./doctrine.mjs");
      return send(res, 200, channelEdgeSources(ledger.load()));
    }
    if (p === "/api/telegram") {
      const { recentCalls } = await import("./telegram/calls.mjs");
      return send(res, 200, { calls: recentCalls(), config: loadConfig().telegram });
    }
    if (p === "/api/adapt") {
      const cfg = loadConfig();
      return send(res, 200, adapt.propose(cfg, cfg.adapt || {}));
    }
    if (p === "/api/ledger/open") return send(res, 200, ledger.open());
    if (p.startsWith("/api/panel/")) return send(res, 200, ledger.latestByToken(decodeURIComponent(p.slice(11))));
    if (p === "/api/grade" && req.method === "POST") return send(res, 200, await gradeDue({ verbose: false }));

    if (p === "/api/scan" && req.method === "POST") {
      if (scanState.running) return send(res, 409, { ok: false, error: "scan already running" });
      startScan();
      return send(res, 200, { ok: true, started: true });
    }
    if (p.startsWith("/api/note/") && req.method === "POST") {
      const body = await readBody(req);
      store.setNote(decodeURIComponent(p.slice(10)), body.note || "");
      return send(res, 200, { ok: true });
    }

    // static
    const file = p === "/" ? "/index.html" : p;
    const full = join(DASH, file);
    if (!full.startsWith(DASH) || !existsSync(full)) return send(res, 404, "not found", "text/plain");
    return send(res, 200, readFileSync(full), MIME[extname(full)] || "application/octet-stream");
  } catch (e) {
    return send(res, 500, { error: e.message });
  }
});

export function main(port = Number(process.env.PORT) || 8787) {
  server.listen(port, "127.0.0.1", () =>
    console.log(`degen-radar -> http://127.0.0.1:${port}  (agents ${orchestrator.available() ? "on" : "off"})`)
  );
}
