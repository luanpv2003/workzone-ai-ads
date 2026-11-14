import type { Client, NurtureFlow } from "@prisma/client";
import { db } from "./db";
import { errorMessage, logActivity } from "./activity";
import { getMetaClient } from "./meta";
import type { RecentThread } from "./meta/types";
import { generateStructured } from "./ai/claude";
import { NURTURE_CHECK_SYSTEM, NURTURE_WRITE_SYSTEM } from "./ai/prompts";
import { NurtureCheckSchema, NurtureWriteSchema } from "./ai/schemas";
import { clientProfile } from "./ai/context";
import { knowledgePromptSection } from "./knowledge";
import { stageLabels } from "./format";
import { getT } from "@/i18n/server";
import { translator, type T } from "@/i18n/translate";
import { localTime } from "./schedule";
import { friendlyMetaError } from "./sync";
import { createCustomerListAudience, normalizePhone as metaPhone } from "./meta/audiences";
import { isOptOut, messageKey, nurtureGate, parsePolicy, parseStages, personalize, SEND_FROM, SEND_TO, WINDOW_HOURS, type NurturePolicy } from "./nurture-rules";

// Re-engagement: message customers who messaged the Page, ONLY within 24 hours of the customer's last message (Meta rule).
// Manual: view the eligible list → open the inbox and message yourself → "Đã gửi tay" (sent manually). Automatic: background job sends on schedule.
// Never send when: the customer is awaiting a Page reply, mid-conversation, asked to stop, just received a re-engagement message, or outside 8am–9pm.

const enT = translator("en");
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const GAP_MS = 1200; // between 2 sends

const pageOf = (flow: Pick<NurtureFlow, "pageId">, client: Pick<Client, "metaPageId">) => flow.pageId ?? client.metaPageId ?? "";

export type Candidate = {
  conversationId: string;
  psid: string;
  name: string;
  link: string | null;
  stage: string | null;
  leadScore: number | null;
  intent: string | null;
  lastCustomerAt: Date;
  lastAt: Date;
  lastText: string;
  text: string; // personalized message
  skip: string | null; // reason not sent; null = eligible
};

function ago(t: T, d: Date) {
  const m = Math.round((Date.now() - d.getTime()) / 60_000);
  return m < 60 ? t("customers.nurtureLib.minutes", { n: m }) : t("customers.nurtureLib.hours", { n: Math.round(m / 60) });
}

/** Read the last 24 hours of conversations directly from Meta and check them against the playbook's conditions. */
export async function liveCandidates(flow: NurtureFlow, client: Client): Promise<Candidate[]> {
  const pageId = pageOf(flow, client);
  if (!pageId) throw new Error((await getT())("customers.nurtureLib.noPageId"));
  const since = new Date(Date.now() - DAY);
  const threads = await getMetaClient(client).recentThreads(pageId, since);
  return judgeThreads(flow, client, pageId, threads);
}

