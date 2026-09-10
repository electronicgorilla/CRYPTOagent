// Operator observations - the human feedback channel.
//
// This system measures what it can compute. It cannot see what the operator
// sees sitting in front of the tape: that a particular channel front-runs its
// own calls, that a wallet cluster keeps appearing before pulls, that a pattern
// repeated three times tonight. Those observations are the highest-value data
// in the whole stack and until now there was nowhere to put them.
//
// So: a timestamped log, optionally attached to a token, that
//   1. survives restarts,
//   2. is shown back in the interface next to the token it concerns, and
//   3. is handed to the arbiter agent as context, so a hypothesis the operator
//      formed at 1am is available to the reasoning layer at 4am.
//
// Observations are DATA, not instructions. They are quoted to the agents as
// "the operator observed X", never executed as commands.
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_DIR } from "./config.mjs";

const FILE = join(DATA_DIR, "observations.json");
const MAX = 2000;

export function load() {
  if (!existsSync(FILE)) return [];
  try { return JSON.parse(readFileSync(FILE, "utf8")); } catch { return []; }
}

function save(rows) {
  const tmp = FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(rows.slice(-MAX), null, 2));
  renameSync(tmp, FILE);
}

/**
 * @param {{text:string, mint?:string, symbol?:string, tag?:string,
 *          outcome?:string}} obs
 */
export function record(obs) {
  const rows = load();
  const row = {
    id: randomUUID(),
    ts: Date.now() / 1000,
    text: String(obs.text || "").slice(0, 2000),
    mint: obs.mint || null,
    symbol: obs.symbol || null,
    // free tag so patterns can be grouped later: "rug", "channel", "pattern"...
    tag: obs.tag || "note",
    outcome: obs.outcome || null,
  };
  rows.push(row);
  save(rows);
  return row;
}

export function forToken(mint) {
  return load().filter((r) => r.mint === mint).reverse();
}

export function recent(limit = 60) {
  return load().slice(-limit).reverse();
}

/**
 * Compact form for the arbiter's prompt. Kept small - it sits in the volatile
 * part of the request and is paid for on every call.
 */
export function forArbiter(mint, limit = 6) {
  const mine = forToken(mint).slice(0, 3);
  const global = load()
    .filter((r) => !r.mint && (r.tag === "pattern" || r.tag === "rug"))
    .slice(-3).reverse();
  const pick = [...mine, ...global].slice(0, limit);
  if (!pick.length) return null;
  return pick.map((r) => ({
    when: new Date(r.ts * 1000).toISOString(),
    about: r.symbol || "general",
    tag: r.tag,
    operator_observed: r.text,
  }));
}
