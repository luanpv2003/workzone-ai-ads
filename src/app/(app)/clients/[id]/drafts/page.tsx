import { connection } from "next/server";
import { db } from "@/lib/db";
import { EditablePlanSchema } from "@/lib/ai/schemas";
import { reviewPlan, totalDailyBudget } from "@/lib/plan-rules";
import Link from "next/link";
import { DraftTable, type DraftRow } from "@/components/draft-table";
import { btnClass, LinkButton } from "@/components/ui";
import { requirePageClient } from "@/lib/access";
import { getT } from "@/i18n/server";

const OBJECTIVE_KEYS = {
  messages: "campaigns.draftsPage.objective.messages",
  engagement: "campaigns.draftsPage.objective.engagement",
  video_views: "campaigns.draftsPage.objective.video_views",
  profile_visits: "campaigns.draftsPage.objective.profile_visits",
  link_clicks: "campaigns.draftsPage.objective.link_clicks",
  reach: "campaigns.draftsPage.objective.reach",
  leads: "campaigns.draftsPage.objective.leads",
  purchases: "campaigns.draftsPage.objective.purchases",
} as const;

export default async function DraftsPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const t = await getT();
  const { id } = await params;
  await requirePageClient(id); // check access right on the page: the layout may not re-run on client-side navigation
  const [client, drafts] = await Promise.all([
    db.client.findUniqueOrThrow({ where: { id } }),
    db.campaignDraft.findMany({ where: { clientId: id }, orderBy: { updatedAt: "desc" } }),
  ]);
  const isMeta = client.dataSource === "meta";
  const acct = client.metaAdAccountId?.replace("act_", "");

  const rows: DraftRow[] = drafts.flatMap((d) => {
    const parsed = EditablePlanSchema.safeParse(JSON.parse(d.plan));
    if (!parsed.success) return [];
    const plan = parsed.data;
    const result = d.result ? JSON.parse(d.result) : {};
    const review = reviewPlan(plan, client, isMeta, t);
    const verify = result.verify && !result.verify.error
      ? { ok: result.verify.ok as boolean, bad: (result.verify.sections as { checks: { ok: boolean }[] }[]).flatMap((s) => s.checks).filter((c) => !c.ok).length }
      : null;
    return [{
      id: d.id,
      name: plan.campaign_name,
      objective: plan.result_type in OBJECTIVE_KEYS ? t(OBJECTIVE_KEYS[plan.result_type as keyof typeof OBJECTIVE_KEYS]) : plan.result_type,
      adSets: plan.ad_sets.length,
      ads: plan.ads.length,
      budget: totalDailyBudget(plan),
      status: d.status === "published" || d.status === "publishing" ? d.status : result.error ? "error" : "draft",
      error: result.error ?? null,
      reviewErrors: review.errors,
      reviewWarnings: review.warnings.length,
      verify,
      updatedAt: d.updatedAt.toISOString(),
      adsManagerUrl:
        d.status === "published" && isMeta && acct && result.campaignId
          ? `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${acct}&selected_campaign_ids=${result.campaignId}`
          : null,
    }];
  });

  return (
    <div className="space-y-4">
      {/* Page title + description live in the client page header (lib/client-sections.ts). */}
      <div className="flex flex-wrap items-center justify-end gap-3">
        <div className="flex gap-2">
          <LinkButton href={`/clients/${id}/create`}>{t("campaigns.draftsPage.askClaude")}</LinkButton>
          <Link href={`/clients/${id}/create/new`} className={btnClass("primary")}>
            {t("campaigns.draftsPage.newCampaign")}
          </Link>
        </div>
      </div>
      <DraftTable clientId={id} rows={rows} currency={client.currency} isMeta={isMeta} />
    </div>
  );
}
