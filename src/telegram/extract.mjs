// Pull tradeable claims out of Telegram message text.
//
// Two kinds of reference matter, and they differ enormously in precision:
//
//   MINT ADDRESS - a base58 string of 32-44 chars. Near-zero false positives,
//     and it resolves to exactly one token. This is the signal.
//   $TICKER      - noisy. Tickers are reused constantly (there are dozens of
//     $CAT), so a ticker alone is a weak reference that must be resolved
//     against the current cohort and can still be wrong.
//
// So a call carrying a mint is treated as high confidence; a ticker-only call
// is low confidence and is labelled as such rather than quietly promoted.

// Base58 excludes 0, O, I and l - which is most of what makes this precise.
const MINT_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const TICKER_RE = /\$([A-Za-z][A-Za-z0-9_]{1,9})\b/g;

// Words that look like tickers but are market chatter, not calls.
const TICKER_STOP = new Set([
  "sol", "usd", "usdt", "usdc", "btc", "eth", "bnb", "ath", "atl",
  "mc", "mcap", "fdv", "lp", "ca", "dex", "cex", "tp", "sl", "roi", "pnl", "x",
]);

// Phrases that make a message a CALL rather than commentary. A channel saying
// "still holding" is not a new prediction and must not be logged as one.
const CALL_CUES = [
  /\bbuy(ing)?\b/i, /\bape(d|ing)?\b/i, /\bentry\b/i, /\bentered\b/i,
  /\blong(ing)?\b/i, /\bsend(ing)?\b/i, /\bnew\s+call\b/i, /\bcall(ing)?\b/i,
  /\bgem\b/i, /\bdegen\s+play\b/i, /\bloading\b/i, /\bfilled\b/i,
];
// Phrases that make it an EXIT - the single most valuable signal a channel
// emits, and the one most systems ignore (taxonomy #18).
const EXIT_CUES = [
  /\b(taking|took)\s+profit/i, /\bsold\b/i, /\bselling\b/i, /\bout\b/i,
  /\bexit(ing|ed)?\b/i, /\bclosed?\b/i, /\btrim(ming|med)?\b/i, /\brug(ged)?\b/i,
  /\bdead\b/i, /\bstop(ped)?\s*loss/i,
];
// Explicitly NOT a fresh call, even when it names a token.
const NOT_A_CALL = [
  /\bstill\s+hold/i, /\bupdate\b/i, /\brecap\b/i, /\bcongrat/i,
  /\bcalled\s+(at|it)\b/i, /\bfrom\s+our\s+call\b/i, /\bpaid\b/i,
];

const SOL_SYSTEM = new Set([
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "11111111111111111111111111111111",
]);

/**
 * @returns {{
 *   kind: "call"|"exit"|"mention",
 *   mints: string[], tickers: string[],
 *   confidence: "high"|"low",
 *   cue: string|null
 * } | null}
 */
export function extractCall(text) {
  if (!text || text.length < 3) return null;

  const mints = [...new Set((text.match(MINT_RE) || []).filter((m) => !SOL_SYSTEM.has(m)))];
  const tickers = [...new Set(
    [...text.matchAll(TICKER_RE)]
      .map((m) => m[1].toUpperCase())
      .filter((t) => !TICKER_STOP.has(t.toLowerCase()))
  )];
  if (!mints.length && !tickers.length) return null;

  const exitCue = EXIT_CUES.find((r) => r.test(text));
  const callCue = CALL_CUES.find((r) => r.test(text));
  const suppressed = NOT_A_CALL.some((r) => r.test(text));

  // Exit wins: a message that both mentions buying history and announces a sale
  // is an exit. Getting this backwards would credit a channel for a call it was
  // actually closing.
  let kind = "mention";
  if (exitCue) kind = "exit";
  else if (callCue && !suppressed) kind = "call";

  return {
    kind,
    mints,
    tickers,
    // A mint address resolves to exactly one token; a bare ticker does not.
    confidence: mints.length ? "high" : "low",
    cue: (exitCue || callCue)?.source ?? null,
  };
}

/** Strip Telegram's HTML down to plain text. */
export function htmlToText(html) {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .trim();
}
