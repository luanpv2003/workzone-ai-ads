import { BRAND } from "@/lib/brand";
import nodemailer from "nodemailer";
import { db } from "./db";
import { decrypt, encrypt } from "./crypto";
import { getT } from "@/i18n/server";

// Channels for sending reports to clients besides Zalo OA (System settings → Messaging channels, admins only):
// - Email: the platform's SMTP (e.g. Google Workspace: smtp.gmail.com:465 + App password). Sent from that mailbox; clients reply to it.
// - Telegram: bot created via @BotFather. Add the bot to a group shared with the client, send 1 message in the group → the web finds the group (getUpdates).
// Tokens / passwords are encrypted in the Setting table and never returned to the browser.

const SMTP_KEY = "report.smtp";
const TG_KEY = "report.telegram";

type SmtpConfig = { host: string; port: number; user: string; pass: string; fromName: string; savedBy: string; savedAt: string };
type TelegramConfig = { token: string; username: string; savedBy: string; savedAt: string };

async function readSecret<T>(key: string): Promise<T | null> {
  const row = await db.setting.findUnique({ where: { key } });
  if (!row) return null;
  try {
    return JSON.parse(decrypt(row.value)) as T;
  } catch {
    return null;
  }
}
async function writeSecret(key: string, value: unknown) {
  const v = encrypt(JSON.stringify(value));
  await db.setting.upsert({ where: { key }, create: { key, value: v }, update: { value: v } });
}

// ------------------------------------------------------------------ Email (SMTP)

export async function smtpStatus() {
  const c = await readSecret<SmtpConfig>(SMTP_KEY);
  return c ? { host: c.host, port: c.port, user: c.user, fromName: c.fromName, savedBy: c.savedBy, savedAt: c.savedAt } : null;
}
export type SmtpStatus = Awaited<ReturnType<typeof smtpStatus>>;

const transport = (c: Pick<SmtpConfig, "host" | "port" | "user" | "pass">) =>
  nodemailer.createTransport({ host: c.host, port: c.port, secure: c.port === 465, auth: { user: c.user, pass: c.pass }, connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000 });

/** Save SMTP after a successful test login. Empty pass = keep the old password. */
export async function saveSmtp(v: { host: string; port: number; user: string; pass: string; fromName: string }, by: string) {
  const old = await readSecret<SmtpConfig>(SMTP_KEY);
  const pass = v.pass.trim() ? v.pass.replace(/\s/g, "") : old?.pass; // Google app passwords display as "abcd efgh ..." → strip spaces
  if (!pass) throw new Error((await getT())("notify.channels.noSmtpPass"));
  const c: SmtpConfig = { host: v.host.trim(), port: v.port, user: v.user.trim(), pass, fromName: v.fromName.trim() || BRAND.agency, savedBy: by, savedAt: new Date().toISOString() };
  try {
    await transport(c).verify();
  } catch (err) {
    throw new Error((await getT())("notify.channels.smtpLoginFailed", { err: err instanceof Error ? err.message : String(err) }));
  }
  await writeSecret(SMTP_KEY, c);
}
export const clearSmtp = () => db.setting.deleteMany({ where: { key: SMTP_KEY } });

export async function sendEmail(to: string, subject: string, html: string, text: string) {
  const c = await readSecret<SmtpConfig>(SMTP_KEY);
  if (!c) throw new Error((await getT())("notify.channels.noEmail"));
  const info = await transport(c).sendMail({ from: { name: c.fromName, address: c.user }, to, subject, html, text });
  return info.messageId;
}

// ------------------------------------------------------------------ Telegram

type TgResponse<T> = { ok: boolean; result?: T; description?: string };
async function tg<T>(token: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const j = (await res.json().catch(() => null)) as TgResponse<T> | null;
  if (!j?.ok) throw new Error(`Telegram: ${j?.description ?? `HTTP ${res.status}`}`);
  return j.result as T;
}

export async function telegramStatus() {
  const c = await readSecret<TelegramConfig>(TG_KEY);
  return c ? { username: c.username, savedBy: c.savedBy, savedAt: c.savedAt } : null;
}
export type TelegramStatus = Awaited<ReturnType<typeof telegramStatus>>;

/** Save the bot token after Telegram confirms it (getMe). */
export async function saveTelegramBot(token: string, by: string) {
  const t = token.trim();
  if (!/^\d+:[\w-]{20,}$/.test(t)) throw new Error((await getT())("notify.channels.badTgToken"));
  const me = await tg<{ username: string }>(t, "getMe");
  await writeSecret(TG_KEY, { token: t, username: me.username, savedBy: by, savedAt: new Date().toISOString() } satisfies TelegramConfig);
  return me.username;
}
export const clearTelegramBot = () => db.setting.deleteMany({ where: { key: TG_KEY } });

async function botToken() {
  const c = await readSecret<TelegramConfig>(TG_KEY);
  if (!c) throw new Error((await getT())("notify.channels.noTgBot"));
  return c.token;
}

type TgChat = { id: number; type: string; title?: string; first_name?: string; last_name?: string; username?: string };
type TgUpdate = { message?: { chat: TgChat }; channel_post?: { chat: TgChat }; my_chat_member?: { chat: TgChat } };

/** Groups / people who recently messaged the bot or added it to a group (Telegram keeps updates ~24 hours). */
export async function findTelegramChats() {
  const updates = await tg<TgUpdate[]>(await botToken(), "getUpdates", { allowed_updates: ["message", "channel_post", "my_chat_member"] });
  const chats = new Map<string, { chatId: string; title: string; type: string }>();
  for (const u of updates) {
    const c = u.message?.chat ?? u.channel_post?.chat ?? u.my_chat_member?.chat;
    if (!c) continue;
    const title = c.title ?? ([c.first_name, c.last_name].filter(Boolean).join(" ") || (c.username ? `@${c.username}` : String(c.id)));
    chats.set(String(c.id), { chatId: String(c.id), title, type: c.type === "private" ? "Cá nhân" : c.type === "channel" ? "Kênh" : "Nhóm" });
  }
  return [...chats.values()];
}

export async function sendTelegram(chatId: string, html: string, button?: { text: string; url: string }) {
  const res = await tg<{ message_id: number }>(await botToken(), "sendMessage", {
    chat_id: chatId,
    text: html,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...(button && { reply_markup: { inline_keyboard: [[{ text: button.text, url: button.url }]] } }),
  });
  return String(res.message_id);
}
