import { randomBytes } from "node:crypto";
import type { Client, Conversation, Lead } from "@prisma/client";
import { db } from "./db";
import { getMetaClient } from "./meta";
import { clientPages } from "./client-pages";
import { extractContacts, hidePhonesIn } from "./pii";
import { sendZaloBot } from "./zalo-bot";
import { sendTelegram } from "./report-channels";
import { dutyAt, MERGED_NOTICE, parseLeadNotify, qaLine, type LeadNotifyConfig, type NotifyTarget } from "./lead-notify-config";
import { getT } from "@/i18n/server";
import type { T } from "@/i18n/translate";
import { confirmLine, DUTY_LINE, dutyLine, renderNotice, type TemplateKey, type Templates, type TemplateVars } from "./notify-templates";
import { globalTemplates } from "./notify-templates-db";
import { publicUrl } from "./zalo";

export * from "./lead-notify-config";

// New lead notifications to the Zalo group (Zalo Bot) / Telegram shared with the client (client page → Notifications & reports).
// Background job scans the DB every minute (runLeadNotify), so it catches leads whether they arrive via webhook, fast message sync or full sync:
// - form: new Instant Form leads (pollFormLeads reads Meta every 5 minutes for clients with it on, since form leads only arrive on sync).
// - chat "new": new conversation (customer's first message after enabling) · "phone": customer types a phone number in a message.
// A customer sending their phone number multiple times (messaging again, refilling the form) is notified each time, marked "time N" (repeating = genuinely interested);
// multiple phone-bearing messages in one scan are combined into 1 notice. Each message / lead is notified exactly once (LeadNotice table).
// Only notify leads after enabling; no backlog of old leads.
// Message content from templates (lib/notify-templates.ts): client template → shared template → default.
// Confirmation (Zalo Bot has no buttons): each message includes a /l/<code> link → sales clicks Claim, reports the result after calling (written to the sales rating
// of the Lead list, same place as the web and Google Sheet); the bot reports back to the group. If unclaimed after N minutes, remind once (runLeadReminders).

const MAX_PER_RUN = 5; // beyond this, combine into 1 list message to avoid spamming the group
const NOTICE_TTL = 7 * 86400_000; // only consider leads / messages from the last 7 days

type Notice = { kind: "form" | "chat" | "phone"; refId: string; rowKey: string; code: string | null; text: string; line: string; also?: { kind: "phone" | "chat"; refId: string }[] };

