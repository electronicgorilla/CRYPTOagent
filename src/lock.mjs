// Single-instance guard for the scan loop.
//
// Learned the hard way: three loops were started across separate sessions and
// all three read-modify-wrote data/ledger.json. Concurrent writes clobber each
// other - A reads, B reads, A writes, B writes over A - so 255 predictions were
// silently lost before anyone noticed. The evidence base is the one thing in
// this system that cannot be regenerated, so it gets a lock.
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.mjs";

const LOCK = join(DATA_DIR, "loop.lock");

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Returns true if the lock was acquired; false if another loop holds it. */
export function acquire() {
  if (existsSync(LOCK)) {
    try {
      const { pid, started } = JSON.parse(readFileSync(LOCK, "utf8"));
      if (pid !== process.pid && alive(pid)) {
        console.error(`[lock] another loop is already running (pid ${pid}, started ${new Date(started).toLocaleTimeString()}).`);
        console.error("[lock] refusing to start a second one - concurrent loops corrupt the ledger.");
        console.error("[lock] stop the other process first, or delete data/loop.lock if it is stale.");
        return false;
      }
      // stale lock from a crashed run - safe to take over
    } catch { /* unreadable lock: treat as stale */ }
  }
  writeFileSync(LOCK, JSON.stringify({ pid: process.pid, started: Date.now() }));
  const release = () => { try { if (existsSync(LOCK)) unlinkSync(LOCK); } catch {} };
  process.on("exit", release);
  process.on("SIGINT", () => { release(); process.exit(0); });
  process.on("SIGTERM", () => { release(); process.exit(0); });
  return true;
}
