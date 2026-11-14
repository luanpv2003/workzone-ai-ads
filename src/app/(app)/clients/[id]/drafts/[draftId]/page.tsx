import { notFound } from "next/navigation";
import { connection } from "next/server";
import { db } from "@/lib/db";
import { clientPages } from "@/lib/client-pages";
import { EditablePlanSchema } from "@/lib/ai/schemas";
import { CampaignEditor } from "@/components/editor/campaign-editor";
import { parseDraftPolicy } from "@/lib/draft-policy-rules";
import { requirePageClient } from "@/lib/access";
import { getT } from "@/i18n/server";

export default async function DraftPage({ params }: { params: Promise<{ id: string; draftId: string }> }) {
  await connection();
  const t = await getT();
  const { id, draftId } = await params;
  await requirePageClient(id); // check access right on the page: the layout may not re-run on client-side navigation
  const draft = await db.campaignDraft.findFirst({ where: { id: draftId, clientId: id }, include: { client: true } });
  if (!draft) notFound();

  const parsed = EditablePlanSchema.safeParse(JSON.parse(draft.plan));
  if (!parsed.success) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        {t("campaigns.draftPage.legacy")}
      </div>
    );
  }
  const c = draft.client;
  const policyJob = await db.clientJob.findFirst({ where: { clientId: id, kind: "draft_check", params: { contains: draft.id } }, orderBy: { createdAt: "desc" }, select: { status: true, error: true } });

  return (
    <CampaignEditor
      // Only reload when Claude redrafts (revision increases), not after every autosave.
      key={draft.revision}
      draftId={draft.id}
      revision={draft.revision}
      clientId={id}
      initialPlan={parsed.data}
      client={{
        maxDailyBudget: c.maxDailyBudget,
        currency: c.currency,
        metaPageId: c.metaPageId,
        metaInstagramId: c.metaInstagramId,
        storeLat: c.storeLat,
        storeLng: c.storeLng,
        timezone: c.timezone,
        primaryResult: c.primaryResult,
        targetCpr: c.targetCpr,
        autoTargetCpr: c.autoTargetCpr,
      }}
      pageName={c.metaPageName || c.name}
      pages={clientPages(c).map((x) => ({ id: x.id, name: x.name }))}
      isMeta={c.dataSource === "meta"}
      published={draft.status === "published"}
      lastResult={draft.result ? JSON.parse(draft.result) : null}
      policy={parseDraftPolicy(draft.policy)}
      policyJob={policyJob}
    />
  );
}
