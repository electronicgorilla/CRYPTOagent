// Source-change detection for the long-running loop.
//
// Node caches modules at import. A loop started before an edit keeps running
// the OLD code forever, and because it also WRITES data/latest.json every
// cycle, it silently overwrites anything a newer scan produced. This has now
// bitten three separate times - FOMO, Telegram and Aura each shipped, verified
// by a manual scan, and then vanished from the dashboard minutes later when the
// stale loop clobbered the file. Each time it looked like a broken feature
// rather than a stale process.
//
// So the loop watches its own source and re-executes itself when it changes.
// Restarting is safe: the lock is released on exit, state lives on disk, and a
// scan is idempotent.
import { readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const SRC = dirname(fileURLToPath(import.meta.url));

function newestMtime(dir) {
  let newest = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) newest = Math.max(newest, newestMtime(p));
    else if (e.name.endsWith(".mjs")) newest = Math.max(newest, statSync(p).mtimeMs);
  }
  return newest;
}

export function sourceStamp() {
  try { return newestMtime(SRC); } catch { return 0; }
}

/**
 * Returns true if source changed since `stamp`. When it has, re-exec this
 * process so the next cycle runs the code that is actually on disk.
 */
export function restartIfSourceChanged(stamp) {
  const now = sourceStamp();
  if (!stamp || now <= stamp) return false;
  console.log("[reload] source changed on disk — restarting the loop so it runs current code");
  const child = spawn(process.execPath, process.argv.slice(1), {
    detached: true, stdio: "inherit", cwd: process.cwd(),
  });
  child.unref();
  process.exit(0);
}
