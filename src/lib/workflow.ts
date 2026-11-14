import { db } from "./db";
import { tokenLevel } from "./token-status";
import { audienceFreshness, conversationFreshness } from "./freshness";
import { healthChecks } from "./health-checks";
import { hypothesisChecks } from "./planner-context";
import { targetCprOf } from "./target-cpr";
import { clientPages } from "./client-pages";
import { money } from "./format";
import { leadScoresByAd } from "./lead-quality";
import { getT } from "@/i18n/server";
import type { MessageKey, T } from "@/i18n/translate";
import { IDLE_HOURS, hoursLabel, nextAiAt, nextOptimizeAt, nextRunAt, nextSyncAt, optimizeHourList, syncHours } from "./schedule";

// System activity diagram for ONE client (n8n-style workflow): blocks connected along the data flow,
// each block computes its status from real DB data (no Meta / Claude calls): ok · needs attention · error · unused.

export type NodeStatus = "ok" | "warn" | "bad" | "off";
export type FlowNode = {
  id: string;
  col: number;
  row: number;
  icon: string; // lucide icon name (mapped in the UI)
  title: string;
  status: NodeStatus;
  metric: string; // one line of key metrics
  lines: string[]; // details
  issue?: string; // why it's not ok + what to do
  mode?: string; // automatic / manual
  href?: string;
  cta?: string;
  // Timing: last update + next automatic run (the UI shows a countdown).
  updatedAt?: string | null;
  updatedLabel?: string;
  nextAt?: string | null;
  nextLabel?: string;
  nextNote?: string; // when there's no fixed time (e.g. "as soon as a message arrives", "when there are ≥ 50 new conversations")
};
export type FlowEdge = { from: string; to: string; label?: string; loop?: boolean };

// Optimization loop: 4 core points joined in a loop (Persona → Targeting + creatives → Run & optimize → Real customers → Persona),
// the other blocks are secondary points (chips) feeding the core points. Arrow i goes from cores[i] to cores[(i + 1) % 4].
export type LoopChip = { node: string; text: string; status: NodeStatus };
export type LoopCore = { key: "aud" | "tg" | "run" | "q"; title: string; name: string; status: NodeStatus; metric: string; sub: string; detail: string; href: string; cta: string; chips: LoopChip[] };
export type LoopArrow = { status: "ok" | "warn" | "off"; label: string[] };
export type LoopKpi = { label: string; value: string; sub: string; tone?: "good" | "bad" | "warn" };
/** Bottleneck = a block with a problem (with enough block info to open details in a dialog). */
export type LoopIssue = FlowNode & { node: string; text: string };
export type Loop = { cores: LoopCore[]; arrows: LoopArrow[]; flowing: number; kpis: LoopKpi[]; issues: LoopIssue[] };
export type Workflow = { nodes: FlowNode[]; edges: FlowEdge[]; columns: string[]; loop: Loop };

const RANK: Record<NodeStatus, number> = { off: 0, ok: 1, warn: 2, bad: 3 };
/** Combined status of a core point: the worst among its blocks (unused blocks don't drag it down). */
const worst = (list: NodeStatus[]) => list.reduce<NodeStatus>((a, b) => (RANK[b] > RANK[a] ? b : a), "off");
const cut = (t: string, max = 26) => (t.length > max ? `${t.slice(0, max - 1)}…` : t);
/** Regex for a freshness reason template ({count} becomes a capture group), so matching works in any language. */
const reasonRe = (t: T, key: MessageKey) => new RegExp("^" + t(key, { count: "@@" }).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("@@", "(\\S+)") + "$");
/** Reasons to rebuild the persona (lib/freshness.ts) → short label on the Real customers → Persona arrow. */
const shortReason = (t: T, r: string) => {
  const rules: [MessageKey, MessageKey][] = [
    ["workflow.freshness.newAnalyzed", "workflow.flow.loop.short.newConversations"],
    ["workflow.freshness.newFeedback", "workflow.flow.loop.short.saleRated"],
    ["workflow.freshness.changedDocs", "workflow.flow.loop.short.newDocs"],
    ["workflow.freshness.hypotheses", "workflow.flow.loop.short.hypotheses"],
  ];
  if (r === t("workflow.freshness.briefEdited")) return cut(t("workflow.flow.loop.short.brief"));
  for (const [from, to] of rules) {
    const m = reasonRe(t, from).exec(r);
    if (m) return cut(t(to, { count: m[1] }));
  }
  return cut(r);
};

const DAY = 86400000;
const daysSince = (d: Date | null | undefined) => (d ? (Date.now() - d.getTime()) / DAY : null);
/** Label of a schedule mode (sync / AI / optimize); unknown keys show as-is. */
const modeLabel = (t: T, kind: "sync" | "ai" | "opt", key: string) => t(`workflow.flow.modes.${kind}.${key}` as MessageKey, { hours: IDLE_HOURS });

