import { BRAND } from "@/lib/brand";
import { createHash, randomBytes } from "node:crypto";
import type { Client, ClientReport } from "@prisma/client";
import { getT } from "@/i18n/server";
import { translator, type T } from "@/i18n/translate";
import { db } from "./db";
import { decrypt, encrypt } from "./crypto";
import { buildCampaignReport, change, periodLabel, type CampaignReport } from "./campaign-report";
import { money, num } from "./format";
import { localTime } from "./schedule";
import { loadTemplate, oaStatus, publicUrl, sendTemplate, type ZaloTemplate } from "./zalo";
import { sendEmail, sendTelegram, smtpStatus, telegramStatus } from "./report-channels";
import { dailyMessage, digestOf, isDaily } from "./client-daily-report";
import { sendZaloBot, zaloBotStatus } from "./zalo-bot";
import {
  checkData,
  guessVar,
  normalizePhone,
  parseEmails,
  parseRecipients,
  parseTelegram,
  reportMessage,
  type Channel,
  type Recipient,
  type TelegramTo,
  type VarKey,
  type Vars,
} from "./client-report-vars";

export * from "./client-report-vars";

// Client reports:
// 1. Build: snapshot the campaign report (lib/campaign-report.ts) for a 7 / 30-day period → ClientReport, with public link /r/<code>
//    (no login needed, always shows the metrics as of generation time, revocable).
// 2. Content: a short message auto-composed from the metrics (reportMessage), editable per copy → copy-paste to Zalo, email, Telegram.
//    Zalo OA (optional): each template parameter comes from a variable (spend, result count, link...) or fixed text.
// 3. Send: manually (click Send) or automatically on the client's schedule (reportAutoSend) to every configured channel. On error, keep the draft for editing.
// Daily report (period "daily", the client-friendly version): lib/client-daily-report.ts.

const VI = translator("vi");
const dmy = (s: string) => s.split("-").reverse().join("/");

/** Fixed variables of a report (except recipient name). */
function reportVars(client: Pick<Client, "name" | "currency" | "primaryResult">, r: CampaignReport, key: string, tr: T = VI): Vars {
  const cur = client.currency;
  const primary = r.types.find((t) => t.resultType === client.primaryResult) ?? r.types[0];
  const results = primary?.m.results ?? 0;
  const label = primary?.label ?? tr("notify.clientReport.resultWord");
  const cprCh = primary ? change(primary.cpr, primary.prevCpr) : null;
  const resCh = primary ? change(primary.m.results, primary.prev.results) : null;
  const pct = (c: number) => `${Math.round(Math.abs(c) * 100)}%`;
  const vs =
    cprCh != null && Number.isFinite(cprCh)
      ? Math.abs(cprCh) < 0.03
        ? tr("notify.clientReport.cprSame")
        : tr(cprCh < 0 ? "notify.clientReport.cprDown" : "notify.clientReport.cprUp", { pct: pct(cprCh) })
      : resCh != null && Number.isFinite(resCh)
        ? tr(resCh >= 0 ? "notify.clientReport.resUp" : "notify.clientReport.resDown", { pct: pct(resCh) })
        : tr("notify.clientReport.noPrev");
  const { since, until } = r.range;
  const sameYear = since.slice(0, 4) === until.slice(0, 4);
  const today = localTime("Asia/Ho_Chi_Minh").date;
  return {
    ten_khach: client.name,
    ky_bao_cao: periodLabel(r.days, tr),
    khoang_ngay: since === until ? dmy(since) : `${sameYear ? dmy(since).slice(0, 5) : dmy(since)} - ${dmy(until)}`,
    tu_ngay: dmy(since),
    den_ngay: dmy(until),
    chi_tieu: money(r.total.spend, cur),
    so_ket_qua: num(results),
    loai_ket_qua: label,
    ket_qua: `${num(results)} ${label.toLowerCase()}`,
    gia_ket_qua: primary?.cpr != null ? money(primary.cpr, cur) : "—",
    so_ky_truoc: vs,
    tiep_can: num(r.total.reach),
    hien_thi: num(r.total.impressions),
    nhan_xet: r.highlights[0]?.text ?? "",
    link_bao_cao: `${publicUrl()}/r/${key}`,
    ma_bao_cao: key,
    ngay_lap: dmy(today),
  };
}

