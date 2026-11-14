import { db } from "./db";
import { audienceFreshness, conversationFreshness } from "./freshness";
import { getT } from "@/i18n/server";

// Workflow progress per client, computed from real data in the DB:
// Collect → Analyze → Persona & targeting → Campaign proposal → Run → Optimize → Review & new cycle.

export type StepState = "done" | "stale" | "current" | "todo";
export type PipelineStep = { key: string; label: string; state: StepState; detail: string; href: string; action?: string };
export type Pipeline = { steps: PipelineStep[]; done: number; current: PipelineStep | null };

const DAY = 86400000;
const daysAgo = (d: Date | null | undefined) => (d ? Math.floor((Date.now() - d.getTime()) / DAY) : null);

export async function clientPipeline(clientId: string): Promise<Pipeline> {
  const t = await getT();
  const base = `/clients/${clientId}`;
  const [client, campaigns, convCount, convAudit, accountAudit, docs, analysis, ranking, drafts, published, pending, executed] = await Promise.all([
    db.client.findUniqueOrThrow({ where: { id: clientId } }),
    db.campaign.findMany({ where: { clientId }, select: { status: true, spend: true } }),
    db.conversation.count({ where: { clientId } }),
    db.audit.findFirst({ where: { clientId, kind: "conversations" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    db.audit.findFirst({ where: { clientId, kind: "account" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    db.knowledgeDoc.count({ where: { clientId, useForAi: true } }),
    db.audienceAnalysis.findFirst({ where: { clientId }, orderBy: { createdAt: "desc" }, select: { createdAt: true, report: true } }),
    db.targetingRanking.findFirst({ where: { clientId, stage: "with_ads" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    db.campaignDraft.count({ where: { clientId } }),
    db.campaignDraft.findFirst({ where: { clientId, status: "published" }, orderBy: { updatedAt: "desc" }, select: { updatedAt: true } }),
    db.recommendation.count({ where: { clientId, status: "pending" } }),
    db.recommendation.count({ where: { clientId, status: { in: ["executed", "done"] } } }),
  ]);
  const running = campaigns.filter((c) => c.status === "ACTIVE" && c.spend > 0).length;
  const spent = campaigns.some((c) => c.spend > 0);
  const synced = daysAgo(client.lastSyncedAt);
  const isMock = client.dataSource === "mock";

  const steps: PipelineStep[] = [];

  // 1. Data collection
  steps.push({
    key: "collect",
    label: t("workflow.pipeline.collect.label"),
    state: synced == null ? "todo" : synced > 3 && !isMock ? "stale" : campaigns.length || convCount ? "done" : "current",
    detail:
      synced == null
        ? t("workflow.pipeline.collect.never")
        : t("workflow.pipeline.collect.summary", { campaigns: campaigns.length, conversations: convCount, docs }) +
          (synced > 3 && !isMock ? t("workflow.pipeline.collect.stale", { days: synced }) : ""),
    href: base,
    action: t("workflow.pipeline.collect.action"),
  });

  // 2. Analysis (messages + knowledge base): "stale" when there's new data since last time, not by number of days.
  const [convFresh, audFresh] = await Promise.all([conversationFreshness(clientId), audienceFreshness(clientId)]);
  const convAge = daysAgo(convAudit?.createdAt);
  const when = (d: number | null) => (d === 0 ? t("workflow.pipeline.today") : t("workflow.pipeline.daysAgo", { days: d ?? 0 }));
  steps.push({
    key: "analyze",
    label: t("workflow.pipeline.analyze.label"),
    state: convAudit ? (convFresh.need ? "stale" : "done") : convCount || docs ? "current" : "todo",
    detail: convAudit
      ? convFresh.need
        ? t("workflow.pipeline.analyze.rerun", { reasons: convFresh.reasons.join(", ") })
        : t("workflow.pipeline.analyze.fresh", { when: when(convAge) }) +
          (convFresh.unanalyzed ? t("workflow.pipeline.analyze.freshNew", { count: convFresh.unanalyzed }) : t("workflow.pipeline.analyze.freshNone"))
      : convCount
        ? t("workflow.pipeline.analyze.unanalyzed", { count: convCount })
        : t("workflow.pipeline.analyze.noMessages"),
    href: `${base}/audits`,
    action: t("workflow.pipeline.analyze.action"),
  });

  // 3. Persona & targeting
  const audAge = daysAgo(analysis?.createdAt);
  let personas = 0;
  try {
    personas = analysis ? (JSON.parse(analysis.report).personas?.length ?? 0) : 0;
  } catch {}
  steps.push({
    key: "audience",
    label: t("workflow.pipeline.audience.label"),
    state: analysis ? (audFresh.need ? "stale" : "done") : "todo",
    detail: analysis
      ? audFresh.need
        ? t("workflow.pipeline.analyze.rerun", { reasons: audFresh.reasons.join(", ") })
        : t("workflow.pipeline.audience.fresh", { personas, when: when(audAge) })
      : t("workflow.pipeline.audience.none"),
    href: `${base}/audience`,
    action: t("workflow.pipeline.audience.action"),
  });

  // 4. Campaign proposal
  steps.push({
    key: "plan",
    label: t("workflow.pipeline.plan.label"),
    state: published || spent ? "done" : drafts ? "current" : "todo",
    detail: drafts ? t("workflow.pipeline.plan.drafts", { count: drafts }) + (published ? t("workflow.pipeline.plan.published") : t("workflow.pipeline.plan.notPublished")) : spent ? t("workflow.pipeline.plan.running") : t("workflow.pipeline.plan.none"),
    href: drafts ? `${base}/drafts` : `${base}/create`,
    action: t("workflow.pipeline.plan.action"),
  });

  // 5. Running ads
  steps.push({
    key: "run",
    label: t("workflow.pipeline.run.label"),
    state: running ? "done" : published || campaigns.length ? "current" : "todo",
    detail: running ? t("workflow.pipeline.run.running", { count: running }) : published ? t("workflow.pipeline.run.paused") : campaigns.length ? t("workflow.pipeline.run.noneRunning") : t("workflow.pipeline.run.none"),
    href: base,
  });

  // 6. Monitoring & optimization
  const auditAge = daysAgo(accountAudit?.createdAt);
  steps.push({
    key: "optimize",
    label: t("workflow.pipeline.optimize.label"),
    state: !spent ? "todo" : pending ? "current" : accountAudit ? (auditAge! > 7 ? "stale" : "done") : "current",
    detail: pending
      ? t("workflow.pipeline.optimize.pending", { count: pending })
      : accountAudit
        ? t("workflow.pipeline.optimize.audited", { when: when(auditAge), count: executed })
        : spent
          ? t("workflow.pipeline.optimize.noAudit")
          : t("workflow.pipeline.waitingData"),
    href: pending ? `${base}/recommendations` : `${base}/audits`,
    action: pending ? t("workflow.pipeline.optimize.approve") : t("workflow.pipeline.optimize.auditAction"),
  });

  // 7. Review & new cycle: re-rank targeting using real ad metrics
  const rankAge = daysAgo(ranking?.createdAt);
  steps.push({
    key: "review",
    label: t("workflow.pipeline.review.label"),
    state: ranking ? (rankAge! > 7 ? "stale" : "done") : spent ? "current" : "todo",
    detail: ranking ? t("workflow.pipeline.review.ranked", { when: when(rankAge) }) : spent ? t("workflow.pipeline.review.update") : t("workflow.pipeline.waitingData"),
    href: `${base}/audience`,
    action: t("workflow.pipeline.review.action"),
  });

  const done = steps.filter((s) => s.state === "done").length;
  return { steps, done, current: steps.find((s) => s.state !== "done") ?? null };
}
