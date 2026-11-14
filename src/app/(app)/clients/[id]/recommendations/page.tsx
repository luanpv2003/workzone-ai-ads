import Link from "next/link";
import { connection } from "next/server";
import { db } from "@/lib/db";
import { byPriority, currentBudgets, toRecView } from "@/lib/recview";
import { RecommendationCard } from "@/components/recommendation-card";
import { Empty } from "@/components/ui";
import { requirePageClient } from "@/lib/access";
import { getT } from "@/i18n/server";

export default async function ClientRecommendationsPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const t = await getT();
  const { id } = await params;
  await requirePageClient(id); // check access right on the page: the layout may not re-run on client-side navigation
  const [client, recs, activeCampaigns] = await Promise.all([
    db.client.findUniqueOrThrow({ where: { id } }),
    db.recommendation.findMany({ where: { clientId: id }, include: { audit: { select: { kind: true } } }, orderBy: { createdAt: "desc" }, take: 100 }),
    db.campaign.count({ where: { clientId: id, status: "ACTIVE" } }),
  ]);
  const pending = recs.filter((r) => r.status === "pending").sort(byPriority);
  const done = recs.filter((r) => r.status !== "pending");
  const budgets = await currentBudgets(pending);

  return (
    <div className="space-y-8">
      <section>
        <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("workflow.recsClientPage.pending", { count: pending.length })}</h2>
        {client.optimizeMode === "manual" && activeCampaigns > 0 && (
          <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            {t("workflow.recsClientPage.optimizeOff", { count: activeCampaigns })}{" "}
            <Link href={`/clients/${id}/settings/automation`} className="font-medium underline">
              {t("workflow.recsClientPage.enableOptimize")}
            </Link>
          </p>
        )}
        <div className="space-y-3">
          {pending.map((r) => (
            <RecommendationCard key={r.id} rec={toRecView(r)} currency={client.currency} currentBudget={r.targetId ? budgets.get(r.targetId) : null} />
          ))}
          {!pending.length && <Empty>{t("workflow.recsClientPage.empty")}</Empty>}
        </div>
      </section>
      {done.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("workflow.recsClientPage.done")}</h2>
          <div className="space-y-3 opacity-80">
            {done.map((r) => <RecommendationCard key={r.id} rec={toRecView(r)} currency={client.currency} />)}
          </div>
        </section>
      )}
    </div>
  );
}
