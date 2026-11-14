import { BRAND } from "@/lib/brand";
import { z } from "zod";
import { getT } from "@/i18n/server";
import { translator, type T } from "@/i18n/translate";
import { db } from "./db";
import { generateStructured } from "./ai/claude";
import { BOT_REPLY_SYSTEM, DUTY_EXTRACT_SYSTEM } from "./ai/prompts";
import { confirmUrl, deliver, groupText } from "./lead-notify";
import { chatCode, DUTY_DAYS, dutyAt, MERGED_NOTICE, parseLeadNotify, qaLine, type LeadNotifyConfig, type NotifyChannel } from "./lead-notify-config";
import { sinceToDate, type Feedback } from "./lead-sheet";

// Bot replies in groups: a group member tags the bot with a question ("@<bot name> hôm nay bao nhiêu khách?") → the bot replies.
// - Template summary (always available): customers reported to the group in the asked period (today / yesterday / 7 days / this month) + each customer's status.
// - Claude (enabled per client, on by default): free-form questions, reading ~1 month of the customer list + Bot instructions (shared + client-specific).
//   If Claude fails, send the template summary.
// Customer = a Customer list row the bot first reported in the period (LeadNotice table); status comes from lead pickup + sales rating (SalesFeedback).
// Zalo only forwards messages tagging the bot (in groups), so tagging the bot means asking it. Each question is saved to BotChat for review;
// Claude reads the group's recent Q&A turns + lead notifications to follow the thread ("bot nói đúng không" (is the bot right?)).
// The group asks the bot to remember something (duty roster…) → Claude proposes an instruction line (BotChat.note), which only gets added to the Instructions after approval on the web.

const LIST_MAX = 14; // max detail lines in the template summary (Zalo max 2000 characters)
const TEXT_MAX = 2000;
const AI_ROWS = 250; // max customers given to Claude
const HISTORY_MS = 24 * 3600_000; // recent conversations given to Claude
const HISTORY_MAX = 8; // number of Q&A turns
const NOTICE_MAX = 8; // number of recent lead notifications
const DEDUPE_MS = 60_000; // the same question in 1 group (Zalo re-calling the webhook, double send) is answered only once
const recent = new Map<string, number>();

// Order = most urgent work first.
const STATUSES = ["Chưa ai nhận", "Đã nhận, chưa báo kết quả", "Không nghe máy", "Bận, hẹn gọi lại", "Sai số", "Đã gọi được", "Đang chăm", "Đã chốt", "Không mua", "Bỏ lead"] as const;
type Status = (typeof STATUSES)[number];
/** Statuses are stable ids (they mirror the sales-feedback values); the label shown in replies is translated. */
const STATUS_KEY = {
  "Chưa ai nhận": "unclaimed",
  "Đã nhận, chưa báo kết quả": "claimed",
  "Không nghe máy": "noAnswer",
  "Bận, hẹn gọi lại": "callLater",
  "Sai số": "wrongNumber",
  "Đã gọi được": "reached",
  "Đang chăm": "nurturing",
  "Đã chốt": "won",
  "Không mua": "notBuying",
  "Bỏ lead": "dropped",
} as const satisfies Record<Status, string>;
const statusLabel = (t: T, s: Status) => t(`notify.botReport.status.${STATUS_KEY[s]}`);

// Sales picked "Được" (OK) but noted the customer was busy and asked for a callback (before the "Hẹn gọi lại" (Call back) option existed).
const CALL_LATER = /hen (goi|lien he|lh)|goi lai sau|lien he sau|ban,? hen/;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const plain = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d");
const ymd = (d: Date, tz: string) => d.toLocaleDateString("en-CA", { timeZone: tz }); // YYYY-MM-DD
const dm = (d: Date, tz: string) => ymd(d, tz).slice(5).split("-").reverse().join("/"); // 31/10
const hm = (d: Date, tz: string) => d.toLocaleTimeString("vi-VN", { timeZone: tz, hour: "2-digit", minute: "2-digit" });
const parseJson = <T,>(s: string | null, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};