/** Value sent to Zalo for one recipient: manual edit > template fill rule > empty. */
export function templateData(t: ZaloTemplate, vars: Vars, overrides: Record<string, string>, to: Recipient | null, clientName: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of t.params) {
    let v = overrides[p.name];
    if (v == null) {
      const m = t.map[p.name] ?? guessVar(p.name);
      v = m.startsWith("var:") ? (m === "var:ten_nguoi_nhan" ? to?.name || clientName : (vars[m.slice(4) as VarKey] ?? "")) : m.slice(5);
    }
    out[p.name] = v.trim();
  }
  return out;
}

// ------------------------------------------------------------------ Build, read, public link

const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");
export const reportKeyOf = (r: Pick<ClientReport, "key">) => {
  try {
    return decrypt(r.key);
  } catch {
    return null;
  }
};

/** Snapshot the `days`-day report (through yesterday) as a client copy. */
export async function createClientReport(clientId: string, days: number, trigger: "manual" | "schedule", by: string) {
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId } });
  const report = await buildCampaignReport(client, days, { fresh: true });
  const tr = await getT();
  const key = randomBytes(9).toString("base64url"); // 12 characters, hard to guess
  return db.clientReport.create({
    data: {
      clientId,
      period: String(days),
      since: report.range.since,
      until: report.range.until,
      data: JSON.stringify(report),
      vars: JSON.stringify(reportVars(client, report, key, tr)),
      keyHash: hashKey(key),
      key: encrypt(key),
      trigger,
      createdBy: by,
    },
  });
}

/** Read back a snapshotted report (JSON → object with Dates). */
export function parseReport(r: Pick<ClientReport, "data">): CampaignReport {
  const x = JSON.parse(r.data) as CampaignReport;
  x.generatedAt = new Date(x.generatedAt);
  for (const o of x.optimizations ?? []) o.executedAt = o.executedAt ? new Date(o.executedAt) : null;
  return x;
}

/** Public page /r/<code>: report + client name. null if the code is wrong / revoked. */
export async function reportByKey(key: string) {
  if (!/^[\w-]{8,40}$/.test(key)) return null;
  const r = await db.clientReport.findFirst({ where: { keyHash: hashKey(key), status: { not: "revoked" } }, include: { client: { select: { name: true, industry: true, currency: true } } } });
  if (!r) return null;
  await db.clientReport.update({ where: { id: r.id }, data: { views: { increment: 1 }, viewedAt: new Date() } }).catch(() => {});
  return r;
}

// ------------------------------------------------------------------ Sending (email, Telegram, Zalo OA)

export type SendLog = { channel: Channel; name: string; to: string; ok: boolean; msgId?: string; error?: string; at: string };
/** Recipients selected per channel: email, Telegram chatId, Zalo phone number. */
export type SendTargets = Partial<Record<Channel, string[]>>;

/** Auto-composed message of a report (excluding manual edits). */
export function autoMessageOf(r: Pick<ClientReport, "vars" | "period" | "data" | "key">, client: Pick<Client, "name" | "currency">, tr: T = VI) {
  const d = isDaily(r) ? digestOf(r) : null;
  if (!d) return reportMessage(JSON.parse(r.vars) as Vars, tr);
  const key = reportKeyOf(r);
  return dailyMessage(client.name, client.currency, d, key ? `${publicUrl()}/r/${key}` : null, tr);
}
/** Message content of a report: the manual edit, otherwise auto-composed. */
export const messageOf = (r: Pick<ClientReport, "message" | "vars" | "period" | "data" | "key">, client: Pick<Client, "name" | "currency">, tr: T = VI) => r.message?.trim() || autoMessageOf(r, client, tr);

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const linkify = (html: string) => html.replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" style="color:#2f7fd1">${u}</a>`);

function emailHtml(text: string, link: string | null, tr: T) {
  const [title, ...rest] = text.split("\n");
  const body = rest.map((l) => linkify(esc(l))).join("<br>");
  return `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#0f172a">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px"><tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="background:#2f7fd1;color:#ffffff;padding:20px 24px;font-size:13px;font-weight:bold">${BRAND.agency}</td></tr>
<tr><td style="padding:24px"><p style="margin:0 0 12px;font-size:17px;font-weight:bold">${esc(title)}</p>
<p style="margin:0;font-size:14px;line-height:1.7">${body}</p>
${link ? `<p style="margin:24px 0 0"><a href="${link}" style="display:inline-block;background:#2f7fd1;color:#ffffff;text-decoration:none;padding:11px 20px;border-radius:8px;font-size:14px;font-weight:bold">${esc(tr("notify.clientReport.viewDetails"))}</a></p>` : ""}
</td></tr>
<tr><td style="padding:14px 24px;border-top:1px solid #e2e8f0;font-size:11px;color:#94a3b8">${esc(tr("notify.clientReport.emailFooter"))}</td></tr>
</table></td></tr></table></body></html>`;
}