async function judgeThreads(flow: NurtureFlow, client: Client, pageId: string, threads: RecentThread[]): Promise<Candidate[]> {
  const tr = await getT();
  const stageLabel = stageLabels(tr);
  const stages = new Set(parseStages(flow.stages));
  const ids = threads.map((t) => t.id);
  const psids = threads.flatMap((t) => (t.psid ? [t.psid] : []));
  const [convs, optOuts, sends] = await Promise.all([
    db.conversation.findMany({ where: { id: { in: ids } }, select: { id: true, stage: true, leadScore: true, intent: true, link: true } }),
    db.nurtureOptOut.findMany({ where: { pageId, psid: { in: psids } }, select: { psid: true } }),
    db.nurtureSend.findMany({
      where: { pageId, psid: { in: psids }, status: { in: ["sent", "manual", "test"] }, sentAt: { gt: new Date(Date.now() - Math.max(flow.cooldownDays, 1) * DAY) } },
      select: { psid: true, flowId: true, sentAt: true },
      orderBy: { sentAt: "desc" },
    }),
  ]);
  const conv = new Map(convs.map((c) => [c.id, c]));
  const out = new Set(optOuts.map((o) => o.psid));
  const newOptOuts: { psid: string; name: string }[] = [];
  const res: Candidate[] = [];
  for (const t of threads) {
    if (!t.psid) continue;
    const c = conv.get(t.id);
    const lastCust = [...t.messages].reverse().find((m) => m.fromCustomer);
    const last = t.messages.at(-1);
    if (!lastCust || !last) continue;
    const stage = c?.stage ?? null;
    const base = {
      conversationId: t.id,
      psid: t.psid,
      name: t.customerName,
      link: c?.link ?? t.link,
      stage,
      leadScore: c?.leadScore ?? null,
      intent: c?.intent ?? null,
      lastCustomerAt: lastCust.createdTime,
      lastAt: last.createdTime,
      lastText: (last.text || tr("customers.nurtureLib.mediaPlaceholder")).slice(0, 120),
      text: personalize(flow.message, t.customerName),
    };
    const optOutNow = t.messages.some((m) => m.fromCustomer && isOptOut(m.text));
    if (optOutNow && !out.has(t.psid)) newOptOuts.push({ psid: t.psid, name: t.customerName });
    const mine = sends.find((s) => s.psid === t.psid && s.flowId === flow.id);
    const other = sends.find((s) => s.psid === t.psid && s.sentAt.getTime() > Date.now() - DAY);
    const skip =
      out.has(t.psid) || optOutNow
        ? tr("customers.nurtureLib.skip.optedOut")
        : Date.now() - lastCust.createdTime.getTime() > WINDOW_HOURS * HOUR
          ? Date.now() - lastCust.createdTime.getTime() > DAY
            ? tr("customers.nurtureLib.skip.over24h", { ago: ago(tr, lastCust.createdTime) })
            : tr("customers.nurtureLib.skip.near24h", { ago: ago(tr, lastCust.createdTime) })
          : stage === "spam"
            ? tr("customers.nurtureLib.skip.spam")
            : !stages.has(stage ?? "_none")
              ? tr("customers.nurtureLib.skip.stage", { stage: stage ? (stageLabel[stage] ?? stage) : tr("customers.nurtureRules.stages._none") })
              : flow.minScore != null && (c?.leadScore ?? 0) < flow.minScore
                ? tr("customers.nurtureLib.skip.score", { score: c?.leadScore ?? "?", min: flow.minScore })
                : last.fromCustomer
                  ? tr("customers.nurtureLib.skip.awaitingReply")
                  : Date.now() - last.createdTime.getTime() < flow.waitHours * HOUR
                    ? tr("customers.nurtureLib.skip.chatting", { ago: ago(tr, last.createdTime), hours: flow.waitHours })
                    : mine
                      ? tr("customers.nurtureLib.skip.alreadySent", { ago: ago(tr, mine.sentAt), days: flow.cooldownDays })
                      : other
                        ? tr("customers.nurtureLib.skip.otherNurture")
                        : null;
    res.push({ ...base, skip });
  }
  if (newOptOuts.length) {
    await db.nurtureOptOut.createMany({ data: newOptOuts.map((o) => ({ clientId: client.id, pageId, psid: o.psid, name: o.name, reason: tr("customers.nurtureLib.optOutReason") })) }).catch(() => {});
  }
  // Eligible first, then by lead score.
  return res.sort((a, b) => Number(!!a.skip) - Number(!!b.skip) || (b.leadScore ?? -1) - (a.leadScore ?? -1));
}

export function inSendHours(client: Pick<Client, "timezone">, at = new Date()) {
  const h = localTime(client.timezone || "Asia/Ho_Chi_Minh", at).hour;
  return h >= SEND_FROM && h < SEND_TO;
}

