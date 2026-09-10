// Zero-dependency HTTP server: static dashboard + JSON API.
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
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
