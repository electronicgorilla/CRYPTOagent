import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = join(ROOT, "data");
mkdirSync(DATA_DIR, { recursive: true });

export function loadConfig() {
  return JSON.parse(readFileSync(join(ROOT, "config.json"), "utf8"));
}

export function loadWatchlist() {
  const p = join(ROOT, "kol_watchlist.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : { kols: [], telegramChannels: [] };
}

/** Minimal .env loader (no dependency). Call once at startup. */
export function loadEnv() {
  const p = join(ROOT, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (!(k in process.env)) process.env[k] = v;
  }
}
