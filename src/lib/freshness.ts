import { db } from "./db";
import { hypothesisChecks } from "./planner-context";
import { getT } from "@/i18n/server";

// Answers "does this need re-analysis?" using data new since the previous analysis (not by number of days).
// Used for the progress bar on the web and for automatic schedules (Claude only runs when needed, saving calls).

/** Auto-analyze messages once there are this many new conversations, or there are new conversations and the last run is over 1 day old. */
const MIN_NEW_CONVERSATIONS = 10;
/** Rebuild the persona once this many conversations have been newly analyzed since last time. */
const MIN_NEW_ANALYZED_FOR_AUDIENCE = 50;
/** ... or sales have rated this many more customers (web / Google Sheet / Zalo link / HighLevel). */
const MIN_NEW_SALE_FEEDBACK = 10;
const DAY = 86400000;

type Freshness = {
  need: boolean;
  /** Reasons to rerun (empty when not needed). */
  reasons: string[];
  lastAt: Date | null;
};

export async function conversationFreshness(clientId: string): Promise<Freshness & { unanalyzed: number }> {
  const t = await getT();
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId }, select: { conversationLimit: true } });
  const [last, window] = await Promise.all([
    db.audit.findFirst({ where: { clientId, kind: "conversations" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    // Only count within the window of recent conversations that message analysis actually reads.
    db.conversation.findMany({ where: { clientId }, orderBy: { updatedTime: "desc" }, take: client.conversationLimit, select: { analyzedAt: true } }),
  ]);
  const unanalyzed = window.filter((c) => !c.analyzedAt).length;
  const lastAt = last?.createdAt ?? null;
  const old = !lastAt || Date.now() - lastAt.getTime() > DAY;
  const need = unanalyzed >= MIN_NEW_CONVERSATIONS || (unanalyzed > 0 && old);
  return { need, unanalyzed, lastAt, reasons: need ? [t("workflow.freshness.newConversations", { count: unanalyzed })] : [] };
}

/** Window of conversations that message analysis reads (the conversationLimit most recent). */
async function conversationWindow(clientId: string) {
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId }, select: { conversationLimit: true } });
  return db.conversation.findMany({ where: { clientId }, orderBy: { updatedTime: "desc" }, take: client.conversationLimit, select: { analyzedAt: true, updatedTime: true } });
}

/** "idle" mode: number of unread conversations silent (nobody messaged further) for idleHours hours. */
export async function idleConversationCount(clientId: string, idleHours: number) {
  const cutoff = Date.now() - idleHours * 3600_000;
  return (await conversationWindow(clientId)).filter((c) => !c.analyzedAt && c.updatedTime.getTime() <= cutoff).length;
}

/** Message aggregation still has work: unread conversations, or labeled conversations (idle reads) not yet in the overall report. */
export async function conversationsToSummarize(clientId: string) {
  const [last, window] = await Promise.all([
    db.audit.findFirst({ where: { clientId, kind: "conversations" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    conversationWindow(clientId),
  ]);
  return window.filter((c) => !c.analyzedAt || !last || c.analyzedAt > last.createdAt).length;
}

export async function audienceFreshness(clientId: string): Promise<Freshness> {
  const t = await getT();
  const [client, last] = await Promise.all([
    db.client.findUniqueOrThrow({ where: { id: clientId } }),
    db.audienceAnalysis.findFirst({ where: { clientId }, orderBy: { createdAt: "desc" }, select: { createdAt: true, stats: true } }),
  ]);
  if (!last) {
    const docs = await db.knowledgeDoc.count({ where: { clientId, useForAi: true } });
    const conv = await db.conversation.count({ where: { clientId, analyzedAt: { not: null } } });
    const need = docs > 0 || conv > 0;
    return { need, lastAt: null, reasons: need ? [t("workflow.freshness.noPersona")] : [] };
  }
  const since = last.createdAt;
  let prev: { documents?: number; hypotheses?: number } = {};
  try {
    prev = JSON.parse(last.stats);
  } catch {}
  const prevDocs = prev.documents ?? null;
  const [changedDocs, docsNow, newAnalyzed, newFeedback, decided] = await Promise.all([
    db.knowledgeDoc.count({ where: { clientId, useForAi: true, updatedAt: { gt: since } } }),
    db.knowledgeDoc.count({ where: { clientId, useForAi: true } }),
    db.conversation.count({ where: { clientId, analyzedAt: { gt: since } } }),
    db.salesFeedback.count({ where: { clientId, updatedAt: { gt: since }, OR: [{ quality: { not: "" } }, { outcome: { not: "" } }] } }),
    // If the previous persona build didn't record the hypothesis count (old version), don't compare.
    prev.hypotheses == null ? null : hypothesisChecks(client).then((l) => l.filter((c) => c.verdict === "right" || c.verdict === "wrong").length),
  ]);
  const reasons: string[] = [];
  if (changedDocs) reasons.push(t("workflow.freshness.changedDocs", { count: changedDocs }));
  else if (prevDocs != null && docsNow < prevDocs) reasons.push(t("workflow.freshness.fewerDocs", { count: prevDocs - docsNow }));
  if (client.briefUpdatedAt && client.briefUpdatedAt > since) reasons.push(t("workflow.freshness.briefEdited"));
  if (newAnalyzed >= MIN_NEW_ANALYZED_FOR_AUDIENCE) reasons.push(t("workflow.freshness.newAnalyzed", { count: newAnalyzed }));
  if (newFeedback >= MIN_NEW_SALE_FEEDBACK) reasons.push(t("workflow.freshness.newFeedback", { count: newFeedback }));
  if (decided != null && decided > prev.hypotheses!) reasons.push(t("workflow.freshness.hypotheses", { count: decided - prev.hypotheses! }));
  if (Date.now() - since.getTime() > 30 * DAY) reasons.push(t("workflow.freshness.over30Days"));
  return { need: reasons.length > 0, lastAt: since, reasons };
}

/** Account audit: needed when there is spend on days after the previous audit (at most once a day). */
export async function auditFreshness(clientId: string): Promise<Freshness> {
  const t = await getT();
  const last = await db.audit.findFirst({ where: { clientId, kind: "account" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
  const lastAt = last?.createdAt ?? null;
  if (lastAt && Date.now() - lastAt.getTime() < 20 * 3600_000) return { need: false, lastAt, reasons: [] };
  const after = lastAt ? lastAt.toISOString().slice(0, 10) : "0000-00-00";
  const spent = await db.dailyMetric.count({ where: { clientId, spend: { gt: 0 }, date: { gte: after } } });
  const need = spent > 0;
  return { need, lastAt, reasons: need ? [lastAt ? t("workflow.freshness.newSpend") : t("workflow.freshness.neverAudited")] : [] };
}
