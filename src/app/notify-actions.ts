"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin, requireUser } from "@/lib/auth";
import { requireClient, visibleClientIds } from "@/lib/access";
import { chatMatcher } from "@/lib/chat-match";
import { errorMessage, logActivity } from "@/lib/activity";
import { db } from "@/lib/db";
import { clearZaloBot, findZaloBotChats, saveZaloBot } from "@/lib/zalo-bot";
import { findTelegramChats } from "@/lib/report-channels";
import { CHAT_MODES, chatCode, parseLeadNotify, RECALL_OPTIONS, REMIND_OPTIONS, previewManualNotice, sendManualNotice, sendTestNotice, type NotifyTarget } from "@/lib/lead-notify";
import { cleanTemplates, TEMPLATE_DEF, type TemplateKey, type Templates } from "@/lib/notify-templates";
import { saveGlobalTemplates } from "@/lib/notify-templates-db";
import { suggestNotifyTemplate } from "@/lib/notify-templates-ai";
import { dutyFromGuide } from "@/lib/lead-bot-report";
import type { ActionResult } from "./actions";
import { getT } from "@/i18n/server";

// Zalo Bot (System settings) and new-lead notifications (client page → Notifications & reports).

async function run(fn: () => Promise<void>): Promise<ActionResult> {
  try {
    await fn();
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (err) {
    console.error(err);
    return { ok: false, error: errorMessage(err) };
  }
}

export async function saveZaloBotAction(token: string) {
  return run(async () => {
    const u = await requireAdmin();
    const name = await saveZaloBot(token, u.name);
    await db.activity.create({ data: { clientId: null, kind: "notify", message: (await getT())("notify.actions.zaloBotConnected", { name }), actor: u.name } });
  });
}

export async function clearZaloBotAction() {
  return run(async () => {
    await requireAdmin();
    return clearZaloBot();
  });
}

export type FoundChat = { channel: "zalobot" | "telegram"; chatId: string; title: string; type: string; hint: string; code: string; seenAt: string | null };

/** Groups / people that recently messaged the Zalo bot and Telegram bot (bots shared by all clients), to pick as destinations. With clientId, edit permission on that client is required. */
export async function findNotifyChatsAction(clientId?: string, query = ""): Promise<{ ok: true; list: FoundChat[]; errors: string[] } | { ok: false; error: string }> {
  const t = await getT();
  let match: Awaited<ReturnType<typeof chatMatcher>>;
  try {
    if (clientId) await requireClient(clientId, "edit");
    else {
      const ids = await visibleClientIds(await requireUser());
      if (ids && !ids.length) throw new Error(t("notify.actions.noClients"));
    }
    match = await chatMatcher(query);
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
  const list: FoundChat[] = [];
  const errors: string[] = [];
  const [zalo, tg] = await Promise.allSettled([findZaloBotChats(), findTelegramChats()]);
  if (zalo.status === "fulfilled") {
    for (const c of zalo.value) list.push({ channel: "zalobot", chatId: c.chatId, title: c.label ?? "", type: c.type, hint: [c.from && `${c.from}:`, c.lastText && `“${c.lastText}”`].filter(Boolean).join(" "), code: chatCode(c.chatId), seenAt: c.seenAt });
  } else if (errorMessage(zalo.reason) !== t("notify.zaloBot.notConnected")) errors.push(errorMessage(zalo.reason));
  if (tg.status === "fulfilled") {
    for (const c of tg.value) list.push({ channel: "telegram", chatId: c.chatId, title: c.title, type: c.type, hint: "", code: "", seenAt: null });
  } else if (errorMessage(tg.reason) !== t("notify.channels.noTgBot")) errors.push(errorMessage(tg.reason));
  return { ok: true, list: list.filter(match), errors };
}

export async function saveLeadNotifyAction(clientId: string, v: { on: boolean; form: boolean; chat: string; targets: NotifyTarget[]; confirm: boolean; remindMin: number; showPhone: boolean; recallMax: number; duty?: string[] }) {
  return run(async () => {
    await requireClient(clientId, "edit");
    const t = await getT();
    const c = await db.client.findUniqueOrThrow({ where: { id: clientId }, select: { leadNotify: true } });
    const old = parseLeadNotify(c.leadNotify);
    const targets = v.targets
      .filter((x) => (x.channel === "zalobot" || x.channel === "telegram") && x.chatId.trim())
      .slice(0, 5)
      .map((x) => ({ channel: x.channel, chatId: x.chatId.trim(), title: x.title.trim().slice(0, 80) }));
    if (v.on && !targets.length) throw new Error(t("notify.actions.pickAtLeastOne"));
    const chat = CHAT_MODES.some((m) => m.key === v.chat) ? v.chat : "phone";
    // When re-enabled, count from the moment of enabling: don't flood leads that arrived while disabled.
    const since = v.on ? (old.on && old.since ? old.since : new Date().toISOString()) : null;
    const remindMin = REMIND_OPTIONS.includes(Number(v.remindMin)) ? Number(v.remindMin) : 30;
    await db.client.update({ where: { id: clientId }, data: { leadNotify: JSON.stringify({ on: v.on, since, form: v.form, chat, targets, confirm: v.confirm !== false, remindMin, showPhone: v.showPhone === true, recallMax: RECALL_OPTIONS.includes(Number(v.recallMax)) ? Number(v.recallMax) : 3, duty: parseLeadNotify(JSON.stringify({ duty: Array.isArray(v.duty) ? v.duty : old.duty })).duty, templates: old.templates }) } });
    await logActivity(clientId, "notify", v.on ? t("notify.actions.activityOn", { n: targets.length, form: v.form ? t("notify.actions.yes") : t("notify.actions.no"), chat }) : t("notify.actions.activityOff", { n: targets.length }));
  });
}

export async function testLeadNotifyAction(clientId: string, targets: NotifyTarget[]) {
  try {
    await requireClient(clientId, "edit");
    const t = await getT();
    const c = await db.client.findUniqueOrThrow({ where: { id: clientId }, select: { name: true, leadNotify: true } });
    const res = await sendTestNotice(c, targets.slice(0, 5), parseLeadNotify(c.leadNotify).templates);
    const bad = res.filter((r) => !r.ok);
    if (bad.length === res.length) return { ok: false as const, error: bad.map((b) => b.error).join("; ") };
    return { ok: true as const, partial: bad.length > 0, note: bad.length ? t("notify.actions.testPartial", { ok: res.length - bad.length, total: res.length, errors: bad.map((b) => b.error).join("; ") }) : t("notify.actions.testDone", { n: res.length }) };
  } catch (err) {
    return { ok: false as const, error: errorMessage(err) };
  }
}

/** Save a bot message template: clientId = null is the global template (admin only), with clientId it's the client's own. Empty templates / ones equal to the default are dropped. */
export async function saveNotifyTemplatesAction(clientId: string | null, templates: Templates) {
  if (!clientId) {
    return run(async () => {
      const u = await requireAdmin();
      const t = await saveGlobalTemplates(templates);
      await db.activity.create({ data: { clientId: null, kind: "notify", message: (await getT())("notify.actions.templatesGlobal", { n: Object.keys(t).length }), actor: u.name } });
    });
  }
  return run(async () => {
    await requireClient(clientId, "edit");
    const c = await db.client.findUniqueOrThrow({ where: { id: clientId }, select: { leadNotify: true } });
    let raw: Record<string, unknown> = {};
    try {
      raw = JSON.parse(c.leadNotify || "{}");
    } catch {}
    const t = cleanTemplates(templates, "client");
    await db.client.update({ where: { id: clientId }, data: { leadNotify: JSON.stringify({ ...raw, templates: t }) } });
    await logActivity(clientId, "notify", (await getT())("notify.actions.templatesClient", { n: Object.keys(t).length }));
  });
}

/** Claude suggests a message template (the user reviews and edits before saving). clientId null = global template (admins only). */
export async function suggestNotifyTemplateAction(clientId: string | null, key: TemplateKey, current: string, request: string) {
  try {
    if (clientId) await requireClient(clientId, "edit");
    else await requireAdmin();
    if (!TEMPLATE_DEF[key]) return { ok: false as const, error: (await getT())("notify.actions.unknownType") };
    return { ok: true as const, ...(await suggestNotifyTemplate(clientId, key, current.slice(0, 2000), request.slice(0, 500))) };
  } catch (err) {
    return { ok: false as const, error: errorMessage(err) };
  }
}

/** Lead list → "Báo nhóm" (Notify group): preview the message to be sent for 1 lead (form lead / conversation). */
export async function previewManualNoticeAction(clientId: string, rowKey: string) {
  try {
    await requireClient(clientId, "view");
    const r = await previewManualNotice(clientId, rowKey);
    const tr = await getT();
    return { ok: true as const, text: r.text, targets: r.targets.map((x) => x.title || (x.channel === "zalobot" ? tr("notify.actions.zaloCode", { code: chatCode(x.chatId) }) : `Telegram ${x.chatId}`)) };
  } catch (err) {
    return { ok: false as const, error: errorMessage(err) };
  }
}

/** Manually send 1 lead's notification to the groups chosen in Lead notifications (leads that existed before the bot was set up / notifications enabled). */
export async function sendManualNoticeAction(clientId: string, rowKey: string) {
  try {
    await requireClient(clientId, "edit");
    const res = await sendManualNotice(clientId, rowKey);
    const t = await getT();
    const bad = res.filter((r) => !r.ok);
    await logActivity(clientId, "notify", t("notify.actions.manualActivity", { ok: res.length - bad.length, total: res.length }));
    revalidatePath(`/clients/${clientId}/leads`);
    if (bad.length === res.length) return { ok: false as const, error: bad.map((b) => b.error).join("; ") };
    return { ok: true as const, partial: bad.length > 0, note: bad.length ? t("notify.actions.testPartial", { ok: res.length - bad.length, total: res.length, errors: bad.map((b) => b.error).join("; ") }) : t("notify.actions.sentGroups", { n: res.length }) };
  } catch (err) {
    return { ok: false as const, error: errorMessage(err) };
  }
}

/** Prefill the daily on-duty person from the bot instructions (Claude reads them); not saved yet, the user reviews then clicks Save. */
export async function dutyFromGuideAction(clientId: string) {
  try {
    await requireClient(clientId, "edit");
    const duty = await dutyFromGuide(clientId);
    return duty ? { ok: true as const, duty } : { ok: false as const, error: (await getT())("notify.actions.noDuty") };
  } catch (err) {
    return { ok: false as const, error: errorMessage(err) };
  }
}
