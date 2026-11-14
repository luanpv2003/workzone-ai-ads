"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { getT } from "@/i18n/server";
import { requireClient, requireClientOf } from "@/lib/access";
import { errorMessage, logActivity } from "@/lib/activity";
import { enqueueClientJob } from "@/lib/client-jobs";
import { createRetargetAudience, liveCandidates, sendNurtureTest, type Candidate } from "@/lib/nurture";
import { DEFAULT_STAGES, MAX_TEXT, messageKey, nurtureGate, parsePolicy } from "@/lib/nurture-rules";
import { friendlyMetaError } from "@/lib/sync";

// Re-engagement. Real sends only happen via: "Gửi thử" (Send test, 1 message), and the background process once a flow is approved (status active).

type R<T = object> = ({ ok: true } & T) | { ok: false; error: string };

async function wrap<T extends object>(fn: () => Promise<T>): Promise<R<T>> {
  try {
    const out = await fn();
    revalidatePath("/", "layout");
    return { ok: true, ...out };
  } catch (err) {
    console.error(err);
    return { ok: false, error: errorMessage(err) };
  }
}

const AI_STEP = (label: string) => [{ key: "ai", label }];
const timeFmt = (tz: string) => new Date().toLocaleString("vi-VN", { timeZone: tz, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export async function createFlowAction(clientId: string, name: string) {
  return wrap(async () => {
    const t = await getT();
    const { user: u } = await requireClient(clientId, "edit");
    const client = await db.client.findUniqueOrThrow({ where: { id: clientId } });
    const f = await db.nurtureFlow.create({ data: { clientId, name: name.trim() || t("customers.nurtureActions.defaultName", { time: timeFmt(client.timezone || "Asia/Ho_Chi_Minh") }), pageId: client.metaPageId, stages: JSON.stringify(DEFAULT_STAGES), createdBy: u.name } });
    return { id: f.id };
  });
}

const FlowInput = z.object({
  name: z.string().trim().min(1).max(120),
  pageId: z.string().nullable(),
  stages: z.array(z.string()).max(10),
  minScore: z.number().int().min(0).max(100).nullable(),
  waitHours: z.number().int().min(1).max(20),
  cooldownDays: z.number().int().min(1).max(90),
  maxPerRun: z.number().int().min(1).max(200),
  auto: z.boolean(),
  everyHours: z.number().int().min(1).max(12),
  message: z.string().max(MAX_TEXT),
  brief: z.string().max(2000).nullable(),
});

/** Save. Changing content or audience → back to draft, needs re-approval. Changing content → automatically queues a policy check. */
export async function saveFlowAction(flowId: string, input: z.input<typeof FlowInput>) {
  return wrap(async () => {
    const t = await getT();
    const { user: u } = await requireClientOf("nurtureFlow", flowId, "edit");
    const v = FlowInput.parse(input);
    const cur = await db.nurtureFlow.findUniqueOrThrow({ where: { id: flowId } });
    const stages = JSON.stringify(v.stages.filter((s) => s !== "spam"));
    const changed =
      cur.message.trim() !== v.message.trim() || cur.stages !== stages || cur.minScore !== v.minScore || cur.waitHours !== v.waitHours || cur.pageId !== v.pageId || cur.cooldownDays !== v.cooldownDays;
    await db.nurtureFlow.update({
      where: { id: flowId },
      data: { ...v, stages, message: v.message.trim(), ...(changed && cur.status !== "draft" && { status: "draft", approvedAt: null, approvedBy: null }) },
    });
    const needCheck = v.message.trim() && parsePolicy(cur.policy)?.key !== messageKey(v.message);
    if (needCheck) await enqueueClientJob(cur.clientId, "nurture_check", u.name, { params: { flowId }, steps: AI_STEP(t("customers.nurtureActions.stepCheck")) });
    return { reapprove: changed && cur.status !== "draft", checking: !!needCheck };
  });
}

export async function writeFlowAction(flowId: string, brief: string) {
  return wrap(async () => {
    const t = await getT();
    const { user: u } = await requireClientOf("nurtureFlow", flowId, "edit");
    const f = await db.nurtureFlow.update({ where: { id: flowId }, data: { brief: brief.trim() || null } });
    await enqueueClientJob(f.clientId, "nurture_write", u.name, { params: { flowId }, steps: AI_STEP(t("customers.nurtureActions.stepWrite")) });
    return {};
  });
}

export async function checkFlowAction(flowId: string) {
  return wrap(async () => {
    const t = await getT();
    const { user: u } = await requireClientOf("nurtureFlow", flowId, "edit");
    const f = await db.nurtureFlow.findUniqueOrThrow({ where: { id: flowId } });
    if (!f.message.trim()) throw new Error(t("customers.nurtureActions.noMessage"));
    await enqueueClientJob(f.clientId, "nurture_check", u.name, { params: { flowId }, steps: AI_STEP(t("customers.nurtureActions.stepCheck")) });
    return {};
  });
}

/** Approve = allow sending (automatically if the schedule is on, or when clicking Send now). */
export async function approveFlowAction(flowId: string) {
  return wrap(async () => {
    const t = await getT();
    const { user: u } = await requireClientOf("nurtureFlow", flowId, "edit");
    const f = await db.nurtureFlow.findUniqueOrThrow({ where: { id: flowId } });
    const gate = nurtureGate(f.message, parsePolicy(f.policy), t);
    if (!gate.ok) throw new Error(gate.reason!);
    if (!JSON.parse(f.stages).length) throw new Error(t("customers.nurtureActions.pickStages"));
    await db.nurtureFlow.update({ where: { id: flowId }, data: { status: "active", approvedAt: new Date(), approvedBy: u.name } });
    await logActivity(f.clientId, "nurture", t("customers.nurtureActions.approved", { name: f.name, auto: f.auto ? t("customers.nurtureActions.approvedAuto", { hours: f.everyHours }) : "" }));
    return {};
  });
}

export async function pauseFlowAction(flowId: string) {
  return wrap(async () => {
    const t = await getT();
    await requireClientOf("nurtureFlow", flowId, "edit");
    const f = await db.nurtureFlow.update({ where: { id: flowId }, data: { status: "paused", runRequestedAt: null } });
    await logActivity(f.clientId, "nurture", t("customers.nurtureActions.paused", { name: f.name }));
    return {};
  });
}

export async function runNowAction(flowId: string) {
  return wrap(async () => {
    await requireClientOf("nurtureFlow", flowId, "edit");
    const f = await db.nurtureFlow.findUniqueOrThrow({ where: { id: flowId } });
    if (f.status !== "active") throw new Error((await getT())("customers.nurtureActions.approveFirst"));
    await db.nurtureFlow.update({ where: { id: flowId }, data: { runRequestedAt: new Date() } });
    return {};
  });
}

export async function deleteFlowAction(flowId: string) {
  return wrap(async () => {
    await requireClientOf("nurtureFlow", flowId, "edit");
    const f = await db.nurtureFlow.delete({ where: { id: flowId } });
    await logActivity(f.clientId, "nurture", (await getT())("customers.nurtureActions.deleted", { name: f.name }));
    return {};
  });
}

export type PreviewRow = Omit<Candidate, "lastCustomerAt" | "lastAt"> & { lastCustomerAt: string; lastAt: string };

/** List read directly from Meta: who is eligible right now, who isn't and why. */
export async function previewFlowAction(flowId: string): Promise<R<{ rows: PreviewRow[] }>> {
  try {
    await requireClientOf("nurtureFlow", flowId, "view");
    const f = await db.nurtureFlow.findUniqueOrThrow({ where: { id: flowId } });
    const client = await db.client.findUniqueOrThrow({ where: { id: f.clientId } });
    const rows = await liveCandidates(f, client);
    return { ok: true, rows: rows.map((r) => ({ ...r, lastCustomerAt: r.lastCustomerAt.toISOString(), lastAt: r.lastAt.toISOString() })) };
  } catch (err) {
    return { ok: false, error: friendlyMetaError(err, await getT()) };
  }
}

export async function testSendAction(flowId: string, row: { conversationId: string; psid: string; name: string }) {
  return wrap(async () => {
    const { user: u } = await requireClientOf("nurtureFlow", flowId, "edit");
    await sendNurtureTest(flowId, row, u.name);
    return {};
  });
}

/** Manual mode: staff message from the Page inbox themselves and then mark it (to avoid duplicate sends). */
export async function markManualAction(flowId: string, row: { conversationId: string; psid: string; name: string; text: string }) {
  return wrap(async () => {
    const { user: u } = await requireClientOf("nurtureFlow", flowId, "edit");
    const f = await db.nurtureFlow.findUniqueOrThrow({ where: { id: flowId }, include: { client: { select: { metaPageId: true } } } });
    await db.nurtureSend.create({ data: { flowId, clientId: f.clientId, pageId: f.pageId ?? f.client.metaPageId ?? "", psid: row.psid, conversationId: row.conversationId, customerName: row.name, text: row.text, status: "manual", sentBy: u.name } });
    return {};
  });
}

export async function optOutAction(clientId: string, pageId: string, psid: string, name: string, on: boolean) {
  return wrap(async () => {
    const { user: u } = await requireClient(clientId, "edit");
    if (on) await db.nurtureOptOut.upsert({ where: { pageId_psid: { pageId, psid } }, create: { clientId, pageId, psid, name, reason: (await getT())("customers.nurtureActions.blockedBy", { name: u.name }) }, update: {} });
    else await db.nurtureOptOut.deleteMany({ where: { clientId, pageId, psid } });
    return {};
  });
}

export async function retargetAudienceAction(flowId: string) {
  return wrap(async () => {
    await requireClientOf("nurtureFlow", flowId, "edit");
    const r = await createRetargetAudience(flowId);
    return { name: r.name, received: r.received };
  });
}