export async function clientWorkflow(clientId: string): Promise<Workflow> {
  const t = await getT();
  const ago = (d: Date | null | undefined) => {
    if (!d) return null;
    const days = Math.floor((Date.now() - d.getTime()) / DAY);
    return days <= 0 ? t("workflow.pipeline.today") : t("workflow.pipeline.daysAgo", { days });
  };
  const base = `/clients/${clientId}`;
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId } });
  const isMeta = client.dataSource === "meta";
  const pages = clientPages(client);
  const since90 = new Date(Date.now() - 90 * DAY);
  const [
    campaigns,
    convCount,
    convLinked,
    lastConv,
    referrals,
    leads,
    posts,
    comments,
    docs,
    breakdowns,
    history,
    analysis,
    creative,
    ranking,
    proposal,
    drafts,
    published,
    reviews,
    pending,
    oldPending,
    executed,
    evaluated,
    findRun,
    library,
    convFresh,
    audFresh,
    health,
    hyps,
    times,
    scored,
  ] = await Promise.all([
    db.campaign.findMany({ where: { clientId }, select: { status: true, spend: true, results: true, resultType: true } }),
    db.conversation.count({ where: { clientId } }),
    db.conversation.count({ where: { clientId, sourceAdId: { not: null } } }),
    db.conversation.findFirst({ where: { clientId }, orderBy: { updatedTime: "desc" }, select: { updatedTime: true } }),
    pages.length ? db.adReferral.count({ where: { pageId: { in: pages.map((p) => p.id) } } }) : 0,
    db.lead.count({ where: { clientId, createdTime: { gt: since90 } } }),
    db.pagePost.count({ where: { clientId } }),
    db.postComment.count({ where: { clientId } }),
    db.knowledgeDoc.count({ where: { clientId, useForAi: true } }),
    db.adBreakdown.count({ where: { clientId } }),
    db.adSetHistory.count({ where: { clientId, spend: { gt: 0 } } }),
    db.audienceAnalysis.findFirst({ where: { clientId }, orderBy: { createdAt: "desc" }, select: { createdAt: true, report: true, candidates: true } }),
    db.audit.findFirst({ where: { clientId, kind: "creative" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    db.targetingRanking.findFirst({ where: { clientId }, orderBy: { createdAt: "desc" }, select: { createdAt: true, stage: true, items: true } }),
    db.campaignProposal.findFirst({ where: { clientId }, orderBy: { createdAt: "desc" }, select: { createdAt: true, status: true } }),
    db.campaignDraft.groupBy({ by: ["status"], where: { clientId }, _count: true }),
    db.campaignDraft.findFirst({ where: { clientId, status: "published" }, orderBy: { updatedAt: "desc" }, select: { updatedAt: true } }),
    db.contentReview.groupBy({ by: ["status"], where: { clientId }, _count: true }),
    db.recommendation.count({ where: { clientId, status: "pending" } }),
    db.recommendation.count({ where: { clientId, status: "pending", createdAt: { lt: new Date(Date.now() - 2 * DAY) } } }),
    db.recommendation.count({ where: { clientId, status: { in: ["executed", "done"] } } }),
    db.recommendation.count({ where: { clientId, evaluation: { not: null } } }),
    db.targetingRun.findFirst({ where: { kind: "find", status: "done" }, orderBy: { finishedAt: { sort: "desc", nulls: "last" } }, select: { finishedAt: true } }),
    db.targetingItem.groupBy({ by: ["findable"], where: { status: "active" }, _count: true }),
    conversationFreshness(clientId),
    audienceFreshness(clientId),
    healthChecks(client),
    hypothesisChecks(client),
    Promise.all([
      db.adReferral.aggregate({ where: { pageId: { in: pages.map((p) => p.id) } }, _max: { at: true } }),
      db.lead.aggregate({ where: { clientId }, _max: { createdTime: true } }),
      db.pagePost.aggregate({ where: { clientId }, _max: { syncedAt: true } }),
      db.knowledgeDoc.aggregate({ where: { clientId }, _max: { updatedAt: true } }),
      db.campaignDraft.aggregate({ where: { clientId }, _max: { updatedAt: true } }),
      db.recommendation.aggregate({ where: { clientId }, _max: { createdAt: true } }),
      db.recommendation.aggregate({ where: { clientId, evaluation: { not: null } }, _max: { executedAt: true } }),
      db.setting.findUnique({ where: { key: "targeting.autoUpdate" } }),
    ]),
    leadScoresByAd(clientId),
  ]);
  const [hook, lastLead, lastPost, lastDoc, lastDraft, lastRec, lastEval, autoLib] = times;
  const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
  const nextSync = iso(nextSyncAt(client));
  const idleAi = client.aiMode === "idle";
  // "idle" mode: the hourly scheduler reads conversations that have gone silent.
  const nextAi = iso(idleAi ? nextRunAt(Array.from({ length: 24 }, (_, h) => h), client.timezone) : nextAiAt(client));
  const nextOpt = iso(nextOptimizeAt(client));
  // Tokens are checked daily at 7am (VN time).
  const nextToken = iso(nextRunAt([7], "Asia/Ho_Chi_Minh"));

  const n = (v: number) => v.toLocaleString("vi-VN");
  const active = campaigns.filter((c) => c.status === "ACTIVE");
  const main = campaigns.filter((c) => c.resultType === client.primaryResult);
  const spend7 = main.reduce((a, c) => a + c.spend, 0);
  const res7 = main.reduce((a, c) => a + c.results, 0);
  const cpr = res7 ? spend7 / res7 : null;
  const target = targetCprOf(client);
  const draftBy = Object.fromEntries(drafts.map((d) => [d.status, d._count]));
  const reviewTotal = reviews.reduce((a, r) => a + r._count, 0);
  const libFound = library.find((x) => x.findable === true)?._count ?? 0;
  const libNot = library.find((x) => x.findable === false)?._count ?? 0;
  const lv = isMeta ? tokenLevel(client) : null;
  const syncAge = daysSince(client.lastSyncedAt);
  const msgs = client.primaryResult === "messages";
  const fits: { free?: boolean }[] = analysis ? JSON.parse(analysis.candidates || "[]") : [];
  let personas = 0;
  try {
    personas = analysis ? (JSON.parse(analysis.report).personas?.length ?? 0) : 0;
  } catch {}
  const rankItems: { perf: number | null }[] = ranking ? JSON.parse(ranking.items) : [];

  const nodes: FlowNode[] = [];
  const add = (x: FlowNode) => nodes.push(x);

  // ---------------------------------------------------------------- Column 0 · Data sources
  add({
    id: "meta",
    updatedAt: iso(client.metaTokenCheckedAt),
    updatedLabel: t("workflow.flow.meta.tokenCheck"),
    nextAt: isMeta ? nextToken : null,
    nextLabel: t("workflow.flow.meta.tokenCheck"),
    col: 0,
    row: 0,
    icon: "plug",
    title: t("workflow.flow.meta.title"),
    status: !isMeta ? "off" : lv === "ok" ? "ok" : lv === "warning" || lv === "unchecked" ? "warn" : "bad",
    metric: !isMeta ? t("workflow.flow.meta.notConnected") : lv === "ok" ? t("workflow.flow.meta.tokenOk", { pages: pages.length }) : lv === "warning" ? t("workflow.flow.meta.tokenWarn") : lv === "unchecked" ? t("workflow.flow.meta.tokenUnchecked") : t("workflow.flow.meta.tokenBad"),
    lines: isMeta ? [t("workflow.flow.meta.adAccount", { id: client.metaAdAccountId ?? "—" }), ...pages.map((p) => t("workflow.flow.meta.page", { name: p.name }))] : [t("workflow.flow.meta.needs")],
    issue: !isMeta ? t("workflow.flow.meta.connectIssue") : lv !== "ok" ? t("workflow.flow.meta.pasteToken") : undefined,
    href: lv && lv !== "ok" ? "/connections" : `${base}/settings`,
    cta: t("workflow.flow.meta.cta"),
  });
  add({
    id: "sync",
    updatedAt: iso(client.lastSyncedAt),
    updatedLabel: t("workflow.flow.sync.updatedLabel"),
    nextAt: isMeta ? nextSync : null,
    nextLabel: t("workflow.flow.sync.nextLabel"),
    nextNote: isMeta && !nextSync ? t("workflow.flow.manualOnly") : undefined,
    col: 0,
    row: 1,
    icon: "refresh",
    title: t("workflow.flow.sync.title"),
    status: !isMeta ? "off" : syncAge == null ? "bad" : syncAge > 3 ? "bad" : syncAge > 1.2 || client.syncMode === "manual" ? "warn" : "ok",
    metric: client.lastSyncedAt ? t("workflow.flow.sync.metric", { when: ago(client.lastSyncedAt) ?? "", campaigns: campaigns.length }) : t("workflow.flow.sync.notSynced"),
    lines: [t("workflow.flow.schedule", { value: syncHours(client).length ? hoursLabel(syncHours(client)) : modeLabel(t, "sync", client.syncMode) }), t("workflow.flow.sync.adSets", { count: n(history), days: client.analysisDays }), t("workflow.flow.sync.breakdowns", { count: n(breakdowns) })],
    issue: !isMeta ? undefined : syncAge == null || syncAge > 3 ? t("workflow.flow.sync.staleIssue") : client.syncMode === "manual" ? t("workflow.flow.sync.manualIssue") : undefined,
    mode: client.syncMode === "manual" ? t("workflow.flow.modeManual") : t("workflow.flow.modeAuto"),
    href: base,
    cta: t("workflow.flow.sync.cta"),
  });
  add({
    id: "messages",
    updatedAt: iso(lastConv?.updatedTime),
    updatedLabel: t("workflow.flow.messages.updatedLabel"),
    nextAt: isMeta ? nextSync : null,
    nextLabel: t("workflow.flow.messages.nextLabel"),
    col: 0,
    row: 2,
    icon: "message",
    title: t("workflow.flow.messages.title"),
    status: convCount ? "ok" : msgs ? "warn" : "off",
    metric: t("workflow.flow.messages.metric", { count: n(convCount) }),
    lines: [lastConv?.updatedTime ? t("workflow.flow.messages.latest", { when: ago(lastConv.updatedTime) ?? "" }) : t("workflow.flow.messages.none"), t("workflow.flow.messages.limit", { count: n(client.conversationLimit) })],
    issue: !convCount && msgs ? t("workflow.flow.messages.issue") : undefined,
    href: `${base}/messages`,
    cta: t("workflow.flow.messages.cta"),
  });
  add({
    id: "webhook",
    updatedAt: iso(hook._max.at),
    updatedLabel: t("workflow.flow.webhook.updatedLabel"),
    nextNote: t("workflow.flow.webhook.nextNote"),
    col: 0,
    row: 3,
    icon: "link",
    title: t("workflow.flow.webhook.title"),
    status: !msgs && !convCount ? "off" : convLinked ? "ok" : msgs ? "bad" : "warn",
    metric: convCount ? t("workflow.flow.webhook.metric", { linked: n(convLinked), total: n(convCount) }) : t("workflow.flow.webhook.noConv"),
    lines: [t("workflow.flow.webhook.referrals", { count: n(referrals) })],
    issue: !convLinked && convCount ? t("workflow.flow.webhook.issue") : undefined,
    href: "/connections",
    cta: t("workflow.flow.webhook.cta"),
  });
  add({
    id: "leads",
    updatedAt: iso(lastLead._max.createdTime),
    updatedLabel: t("workflow.flow.leads.updatedLabel"),
    nextAt: isMeta ? nextSync : null,
    nextLabel: t("workflow.flow.leads.nextLabel"),
    col: 0,
    row: 4,
    icon: "form",
    title: t("workflow.flow.leads.title"),
    status: leads ? "ok" : client.primaryResult === "leads" ? "warn" : "off",
    metric: t("workflow.flow.leads.metric", { count: n(leads) }),
    lines: [t("workflow.flow.leads.line")],
    issue: !leads && client.primaryResult === "leads" ? t("workflow.flow.leads.issue") : undefined,
    href: `/contacts`,
    cta: t("workflow.flow.leads.cta"),
  });
  add({
    id: "page",
    updatedAt: iso(lastPost._max.syncedAt),
    updatedLabel: t("workflow.flow.page.updatedLabel"),
    nextAt: isMeta ? nextSync : null,
    nextLabel: t("workflow.flow.page.nextLabel"),
    col: 0,
    row: 5,
    icon: "newspaper",
    title: t("workflow.flow.page.title"),
    status: posts ? "ok" : isMeta ? "warn" : "off",
    metric: t("workflow.flow.page.metric", { posts: n(posts), comments: n(comments) }),
    lines: [t("workflow.flow.page.line")],
    issue: !posts && isMeta ? t("workflow.flow.page.issue") : undefined,
    href: `${base}/page-posts`,
    cta: t("workflow.flow.page.cta"),
  });
  add({
    id: "knowledge",
    updatedAt: iso(lastDoc._max.updatedAt),
    updatedLabel: t("workflow.flow.knowledge.updatedLabel"),
    nextNote: t("workflow.flow.knowledge.nextNote"),
    col: 0,
    row: 6,
    icon: "book",
    title: t("workflow.flow.knowledge.title"),
    status: docs ? "ok" : "warn",
    metric: t("workflow.flow.knowledge.metric", { count: n(docs) }),
    lines: [t("workflow.flow.knowledge.line")],
    issue: !docs ? t("workflow.flow.knowledge.issue") : undefined,
    href: `${base}/knowledge`,
    cta: t("workflow.flow.knowledge.title"),
  });

  // ---------------------------------------------------------------- Column 1 · AI analysis
  add({
    id: "convAI",
    updatedAt: iso(convFresh.lastAt),
    updatedLabel: t("workflow.flow.convAI.updatedLabel"),
    nextAt: nextAi,
    nextLabel: t("workflow.flow.convAI.nextLabel"),
    nextNote: idleAi ? t("workflow.flow.convAI.nextIdle", { hours: IDLE_HOURS }) : nextAi ? t("workflow.flow.convAI.nextMin") : t("workflow.flow.manualOnly"),
    col: 1,
    row: 1,
    icon: "sparkles",
    title: t("workflow.flow.convAI.title"),
    status: !convCount ? "off" : !convFresh.lastAt ? "warn" : convFresh.need ? "warn" : "ok",
    metric: convFresh.lastAt ? t("workflow.flow.lastTime", { when: ago(convFresh.lastAt) ?? "" }) : t("workflow.flow.convAI.notAnalyzed"),
    lines: [t("workflow.flow.convAI.unread", { count: n(convFresh.unanalyzed) }), t("workflow.flow.convAI.schedule", { value: modeLabel(t, "ai", client.aiMode) })],
    issue: convCount && convFresh.need ? convFresh.reasons.join(", ") || t("workflow.flow.convAI.issue") : undefined,
    mode: client.aiMode === "manual" ? t("workflow.flow.modeManual") : idleAi ? t("workflow.flow.convAI.modeIdle", { hours: IDLE_HOURS }) : t("workflow.flow.convAI.modeNew"),
    href: `${base}/messages`,
    cta: t("workflow.flow.convAI.cta"),
  });
  add({
    id: "audience",
    updatedAt: iso(analysis?.createdAt),
    updatedLabel: t("workflow.flow.audience.updatedLabel"),
    nextNote: client.aiMode === "manual" ? t("workflow.flow.manualOnly") : t("workflow.flow.audience.nextNote"),
    col: 1,
    row: 3,
    icon: "users",
    title: t("workflow.flow.audience.title"),
    status: !analysis ? "bad" : audFresh.need ? "warn" : "ok",
    metric: analysis ? t("workflow.flow.audience.metric", { personas, items: fits.length, when: ago(analysis.createdAt) ?? "" }) : t("workflow.pipeline.audience.none"),
    lines: analysis ? [t("workflow.flow.audience.freeItems", { count: fits.filter((f) => f.free).length }), t("workflow.flow.audience.guided")] : [t("workflow.flow.audience.root")],
    issue: !analysis ? t("workflow.flow.audience.issue") : audFresh.need ? t("workflow.pipeline.analyze.rerun", { reasons: audFresh.reasons.join(", ") }) : undefined,
    href: `${base}/audience`,
    cta: t("workflow.flow.audience.cta"),
  });
  add({
    id: "library",
    updatedAt: iso(findRun?.finishedAt),
    updatedLabel: t("workflow.flow.library.updatedLabel"),
    nextNote: autoLib?.value === "on" ? t("workflow.flow.library.nextOn") : t("workflow.flow.library.nextOff"),
    col: 1,
    row: 5,
    icon: "target",
    title: t("workflow.flow.library.title"),
    status: libFound > 1000 ? "ok" : "warn",
    metric: t("workflow.flow.library.metric", { count: n(libFound) }),
    lines: [t("workflow.flow.library.hidden", { count: n(libNot) }), findRun?.finishedAt ? t("workflow.flow.library.lastCheck", { when: ago(findRun.finishedAt) ?? "" }) : t("workflow.flow.library.neverChecked"), t("workflow.flow.library.shared")],
    href: "/targeting",
    cta: t("workflow.flow.library.cta"),
  });
  add({
    id: "creative",
    updatedAt: iso(creative?.createdAt),
    updatedLabel: t("workflow.flow.convAI.updatedLabel"),
    nextNote: t("workflow.flow.manualOnly"),
    col: 1,
    row: 6,
    icon: "image",
    title: t("workflow.flow.creative.title"),
    status: creative ? (daysSince(creative.createdAt)! > 30 ? "warn" : "ok") : spend7 ? "warn" : "off",
    metric: creative ? t("workflow.flow.lastTime", { when: ago(creative.createdAt) ?? "" }) : t("workflow.flow.convAI.notAnalyzed"),
    lines: [t("workflow.flow.creative.line")],
    issue: !creative && spend7 ? t("workflow.flow.creative.issueNone") : creative && daysSince(creative.createdAt)! > 30 ? t("workflow.flow.creative.issueOld") : undefined,
    href: `${base}/audits`,
    cta: t("workflow.flow.creative.cta"),
  });

  // ---------------------------------------------------------------- Column 2 · Assessment & recommendations
  add({
    id: "health",
    updatedAt: iso(client.lastSyncedAt),
    updatedLabel: t("workflow.flow.health.updatedLabel"),
    nextAt: isMeta ? nextSync : null,
    nextLabel: t("workflow.flow.health.nextLabel"),
    col: 2,
    row: 0,
    icon: "heart",
    title: t("workflow.flow.health.title"),
    status: health.score == null ? (spend7 ? "warn" : "off") : health.score >= 75 ? "ok" : health.score >= 50 ? "warn" : "bad",
    metric: health.score != null ? t("workflow.flow.health.metric", { score: health.score, coverage: health.coverage }) : t("workflow.flow.health.metricNone", { coverage: health.coverage }),
    lines: health.checks
      .filter((c) => c.status === "fail")
      .slice(0, 3)
      .map((c) => `✗ ${c.label}`),
    issue: health.score != null && health.score < 75 ? t("workflow.flow.health.issue", { count: health.checks.filter((c) => c.status === "fail").length }) : undefined,
    href: `${base}/audits`,
    cta: t("workflow.flow.health.cta"),
  });
  add({
    id: "ranking",
    updatedAt: iso(ranking?.createdAt),
    updatedLabel: t("workflow.flow.ranking.updatedLabel"),
    nextAt: ranking ? iso(nextRunAt([...Array(24).keys()], client.timezone, new Date(Math.max(Date.now(), ranking.createdAt.getTime() + 20 * 3600_000)))) : null,
    nextLabel: t("workflow.flow.ranking.nextLabel"),
    col: 2,
    row: 2,
    icon: "list",
    title: t("workflow.flow.ranking.title"),
    status: !ranking ? "warn" : ranking.stage === "with_ads" ? "ok" : spend7 ? "warn" : "ok",
    metric: ranking ? t("workflow.flow.ranking.metric", { items: rankItems.length, withAds: rankItems.filter((i) => i.perf != null).length }) : t("workflow.flow.ranking.none"),
    lines: [ranking ? t("workflow.flow.ranking.updated", { when: ago(ranking.createdAt) ?? "" }) : t("workflow.flow.ranking.how"), client.industryKey ? t("workflow.flow.ranking.industry") : t("workflow.flow.ranking.noIndustry")],
    issue: ranking && ranking.stage !== "with_ads" && spend7 ? t("workflow.flow.ranking.issueNoAds") : !client.industryKey ? t("workflow.flow.ranking.issueIndustry") : undefined,
    href: `${base}/audience`,
    cta: t("workflow.flow.ranking.cta"),
  });
  add({
    id: "target",
    col: 2,
    row: 4,
    icon: "gauge",
    title: t("workflow.flow.target.title"),
    status: client.targetCpr != null ? "ok" : target != null ? "warn" : "bad",
    metric: target != null ? t("workflow.flow.target.metric", { value: money(target, client.currency) }) + (client.targetCpr == null ? t("workflow.flow.target.auto") : "") : t("workflow.flow.ranking.none"),
    lines: cpr != null ? [t("workflow.flow.target.last7", { value: money(cpr, client.currency) })] : [t("workflow.flow.target.line")],
    issue: client.targetCpr == null ? (target != null ? t("workflow.flow.target.issueAuto") : t("workflow.flow.target.issueNone")) : undefined,
    href: `${base}/settings`,
    cta: t("workflow.flow.target.cta"),
  });
  add({
    id: "plan",
    updatedAt: iso(lastDraft._max.updatedAt),
    updatedLabel: t("workflow.flow.plan.updatedLabel"),
    col: 2,
    row: 6,
    icon: "pen",
    title: t("workflow.flow.plan.title"),
    status: draftBy.draft || draftBy.published || proposal || reviewTotal ? "ok" : "off",
    metric: t("workflow.flow.plan.metric", { drafts: n(draftBy.draft ?? 0), published: n(draftBy.published ?? 0) }),
    lines: [proposal ? t("workflow.flow.plan.latestIdea", { when: ago(proposal.createdAt) ?? "" }) : t("workflow.flow.plan.noIdea"), t("workflow.flow.plan.reviews", { count: n(reviewTotal) })],
    issue: (draftBy.draft ?? 0) > 3 ? t("workflow.flow.plan.issue", { count: draftBy.draft }) : undefined,
    href: `${base}/drafts`,
    cta: t("workflow.flow.plan.cta"),
  });

  // ---------------------------------------------------------------- Column 3 · Running on Meta
  add({
    id: "publish",
    updatedAt: iso(published?.updatedAt),
    updatedLabel: t("workflow.flow.publish.updatedLabel"),
    col: 3,
    row: 5,
    icon: "send",
    title: t("workflow.flow.publish.title"),
    status: published ? "ok" : "off",
    metric: published ? t("workflow.flow.publish.metric", { when: ago(published.updatedAt) ?? "" }) : t("workflow.flow.publish.none"),
    lines: [t("workflow.flow.publish.line")],
    href: `${base}/drafts`,
    cta: t("workflow.flow.plan.cta"),
  });
  add({
    id: "campaigns",
    updatedAt: iso(client.lastSyncedAt),
    updatedLabel: t("workflow.flow.health.updatedLabel"),
    nextAt: isMeta ? nextSync : null,
    nextLabel: t("workflow.flow.campaigns.nextLabel"),
    col: 3,
    row: 2,
    icon: "megaphone",
    title: t("workflow.flow.campaigns.title"),
    status: !campaigns.length ? "off" : !active.length ? "warn" : target != null && cpr != null && cpr > target * 1.4 ? "bad" : target != null && cpr != null && cpr > target * 1.15 ? "warn" : "ok",
    metric: t("workflow.flow.campaigns.metric", { active: active.length, spend: money(spend7, client.currency) }),
    lines: [t("workflow.flow.campaigns.results", { count: n(res7) }) + (cpr != null ? t("workflow.flow.campaigns.perResult", { value: money(cpr, client.currency) }) : "") + (target != null && cpr != null ? t("workflow.flow.campaigns.vsTarget", { pct: `${cpr > target ? "+" : ""}${Math.round((cpr / target - 1) * 100)}` }) : "")],
    issue: campaigns.length && !active.length ? t("workflow.flow.campaigns.issueNone") : target != null && cpr != null && cpr > target * 1.15 ? t("workflow.flow.campaigns.issueCost") : undefined,
    href: `${base}/campaigns`,
    cta: t("workflow.flow.campaigns.cta"),
  });

  // ---------------------------------------------------------------- Column 4 · Optimization & learning
  const optAge = daysSince(client.lastOptimizeAt);
  add({
    id: "optimize",
    updatedAt: iso(client.lastOptimizeAt),
    updatedLabel: t("workflow.flow.optimize.updatedLabel"),
    nextAt: active.length ? nextOpt : null,
    nextLabel: t("workflow.flow.optimize.nextLabel"),
    nextNote: !nextOpt ? t("workflow.flow.manualOnly") : undefined,
    col: 4,
    row: 1,
    icon: "wand",
    title: t("workflow.flow.optimize.title"),
    status: !active.length ? "off" : client.optimizeMode === "manual" ? (optAge == null || optAge > 3 ? "warn" : "ok") : optAge != null && optAge > 2 ? "warn" : "ok",
    metric: client.lastOptimizeAt ? t("workflow.flow.optimize.metric", { when: ago(client.lastOptimizeAt) ?? "" }) : t("workflow.flow.optimize.none"),
    lines: [t("workflow.flow.schedule", { value: optimizeHourList(client).length ? hoursLabel(optimizeHourList(client)) : modeLabel(t, "opt", client.optimizeMode) }), t("workflow.flow.optimize.rules")],
    issue: active.length && client.optimizeMode === "manual" ? t("workflow.flow.optimize.issue") : undefined,
    mode: client.optimizeMode === "manual" ? t("workflow.flow.modeManual") : t("workflow.flow.modeAuto"),
    href: `${base}/settings/automation`,
    cta: t("workflow.flow.optimize.cta"),
  });
  add({
    id: "approve",
    updatedAt: iso(lastRec._max.createdAt),
    updatedLabel: t("workflow.flow.approve.updatedLabel"),
    col: 4,
    row: 3,
    icon: "inbox",
    title: t("workflow.flow.approve.title"),
    status: oldPending ? "bad" : pending ? "warn" : executed ? "ok" : "off",
    metric: t("workflow.flow.approve.metric", { pending: n(pending), done: n(executed) }),
    lines: [t("workflow.flow.approve.line")],
    issue: oldPending ? t("workflow.flow.approve.issueOld", { count: oldPending }) : pending ? t("workflow.flow.approve.issuePending", { count: pending }) : undefined,
    href: `${base}/recommendations`,
    cta: t("workflow.orbit.approve"),
  });
  const right = hyps.filter((h) => h.verdict === "right").length;
  const wrong = hyps.filter((h) => h.verdict === "wrong").length;
  const notRun = hyps.filter((h) => h.verdict === "not_run").length;
  add({
    id: "learn",
    updatedAt: iso(lastEval._max.executedAt),
    updatedLabel: t("workflow.flow.learn.updatedLabel"),
    nextAt: nextOpt,
    nextLabel: t("workflow.flow.learn.nextLabel"),
    col: 4,
    row: 5,
    icon: "loop",
    title: t("workflow.flow.learn.title"),
    status: evaluated || right || wrong ? "ok" : executed || hyps.length ? "warn" : "off",
    metric: t("workflow.flow.learn.metric", { evaluated: n(evaluated), right, wrong }),
    lines: [t("workflow.flow.learn.unclear", { unclear: hyps.length - right - wrong - notRun, notRun }), t("workflow.flow.learn.line")],
    issue: hyps.length && !right && !wrong ? (notRun ? t("workflow.flow.learn.issueNotRun", { count: notRun }) : t("workflow.flow.learn.issueNoData")) : undefined,
    href: `${base}/audience`,
    cta: t("workflow.flow.audience.cta"),
  });

  const edges: FlowEdge[] = [
    { from: "meta", to: "sync" },
    { from: "sync", to: "health", label: t("workflow.flow.edges.adMetrics") },
    { from: "sync", to: "ranking", label: t("workflow.flow.edges.days90") },
    { from: "sync", to: "campaigns" },
    { from: "meta", to: "messages" },
    { from: "messages", to: "convAI" },
    { from: "webhook", to: "convAI", label: t("workflow.flow.edges.whichAd") },
    { from: "webhook", to: "optimize", label: t("workflow.flow.edges.customerQuality") },
    { from: "leads", to: "optimize", label: t("workflow.flow.edges.leadQuality") },
    { from: "leads", to: "audience", label: t("workflow.flow.edges.saleRated") },
    { from: "convAI", to: "audience", label: t("workflow.flow.edges.insight") },
    { from: "page", to: "audience" },
    { from: "knowledge", to: "audience" },
    { from: "knowledge", to: "plan", label: t("workflow.flow.edges.priceUsp") },
    { from: "library", to: "audience", label: t("workflow.flow.edges.realIds") },
    { from: "audience", to: "ranking" },
    { from: "audience", to: "plan", label: t("workflow.flow.edges.guided") },
    { from: "ranking", to: "plan", label: t("workflow.flow.edges.evidence") },
    { from: "creative", to: "plan", label: t("workflow.flow.edges.winners") },
    { from: "target", to: "plan" },
    { from: "target", to: "campaigns" },
    { from: "health", to: "optimize" },
    { from: "plan", to: "publish", label: t("workflow.flow.edges.youApprove") },
    { from: "publish", to: "campaigns" },
    { from: "campaigns", to: "optimize" },
    { from: "optimize", to: "approve" },
    { from: "approve", to: "learn", label: t("workflow.flow.edges.measure") },
    { from: "campaigns", to: "learn", label: t("workflow.flow.edges.hypotheses") },
    { from: "learn", to: "audience", loop: true, label: t("workflow.flow.edges.newLoop") },
  ];

  // ---------------------------------------------------------------- Optimization loop (orbit UI)
  const by = new Map(nodes.map((x) => [x.id, x]));
  const st = (id: string) => by.get(id)?.status ?? "off";
  const saleN = scored.filter((x) => x.sale).length;
  const chip = (node: string, text: string, status = st(node)): LoopChip => ({ node, text, status });
  const optAuto = client.optimizeMode !== "manual";
  const cores: LoopCore[] = [
    {
      key: "aud",
      title: t("workflow.flow.loop.aud.title"),
      name: t("workflow.flow.loop.aud.name"),
      status: st("audience"),
      metric: analysis ? t("workflow.flow.loop.aud.metric", { personas, items: fits.length }) : t("workflow.flow.loop.aud.notBuilt"),
      sub: analysis ? t("workflow.flow.loop.aud.built", { when: ago(analysis.createdAt) ?? "" }) : t("workflow.flow.loop.aud.needBuild"),
      detail: t("workflow.flow.loop.aud.detail"),
      href: `${base}/audience`,
      cta: t("workflow.flow.audience.cta"),
      chips: [chip("messages", t("workflow.flow.loop.aud.chipMessages", { count: n(convCount) })), chip("page", t("workflow.flow.loop.aud.chipPosts", { count: n(posts) })), chip("knowledge", t("workflow.flow.loop.aud.chipKnowledge", { count: n(docs) }))],
    },
    {
      key: "tg",
      title: t("workflow.flow.loop.tg.title"),
      name: t("workflow.flow.loop.tg.name"),
      status: worst([st("ranking"), st("creative"), st("plan"), st("target")]),
      metric: ranking ? t("workflow.flow.loop.tg.metric", { count: rankItems.length }) : t("workflow.flow.loop.tg.notRanked"),
      sub: !creative && spend7 ? t("workflow.flow.loop.tg.noCreative") : target == null ? t("workflow.flow.loop.tg.noTarget") : t("workflow.flow.loop.tg.withAds", { count: rankItems.filter((i) => i.perf != null).length }),
      detail: t("workflow.flow.loop.tg.detail"),
      href: `${base}/drafts`,
      cta: t("workflow.flow.plan.cta"),
      chips: [chip("library", t("workflow.flow.loop.tg.chipLibrary", { count: n(libFound) })), chip("creative", creative ? (daysSince(creative.createdAt)! > 30 ? t("workflow.flow.loop.tg.creativeOld") : t("workflow.flow.loop.tg.creativeYes")) : t("workflow.flow.loop.tg.creativeNo")), chip("plan", t("workflow.flow.loop.tg.chipDrafts", { count: n(draftBy.draft ?? 0) }))],
    },
    {
      key: "run",
      title: t("workflow.flow.loop.run.title"),
      name: t("workflow.flow.loop.run.title"),
      status: worst([st("campaigns"), st("optimize"), st("approve")]),
      metric: cpr != null ? money(cpr, client.currency) : t("workflow.flow.loop.run.campsOn", { count: active.length }),
      sub: pending ? t("workflow.flow.loop.run.pending", { count: n(pending) }) : target != null && cpr != null ? t("workflow.flow.loop.run.vsTarget", { pct: `${cpr > target ? "+" : "−"}${Math.abs(Math.round((cpr / target - 1) * 100))}` }) : active.length ? t("workflow.flow.loop.run.running") : t("workflow.flow.loop.run.notRunning"),
      detail: t("workflow.flow.loop.run.detail"),
      href: `${base}/campaigns`,
      cta: t("workflow.flow.campaigns.cta"),
      chips: [
        chip("health", health.score != null ? t("workflow.flow.loop.run.chipHealth", { score: health.score }) : t("workflow.flow.loop.run.chipHealthNone")),
        chip("optimize", optAuto ? t("workflow.flow.loop.run.chipOptAuto") : t("workflow.flow.loop.run.chipOptManual"), active.length && !optAuto ? "warn" : st("optimize")),
        chip("sync", client.syncMode === "manual" ? t("workflow.flow.loop.run.chipSyncManual") : t("workflow.flow.loop.run.chipSyncAuto")),
      ],
    },
    {
      key: "q",
      title: t("workflow.flow.loop.q.title"),
      name: t("workflow.flow.loop.q.name"),
      status: worst([scored.length ? "ok" : spend7 ? "warn" : "off", st("webhook")]),
      metric: t("workflow.flow.loop.q.metric", { count: n(scored.length) }),
      sub: t("workflow.flow.loop.q.sub", { count: n(saleN) }),
      detail: t("workflow.flow.loop.q.detail"),
      href: `${base}/leads`,
      cta: t("workflow.flow.loop.q.cta"),
      chips: [chip("leads", t("workflow.flow.loop.q.chipLeads", { count: n(leads) })), chip("webhook", t("workflow.flow.loop.q.chipSource", { count: n(convLinked) })), chip("learn", t("workflow.flow.loop.q.chipSale", { count: n(saleN) }), saleN ? "ok" : "off")],
    },
  ];
  const saleRe = reasonRe(t, "workflow.freshness.newFeedback");
  const staleReason = audFresh.reasons.find((r) => saleRe.test(r)) ?? audFresh.reasons[0];
  const arrows: LoopArrow[] = [
    analysis ? { status: "ok", label: [t("workflow.flow.loop.arrows.guides")] } : { status: "off", label: [t("workflow.flow.loop.arrows.noPersona")] },
    published || active.length
      ? { status: "ok", label: [t("workflow.flow.loop.arrows.published")] }
      : draftBy.draft
        ? { status: "warn", label: [t("workflow.flow.loop.arrows.draftsUnpublished", { count: n(draftBy.draft) })] }
        : { status: "off", label: [t("workflow.flow.loop.arrows.noCampaign")] },
    !spend7 ? { status: "off", label: [t("workflow.flow.loop.arrows.noAds")] } : convLinked || leads ? { status: "ok", label: [t("workflow.flow.loop.arrows.customersBack")] } : { status: "warn", label: [t("workflow.flow.loop.arrows.unknownSource1"), t("workflow.flow.loop.arrows.unknownSource2")] },
    !analysis ? { status: "off", label: [t("workflow.flow.loop.arrows.noPersona")] } : audFresh.need
        ? { status: "warn", label: staleReason === t("workflow.freshness.over30Days") ? [t("workflow.flow.loop.arrows.over30")] : [shortReason(t, staleReason), t("workflow.flow.loop.arrows.notInPersona")] } : { status: "ok", label: [t("workflow.flow.loop.arrows.fixPersona")] },
  ];
  const issues: LoopIssue[] = nodes
    .filter((x) => x.issue && (x.status === "bad" || x.status === "warn"))
    .sort((a, b) => RANK[b.status] - RANK[a.status])
    .map((x) => ({ ...x, node: x.id, text: x.issue! }));
  const kpis: LoopKpi[] = [
    {
      label: t("workflow.flow.loop.kpi.cpr"),
      value: cpr != null ? money(cpr, client.currency) : "—",
      sub: target != null && cpr != null ? t("workflow.flow.loop.run.vsTarget", { pct: `${cpr > target ? "+" : "−"}${Math.abs(Math.round((cpr / target - 1) * 100))}` }) : t("workflow.flow.loop.kpi.last7"),
      tone: target != null && cpr != null ? (cpr > target * 1.15 ? "bad" : cpr <= target ? "good" : undefined) : undefined,
    },
    { label: t("workflow.flow.loop.kpi.scored"), value: n(scored.length), sub: t("workflow.flow.loop.kpi.bySale", { count: n(saleN) }) },
    { label: t("workflow.flow.loop.kpi.learned"), value: t("workflow.flow.loop.kpi.right", { count: right }), sub: t("workflow.flow.loop.kpi.wrong", { count: wrong }) },
    { label: t("workflow.flow.loop.kpi.waiting"), value: n(issues.length), sub: t("workflow.flow.loop.kpi.recs", { count: n(pending) }), tone: issues.length ? "warn" : "good" },
  ];
  const loop: Loop = { cores, arrows, flowing: arrows.filter((a) => a.status === "ok").length, kpis, issues };

  return { nodes, edges, columns: [t("workflow.flow.columns.sources"), t("workflow.flow.columns.analysis"), t("workflow.flow.columns.assessment"), t("workflow.flow.columns.running"), t("workflow.flow.columns.learning")], loop };
}