function statusOf(fb: Pick<Feedback, "contact" | "quality" | "outcome" | "note"> | null, acked: boolean): Status {
  if (fb?.outcome === "Đã chốt" || fb?.outcome === "Không mua" || fb?.outcome === "Bỏ lead") return fb.outcome;
  if (fb?.contact === "Sai số" || fb?.contact === "Không nghe máy") return fb.contact;
  if (fb?.contact === "Hẹn gọi lại" || (fb?.contact === "Được" && !fb.outcome && CALL_LATER.test(plain(fb.note)))) return "Bận, hẹn gọi lại";
  if (fb?.outcome === "Đang chăm") return "Đang chăm";
  if (fb?.contact === "Được" || fb?.quality) return "Đã gọi được";
  return acked ? "Đã nhận, chưa báo kết quả" : "Chưa ai nhận";
}

type Period = { from: Date; to: Date; label: string; multiDay: boolean };

/** Period from the question's wording: yesterday / week, 7 days / month; otherwise today. Dates in Vietnam time (like sinceToDate). */
function periodOf(text: string, tz: string, now = new Date(), tr: T = translator("vi")): Period {
  const t = plain(text);
  const today = sinceToDate(ymd(now, tz));
  const day = 86400_000;
  if (/hom qua|qua hom/.test(t)) {
    const from = new Date(today.getTime() - day);
    return { from, to: today, label: tr("notify.botReport.yesterday", { d: dm(from, tz) }), multiDay: false };
  }
  if (/tuan|7 ngay/.test(t)) {
    const from = new Date(today.getTime() - 6 * day);
    return { from, to: now, label: tr("notify.botReport.last7", { from: dm(from, tz), to: dm(now, tz) }), multiDay: true };
  }
  if (/thang/.test(t)) return { from: sinceToDate(`${ymd(now, tz).slice(0, 8)}01`), to: now, label: tr("notify.botReport.month", { m: Number(ymd(now, tz).slice(5, 7)) }), multiDay: true };
  return { from: today, to: now, label: tr("notify.botReport.today", { d: dm(now, tz) }), multiDay: false };
}

type ReportClient = { id: string; name: string; timezone: string };
type GroupCfg = Pick<LeadNotifyConfig, "confirm" | "showPhone" | "duty">;
type Row = { key: string; at: Date; code: string | null; status: Status; by: string | null; fb: Feedback | null; source: "Form" | "Tin nhắn"; name: string; phone: string; need: string; ad: string };

/** Customers the bot first reported to the group within [from, to) (customers reported earlier who message again are not counted), with status and customer info. */
async function leadRows(clientId: string, from: Date, to: Date): Promise<Row[]> {
  const t = await getT();
  const inPeriod = await db.leadNotice.findMany({ where: { clientId, rowKey: { not: null }, createdAt: { gte: from, lt: to } }, select: { rowKey: true } });
  const keys = [...new Set(inPeriod.map((n) => n.rowKey!))];
  const before = new Set((await db.leadNotice.findMany({ where: { clientId, rowKey: { in: keys }, createdAt: { lt: from } }, select: { rowKey: true } })).map((n) => n.rowKey!));
  const newKeys = keys.filter((k) => !before.has(k));
  if (!newKeys.length) return [];
  const idsOf = (p: string) => newKeys.filter((k) => k.startsWith(p)).map((k) => k.slice(2));
  const [notices, fbs, leads, convs] = await Promise.all([
    db.leadNotice.findMany({ where: { clientId, rowKey: { in: newKeys } }, orderBy: { createdAt: "asc" }, select: { rowKey: true, code: true, createdAt: true, ackBy: true, ackAt: true } }),
    db.salesFeedback.findMany({ where: { clientId, rowKey: { in: newKeys } } }),
    db.lead.findMany({ where: { clientId, id: { in: idsOf("F-") } }, select: { id: true, name: true, phone: true, phones: true, answers: true, adName: true } }),
    db.conversation.findMany({ where: { clientId, id: { in: idsOf("M-") } }, select: { id: true, customerName: true, phone: true, phones: true, intent: true, sourceAdId: true } }),
  ]);
  const adIds = convs.map((c) => c.sourceAdId).filter((x): x is string => !!x);
  const ads = new Map((await db.ownAd.findMany({ where: { clientId, id: { in: adIds } }, select: { id: true, name: true } })).map((a) => [a.id, a.name]));
  const fbOf = new Map(fbs.map((f) => [f.rowKey, f]));
  const leadOf = new Map(leads.map((l) => [`F-${l.id}`, l]));
  const convOf = new Map(convs.map((c) => [`M-${c.id}`, c]));
  const rows: Row[] = [];
  for (const key of newKeys) {
    const ns = notices.filter((n) => n.rowKey === key);
    const ack = ns.filter((n) => n.ackAt).sort((a, b) => a.ackAt!.getTime() - b.ackAt!.getTime())[0];
    const f = fbOf.get(key);
    const fb = f ? { contact: f.contact, quality: f.quality, outcome: f.outcome, note: f.note } : null;
    const base = { key, at: ns[0].createdAt, code: [...ns].reverse().find((n) => n.code)?.code ?? null, status: statusOf(fb, !!ack), by: ack?.ackBy ?? null, fb };
    const l = leadOf.get(key);
    const c = convOf.get(key);
    if (l) {
      const need = parseJson<{ q: string; a: string }[]>(l.answers, []).map((x) => qaLine(x.q, x.a)).join("; ");
      rows.push({ ...base, source: "Form", name: l.name || t("notify.lead.noName"), phone: l.phone ?? parseJson<string[]>(l.phones, [])[0] ?? "", need, ad: l.adName ?? "" });
    } else if (c) {
      rows.push({ ...base, source: "Tin nhắn", name: c.customerName, phone: c.phone ?? parseJson<string[]>(c.phones, [])[0] ?? "", need: c.intent ?? "", ad: (c.sourceAdId && ads.get(c.sourceAdId)) || "" });
    }
  }
  return rows.sort((a, b) => a.at.getTime() - b.at.getTime());
}

