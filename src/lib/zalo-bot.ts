import { randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "./db";
import { decrypt, encrypt } from "./crypto";
import { publicUrl } from "./zalo";
import { renderNotice } from "./notify-templates";
import { chatCode } from "./lead-notify-config";
import { globalTemplates } from "./notify-templates-db";
import { getT } from "@/i18n/server";

// Zalo Bot (bot.zapps.me, no Zalo OA needed): the platform's bot messages the Zalo group shared with the client (new lead notifications).
// - Create the bot: Zalo app → OA "Zalo Bot Manager" → Create bot → token is sent to your Zalo messages. Paste the token in System settings → Messaging channels.
// - Receiving: with a public HTTPS address, set the webhook /api/zalo-bot/webhook (secret key in the X-Bot-Api-Secret-Token header) → record the groups / people
//   who messaged the bot to pick as destinations. On a Mac (localhost, Zalo can't call back) read via getUpdates.
// - Groups (chat_type GROUP) are labeled Beta by Zalo. Messages max 2000 characters.
// - In groups, Zalo only forwards messages that mention the bot: a bare "/id" doesn't reach the webhook; mention the bot then type /id ("@<bot name> /id").

const KEY = "zalobot"; // encrypted: token + webhook key
const CHATS_KEY = "zalobot.chats"; // groups / people who messaged the bot (not secret)
const API = "https://bot-api.zaloplatforms.com";

type BotConfig = { token: string; id: string; name: string; canJoinGroups: boolean | null; secret: string | null; webhookUrl: string | null; savedBy: string; savedAt: string };
type BotChat = { chatId: string; type: string; from: string; lastText: string; seenAt: string; label?: string }; // label: name typed after /id

async function readConfig() {
  const row = await db.setting.findUnique({ where: { key: KEY } });
  if (!row) return null;
  try {
    return JSON.parse(decrypt(row.value)) as BotConfig;
  } catch {
    return null;
  }
}
async function writeConfig(c: BotConfig) {
  const v = encrypt(JSON.stringify(c));
  await db.setting.upsert({ where: { key: KEY }, create: { key: KEY, value: v }, update: { value: v } });
}

type Res<T> = { ok: boolean; result?: T; description?: string; error_code?: number };
async function call<T>(token: string, method: string, body: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<T> {
  const res = await fetch(`${API}/bot${token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const j = (await res.json().catch(() => null)) as Res<T> | null;
  if (!j?.ok) throw new Error(`Zalo Bot: ${j?.description ?? `HTTP ${res.status}`}`);
  return j.result as T;
}

export async function zaloBotStatus() {
  const c = await readConfig();
  return c ? { id: c.id, name: c.name, canJoinGroups: c.canJoinGroups, webhook: !!c.webhookUrl, savedBy: c.savedBy, savedAt: c.savedAt } : null;
}
export type ZaloBotStatus = Awaited<ReturnType<typeof zaloBotStatus>>;

/** If the web runs at a public address (VPS), Zalo can call the webhook; on localhost it can't. */
const webhookUrl = () => {
  const base = publicUrl();
  return /^https:\/\//.test(base) && !/localhost|127\.0\.0\.1/.test(base) ? `${base}/api/zalo-bot/webhook` : null;
};

/** Validate the token (getMe), set the webhook when the app has a public address, store it encrypted. */
export async function saveZaloBot(token: string, by: string) {
  const t = token.trim();
  if (t.length < 20 || /\s/.test(t)) throw new Error((await getT())("notify.zaloBot.badToken"));
  const me = await call<{ id: string; account_name?: string; display_name?: string; can_join_groups?: boolean }>(t, "getMe");
  const url = process.env.NODE_ENV === "production" ? webhookUrl() : null;
  const secret = url ? randomBytes(24).toString("base64url") : null;
  if (url) await call(t, "setWebhook", { url, secret_token: secret });
  else await call(t, "deleteWebhook").catch(() => {}); // so getUpdates works when testing locally
  const c: BotConfig = { token: t, id: String(me.id), name: me.display_name || me.account_name || String(me.id), canJoinGroups: me.can_join_groups ?? null, secret, webhookUrl: url, savedBy: by, savedAt: new Date().toISOString() };
  await writeConfig(c);
  return c.name;
}

export async function clearZaloBot() {
  const c = await readConfig();
  if (c?.webhookUrl) await call(c.token, "deleteWebhook").catch(() => {});
  await db.setting.deleteMany({ where: { key: { in: [KEY, CHATS_KEY] } } });
}

async function token() {
  const c = await readConfig();
  if (!c) throw new Error((await getT())("notify.zaloBot.notConnected"));
  return c.token;
}

/** Zalo calls the webhook: is the secret key correct? */
export async function checkWebhookSecret(header: string | null) {
  const c = await readConfig();
  if (!c?.secret || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(c.secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

type Update = { event_name?: string; message?: { text?: string; from?: { id?: string; display_name?: string; is_bot?: boolean }; chat?: { id?: string; chat_type?: string } } };

async function loadChats(): Promise<BotChat[]> {
  const row = await db.setting.findUnique({ where: { key: CHATS_KEY } });
  try {
    return row ? (JSON.parse(row.value) as BotChat[]) : [];
  } catch {
    return [];
  }
}

/** /id or /start command, even when following a bot mention ("@<bot name> /id"). Text after the command = group name set by the user. */
const idCommand = (text: string) => {
  const m = text.trim().match(/^(?:@[^/\n]*)?\/(?:id|start)\b\s*([\s\S]*)$/i);
  return m ? { label: m[1].replace(/\s+/g, " ").trim().slice(0, 80) } : null;
};

/** Record the group / person that just messaged the bot; returns true if it's a new destination. For /id the bot replies ("groupAck" template) so the user knows the group was registered. */
export async function recordUpdate(u: Update) {
  const chat = u.message?.chat;
  if (!chat?.id || u.message?.from?.is_bot) return false;
  const chats = await loadChats();
  const old = chats.find((c) => c.chatId === chat.id);
  const cmd = idCommand(u.message?.text ?? "");
  const label = cmd?.label || old?.label;
  const entry: BotChat = { chatId: chat.id, type: chat.chat_type === "GROUP" ? "Nhóm" : "Cá nhân", from: u.message?.from?.display_name ?? "", lastText: (u.message?.text ?? "").slice(0, 80), seenAt: new Date().toISOString(), ...(label && { label }) };
  const next = [entry, ...chats.filter((c) => c.chatId !== chat.id)].slice(0, 50);
  await db.setting.upsert({ where: { key: CHATS_KEY }, create: { key: CHATS_KEY, value: JSON.stringify(next) }, update: { value: JSON.stringify(next) } });
  if (cmd) {
    const tr = await getT();
    const vars = { loai: entry.type === "Nhóm" ? tr("notify.zaloBot.typeGroup") : tr("notify.zaloBot.typeConversation"), ten_bot: (await readConfig())?.name, ma_nhom: chatCode(chat.id), ten_nhom: cmd.label };
    const text = renderNotice("groupAck", vars, undefined, await globalTemplates(), tr);
    await sendZaloBot(chat.id, text).catch((err) => console.error(`Zalo Bot reply to /id (${chat.id}) failed:`, err instanceof Error ? err.message : err));
  }
  return !old;
}

/** Messages asking the bot (not /id, not another bot): the bot replies with a lead summary (lib/lead-bot-report.ts). */
export function botQuestion(u: Update) {
  const m = u.message;
  if (!m?.chat?.id || m.from?.is_bot || !m.text?.trim() || idCommand(m.text)) return null;
  return { chatId: m.chat.id, isGroup: m.chat.chat_type === "GROUP", text: m.text, from: m.from?.display_name ?? "" };
}

/** Groups / people who recently messaged the bot. On a test machine (no webhook) also read getUpdates for a few seconds. */
export async function findZaloBotChats() {
  const c = await readConfig();
  if (!c) throw new Error((await getT())("notify.zaloBot.notConnected"));
  if (!c.webhookUrl) {
    for (let i = 0; i < 5; i++) {
      const r = await call<Update | Update[] | null>(c.token, "getUpdates", { timeout: "2" }, 8_000).catch(() => null);
      const list = Array.isArray(r) ? r : r ? [r] : [];
      if (!list.length) break;
      for (const u of list) await recordUpdate(u);
    }
  }
  return loadChats();
}

export async function sendZaloBot(chatId: string, text: string) {
  const r = await call<{ message_id: string }>(await token(), "sendMessage", { chat_id: chatId, text: text.slice(0, 2000) });
  return r.message_id;
}