/** Estimate from the DB (as of the latest sync): customers matching the conditions, bucketed by time since their last message. */
export async function dbBuckets(flow: NurtureFlow, client: Client) {
  const pageId = pageOf(flow, client);
  const stages = parseStages(flow.stages);
  const stageWhere = { OR: [{ stage: { in: stages.filter((s) => s !== "_none") } }, ...(stages.includes("_none") ? [{ stage: null }] : [])] };
  const convs = await db.conversation.findMany({
    where: {
      clientId: client.id,
      psid: { not: null },
      ...(pageId === client.metaPageId ? { OR: [{ pageId }, { pageId: null }] } : { pageId }),
      AND: [stageWhere, ...(flow.minScore != null ? [{ leadScore: { gte: flow.minScore } }] : [])],
    },
    select: { id: true, psid: true, phones: true, phone: true },
  });
  const optOut = new Set((await db.nurtureOptOut.findMany({ where: { pageId }, select: { psid: true } })).map((o) => o.psid));
  const keep = convs.filter((c) => !optOut.has(c.psid!));
  const last = await db.message.groupBy({ by: ["conversationId"], where: { conversationId: { in: keep.map((c) => c.id) }, fromCustomer: true }, _max: { createdTime: true } });
  const at = new Map(last.map((l) => [l.conversationId, l._max.createdTime]));
  const b = { in24: 0, d7: 0, older: 0, phones: 0 };
  const phones = new Set<string>();
  for (const c of keep) {
    const t = at.get(c.id);
    if (!t) continue;
    const age = Date.now() - t.getTime();
    if (age <= DAY) b.in24++;
    else {
      if (age <= 7 * DAY) b.d7++;
      else b.older++;
      for (const p of [c.phone, ...safeList(c.phones)]) {
        const n = p ? metaPhone(p) : null; // format Meta requires: 84xxxxxxxxx
        if (n) phones.add(n);
      }
    }
  }
  b.phones = phones.size;
  return { ...b, phoneSet: phones };
}

