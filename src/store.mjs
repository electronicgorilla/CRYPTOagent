// Zero-dependency JSON persistence under data/. Point your own notebooks/files
// at these:
//   data/latest.json          - full result of the most recent scan
//   data/history/<mint>.json   - append-only score time-series per token
//   data/notes.json            - your per-token notes (fed into the LLM layer)
//   data/scans/<ts>.json       - raw snapshot of every scan
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.mjs";

const HIST = join(DATA_DIR, "history");
const SCANS = join(DATA_DIR, "scans");
mkdirSync(HIST, { recursive: true });
mkdirSync(SCANS, { recursive: true });

const readJson = (p, fb) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : fb);
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2));
const safe = (m) => (m || "unknown").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 60);

export function saveScan(rows) {
  const ts = Date.now() / 1000;
  const payload = {
    ts,
    macro: rows[0]?.feat?.fomo?.macro ?? null,
    tokens: rows.map((r) => ({ feat: r.feat, score: r.score, advice: r.advice, panel: r.panel,
      note: r.note, prediction: r.prediction, stability: r.stability, aura: r.aura })),
  };
  writeJson(join(DATA_DIR, "latest.json"), payload);
  writeJson(join(SCANS, `${Math.round(ts)}.json`), payload);

  for (const r of rows) {
    const p = join(HIST, safe(r.feat.mint) + ".json");
    const arr = readJson(p, []);
    arr.push({
      ts, composite: r.score.composite, attention: r.score.attention,
      momentum: r.score.momentum, liquidityHealth: r.score.liquidityHealth,
      risk: r.score.risk, price: r.feat.priceUsd,
    });
    writeJson(p, arr.slice(-500));
  }

  // keep only the last 200 raw scan snapshots
  const files = readdirSync(SCANS).filter((f) => f.endsWith(".json")).sort();
  for (const f of files.slice(0, Math.max(0, files.length - 200))) {
    try { rmSync(join(SCANS, f)); } catch { /* ignore */ }
  }
  return ts;
}

export function latestScan() {
  return readJson(join(DATA_DIR, "latest.json"), { ts: null, tokens: [] });
}

export function history(mint) {
  return readJson(join(HIST, safe(mint) + ".json"), []);
}

export function getNote(mint) {
  return readJson(join(DATA_DIR, "notes.json"), {})[mint] || "";
}

export function setNote(mint, note) {
  const p = join(DATA_DIR, "notes.json");
  const all = readJson(p, {});
  all[mint] = note;
  writeJson(p, all);
}