const who = (r: Row) => [r.name, r.phone].filter(Boolean).join(" · ");

/** Customer summary message for 1 client in the period: counts by status + list (most urgent first), with lead pickup / result reporting links. */
async function leadStatusReport(c: ReportClient, cfg: GroupCfg, p: Period) {
  const t = await getT();
  const rows = await leadRows(c.id, p.from, p.to);
  const head = `📊 ${c.name} – ${p.label}`;
  if (!rows.length) return `${head}${t("notify.botReport.none")}`;
  const count = (s: Status) => rows.filter((r) => r.status === s).length;
  const summary = STATUSES.filter((s) => count(s)).map((s) => `• ${statusLabel(t, s)}: ${count(s)}`);
  const sorted = [...rows].sort((a, b) => STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status) || a.at.getTime() - b.at.getTime());
  const lines = sorted.slice(0, LIST_MAX).map((r, i) => {
    const when = p.multiDay ? `${dm(r.at, c.timezone)} ${hm(r.at, c.timezone)}` : hm(r.at, c.timezone);
    const duty = r.status === "Chưa ai nhận" ? dutyAt(cfg, r.at, c.timezone) : "";
    const by = r.by && r.status !== "Chưa ai nhận" ? ` (${r.by})` : duty ? ` (${t("notify.botReport.onDuty", { duty })})` : "";
    const note = r.fb?.note ? ` – ${clip(r.fb.note.replace(/\s+/g, " "), 60)}` : "";
    return `${i + 1}. ${when} ${who(r)} – ${statusLabel(t, r.status)}${by}${note}${r.code ? ` 👉 ${confirmUrl(r.code)}` : ""}`;
  });
  const build = (detail: string[]) =>
    [`${head}: ${t("notify.botReport.count", { n: rows.length })}`, ...summary, "", ...detail, ...(rows.length > detail.length ? [t("notify.confirm.remindMore", { n: rows.length - detail.length })] : [])].join("\n");
  let text = groupText(cfg, build(lines));
  // Over 2000 characters: trim detail lines.
  for (let n = lines.length - 1; text.length > TEXT_MAX && n >= 0; n--) text = groupText(cfg, build(lines.slice(0, n)));
  return text;
}

// ------------------------------------------------------------------ Bot settings (enable Claude + Instructions)

type BotSettings = { ai: boolean; guide: string };
export const GUIDE_MAX = 4000;
const settingKey = (clientId: string | null) => (clientId ? `bot.${clientId}` : "bot.global");

/** clientId null = shared Instructions for all clients (System settings → Messaging channels). */
export async function botSettings(clientId: string | null): Promise<BotSettings> {
  const row = await db.setting.findUnique({ where: { key: settingKey(clientId) } });
  const v = parseJson<Partial<BotSettings>>(row?.value ?? null, {});
  return { ai: v.ai !== false, guide: typeof v.guide === "string" ? v.guide : "" };
}

export async function saveBotSettings(clientId: string | null, s: BotSettings) {
  const value = JSON.stringify({ ai: !!s.ai, guide: String(s.guide ?? "").trim().slice(0, GUIDE_MAX) });
  await db.setting.upsert({ where: { key: settingKey(clientId) }, create: { key: settingKey(clientId), value }, update: { value } });
}

