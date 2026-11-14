import Link from "next/link";
import { connection } from "next/server";
import { db } from "@/lib/db";
import { clientWorkflow } from "@/lib/workflow";
import { byPriority, currentBudgets, toRecView } from "@/lib/recview";
import { WorkflowView } from "@/components/workflow-view";
import { LoopOrbit, type IssueAction } from "@/components/loop-orbit";
import { btnClass } from "@/components/ui";
import { requirePageClient } from "@/lib/access";
import { getT } from "@/i18n/server";
import { analyzeAction, audienceAction, auditAction, creativeAnalysisAction, optimizeAction, refreshRankingAction, syncAction } from "@/app/actions";

// Activity diagram of the system for this client. Default: the optimization loop (4 key points joined into a loop, orbit style).
// ?view=full: all 20 blocks, n8n-workflow style (data flow → analysis → suggestions → execution → optimize & learn).
// Each block computes its status from real data, to quickly see what's fine and what isn't.
export default async function WorkflowPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ view?: string }> }) {
  await connection();
  const t = await getT();
  const { id } = await params;
  await requirePageClient(id); // check access right on the page: the layout may not re-run on client-side navigation
  const { view } = await searchParams;
  const base = `/clients/${id}/workflow`;
  if (view === "full") {
    const wf = await clientWorkflow(id);
    return (
      <div className="space-y-4">
        <div className="flex justify-end">
          <Link href={base} className={btnClass("secondary")}>
            {t("workflow.workflowPage.viewLoop")}
          </Link>
        </div>
        <WorkflowView wf={wf} />
      </div>
    );
  }
  const [wf, client, pendingRecs] = await Promise.all([
    clientWorkflow(id),
    db.client.findUniqueOrThrow({ where: { id }, select: { currency: true } }),
    db.recommendation.findMany({ where: { clientId: id, status: "pending" }, include: { audit: { select: { kind: true } } }, take: 50 }),
  ]);
  const recs = pendingRecs.sort(byPriority);
  const budgets = await currentBudgets(recs);
  // Bottlenecks open in a dialog: blocks that can be acted on right away get a run button (same action as the buttons on other pages).
  const actions: Record<string, IssueAction> = {
    sync: { label: t("workflow.workflowPage.sync"), pending: t("workflow.workflowPage.syncPending"), action: syncAction.bind(null, id) },
    convAI: { label: t("workflow.workflowPage.convAI"), pending: t("workflow.workflowPage.convAIPending"), action: analyzeAction.bind(null, id) },
    audience: { label: t("workflow.workflowPage.audience"), pending: t("workflow.workflowPage.audiencePending"), action: audienceAction.bind(null, id) },
    creative: { label: t("workflow.workflowPage.creative"), pending: t("workflow.workflowPage.queued"), action: creativeAnalysisAction.bind(null, id) },
    ranking: { label: t("workflow.workflowPage.ranking"), pending: t("workflow.workflowPage.rankingPending"), action: refreshRankingAction.bind(null, id) },
    health: { label: t("workflow.workflowPage.health"), pending: t("workflow.workflowPage.healthPending"), action: auditAction.bind(null, id) },
    optimize: { label: t("workflow.workflowPage.optimize"), pending: t("workflow.workflowPage.queued"), action: optimizeAction.bind(null, id) },
  };
  return (
    <LoopOrbit
      loop={wf.loop}
      fullHref={`${base}?view=full`}
      actions={actions}
      recs={recs.map((r) => ({ rec: toRecView(r), currentBudget: r.targetId ? (budgets.get(r.targetId) ?? null) : null }))}
      currency={client.currency}
    />
  );
}