function telegramHtml(text: string) {
  const [title, ...rest] = text.split("\n");
  return [`<b>${esc(title)}</b>`, ...rest.map(esc)].join("\n");
}

/** Whether Zalo OA can send: null = ready, otherwise the reason. */
export async function zaloNotReady() {
  const [oa, t, tr] = await Promise.all([oaStatus(), loadTemplate(), getT()]);
  return !oa?.connected ? tr("notify.clientReport.zaloNotConnected") : !t ? tr("notify.clientReport.zaloNoTemplate") : t.status && t.status !== "ENABLE" ? tr("notify.clientReport.zaloTemplateStatus", { status: t.status }) : null;
}

/** Zalo groups receiving reports via Zalo Bot (Setting table, no extra columns on Client). Same {title, chatId} shape as Telegram. */
const zaloBotKey = (clientId: string) => `clientReport.zalobot:${clientId}`;
export async function loadReportZaloGroups(clientId: string): Promise<TelegramTo[]> {
  return parseTelegram((await db.setting.findUnique({ where: { key: zaloBotKey(clientId) } }))?.value);
}
export async function saveReportZaloGroups(clientId: string, list: TelegramTo[]) {
  const value = JSON.stringify(list);
  await db.setting.upsert({ where: { key: zaloBotKey(clientId) }, create: { key: zaloBotKey(clientId), value }, update: { value } });
}

/** Default recipients for auto-send: every configured recipient on connected channels. */
async function defaultTargets(c: Pick<Client, "id" | "reportEmails" | "reportTelegram" | "reportPhones">): Promise<SendTargets> {
  const [smtp, tgBot, zalo, bot] = await Promise.all([smtpStatus(), telegramStatus(), zaloNotReady(), zaloBotStatus().catch(() => null)]);
  return {
    email: smtp ? parseEmails(c.reportEmails).map((x) => x.email) : [],
    telegram: tgBot ? parseTelegram(c.reportTelegram).map((x) => x.chatId) : [],
    zalobot: bot ? (await loadReportZaloGroups(c.id)).map((x) => x.chatId) : [],
    zalo: zalo ? [] : parseRecipients(c.reportPhones).map((x) => x.phone),
  };
}

/**
 * Send the report to the selected recipients (default: defaultTargets). One attempt per recipient; one failure doesn't block others.
 * Zalo OA template parameters are checked first: on error, nobody gets the Zalo message.
 */