/** Bot questions in 7 days + questions where Claude reported missing info + memory proposals awaiting approval (Bot replies tab). */
export async function botChatStats(clientId: string) {
  const week = new Date(Date.now() - 7 * 86400_000);
  const [total, unanswered, notes] = await Promise.all([
    db.botChat.count({ where: { clientId, createdAt: { gte: week } } }),
    db.botChat.count({ where: { clientId, answered: false, createdAt: { gte: week } } }),
    db.botChat.count({ where: { clientId, noteStatus: "pending" } }),
  ]);
  return { total, unanswered, notes };
}

// ------------------------------------------------------------------ Claude replies

const ReplySchema = z.object({
  answer: z.string().describe("Reply posted into the group, in Vietnamese: plain text, concise, results first"),
  answered: z.boolean().describe("true if it could be answered with the data provided; false if information was missing"),
  note: z.string().describe("Information the group asked the bot to remember, written as 1–5 lines of instructions in Vietnamese; empty if none"),
});

// Weekday names stay Vietnamese: the duty roster and the Instructions the model matches against are written in Vietnamese.
const WEEKDAY = ["Chủ nhật", "Thứ hai", "Thứ ba", "Thứ tư", "Thứ năm", "Thứ sáu", "Thứ bảy"];

/** What the bot saw in the group over the last 24 hours: Q&A turns + lead notifications. chatId null (Test question on the web) = all of the client's groups. */
async function recentContext(clientId: string, chatId: string | null, tz: string, now: Date) {
  const since = new Date(now.getTime() - HISTORY_MS);
  const [chats, notices] = await Promise.all([
    db.botChat.findMany({ where: { clientId, ...(chatId && { chatId }), createdAt: { gte: since, lt: now } }, orderBy: { createdAt: "desc" }, take: HISTORY_MAX }),
    db.leadNotice.findMany({ where: { clientId, createdAt: { gte: since, lt: now }, NOT: { text: MERGED_NOTICE } }, orderBy: { createdAt: "desc" }, take: NOTICE_MAX, select: { createdAt: true, text: true } }),
  ]);
  const flat = (t: string, n: number) => clip(t.replace(/\s*\n+\s*/g, " / "), n);
  const items = [
    ...chats.flatMap((b) => [
      { at: b.createdAt, line: `${hm(b.createdAt, tz)} ${b.fromName || "Someone"}: ${flat(b.question, 300)}` },
      { at: new Date(b.createdAt.getTime() + 1), line: `${hm(b.createdAt, tz)} Bot replied: ${flat(b.answer, 500)}` },
    ]),
    ...notices.map((n) => ({ at: n.createdAt, line: `${hm(n.createdAt, tz)} Bot lead notice: ${flat(n.text, 220)}` })),
  ];
  return items.sort((a, b) => a.at.getTime() - b.at.getTime()).map((x) => `${dm(x.at, tz)} ${x.line}`);
}

