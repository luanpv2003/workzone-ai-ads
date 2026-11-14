import Link from "next/link";
import { connection } from "next/server";
import { db } from "@/lib/db";
import { byPriority, currentBudgets, toRecView } from "@/lib/recview";
import { RecommendationCard } from "@/components/recommendation-card";
import { ReviewQueue } from "@/components/review-queue";
import { Empty, PageHeader } from "@/components/ui";
import { requirePageUser } from "@/lib/auth";
import { clientScope } from "@/lib/access";
import { getT } from "@/i18n/server";

export default async function AllRecommendationsPage({ searchParams }: { searchParams: Promise<{ c?: string }> }) {
  const user = await requirePageUser(); // check the session right on the page: the layout may not re-run on client-side navigation
  await connection();
  const t = await getT();
  const { c } = await searchParams;
  const all = await db.recommendation.findMany({
    where: { ...(await clientScope(user)), status: "pending" },
    include: { client: true, audit: { select: { kind: true } } },
  });
  all.sort(byPriority);
  const recs = c ? all.filter((r) => r.clientId === c) : all;
  const budgets = await currentBudgets(recs);
  const clients = [...new Map(all.map((r) => [r.clientId, r.client.name])).entries()];
  const chip = (key: string | undefined, label: string, n: number) => (
    <Link
      key={key ?? "all"}
      href={key ? `/recommendations?c=${key}` : "/recommendations"}
      scroll={false}
      className={`inline-flex h-7 items-center rounded-full px-3 text-xs font-medium ${c === key ? "bg-ink text-panel" : "border border-line bg-panel text-ink2 hover:bg-hover"}`}
    >
      {label} {n}
    </Link>
  );

  return (
    <>
      <PageHeader
        title={t("workflow.recsAllPage.title")}
        subtitle={t("workflow.recsAllPage.subtitle")}
      />
      {all.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          {chip(undefined, t("workflow.recsAllPage.all"), all.length)}
          {clients.map(([id, name]) => chip(id, name.split(" – ")[0], all.filter((r) => r.clientId === id).length))}
          <span className="ml-auto hidden text-xs text-mut2 md:inline">
            {t("workflow.recsAllPage.shortcuts")} <kbd className="rounded border border-line px-1">J</kbd>/<kbd className="rounded border border-line px-1">K</kbd> {t("workflow.recsAllPage.switchCard")} ·{" "}
            <kbd className="rounded border border-line px-1">Enter</kbd> {t("workflow.recsAllPage.approve")} · <kbd className="rounded border border-line px-1">S</kbd> {t("workflow.recsAllPage.skip")}
          </span>
        </div>
      )}
      <ReviewQueue count={recs.length}>
        {recs.map((r) => (
          <RecommendationCard key={r.id} rec={toRecView(r)} currency={r.client.currency} currentBudget={r.targetId ? budgets.get(r.targetId) : null} client={{ id: r.client.id, name: r.client.name }} />
        ))}
        {!recs.length && <Empty>{t("workflow.recsAllPage.allDone")}</Empty>}
      </ReviewQueue>
    </>
  );
}