export async function sendClientReport(reportId: string, by: string, targets?: SendTargets) {
  const tr = await getT();
  const r = await db.clientReport.findUniqueOrThrow({ where: { id: reportId }, include: { client: true } });
  if (r.status === "revoked") throw new Error(tr("notify.clientReport.revoked"));
  const want = targets ?? (await defaultTargets(r.client));
  const emails = parseEmails(r.client.reportEmails).filter((x) => want.email?.includes(x.email));
  const chats = parseTelegram(r.client.reportTelegram).filter((x) => want.telegram?.includes(x.chatId));
  const phones = parseRecipients(r.client.reportPhones).filter((x) => want.zalo?.includes(x.phone));
  const groups = (await loadReportZaloGroups(r.clientId)).filter((x) => want.zalobot?.includes(x.chatId));
  if (!emails.length && !chats.length && !phones.length && !groups.length) throw new Error(tr("notify.clientReport.noRecipients"));

  const vars = JSON.parse(r.vars) as Vars;
  const text = messageOf(r, r.client, tr);
  const key = reportKeyOf(r);
  const daily = isDaily(r) ? digestOf(r) : null;
  // Daily report with "kèm link" (include link) off: no view-details button / link.
  const link = key && daily?.opts.link !== false ? `${publicUrl()}/r/${key}` : null;
  const now: SendLog[] = [];
  const log = (channel: Channel, name: string, to: string, res: { ok: true; msgId?: string } | { ok: false; error: string }) =>
    now.push({ channel, name, to, ok: res.ok, ...(res.ok ? { msgId: res.msgId } : { error: res.error }), at: new Date().toISOString() });
  const attempt = async (fn: () => Promise<string | undefined>) => {
    try {
      return { ok: true as const, msgId: await fn() };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  };

  if (emails.length) {
    const subject = daily
      ? tr("notify.clientReport.subjectDaily", { range: vars.khoang_ngay ?? "", name: vars.ten_khach ?? "" })
      : tr("notify.clientReport.subject", { period: vars.ky_bao_cao ?? "", range: vars.khoang_ngay ?? "", name: vars.ten_khach ?? "" });
    const html = emailHtml(text, link, tr);
    for (const x of emails) log("email", x.name, x.email, await attempt(() => sendEmail(x.name ? `"${x.name.replace(/"/g, "")}" <${x.email}>` : x.email, subject, html, text)));
  }
  // Nhóm Zalo (Zalo Bot): tin chữ thường, link nằm trong nội dung (Zalo tự hiện thành link bấm được).
  for (const x of groups) log("zalobot", x.title, x.chatId, await attempt(() => sendZaloBot(x.chatId, text)));
  for (const x of chats) log("telegram", x.title, x.chatId, await attempt(() => sendTelegram(x.chatId, telegramHtml(text), link ? { text: tr("notify.clientReport.viewDetails"), url: link } : undefined)));
  if (phones.length) {
    const t = await loadTemplate();
    if (!t) throw new Error(tr("notify.clientReport.noZaloTemplate"));
    if (t.status && t.status !== "ENABLE") throw new Error(tr("notify.clientReport.templateNotReady", { name: t.templateName, status: t.status }));
    const overrides = JSON.parse(r.overrides) as Record<string, string>;
    const batch = phones.map((x) => ({ x, data: templateData(t, vars, overrides, x, r.client.name) }));
    const bad = batch.flatMap(({ x, data }) => checkData(t, data, tr).map((e) => `${e.param}${phones.length > 1 ? ` (${x.name || x.phone})` : ""}: ${e.error}`));
    if (bad.length) {
      for (const { x } of batch) log("zalo", x.name, x.phone, { ok: false, error: tr("notify.clientReport.fixParams", { list: bad.join("; ") }) });
    } else {
      for (const [i, { x, data }] of batch.entries()) {
        const phone = normalizePhone(x.phone);
        const res = phone ? await sendTemplate(phone, t.templateId, data, `wzr-${r.id.slice(-16)}-${i}-${Date.now() % 100000}`) : ({ ok: false, error: tr("notify.clientReport.badPhone") } as const);
        log("zalo", x.name, x.phone, res);
      }
    }
  }

  const okCount = now.filter((l) => l.ok).length;
  const status = okCount === now.length ? "sent" : okCount ? "partial" : r.status === "draft" ? "failed" : r.status;
  const logs = [...(JSON.parse(r.sends) as SendLog[]), ...now];
  await db.clientReport.update({ where: { id: r.id }, data: { sends: JSON.stringify(logs), status, ...(okCount && { sentAt: new Date(), sentBy: by }) } });
  return { ok: okCount, failed: now.filter((l) => !l.ok) };
}

/** One-line summary of a send result, for the activity log. */
export const sendSummary = (res: Awaited<ReturnType<typeof sendClientReport>>, tr: T = VI) =>
  tr("notify.clientReport.sendSummary", { ok: res.ok }) + (res.failed.length ? tr("notify.clientReport.sendSummaryFailed", { n: res.failed.length, list: res.failed.map((f) => `${f.name || f.to}: ${f.error}`).join("; ") }) : "");

/** Test send to any phone number (not added to the client's recipient list). */
export async function sendTestReport(reportId: string, rawPhone: string) {
  const r = await db.clientReport.findUniqueOrThrow({ where: { id: reportId }, include: { client: true } });
  const t = await loadTemplate();
  const tr = await getT();
  if (!t) throw new Error(tr("notify.clientReport.noZaloTemplateShort"));
  const phone = normalizePhone(rawPhone);
  if (!phone) throw new Error(tr("notify.clientReport.badPhoneDot"));
  const data = templateData(t, JSON.parse(r.vars), JSON.parse(r.overrides), { name: "", phone }, r.client.name);
  const bad = checkData(t, data, tr);
  if (bad.length) throw new Error(bad.map((e) => `${e.param}: ${e.error}`).join("; "));
  const res = await sendTemplate(phone, t.templateId, data, `wzt-${r.id.slice(-16)}-${Date.now() % 100000}`);
  if (!res.ok) throw new Error(tr("notify.clientReport.zaloRejected", { err: res.error }));
  return res;
}