async function claudeReply(c: ReportClient, cfg: GroupCfg, question: string, from: string, own: BotSettings, chatId: string | null) {
  const now = new Date();
  const period = periodOf(question, c.timezone, now, await getT());
  const today = sinceToDate(ymd(now, c.timezone));
  const since = new Date(Math.min(sinceToDate(`${ymd(now, c.timezone).slice(0, 8)}01`).getTime(), today.getTime() - 30 * 86400_000));
  const [rows, global, report, history] = await Promise.all([leadRows(c.id, since, now), botSettings(null), leadStatusReport(c, cfg, period), recentContext(c.id, chatId, c.timezone, now)]);
  const list = rows.slice(-AI_ROWS).reverse();
  const fbText = (f: Feedback | null) => (f ? [f.contact && `contact ${f.contact}`, f.quality && `quality ${f.quality}`, f.outcome && `outcome ${f.outcome}`].filter(Boolean).join(", ") : "");
  const line = (r: Row) =>
    [
      `${dm(r.at, c.timezone)} ${hm(r.at, c.timezone)}`,
      r.source,
      r.name,
      r.phone || "no phone number",
      r.status,
      r.by ? `claimed by: ${r.by}` : "",
      dutyAt(cfg, r.at, c.timezone) ? `on duty that day: ${dutyAt(cfg, r.at, c.timezone)}` : "",
      fbText(r.fb),
      r.fb?.note ? `sales note: ${clip(r.fb.note.replace(/\s+/g, " "), 200)}` : "",
      r.need ? `need: ${clip(r.need.replace(/\s+/g, " "), 160)}` : "",
      r.ad ? `ad: ${r.ad}` : "",
      r.code ? confirmUrl(r.code) : "",
    ]
      .filter(Boolean)
      .join(" | ");
  const t = now.toLocaleString("vi-VN", { timeZone: c.timezone, hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit", year: "numeric" });
  const weekday = WEEKDAY[new Date(`${ymd(now, c.timezone)}T12:00:00Z`).getUTCDay()];
  const roster = cfg.duty.some(Boolean)
    ? [...DUTY_DAYS.map((d) => `${d.label}: ${cfg.duty[d.day] || "(empty)"}`), `On duty today (${weekday}): ${dutyAt(cfg, now, c.timezone) || "not set"}`].join("\n")
    : "";
  const prompt = `Client: ${c.name}
Now: ${weekday}, ${t}
Asked by: ${from || "(name unknown)"}

# ${BRAND.agency}'s Instructions ("Hướng dẫn", shared by all clients)
${global.guide || "(none)"}

# Instructions specific to ${c.name}
${own.guide || "(none)"}

# Duty roster ("Lịch trực", set in the system; applies to lead notices and reminders; takes priority over a roster written in the Instructions if they differ)
${roster || "(not set)"}

# Customer statuses (use these Vietnamese names as written)
Chưa ai nhận (Unclaimed: no salesperson has claimed it) · Đã nhận, chưa báo kết quả (claimed, no outcome reported yet) · Không nghe máy (no answer) · Bận, hẹn gọi lại (busy, call back later) · Sai số (wrong number) · Đã gọi được (reached) · Đang chăm (nurturing) · Đã chốt (closed) · Không mua (not buying) · Bỏ lead (dropped: sales gave up because the customer could not be reached; the bot stops reminding).

# Counts pre-computed by the system ("Tổng hợp hệ thống đã đếm sẵn", ${period.label})
${report}

# Customers the bot reported to the group since ${dm(since, c.timezone)} (newest first, ${list.length}${rows.length > list.length ? `/${rows.length}` : ""} customers)
${list.map(line).join("\n") || "(no customers yet)"}

# Recent conversation in the group ("Hội thoại gần đây", 24 hours, oldest first; the bot only sees messages that tag the bot and messages the bot sent)
${history.join("\n") || "(none yet)"}

# Message that just tagged the bot (${from || "name unknown"})
${question}`;
  const res = await generateStructured({ clientId: c.id, system: BOT_REPLY_SYSTEM, prompt: groupText(cfg, prompt), schema: ReplySchema, effort: "low" });
  return { answer: groupText(cfg, res.data.answer).slice(0, TEXT_MAX), answered: res.data.answered, note: res.data.note.trim().slice(0, 1000) || null };
}

/** The bot's answer for 1 client (not yet sent): Claude if enabled, on error the template summary. */
export async function botAnswer(c: ReportClient, cfg: GroupCfg, question: string, from: string, chatId: string | null = null) {
  const own = await botSettings(c.id);
  const tr = await getT();
  const report = () => leadStatusReport(c, cfg, periodOf(question, c.timezone, new Date(), tr));
  if (!own.ai) return { mode: "report" as const, answer: await report(), answered: true, note: null, error: null };
  try {
    return { mode: "ai" as const, ...(await claudeReply(c, cfg, question, from, own, chatId)), error: null };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`Bot reply for ${c.name} via Claude failed, sending the summary instead:`, error);
    return { mode: "fallback" as const, answer: await report(), answered: true, note: null, error };
  }
}

// ------------------------------------------------------------------ Memory proposals (approved on the web)

export async function pendingNotes(clientId: string) {
  return db.botChat.findMany({ where: { clientId, noteStatus: "pending" }, orderBy: { createdAt: "asc" }, select: { id: true, createdAt: true, fromName: true, question: true, note: true } });
}

/** Approve a memory proposal: "add" = append (edited content) to the end of the client's own Instructions; "dismiss" = ignore. */
export async function resolveNote(clientId: string, id: string, action: "add" | "dismiss", text?: string) {
  const row = await db.botChat.findFirst({ where: { id, clientId, noteStatus: "pending" } });
  if (!row) throw new Error((await getT())("notify.botReport.noteGone"));
  if (action === "add") {
    const add = String(text ?? row.note ?? "").trim();
    if (!add) throw new Error((await getT())("notify.botReport.noteEmpty"));
    const own = await botSettings(clientId);
    const guide = own.guide ? `${own.guide.trimEnd()}\n${add}` : add;
    if (guide.length > GUIDE_MAX) throw new Error((await getT())("notify.botReport.guideTooLong", { max: GUIDE_MAX }));
    await saveBotSettings(clientId, { ...own, guide });
  }
  await db.botChat.update({ where: { id }, data: { noteStatus: action === "add" ? "added" : "dismissed", ...(action === "add" && text?.trim() && { note: text.trim() }) } });
}


/** Question tagging the bot in a group (not /id) → answer for each client reporting leads into this group, saved to BotChat. */
export async function answerGroupQuestion(channel: NotifyChannel, chatId: string, isGroup: boolean, text: string, from: string) {
  const t = await getT();
  const HELP = t("notify.botReport.help");
  const now = Date.now();
  const dedupe = `${chatId}:${text}`;
  if (now - (recent.get(dedupe) ?? 0) < DEDUPE_MS) return;
  recent.set(dedupe, now);
  for (const [k, at] of recent) if (now - at > DEDUPE_MS) recent.delete(k);

  const question = text.slice(0, 1000);
  const clients = (await db.client.findMany({ where: { leadNotify: { contains: chatId } }, select: { id: true, name: true, timezone: true, leadNotify: true } }))
    .map((c) => ({ c, cfg: parseLeadNotify(c.leadNotify) }))
    .filter(({ cfg }) => cfg.targets.some((t) => t.channel === channel && t.chatId === chatId));
  const send = async (answer: string) => {
    const [r] = await deliver([{ channel, chatId, title: "" }], answer);
    if (!r.ok) console.error(`Bot reply to group ${chatCode(chatId)} failed:`, r.error);
    return { sent: r.ok, error: r.ok ? null : t("notify.botReport.sendError", { err: r.error ?? "" }) };
  };
  if (!clients.length) {
    // A private message to the bot not linked to any client: stay silent (the bot is shared); in a group, explain how to link.
    if (!isGroup) return;
    const answer = t("notify.botReport.unlinked", { code: chatCode(chatId) });
    const r = await send(answer);
    await db.botChat.create({ data: { clientId: null, channel, chatId, fromName: from, question, answer, mode: "unlinked", sent: r.sent, error: r.error } });
    return;
  }
  for (const [i, { c, cfg }] of clients.entries()) {
    const t0 = Date.now();
    const a = await botAnswer(c, cfg, question, from, chatId);
    // The template summary explains how to ask more; Claude answers naturally on its own.
    const help = i === clients.length - 1 && a.mode !== "ai" && a.answer.length + HELP.length + 2 <= TEXT_MAX;
    const answer = help ? `${a.answer}\n\n${HELP}` : a.answer;
    const r = await send(answer);
    const error = [a.error, r.error].filter(Boolean).join(" · ") || null;
    await db.botChat.create({
      data: { clientId: c.id, channel, chatId, fromName: from, question, answer, mode: a.mode, answered: a.answered, sent: r.sent, error, ms: Date.now() - t0, ...(a.note && { note: a.note, noteStatus: "pending" }) },
    });
  }
}

// ------------------------------------------------------------------ Duty roster from Instructions (pre-filled, the user reviews then Saves)

const DutySchema = z.object({
  found: z.boolean(),
  mon: z.string(),
  tue: z.string(),
  wed: z.string(),
  thu: z.string(),
  fri: z.string(),
  sat: z.string(),
  sun: z.string(),
});

/** Claude reads the Bot instructions (client-specific + shared) → person on duty by Date.getDay() (0 = Sunday). null = no roster found. */
export async function dutyFromGuide(clientId: string) {
  const [own, global] = await Promise.all([botSettings(clientId), botSettings(null)]);
  const text = [own.guide, global.guide].filter(Boolean).join("\n\n");
  if (!text.trim()) return null;
  const res = await generateStructured({ clientId: clientId, system: DUTY_EXTRACT_SYSTEM, prompt: `# Instructions for the bot\n${text}`, schema: DutySchema, effort: "low" });
  const d = res.data;
  return d.found ? [d.sun, d.mon, d.tue, d.wed, d.thu, d.fri, d.sat].map((x) => x.trim()) : null;
}
