import type { Audit, Recommendation } from "@prisma/client";
import type { RecView } from "@/components/recommendation-card";
import { db } from "./db";

export function toRecView(r: Recommendation & { audit?: Pick<Audit, "kind"> | null }): RecView {
  return {
    id: r.id,
    title: r.title,
    rationale: r.rationale,
    priority: r.priority,
    expectedImpact: r.expectedImpact,
    actionType: r.actionType,
    targetLevel: r.targetLevel,
    targetName: r.targetName,
    newDailyBudget: r.newDailyBudget,
    status: r.status,
    result: r.result,
    decidedBy: r.decidedBy,
    source: r.kind === "optimize" ? "optimize" : (r.audit?.kind ?? null),
    campaignName: r.campaignName,
    campaignId: r.campaignId,
    clientId: r.clientId,
    rule: r.rule,
    params: JSON.parse(r.params || "{}"),
    evidence: JSON.parse(r.evidence || "{}"),
    evaluation: r.evaluation ? JSON.parse(r.evaluation) : null,
    executedAt: r.executedAt?.toISOString() ?? null,
    guide: r.guide ? JSON.parse(r.guide) : null,
    guideDone: JSON.parse(r.guideDone || "[]"),
    auto: r.auto,
    undone: !!r.undoneAt,
    canUndo: canUndo(r),
  };
}

/** Pauses / budget changes applied within 7 days with stored old state: Undo is available. */
function canUndo(r: Recommendation) {
  if (r.status !== "executed" || r.undoneAt || !r.executedAt || r.executedAt.getTime() < Date.now() - 7 * 86400000) return false;
  const p = JSON.parse(r.params || "{}") as { prevStatus?: string; prevBudget?: number | null };
  return (r.actionType === "pause" && p.prevStatus === "ACTIVE") || (r.actionType === "update_budget" && p.prevBudget != null);
}

/** Current budgets of objects with a recommended budget change. */
export async function currentBudgets(recs: Recommendation[]) {
  const ids = recs.filter((r) => r.actionType === "update_budget" && r.targetId).map((r) => r.targetId!);
  if (!ids.length) return new Map<string, number | null>();
  const [c, s] = await Promise.all([
    db.campaign.findMany({ where: { id: { in: ids } }, select: { id: true, dailyBudget: true } }),
    db.adSet.findMany({ where: { id: { in: ids } }, select: { id: true, dailyBudget: true } }),
  ]);
  return new Map([...c, ...s].map((x) => [x.id, x.dailyBudget]));
}

const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };
export function byPriority(a: Recommendation, b: Recommendation) {
  return (PRIORITY_ORDER[a.priority] ?? 3) - (PRIORITY_ORDER[b.priority] ?? 3) || b.createdAt.getTime() - a.createdAt.getTime();
}