const fmtTime = (d: Date, tz: string) => d.toLocaleString("vi-VN", { timeZone: tz, hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const noticeId = (clientId: string, kind: string, refId: string) => `${clientId}:${kind}:${refId}`;
/** Confirmation link code: 8 random alphanumeric chars (~47 bits), unguessable. No "-" / "_": Zalo may cut trailing chars off links. */
const CODE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const newCode = () => [...randomBytes(8)].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
export const confirmUrl = (code: string) => `${publicUrl()}/l/${code}`;
/** If an edited template lacks {link_xac_nhan}, still append the link at the end (when confirmation is on). */
const withLink = (t: T, text: string, code: string | null) => (code && !text.includes(confirmUrl(code)) ? `${text}\n${confirmLine(t).replace("{link_xac_nhan}", confirmUrl(code))}` : text);
const linkVar = (code: string | null) => ({ link_xac_nhan: code ? confirmUrl(code) : null });

/** If an edited template lacks {nguoi_truc}, still include the on-duty person: insert before the claim-link line (or at the end). */
export function withDuty(text: string, duty: string, line = DUTY_LINE) {
  if (!duty || text.includes(duty)) return text;
  const add = line.replace("{nguoi_truc}", duty);
  const i = text.indexOf("\n👉 ");
  return i < 0 ? `${text}\n${add}` : `${text.slice(0, i)}\n${add}${text.slice(i)}`;
}

/** at = when the customer left the lead: on-duty person for that weekday (Lead notifications → On-duty by day). */
type Render = (key: TemplateKey, vars: TemplateVars, at: Date) => string;
/** Group message: mask phone (09123xxx) when "Hiện đủ SĐT" (show full phone) is off — sales sees the full number via the claim link. Without a link, always show in full. */
export const groupText = (cfg: Pick<LeadNotifyConfig, "confirm" | "showPhone">, text: string) => (cfg.confirm && !cfg.showPhone ? hidePhonesIn(text) : text);
const renderFor = (c: Pick<Client, "name" | "timezone">, cfg: LeadNotifyConfig, global: Templates, t: T): Render => (key, vars, at) => {
  const duty = dutyAt(cfg, at, c.timezone);
  return groupText(cfg, withDuty(renderNotice(key, { khach_hang: c.name, nguoi_truc: duty, ...vars }, cfg.templates, global, t), duty, dutyLine(t)));
};
type Msg = { id: string; text: string; createdTime: Date };

// Build the message for each type (shared by the background job and the "Báo vào nhóm" (notify group) button in the Lead list).
function formNotice(l: Lead, times: number, tz: string, render: Render, code: string | null, t: T): Notice {
  let answers: { q: string; a: string }[] = [];
  try {
    answers = JSON.parse(l.answers);
  } catch {}
  const ten = l.name || t("notify.lead.noName");
  const who = [ten, l.phone].filter(Boolean).join(" · ");
  return {
    kind: "form",
    refId: l.id,
    rowKey: `F-${l.id}`,
    code,
    line: t("notify.lead.lineForm", { who, time: fmtTime(l.createdTime, tz), repeat: times > 1 ? t("notify.lead.repeat", { n: times }) : "" }),
    text: withLink(t, render(times > 1 ? "formRepeat" : "form", {
      ten,
      sdt: l.phone,
      ten_sdt: who,
      email: l.email,
      cau_tra_loi: answers
        .slice(0, 4)
        .map((x) => qaLine(clip(x.q, 60), clip(x.a, 120)))
        .join("\n"),
      form: l.formName || l.formId,
      quang_cao: l.adName,
      lan_thu: times,
      thoi_gian: fmtTime(l.createdTime, tz),
      ...linkVar(code),
    }, l.createdTime), code),
  };
}

function chatVarsOf(cv: Conversation, adName: string | null, phone: string | null, t: T) {
  const who = `${cv.customerName}${phone ? ` · ${phone}` : ""}`;
  return { who, vars: { ten: cv.customerName, quang_cao: adName, nguon: adName ? t("notify.lead.adSource", { name: adName }) : cv.adReply ? t("notify.lead.fromAd") : null, link_hop_thu: cv.link, sdt: phone, ten_sdt: who } };
}

/** New conversation: the customer's first message. */
function chatNotice(cv: Conversation, first: Msg, phone: string | null, adName: string | null, tz: string, render: Render, code: string | null, t: T): Notice {
  const { who, vars } = chatVarsOf(cv, adName, phone, t);
  const text = render("chat", { ...vars, tin_nhan: clip(first.text, 200), thoi_gian: fmtTime(first.createdTime, tz), ...linkVar(code) }, first.createdTime);
  return { kind: "chat", refId: cv.id, rowKey: `M-${cv.id}`, code, line: t("notify.lead.lineChat", { who, time: fmtTime(first.createdTime, tz) }), text: withLink(t, text, code) };
}

/** Customer typed a phone number in a message; times = total times a phone was sent in the conversation. */
function phoneNotice(cv: Conversation, last: Msg, phone: string | null, times: number, adName: string | null, tz: string, render: Render, code: string | null, t: T): Notice {
  const { who, vars } = chatVarsOf(cv, adName, phone, t);
  const text = render(times > 1 ? "phoneRepeat" : "phone", { ...vars, tin_nhan: clip(last.text, 200), lan_thu: times, thoi_gian: fmtTime(last.createdTime, tz), ...linkVar(code) }, last.createdTime);
  return { kind: "phone", refId: last.id, rowKey: `M-${cv.id}`, code, line: t("notify.lead.linePhone", { who, repeat: times > 1 ? t("notify.lead.repeat", { n: times }) : "" }), text: withLink(t, text, code) };
}

/** Number of times the customer left a phone number up to this lead (earlier forms with the same phone + conversations with that phone). */
async function formTimes(clientId: string, leads: Lead[]) {
  const phones = [...new Set(leads.map((l) => l.phone).filter((x): x is string => !!x))];
  const [prevLeads, prevConvs] = phones.length
    ? await Promise.all([
        db.lead.findMany({ where: { clientId, phone: { in: phones } }, select: { id: true, phone: true, createdTime: true } }),
        db.conversation.findMany({ where: { clientId, phone: { in: phones } }, select: { phone: true } }),
      ])
    : [[], []];
  return (l: Lead) => (l.phone ? prevLeads.filter((x) => x.phone === l.phone && x.createdTime <= l.createdTime).length + prevConvs.filter((x) => x.phone === l.phone).length : 1);
}

const adNames = async (clientId: string, ids: (string | null)[]) =>
  new Map((await db.ownAd.findMany({ where: { clientId, id: { in: ids.filter((x): x is string => !!x) } }, select: { id: true, name: true } })).map((a) => [a.id, a.name]));

async function sendTo(t: NotifyTarget, text: string) {
  if (t.channel === "zalobot") return sendZaloBot(t.chatId, text);
  const html = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return sendTelegram(t.chatId, html);
}

/** Send 1 message to every destination. Returns the result per destination. */
export async function deliver(targets: NotifyTarget[], text: string) {
  const out: { channel: string; chatId: string; ok: boolean; error?: string; at: string }[] = [];
  for (const t of targets) {
    try {
      await sendTo(t, text);
      out.push({ channel: t.channel, chatId: t.chatId, ok: true, at: new Date().toISOString() });
    } catch (err) {
      out.push({ channel: t.channel, chatId: t.chatId, ok: false, error: err instanceof Error ? err.message : String(err), at: new Date().toISOString() });
    }
  }
  return out;
}

async function pendingNotices(c: Client, cfg: LeadNotifyConfig, global: Templates, t: T): Promise<Notice[]> {
  const render = renderFor(c, cfg, global, t);
  const since = new Date(Math.max(cfg.since ? new Date(cfg.since).getTime() : Date.now(), Date.now() - NOTICE_TTL));
  const tz = c.timezone;
  const code = () => (cfg.confirm ? newCode() : null);
  const out: Notice[] = [];

  if (cfg.form) {
    const leads = await db.lead.findMany({ where: { clientId: c.id, createdTime: { gte: since } }, orderBy: { createdTime: "asc" }, take: 50 });
    // Customer left their phone multiple times (repeated form, or already messaged with a phone) = genuinely interested → state which time this is.
    const timesOf = await formTimes(c.id, leads);
    for (const l of leads) out.push(formNotice(l, timesOf(l), tz, render, code(), t));
  }

  if (cfg.chat !== "off") {
    const convs = await db.conversation.findMany({
      where: { clientId: c.id, updatedTime: { gte: since }, ...(cfg.chat === "phone" && { phone: { not: null } }) },
      orderBy: { updatedTime: "asc" },
      take: 50,
      include: { messages: { where: { fromCustomer: true }, orderBy: { createdTime: "asc" }, take: 300 } },
    });
    const ads = await adNames(c.id, convs.map((x) => x.sourceAdId));
    // Each customer message containing a phone (after enabling) is 1 notice; notified messages are recorded by message id.
    const phoneMsgs = convs.flatMap((cv) => cv.messages.filter((m) => m.createdTime >= since && extractContacts([m.text]).phones.length).map((m) => m.id));
    const doneMsgs = new Set(
      (await db.leadNotice.findMany({ where: { id: { in: phoneMsgs.map((id) => noticeId(c.id, "phone", id)) } }, select: { refId: true } })).map((x) => x.refId),
    );
    for (const cv of convs) {
      const first = cv.messages[0];
      const adName = cv.sourceAdId ? ads.get(cv.sourceAdId) || cv.sourceAdId : null;
      const withPhone = cv.messages.map((m) => ({ m, phones: extractContacts([m.text]).phones })).filter((x) => x.phones.length);
      const fresh = withPhone.filter((x) => x.m.createdTime >= since && !doneMsgs.has(x.m.id));
      const times = withPhone.length; // total times the customer sent a phone number in this conversation
      const phone = fresh.at(-1)?.phones[0] ?? cv.phone;
      if (cfg.chat === "new" && first && first.createdTime >= since) {
        // New conversation: 1 message (also folding in phone sends in this run).
        out.push({ ...chatNotice(cv, first, phone, adName, tz, render, code(), t), also: fresh.map((x) => ({ kind: "phone" as const, refId: x.m.id })) });
        continue;
      }
      if (!fresh.length) continue;
      out.push({ ...phoneNotice(cv, fresh.at(-1)!.m, phone, times, adName, tz, render, code(), t), also: fresh.slice(0, -1).map((x) => ({ kind: "phone" as const, refId: x.m.id })) });
    }
  }
  if (!out.length) return [];
  const done = new Set((await db.leadNotice.findMany({ where: { id: { in: out.map((n) => noticeId(c.id, n.kind, n.refId)) } }, select: { id: true } })).map((x) => x.id));
  return out.filter((n) => !done.has(noticeId(c.id, n.kind, n.refId)));
}

/** One run for one client: notify leads not yet notified. */
async function notifyClient(c: Client) {
  const cfg = parseLeadNotify(c.leadNotify);
  if (!cfg.on || !cfg.targets.length) return 0;
  const t = await getT();
  const global = await globalTemplates();
  const list = await pendingNotices(c, cfg, global, t);
  if (!list.length) return 0;
  // Record first, then send: 2 overlapping runs won't double-notify (id is the primary key).
  const mine: Notice[] = [];
  for (const n of list) {
    const ok = await db.leadNotice
      .create({ data: { id: noticeId(c.id, n.kind, n.refId), clientId: c.id, kind: n.kind, refId: n.refId, rowKey: n.rowKey, code: n.code, text: n.text } })
      .then(() => true)
      .catch(() => false);
    if (!ok) continue;
    mine.push(n);
    for (const x of n.also ?? []) await db.leadNotice.create({ data: { id: noticeId(c.id, x.kind, x.refId), clientId: c.id, kind: x.kind, refId: x.refId, text: MERGED_NOTICE } }).catch(() => {});
  }
  if (!mine.length) return 0;
  if (mine.length > MAX_PER_RUN) {
    // Each line carries a claim link so fewer lines fit (Zalo max 2000 characters / message); remaining leads are on the web.
    const max = cfg.confirm ? 14 : 20;
    const rows = [...mine.slice(0, max).map((n, i) => `${i + 1}. ${n.line}${n.code ? ` 👉 ${confirmUrl(n.code)}` : ""}`), mine.length > max ? t("notify.lead.digestMore", { n: mine.length - max }) : null].filter(Boolean).join("\n");
    const text = withDuty(renderNotice("digest", { khach_hang: c.name, so_lead: mine.length, danh_sach: rows }, cfg.templates, global, t), dutyAt(cfg, new Date(), c.timezone), dutyLine(t));
    const sends = await deliver(cfg.targets, groupText(cfg, text));
    await db.leadNotice.updateMany({ where: { id: { in: mine.map((n) => noticeId(c.id, n.kind, n.refId)) } }, data: { sends: JSON.stringify(sends) } });
  } else {
    for (const n of mine) {
      const sends = await deliver(cfg.targets, n.text);
      await db.leadNotice.update({ where: { id: noticeId(c.id, n.kind, n.refId) }, data: { sends: JSON.stringify(sends) } });
    }
  }
  return mine.length;
}

/** Background job, every minute: every client with notifications on. */
export async function runLeadNotify() {
  const lines: string[] = [];
  for (const c of await db.client.findMany({ where: { leadNotify: { contains: '"on":true' } } })) {
    const n = await notifyClient(c).catch((err) => (console.error(`Lead notification failed for ${c.name}:`, err instanceof Error ? err.message : err), 0));
    if (n) lines.push(`${c.name}: ${n} lead`);
  }
  return lines;
}

/** Background job, every 5 minutes: read the last day of form leads for clients with form-lead notices on (form leads only arrive on sync). */
export async function pollFormLeads() {
  let total = 0;
  for (const c of await db.client.findMany({ where: { dataSource: "meta", metaAccessToken: { not: null }, leadNotify: { contains: '"on":true' } } })) {
    if (!parseLeadNotify(c.leadNotify).form) continue;
    const meta = getMetaClient(c);
    for (const page of clientPages(c)) {
      try {
        const { leads } = await meta.fetchLeads(1, page.id);
        for (const l of leads) await db.lead.upsert({ where: { id: l.id }, create: { ...l, clientId: c.id, pageId: page.id }, update: { ...l, pageId: page.id, syncedAt: new Date() } });
        total += leads.length;
      } catch (err) {
        console.error(`Reading form leads failed for ${c.name} (${page.name}):`, err instanceof Error ? err.message : err);
      }
    }
  }
  return total;
}

/** Send 1 test message to the client's destinations ("Tin thử" (test message) template). */
export async function sendTestNotice(c: Pick<Client, "name">, targets: NotifyTarget[], templates?: Templates) {
  return deliver(targets, renderNotice("test", { khach_hang: c.name }, templates, await globalTemplates(), await getT()));
}

// ------------------------------------------------------------------ Manual notify (Lead list → "Báo vào nhóm" button)
// For leads / conversations that predate the bot setup or enabling. Uses the same templates as automatic notices; requires notification groups to be chosen
// (auto-notify need not be on). Recorded in LeadNotice so the background job won't duplicate it and to know when it was notified.

/** Lead list rowKey: "F-<lead id>" (form) or "M-<conversation id>" (message). */
async function manualNotice(c: Client, cfg: LeadNotifyConfig, global: Templates, rowKey: string): Promise<Notice> {
  const t = await getT();
  const render = renderFor(c, cfg, global, t);
  const id = rowKey.slice(2);
  // Re-notifying the same message keeps the old link code: links in earlier messages still open.
  const old = new Map((await db.leadNotice.findMany({ where: { clientId: c.id, rowKey, code: { not: null } }, select: { id: true, code: true } })).map((x) => [x.id, x.code!]));
  const codeOf = (kind: string, refId: string) => (cfg.confirm ? (old.get(noticeId(c.id, kind, refId)) ?? newCode()) : null);
  if (rowKey.startsWith("F-")) {
    const l = await db.lead.findFirst({ where: { id, clientId: c.id } });
    if (!l) throw new Error(t("notify.lead.leadNotFound"));
    return formNotice(l, (await formTimes(c.id, [l]))(l), c.timezone, render, codeOf("form", l.id), t);
  }
  if (!rowKey.startsWith("M-")) throw new Error(t("notify.lead.unknownRow"));
  const cv = await db.conversation.findFirst({ where: { id, clientId: c.id }, include: { messages: { where: { fromCustomer: true }, orderBy: { createdTime: "asc" }, take: 300 } } });
  if (!cv) throw new Error(t("notify.lead.convNotFound"));
  if (!cv.messages.length) throw new Error(t("notify.lead.noCustomerMsg"));
  const adName = cv.sourceAdId ? (await adNames(c.id, [cv.sourceAdId])).get(cv.sourceAdId) || cv.sourceAdId : null;
  const withPhone = cv.messages.map((m) => ({ m, phones: extractContacts([m.text]).phones })).filter((x) => x.phones.length);
  // Phone in messages → "left phone" message (most recent message with a phone); none → "new customer message" (first message). Always also record a conversation-level marker.
  if (!withPhone.length) return chatNotice(cv, cv.messages[0], cv.phone, adName, c.timezone, render, codeOf("chat", cv.id), t);
  const last = withPhone.at(-1)!;
  return {
    ...phoneNotice(cv, last.m, last.phones[0], withPhone.length, adName, c.timezone, render, codeOf("phone", last.m.id), t),
    also: [...withPhone.slice(0, -1).map((x) => ({ kind: "phone" as const, refId: x.m.id })), { kind: "chat" as const, refId: cv.id }],
  };
}

/** Preview the message to be sent (does not send). */
export async function previewManualNotice(clientId: string, rowKey: string) {
  const c = await db.client.findUniqueOrThrow({ where: { id: clientId } });
  const cfg = parseLeadNotify(c.leadNotify);
  return { text: (await manualNotice(c, cfg, await globalTemplates(), rowKey)).text, targets: cfg.targets };
}

/** Manually send 1 lead to the groups chosen in Lead notifications. Can be resent (overwrites the previous notice). */
export async function sendManualNotice(clientId: string, rowKey: string) {
  const c = await db.client.findUniqueOrThrow({ where: { id: clientId } });
  const cfg = parseLeadNotify(c.leadNotify);
  if (!cfg.targets.length) throw new Error((await getT())("notify.lead.noTargets"));
  const n = await manualNotice(c, cfg, await globalTemplates(), rowKey);
  const sends = await deliver(cfg.targets, n.text);
  const data = { clientId: c.id, kind: n.kind, refId: n.refId, rowKey: n.rowKey, code: n.code, text: n.text, sends: JSON.stringify(sends), createdAt: new Date(), remindedAt: null };
  await db.leadNotice.upsert({ where: { id: noticeId(c.id, n.kind, n.refId) }, create: { id: noticeId(c.id, n.kind, n.refId), ...data }, update: data });
  for (const x of n.also ?? []) {
    const id = noticeId(c.id, x.kind, x.refId);
    await db.leadNotice.upsert({ where: { id }, create: { id, clientId: c.id, kind: x.kind, refId: x.refId, text: MERGED_NOTICE }, update: x.kind === "chat" ? { createdAt: data.createdAt } : {} });
  }
  return sends;
}

/** Most recent notice per Lead list row (rowKey → time), to show "Đã báo" (notified). */
export async function notifiedRows(clientId: string, rowKeys: string[]) {
  const ids = rowKeys.map((k) => k.slice(2));
  const rows = await db.leadNotice.findMany({ where: { clientId, refId: { in: ids }, kind: { in: ["form", "chat"] } }, select: { kind: true, refId: true, createdAt: true } });
  const out = new Map<string, Date>();
  for (const r of rows) {
    const key = `${r.kind === "form" ? "F" : "M"}-${r.refId}`;
    if (!out.has(key) || out.get(key)! < r.createdAt) out.set(key, r.createdAt);
  }
  return out;
}
