import { connection } from "next/server";
import { db } from "@/lib/db";
import { clientPages } from "@/lib/client-pages";
import { blankPlan } from "@/lib/plan-rules";
import { AudienceReportSchema } from "@/lib/ai/schemas";
import { wizardTables } from "@/lib/wizard-targets";
import { CampaignWizard } from "@/components/wizard/campaign-wizard";
import { requirePageClient } from "@/lib/access";
import { getT } from "@/i18n/server";

// Step-by-step campaign creation (standard Ads Manager setup); each step is prefilled with suggestions from real data and editable.

export default async function NewCampaignWizardPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  await requirePageClient(id); // check access right on the page: the layout may not re-run on client-side navigation
  const [client, analysis] = await Promise.all([
    db.client.findUniqueOrThrow({ where: { id } }),
    db.audienceAnalysis.findFirst({ where: { clientId: id }, orderBy: { createdAt: "desc" } }),
  ]);
  // Table 1: Claude's suggestions (with system evidence). Table 2: the system scores items Claude didn't pick + industry winners.
  const tables = await wizardTables(client);

  // Default demographics from the persona (if already analyzed).
  const report = analysis ? AudienceReportSchema.safeParse(JSON.parse(analysis.report)) : null;
  const demo = report?.success ? report.data.demographics : null;
  const pages = clientPages(client).map((x) => ({ id: x.id, name: x.name }));

  return (
    <CampaignWizard
      clientId={id}
      clientShort={client.name.split(" – ")[0]}
      initialPlan={blankPlan(client, await getT())}
      client={{
        maxDailyBudget: client.maxDailyBudget,
        currency: client.currency,
        metaPageId: client.metaPageId,
        metaInstagramId: client.metaInstagramId,
        storeLat: client.storeLat,
        storeLng: client.storeLng,
        timezone: client.timezone,
        primaryResult: client.primaryResult,
        targetCpr: client.targetCpr,
        autoTargetCpr: client.autoTargetCpr,
      }}
      pages={pages}
      isMeta={client.dataSource === "meta"}
      demographics={demo ? { ageMin: demo.age_min, ageMax: demo.age_max, genders: demo.genders, note: demo.note } : null}
      claude={tables.claude}
      system={tables.system.slice(0, 40)}
      hasAnalysis={tables.hasAnalysis}
      rankingStage={tables.rankingStage}
    />
  );
}
