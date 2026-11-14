"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { requireClient, requireClientOf } from "@/lib/access";
import { chatMatcher } from "@/lib/chat-match";
import { errorMessage, logActivity } from "@/lib/activity";
import { db, isDbBusy, retryBusy } from "@/lib/db";
import { authorizeUrl, clearTemplate, connectWithRefreshToken, disconnectOa, listTemplates, loadTemplate, saveApp, saveTemplate, templateInfo } from "@/lib/zalo";
import {
  createClientReport,
  defaultMap,
  isEmail,
  normalizePhone,
  REPORT_VARS,
  saveReportZaloGroups,
  sendClientReport,
  sendSummary,
  sendTestReport,
  type EmailTo,
  type Recipient,
  type SendTargets,
  type TelegramTo,
} from "@/lib/client-report";
import { createDailyReport, saveDailyOpts, saveDailyTodo, type DailyOpts } from "@/lib/client-daily-report";
import { clearSmtp, clearTelegramBot, findTelegramChats, saveSmtp, saveTelegramBot } from "@/lib/report-channels";
import type { ActionResult } from "./actions";
import { getT } from "@/i18n/server";

// Report sending channels (System settings: Email, Telegram, Zalo OA) and Client reports (client page → Client reports; schedules + recipients in Notifications & reports).

async function run(fn: () => Promise<string | void>): Promise<ActionResult> {
  try {
    const id = await fn();
    revalidatePath("/", "layout");
    return { ok: true, ...(id && { id }) };
  } catch (err) {
    console.error(err);
    // The DB write lock is held by the scheduled sync run (usually minute :05–:10 each hour): show a readable message instead of a Prisma error.
    if (isDbBusy(err)) return { ok: false, error: (await getT())("notify.actions.busy") };
    return { ok: false, error: errorMessage(err) };
  }
}

// ------------------------------------------------------------------ OA connection (admins)

export async function saveZaloAppAction(appId: string, secretKey: string) {
  return run(async () => {
    await requireAdmin();
    await saveApp(appId.trim(), secretKey);
    await logActivity(null, "zalo", (await getT())("notify.zaloActions.saveApp", { id: appId.trim() }));
  });
}