function safeList(s: string) {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Send one run. Called by the background job (automatic schedule or the user clicking "Gửi ngay" (send now)).
 * Consecutive errors right from the start (missing permission, app not approved) → auto-pause the playbook, recording the reason.
 */
async function runNurtureFlow(flowId: string, by?: string) {
  const tr = await getT();
  by ??= tr("customers.nurtureLib.by.schedule");
  const flow = await db.nurtureFlow.findUniqueOrThrow({ where: { id: flowId } });
  const client = await db.client.findUniqueOrThrow({ where: { id: flow.clientId } });
  const finish = async (note: string, extra: Partial<NurtureFlow> = {}) => {
    await db.nurtureFlow.update({ where: { id: flowId }, data: { lastRunAt: new Date(), lastRunNote: note, runRequestedAt: null, ...extra } });
    return note;
  };
  if (flow.status !== "active") return finish(tr("customers.nurtureLib.run.notApproved"));
  const gate = nurtureGate(flow.message, parsePolicy(flow.policy), tr);
  if (!gate.ok) return finish(gate.reason!, { status: "draft" });
  if (!inSendHours(client)) return tr("customers.nurtureLib.run.outsideHours", { from: SEND_FROM, to: SEND_TO }); // keep the "Send now" request, send when the window opens

  let list: Candidate[];
  try {
    list = await liveCandidates(flow, client);
  } catch (err) {
    return finish(tr("customers.nurtureLib.run.readFailed", { error: friendlyMetaError(err, tr) }));
  }
  const ready = list.filter((c) => !c.skip).slice(0, flow.maxPerRun);
  const meta = getMetaClient(client);
  const pageId = pageOf(flow, client);
  let sent = 0;
  let failed = 0;
  let firstError = "";
  for (const c of ready) {
    // If the user pauses mid-way, stop immediately.
    const cur = await db.nurtureFlow.findUnique({ where: { id: flowId }, select: { status: true } });
    if (cur?.status !== "active") break;
    try {
      const messageId = await meta.sendPageMessage(pageId, c.psid, c.text);
      await db.nurtureSend.create({ data: { flowId, clientId: client.id, pageId, psid: c.psid, conversationId: c.conversationId, customerName: c.name, text: c.text, status: "sent", messageId, sentBy: by } });
      sent++;
    } catch (err) {
      const msg = friendlyMetaError(err, tr);
      firstError ||= msg;
      await db.nurtureSend.create({ data: { flowId, clientId: client.id, pageId, psid: c.psid, conversationId: c.conversationId, customerName: c.name, text: c.text, status: "failed", error: msg, sentBy: by } });
      failed++;
      if (!sent && failed >= 3) {
        const note = tr("customers.nurtureLib.run.autoPaused", { error: msg });
        await logActivity(client.id, "error", tr("customers.nurtureLib.run.activity", { name: flow.name, note }));
        return finish(note, { status: "paused" });
      }
    }
    await new Promise((r) => setTimeout(r, GAP_MS));
  }
  const skipped = list.length - ready.length;
  const note = tr("customers.nurtureLib.run.summary", { by, sent, failed: failed ? tr("customers.nurtureLib.run.failedPart", { failed, error: firstError }) : "", skipped });
  if (sent || failed) await logActivity(client.id, "nurture", tr("customers.nurtureLib.run.activity", { name: flow.name, note }));
  return finish(note);
}

/** Playbooks that are due (background job calls every minute). */
export async function runDueNurture() {
  const flows = await db.nurtureFlow.findMany({ where: { status: "active", OR: [{ runRequestedAt: { not: null } }, { auto: true }] }, include: { client: { select: { timezone: true, dataSource: true } } } });
  const tr = await getT();
  const out: string[] = [];
  for (const f of flows) {
    if (f.client.dataSource !== "meta" || !inSendHours(f.client)) continue;
    const due = f.runRequestedAt || !f.lastRunAt || Date.now() - f.lastRunAt.getTime() >= f.everyHours * HOUR - 60_000;
    if (!due) continue;
    try {
      out.push(`${f.name}: ${await runNurtureFlow(f.id, tr(f.runRequestedAt ? "customers.nurtureLib.by.now" : "customers.nurtureLib.by.schedule"))}`);
    } catch (err) {
      out.push(tr("customers.nurtureLib.run.errorLine", { name: f.name, error: errorMessage(err) }));
    }
  }
  return out;
}

/** Send 1 test message to 1 conversation (e.g. your own conversation with the Page). Still goes through the policy check. */
/** row: a row from the list read directly from Meta (new conversations may not be synced to the DB yet). */
export async function sendNurtureTest(flowId: string, row: { conversationId: string; psid: string; name: string }, by: string) {
  const flow = await db.nurtureFlow.findUniqueOrThrow({ where: { id: flowId } });
  const client = await db.client.findUniqueOrThrow({ where: { id: flow.clientId } });
  const tr = await getT();
  const gate = nurtureGate(flow.message, parsePolicy(flow.policy), tr);
  if (!gate.ok) throw new Error(gate.reason!);
  const { conversationId } = row;
  const saved = await db.conversation.findFirst({ where: { id: conversationId, clientId: client.id }, select: { pageId: true, psid: true, customerName: true } });
  const conv = { pageId: saved?.pageId ?? null, psid: saved?.psid ?? row.psid, customerName: saved?.customerName ?? row.name };
  if (!conv.psid) throw new Error(tr("customers.nurtureLib.test.noPsid"));
  const pageId = conv.pageId ?? pageOf(flow, client);
  const text = personalize(flow.message, conv.customerName);
  try {
    const messageId = await getMetaClient(client).sendPageMessage(pageId, conv.psid, text);
    await db.nurtureSend.create({ data: { flowId, clientId: client.id, pageId, psid: conv.psid, conversationId, customerName: conv.customerName, text, status: "test", messageId, sentBy: by } });
  } catch (err) {
    const msg = friendlyMetaError(err, tr);
    throw new Error(/24|window|outside|2018278|551/i.test(msg) ? tr("customers.nurtureLib.test.window", { msg }) : msg);
  }
  await logActivity(client.id, "nurture", tr("customers.nurtureLib.test.activity", { name: flow.name, customer: conv.customerName }));
}

// ---------------------------------------------------------------- Claude

async function intents(flow: NurtureFlow) {
  const stages = parseStages(flow.stages).filter((s) => s !== "_none");
  const rows = await db.conversation.findMany({
    where: { clientId: flow.clientId, stage: { in: stages }, intent: { not: null } },
    orderBy: { updatedTime: "desc" },
    take: 25,
    select: { intent: true, stage: true },
  });
  const labels = stageLabels(await getT());
  return rows.map((r) => `- [${labels[r.stage!] ?? r.stage}] ${r.intent}`).join("\n");
}

function flowSection(flow: NurtureFlow) {
  // Prompt text for Claude: stage names in English (same language as the rest of the prompt).
  const labels = stageLabels(enT);
  const st = parseStages(flow.stages).map((s) => (s === "_none" ? enT("customers.nurtureRules.stages._none") : (labels[s] ?? s)));
  return `# Follow-up flow: ${flow.name}
Customer group: ${st.join(", ") || "(none selected)"}${flow.minScore != null ? `, lead score from ${flow.minScore}` : ""}
When to send: once the conversation has been silent for at least ${flow.waitHours} hours, the Page has replied to the customer's last message, and still within 24 hours of the customer's last message.`;
}

export async function runNurtureWrite(flowId: string) {
  const flow = await db.nurtureFlow.findUniqueOrThrow({ where: { id: flowId } });
  const client = await db.client.findUniqueOrThrow({ where: { id: flow.clientId } });
  const prompt = `# Client\n${clientProfile(client)}\n\n${await knowledgePromptSection(client.id)}\n\n${flowSection(flow)}\n\n# Recent needs of this customer group (summarised by Claude from messages)\n${(await intents(flow)) || "(none yet)"}\n\n# User request\n${flow.brief?.trim() || "(none, propose on your own)"}\n\nWrite 3 versions of the message (in Vietnamese, for the client's customers).`;
  const res = await generateStructured({ clientId: flow.clientId, system: NURTURE_WRITE_SYSTEM, prompt, schema: NurtureWriteSchema, effort: "medium" });
  const variants = res.data.variants.slice(0, 3);
  // If there's no content yet, prefill the first version (the user can still edit / change it) and check it right away.
  const fill = !flow.message.trim() && variants[0];
  await db.nurtureFlow.update({ where: { id: flowId }, data: { suggestions: JSON.stringify(variants), ...(fill && { message: variants[0].message, status: "draft", approvedAt: null, approvedBy: null }) } });
  if (fill) await runNurtureCheck(flowId);
  const tr = await getT();
  return tr("customers.nurtureLib.write.result", { n: variants.length, fill: fill ? tr("customers.nurtureLib.write.fill") : "" });
}

export async function runNurtureCheck(flowId: string) {
  const flow = await db.nurtureFlow.findUniqueOrThrow({ where: { id: flowId } });
  const client = await db.client.findUniqueOrThrow({ where: { id: flow.clientId } });
  const message = flow.message.trim();
  const tr = await getT();
  if (!message) throw new Error(tr("customers.nurtureLib.check.empty"));
  const prompt = `# Client\n${clientProfile(client)}\n\n${await knowledgePromptSection(client.id)}\n\n${flowSection(flow)}\n\n# Message to check ({ten} = the customer's name, filled in by the system)\n${message}`;
  const res = await generateStructured({ clientId: flow.clientId, system: NURTURE_CHECK_SYSTEM, prompt, schema: NurtureCheckSchema, effort: "medium" });
  const policy: NurturePolicy = { ...res.data, key: messageKey(message), at: new Date().toISOString() };
  // Content may have been edited while Claude was checking: the result only applies to the exact version checked (key).
  await db.nurtureFlow.update({ where: { id: flowId }, data: { policy: JSON.stringify(policy) } });
  await logActivity(client.id, "analyze", tr("customers.nurtureLib.check.activity", { name: flow.name, verdict: tr(policy.verdict === "safe" ? "customers.nurtureLib.check.safeLower" : policy.verdict === "fix" ? "customers.nurtureLib.check.fixLower" : "customers.nurtureLib.check.spamLower") }));
  return tr(policy.verdict === "safe" ? "customers.nurtureLib.check.safe" : policy.verdict === "fix" ? "customers.nurtureLib.check.fix" : "customers.nurtureLib.check.spam");
}

/** Customers past 24 hours: build an audience from phones customers sent in messages for retargeting ads. */
export async function createRetargetAudience(flowId: string) {
  const flow = await db.nurtureFlow.findUniqueOrThrow({ where: { id: flowId } });
  const client = await db.client.findUniqueOrThrow({ where: { id: flow.clientId } });
  const b = await dbBuckets(flow, client);
  const tr = await getT();
  if (b.phoneSet.size < 20) throw new Error(tr("customers.nurtureLib.audience.tooSmall", { n: b.phoneSet.size }));
  const name = tr("customers.nurtureLib.audience.name", { flow: flow.name, date: new Date().toLocaleDateString("vi-VN") });
  const r = await createCustomerListAudience(client, { name, description: tr("customers.nurtureLib.audience.description"), phones: b.phoneSet, emails: new Set() });
  await logActivity(client.id, "audience", tr("customers.nurtureLib.audience.activity", { name, n: b.phoneSet.size }));
  return r;
}
