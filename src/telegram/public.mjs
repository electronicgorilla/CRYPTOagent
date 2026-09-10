// Public-channel reader. Zero auth, zero setup.
//
// Telegram serves a server-rendered preview of any PUBLIC channel at
// https://t.me/s/<channel>. Verified working: returns the last ~20 posts with
// id, timestamp and view count. That is enough to log calls and grade them.
//
// Limits, stated plainly so nobody builds on a false assumption:
//   - PUBLIC channels only. A private channel returns a 302 to the join page.
//   - Only the most recent ~20 posts, so the poll interval must be shorter than
//     the channel's posting rate or calls will be missed.
//   - No edit/delete visibility - a deleted call simply stops appearing, which
//     is itself worth noticing (see deleted-call handling in the collector).
import { htmlToText } from "./extract.mjs";

const UA = { "User-Agent": "Mozilla/5.0 (compatible; degen-radar/0.1)" };

/** @returns {{ok:boolean, reason?:string, messages:Array}} */
export async function fetchChannel(channel, { timeoutMs = 15000 } = {}) {
  const name = String(channel).replace(/^@/, "").trim();
  let html;
  try {
    const r = await fetch(`https://t.me/s/${encodeURIComponent(name)}`, {
      headers: UA,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (r.status >= 300 && r.status < 400)
      return { ok: false, reason: "not a public channel (redirected to join page)", messages: [] };
    if (!r.ok) return { ok: false, reason: `HTTP ${r.status}`, messages: [] };
    html = await r.text();
  } catch (e) {
    return { ok: false, reason: e.message, messages: [] };
  }

  const messages = [];
  // Each post is a widget block; pull id, time, text and views out of it.
  const blocks = html.split('class="tgme_widget_message ').slice(1);
  for (const b of blocks) {
    const id = b.match(/data-post="([^"]+)"/)?.[1];
    const iso = b.match(/datetime="([^"]+)"/)?.[1];
    const textHtml = b.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1];
    const viewsRaw = b.match(/tgme_widget_message_views">([^<]*)/)?.[1];
    if (!id || !textHtml) continue;
    messages.push({
      id,
      channel: name,
      ts: iso ? new Date(iso).getTime() / 1000 : null,
      text: htmlToText(textHtml),
      views: parseViews(viewsRaw),
      url: `https://t.me/${id}`,
    });
  }
  if (!messages.length)
    return { ok: false, reason: "no message blocks found (channel may be media-only or empty)", messages: [] };

  messages.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return { ok: true, messages };
}

function parseViews(s) {
  if (!s) return null;
  const t = s.trim().toUpperCase();
  const n = parseFloat(t);
  if (!isFinite(n)) return null;
  if (t.endsWith("K")) return Math.round(n * 1e3);
  if (t.endsWith("M")) return Math.round(n * 1e6);
  return Math.round(n);
}
