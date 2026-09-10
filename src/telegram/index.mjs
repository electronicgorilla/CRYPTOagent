// Telegram source dispatcher.
//
// Three access modes, in increasing order of what they can see and of what they
// demand from you:
//
//   public  - t.me/s/<channel>. No auth, no setup, works right now. PUBLIC
//             channels only, last ~20 posts. VERIFIED working.
//   bot     - Bot API. You create a bot with @BotFather and add it to the
//             channel as an admin. Sees private channels it was added to.
//   mtproto - logs in as YOU via GramJS, so it sees every channel you are in,
//             including ones you cannot add a bot to. Requires a session string
//             that only you can generate (it needs a phone code).
//
// Authentication is deliberately not automated here. Generating an MTProto
// session means entering a login code sent to your phone; that is yours to do,
// and this file will not ask you for it or handle it.
import { fetchChannel as fetchPublic } from "./public.mjs";

export function mode(cfg) {
  const m = cfg?.telegram?.mode || "public";
  if (m === "bot" && !process.env.TELEGRAM_BOT_TOKEN) return { m: "public", note: "bot mode selected but TELEGRAM_BOT_TOKEN unset - falling back to public" };
  if (m === "mtproto" && !process.env.TELEGRAM_SESSION) return { m: "public", note: "mtproto selected but TELEGRAM_SESSION unset - falling back to public" };
  return { m, note: null };
}

export function enabled(cfg) {
  return !!(cfg?.telegram?.enabled && (cfg.telegram.channels || []).length);
}

export async function fetchMessages(channel, cfg) {
  const { m } = mode(cfg);
  if (m === "bot") return fetchViaBot(channel, cfg);
  if (m === "mtproto") return fetchViaMtproto(channel, cfg);
  return fetchPublic(channel);
}

// ---------------------------------------------------------------------------
// Bot API. Works only for channels your bot was added to as an admin.
// getUpdates is a long-poll with a cursor, so we persist the offset per run.
let botOffset = 0;
async function fetchViaBot(channel, cfg) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const want = String(channel).replace(/^@/, "").toLowerCase();
  try {
    const url = `https://api.telegram.org/bot${token}/getUpdates?timeout=0&limit=100` +
      (botOffset ? `&offset=${botOffset}` : "") +
      `&allowed_updates=${encodeURIComponent(JSON.stringify(["channel_post"]))}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    const js = await r.json();
    if (!js.ok) return { ok: false, reason: js.description || "bot API error", messages: [] };

    const messages = [];
    for (const u of js.result || []) {
      botOffset = Math.max(botOffset, u.update_id + 1);
      const p = u.channel_post;
      if (!p) continue;
      const uname = (p.chat?.username || "").toLowerCase();
      if (want && uname && uname !== want) continue;
      const text = p.text || p.caption;
      if (!text) continue;
      messages.push({
        id: `${uname || p.chat?.id}/${p.message_id}`,
        channel: uname || String(p.chat?.id),
        ts: p.date,
        text,
        views: null,
        url: uname ? `https://t.me/${uname}/${p.message_id}` : null,
      });
    }
    return { ok: true, messages };
  } catch (e) {
    return { ok: false, reason: e.message, messages: [] };
  }
}

// ---------------------------------------------------------------------------
// MTProto via GramJS. Sees everything your account can see.
//
// SETUP (yours to do - it needs a code sent to your phone):
//   1. npm install telegram
//   2. Get api_id + api_hash from https://my.telegram.org -> API development tools
//   3. Generate a session string ONCE, interactively, in your own terminal:
//
//      node -e "
//        const {TelegramClient}=require('telegram');
//        const {StringSession}=require('telegram/sessions');
//        const input=require('readline/promises').createInterface({input:process.stdin,output:process.stdout});
//        (async()=>{
//          const c=new TelegramClient(new StringSession(''), Number(process.env.TG_API_ID), process.env.TG_API_HASH, {connectionRetries:3});
//          await c.start({
//            phoneNumber:()=>input.question('phone: '),
//            phoneCode:()=>input.question('code: '),
//            password:()=>input.question('2FA password: '),
//            onError:console.error});
//          console.log('TELEGRAM_SESSION=' + c.session.save());
//          process.exit(0);
//        })()"
//
//   4. Put that line in .env alongside TG_API_ID and TG_API_HASH.
//
// The session string is a full credential - it grants access to your account.
// Keep it in .env (already gitignored) and never paste it anywhere else.
async function fetchViaMtproto(channel, cfg) {
  let TelegramClient, StringSession;
  try {
    ({ TelegramClient } = await import("telegram"));
    ({ StringSession } = await import("telegram/sessions/index.js"));
  } catch {
    return { ok: false, reason: "gramjs not installed - run: npm install telegram", messages: [] };
  }
  const apiId = Number(process.env.TG_API_ID);
  const apiHash = process.env.TG_API_HASH;
  if (!apiId || !apiHash)
    return { ok: false, reason: "TG_API_ID / TG_API_HASH not set", messages: [] };

  try {
    const client = new TelegramClient(
      new StringSession(process.env.TELEGRAM_SESSION), apiId, apiHash,
      { connectionRetries: 2 }
    );
    await client.connect();
    const limit = cfg?.telegram?.fetchLimit ?? 30;
    const msgs = await client.getMessages(channel, { limit });
    const out = [];
    for (const m of msgs) {
      const text = m.message || m.text;
      if (!text) continue;
      out.push({
        id: `${channel}/${m.id}`,
        channel: String(channel).replace(/^@/, ""),
        ts: m.date,
        text,
        views: m.views ?? null,
        url: `https://t.me/${String(channel).replace(/^@/, "")}/${m.id}`,
      });
    }
    await client.disconnect();
    out.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    return { ok: true, messages: out };
  } catch (e) {
    return { ok: false, reason: e.message, messages: [] };
  }
}
