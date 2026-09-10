// The recurring radar brief - archived so the board has a track record.
//
// A horizon board that only ever shows "now" cannot be audited. Archiving each
// generation turns it into something with a history: you can scroll back to what
// it said at 2am and, because every pick is also logged to the ledger, see what
// actually happened. A feed that publishes its own misses is the only kind worth
// reading.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.mjs";

const DIR = join(DATA_DIR, "briefs");
const KEEP = 300;

export function archive(board) {
  mkdirSync(DIR, { recursive: true });
  const name = Math.round(board.ts) + ".json";
  writeFileSync(join(DIR, name), JSON.stringify(board, null, 2));
  const files = readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();
  for (const f of files.slice(0, Math.max(0, files.length - KEEP))) {
    try { unlinkSync(join(DIR, f)); } catch {}
  }
  return name;
}

export function list(limit = 40) {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".json"))
    .sort().reverse().slice(0, limit)
    .map((f) => {
      try { return JSON.parse(readFileSync(join(DIR, f), "utf8")); } catch { return null; }
    })
    .filter(Boolean);
}

export function latest() {
  return list(1)[0] || null;
}