/** Return the Zalo consent page link; the browser opens it, Zalo redirects back to /api/zalo/callback. */
export async function zaloAuthorizeAction(): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  try {
    await requireAdmin();
    return { ok: true, url: await authorizeUrl() };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function zaloRefreshTokenAction(refreshToken: string) {
  return run(async () => {
    const u = await requireAdmin();
    if (refreshToken.trim().length < 20) throw new Error((await getT())("notify.zaloActions.badRefresh"));
    await connectWithRefreshToken(refreshToken, u.name);
    await logActivity(null, "zalo", (await getT())("notify.zaloActions.refreshConnect"));
  });
}

export async function zaloDisconnectAction() {
  return run(async () => {
    await requireAdmin();
    await disconnectOa();
    await logActivity(null, "zalo", (await getT())("notify.zaloActions.disconnect"));
  });
}

export async function zaloTemplatesAction(): Promise<{ ok: true; list: Awaited<ReturnType<typeof listTemplates>> } | { ok: false; error: string }> {
  try {
    await requireAdmin();
    return { ok: true, list: await listTemplates() };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** Pick the message template used for reports: read parameters from Zalo, keep the old fill rules for parameters with the same name. */
export async function chooseZaloTemplateAction(templateId: string) {
  return run(async () => {
    await requireAdmin();
    const info = await templateInfo(templateId.trim());
    const old = await loadTemplate();
    const guess = defaultMap(info.params);
    const map = Object.fromEntries(info.params.map((p) => [p.name, old?.map[p.name] ?? guess[p.name]]));
    await saveTemplate({ ...info, map, savedAt: new Date().toISOString() });
    await logActivity(null, "zalo", (await getT())("notify.zaloActions.chooseTemplate", { name: info.templateName, id: info.templateId }));
  });
}

export async function saveZaloMapAction(map: Record<string, string>) {
  return run(async () => {
    await requireAdmin();
    const t = await loadTemplate();
    if (!t) throw new Error((await getT())("notify.zaloActions.noTemplate"));
    const keys = new Set<string>(REPORT_VARS.map((v) => v.key));
    const clean: Record<string, string> = {};
    for (const p of t.params) {
      const m = map[p.name] ?? "";
      if (m.startsWith("var:") && keys.has(m.slice(4))) clean[p.name] = m;
      else clean[p.name] = `text:${m.startsWith("text:") ? m.slice(5).slice(0, 400) : ""}`;
    }
    await saveTemplate({ ...t, map: clean });
  });
}

export async function clearZaloTemplateAction() {
  return run(async () => {
    await requireAdmin();
    return clearTemplate();
  });
}

// ------------------------------------------------------------------ Client reports

export async function saveReportSettingsAction(
  clientId: string,
  v: { emails: EmailTo[]; telegram: TelegramTo[]; zalobot: TelegramTo[]; recipients: Recipient[]; daily: DailyOpts },
) {
  return run(async () => {
    await requireClient(clientId, "edit");
    const t = await getT();
    const emails = v.emails.map((r) => ({ name: r.name.trim().slice(0, 60), email: r.email.trim().toLowerCase() })).filter((r) => r.email || r.name);
    for (const r of emails) if (!isEmail(r.email)) throw new Error(t("notify.zaloActions.badEmail", { v: r.email || r.name }));
    const telegram = v.telegram.map((r) => ({ title: r.title.trim().slice(0, 80), chatId: r.chatId.trim() })).filter((r) => r.chatId);
    for (const r of telegram) if (!/^-?\d{3,20}$/.test(r.chatId)) throw new Error(t("notify.zaloActions.badTgId", { id: r.chatId }));
    const recipients = v.recipients
      .map((r) => ({ name: r.name.trim().slice(0, 60), phone: r.phone.trim() }))
      .filter((r) => r.phone || r.name);
    for (const r of recipients) if (!normalizePhone(r.phone)) throw new Error(t("notify.zaloActions.badPhone", { v: r.phone || r.name }));
    const zalobot = v.zalobot.map((r) => ({ title: r.title.trim().slice(0, 80), chatId: r.chatId.trim() })).filter((r) => r.chatId);
    if (emails.length > 10 || telegram.length > 10 || zalobot.length > 10 || recipients.length > 10) throw new Error(t("notify.zaloActions.maxRecipients"));
    await db.client.update({
      where: { id: clientId },
      data: {
        reportEmails: JSON.stringify(emails),
        reportTelegram: JSON.stringify(telegram),
        reportPhones: JSON.stringify(recipients.map((r) => ({ name: r.name, phone: normalizePhone(r.phone)! }))),
      },
    });
    await saveDailyOpts(clientId, v.daily);
    await saveReportZaloGroups(clientId, zalobot);
    await logActivity(clientId, "report", t("notify.zaloActions.recipientsActivity", { zalobot: zalobot.length, emails: emails.length, telegram: telegram.length, zalo: recipients.length }));
  });
}

export async function createClientReportAction(clientId: string, days: number) {
  return run(async () => {
    const { user: u } = await requireClient(clientId, "edit");
    const t = await getT();
    if (![7, 14, 30].includes(days)) throw new Error(t("notify.zaloActions.badPeriod"));
    const r = await createClientReport(clientId, days, "manual", u.name);
    await logActivity(clientId, "report", t("notify.zaloActions.createdReport", { days, since: r.since, until: r.until }));
    return r.id;
  });
}

/** Build the daily report (yesterday's numbers, or today so far when live; plain-language version for the client). */
export async function createDailyReportAction(clientId: string, live = false) {
  return run(async () => {
    const { user: u } = await requireClient(clientId, "edit");
    const r = await createDailyReport(clientId, "manual", u.name, live);
    const t = await getT();
    await logActivity(clientId, "report", t("notify.zaloActions.createdDaily", { kind: live ? t("notify.zaloActions.kindLive") : t("notify.zaloActions.kindDay"), since: r.since }));
    return r.id;
  });
}

/** Edit the "Hôm nay {operator} làm gì" (What we did today) line of the daily report. */
export async function saveDailyTodoAction(reportId: string, todo: string) {
  return run(async () => {
    await requireClientOf("clientReport", reportId, "edit");
    await saveDailyTodo(reportId, todo);
  });
}

/** Manually edit a report's message template parameter values (empty = fall back to the default fill rule). */
export async function saveReportOverridesAction(reportId: string, overrides: Record<string, string>) {
  return run(async () => {
    await requireClientOf("clientReport", reportId, "edit");
    const clean = Object.fromEntries(Object.entries(overrides).map(([k, v]) => [k, String(v).slice(0, 500)]));
    await retryBusy(() => db.clientReport.update({ where: { id: reportId }, data: { overrides: JSON.stringify(clean) } }));
  });
}

/** Manually edit the message content (email / Telegram / Zalo paste). Empty = fall back to the auto-drafted version. */
export async function saveReportMessageAction(reportId: string, message: string) {
  return run(async () => {
    await requireClientOf("clientReport", reportId, "edit");
    await retryBusy(() => db.clientReport.update({ where: { id: reportId }, data: { message: message.trim() ? message.trim().slice(0, 3000) : null } }));
  });
}

export async function sendClientReportAction(reportId: string, targets: SendTargets): Promise<{ ok: true; note: string; partial: boolean } | { ok: false; error: string }> {
  try {
    const { user: u } = await requireClientOf("clientReport", reportId, "edit");
    const r = await db.clientReport.findUniqueOrThrow({ where: { id: reportId }, select: { clientId: true, since: true, until: true } });
    const res = await sendClientReport(reportId, u.name, targets);
    const t = await getT();
    const list = res.failed.map((f) => `${f.name || f.to}: ${f.error}`).join("; ");
    await logActivity(r.clientId, "report", t("notify.zaloActions.sentActivity", { since: r.since, until: r.until, summary: sendSummary(res, t) }));
    revalidatePath("/", "layout");
    if (!res.ok) return { ok: false, error: t("notify.zaloActions.notSent", { list }) };
    return { ok: true, partial: res.failed.length > 0, note: res.failed.length ? t("notify.zaloActions.partial", { ok: res.ok, n: res.failed.length, list }) : t("notify.zaloActions.sentN", { n: res.ok }) };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function sendTestReportAction(reportId: string, phone: string) {
  return run(async () => {
    await requireClientOf("clientReport", reportId, "edit");
    await sendTestReport(reportId, phone);
  });
}

/** Revoke the public link (opening it will say it doesn't exist). */
export async function revokeClientReportAction(reportId: string) {
  return run(async () => {
    await requireClientOf("clientReport", reportId, "edit");
    const r = await retryBusy(() => db.clientReport.update({ where: { id: reportId }, data: { status: "revoked" } }));
    await logActivity(r.clientId, "report", (await getT())("notify.zaloActions.revoked", { since: r.since, until: r.until }));
  });
}

/** Delete an unsent draft (sent ones only get their link revoked, history kept). */
export async function deleteClientReportAction(reportId: string) {
  return run(async () => {
    await requireClientOf("clientReport", reportId, "edit");
    const r = await db.clientReport.findUniqueOrThrow({ where: { id: reportId } });
    if (r.sentAt) throw new Error((await getT())("notify.zaloActions.alreadySent"));
    await retryBusy(() => db.clientReport.delete({ where: { id: reportId } }));
  });
}

// ------------------------------------------------------------------ Email & Telegram (admins)

export async function saveSmtpAction(v: { host: string; port: number; user: string; pass: string; fromName: string }) {
  return run(async () => {
    const u = await requireAdmin();
    if (!v.host.trim() || !isEmail(v.user.trim())) throw new Error((await getT())("notify.zaloActions.smtpNeed"));
    if (![465, 587, 25, 2525].includes(v.port)) throw new Error((await getT())("notify.zaloActions.smtpPort"));
    await saveSmtp(v, u.name);
    await db.activity.create({ data: { clientId: null, kind: "report", message: (await getT())("notify.zaloActions.smtpActivity", { user: v.user.trim() }), actor: u.name } });
  });
}

export async function clearSmtpAction() {
  return run(async () => {
    await requireAdmin();
    await clearSmtp();
  });
}

export async function saveTelegramBotAction(token: string) {
  return run(async () => {
    const u = await requireAdmin();
    const name = await saveTelegramBot(token, u.name);
    await db.activity.create({ data: { clientId: null, kind: "report", message: (await getT())("notify.zaloActions.tgActivity", { name }), actor: u.name } });
  });
}

export async function clearTelegramBotAction() {
  return run(async () => {
    await requireAdmin();
    await clearTelegramBot();
  });
}

/** Shared Telegram bot chat groups currently visible, to pick where a client's reports go (requires edit permission on that client). */
export async function findTelegramChatsAction(clientId: string, query = ""): Promise<{ ok: true; list: Awaited<ReturnType<typeof findTelegramChats>> } | { ok: false; error: string }> {
  try {
    await requireClient(clientId, "edit");
    const match = await chatMatcher(query); // shared bot: people outside the platform workspace must type the exact group name
    return { ok: true, list: (await findTelegramChats()).filter(match) };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
