import Link from "next/link";
import { btnClass } from "@/components/ui";
import { connection } from "next/server";
import { db } from "@/lib/db";
import { EditablePlanSchema, CampaignIdeasSchema } from "@/lib/ai/schemas";
import { CampaignProposals } from "@/components/campaign-proposals";
import { blankDraftAction } from "@/app/actions";
import { ActionButton } from "@/components/action-button";
import { Card } from "@/components/ui";
import { requirePageClient } from "@/lib/access";
import { getT } from "@/i18n/server";

export default async function CreateCampaignPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const t = await getT();
  const { id } = await params;
  await requirePageClient(id); // check access right on the page: the layout may not re-run on client-side navigation
  const [client, drafts, knowledge, proposalRow, audienceCount, postCount, jobs] = await Promise.all([
    db.client.findUniqueOrThrow({ where: { id } }),
    db.campaignDraft.findMany({ where: { clientId: id }, orderBy: { updatedAt: "desc" }, take: 30 }),
    db.knowledgeDoc.count({ where: { clientId: id, useForAi: true } }),
    db.campaignProposal.findFirst({ where: { clientId: id }, orderBy: { createdAt: "desc" } }),
    db.audienceAnalysis.count({ where: { clientId: id } }),
    db.pagePost.count({ where: { clientId: id } }),
    db.clientJob.findMany({ where: { clientId: id, kind: { in: ["propose_campaigns", "draft_campaigns"] }, status: { in: ["queued", "running"] } }, select: { kind: true } }),
  ]);
  const raw = proposalRow ? JSON.parse(proposalRow.report) : null;
  const report = raw ? CampaignIdeasSchema.safeParse(raw) : null;
  const draftIds: string[] = proposalRow?.draftIds ? JSON.parse(proposalRow.draftIds) : [];
  const proposal =
    proposalRow && report?.success
      ? {
          id: proposalRow.id,
          status: proposalRow.status,
          report: { ...report.data, test_mode: raw.test_mode, brief: raw.brief }, // zod drops the extra stored fields (test mode, brief)
          model: proposalRow.model,
          createdAt: proposalRow.createdAt.toISOString(),
          drafts: draftIds.flatMap((did) => {
            const d = drafts.find((x) => x.id === did);
            const plan = d ? EditablePlanSchema.safeParse(JSON.parse(d.plan)) : null;
            return d ? [{ id: d.id, name: plan?.success ? plan.data.campaign_name : t("campaigns.createPage.draftFallback") }] : [];
          }),
        }
      : null;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6 @5xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="space-y-6">
        <Card>
          <CampaignProposals
            key={proposal?.id ?? "none"}
            clientId={id}
            proposal={proposal}
            currency={client.currency}
            defaultGoal={client.primaryResult}
            maxDailyBudget={client.maxDailyBudget}
            data={{ audience: audienceCount > 0, docs: knowledge, posts: postCount }}
            proposing={jobs.some((j) => j.kind === "propose_campaigns")}
            drafting={jobs.some((j) => j.kind === "draft_campaigns")}
          />
        </Card>
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0">
              <h2 className="text-[15px] font-semibold text-ink">{t("campaigns.createPage.orDoItYourself")}</h2>
              <p className="mt-1 text-sm text-mut">{t("campaigns.createPage.stepsHint")}</p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Link href={`/clients/${id}/create/new`} className={btnClass("secondary")}>
                {t("campaigns.createPage.stepByStep")}
              </Link>
              <ActionButton action={blankDraftAction.bind(null, id)} variant="ghost" pending={t("campaigns.createPage.creating")} redirectTo={`/clients/${id}/drafts/`}>
                {t("campaigns.createPage.openBlankEditor")}
              </ActionButton>
            </div>
          </div>
        </Card>
      </div>
      <Card title={t("campaigns.createPage.draftsTitle")} className="@5xl:self-start">
        <p className="text-sm text-slate-600">
          {t("campaigns.createPage.draftCounts", { unpublished: drafts.filter((d) => d.status === "draft").length, published: drafts.filter((d) => d.status === "published").length })}
        </p>
        <ul className="mt-3 space-y-1 text-sm">
          {drafts.slice(0, 3).map((d) => {
            const plan = EditablePlanSchema.safeParse(JSON.parse(d.plan));
            return (
              <li key={d.id} className="truncate">
                <Link href={`/clients/${id}/drafts/${d.id}`} className="text-slate-700 hover:text-indigo-600">
                  {plan.success ? plan.data.campaign_name : t("campaigns.createPage.oldDraft")}
                </Link>
              </li>
            );
          })}
        </ul>
        <Link href={`/clients/${id}/drafts`} className="mt-3 inline-block text-sm font-medium text-indigo-600 hover:underline">
          {t("campaigns.createPage.manageAll")}
        </Link>
      </Card>
    </div>
  );
}
