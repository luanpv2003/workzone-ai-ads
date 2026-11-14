import Link from "next/link";
import { connection } from "next/server";
import { db } from "@/lib/db";
import { requirePageClient } from "@/lib/access";
import { dateOnly, resultLabels } from "@/lib/format";
import { parseIds } from "@/lib/sales-lift";
import { Card, Empty } from "@/components/ui";
import { NewLiftForm } from "@/components/sales-lift/new-lift-form";
import { getT } from "@/i18n/server";

// Sales lift by SKU: list of measurements + create a new measurement for a campaign / an ad boosting an existing post.

export default async function LiftListPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const t = await getT();
  const { id } = await params;
  await requirePageClient(id); // check access right on the page: the layout may not re-run on client-side navigation
  const client = await db.client.findUniqueOrThrow({ where: { id }, select: { kiotSecret: true } });
  if (!client.kiotSecret) {
    return (
      <Empty>
        {t("settings.liftPage.needKiot")}{" "}
        <Link href={`/clients/${id}/settings/integrations#kiotviet`} className="text-indigo-600 hover:underline">
          {t("settings.liftPage.settingsLink")}
        </Link>{" "}
        {t("settings.liftPage.toConnect")}
      </Empty>
    );
  }
  const [lifts, campaigns] = await Promise.all([
    db.salesLift.findMany({ where: { clientId: id }, orderBy: { updatedAt: "desc" } }),
    db.campaign.findMany({
      where: { clientId: id },
      orderBy: [{ createdTime: { sort: "desc", nulls: "last" } }],
      select: { id: true, name: true, status: true, resultType: true, createdTime: true, ads: { select: { id: true, name: true, status: true }, orderBy: { name: "asc" } } },
    }),
  ]);

  return (
    <>
      <div className="mb-4 rounded-lg border border-line bg-panel px-4 py-3 text-sm text-ink2">
        {t("settings.liftPage.intro1")}<b>{t("settings.liftPage.introBoost")}</b>{t("settings.liftPage.intro2")}<b>{t("settings.liftPage.introSales")}</b>{t("settings.liftPage.intro3")}<b>{t("settings.liftPage.introControl")}</b>{t("settings.liftPage.intro4")}
      </div>

      <Card title={t("settings.liftPage.newTitle")} className="mb-6">
        {campaigns.length ? (
          <NewLiftForm
            clientId={id}
            campaigns={campaigns.map((c) => ({
              id: c.id,
              name: c.name,
              status: c.status,
              type: resultLabels(t)[c.resultType] ?? c.resultType,
              engagement: /engagement|post/.test(c.resultType) || /đẩy bài|tương tác/i.test(c.name),
              ads: c.ads,
            }))}
          />
        ) : (
          <p className="text-sm text-mut">{t("settings.liftPage.noCampaigns")}</p>
        )}
      </Card>

      <Card title={<>{t("settings.liftPage.listTitle")} <span className="font-normal text-slate-400">· {lifts.length}</span></>}>
        {lifts.length ? (
          <ul className="divide-y divide-line">
            {lifts.map((l) => (
              <li key={l.id} className="py-2.5">
                <Link href={`/clients/${id}/lift/${l.id}`} className="font-medium text-indigo-700 hover:underline">
                  {l.name}
                </Link>
                <p className="mt-0.5 text-xs text-mut">
                  {l.level === "ad" ? t("settings.liftPage.levelAd") : t("settings.liftPage.levelCampaign")} · {t("settings.liftPage.runFrom", { date: dateOnly(l.runStart) })}
                  {l.runEnd ? ` ${t("settings.liftPage.runTo", { date: dateOnly(l.runEnd) })}` : ` ${t("settings.liftPage.runToYesterday")}`} · {t("settings.liftPage.baseline", { start: dateOnly(l.baseStart), end: dateOnly(l.baseEnd) })} · {t("settings.liftPage.counts", { test: parseIds(l.testIds).length, control: parseIds(l.controlIds).length })}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-mut">{t("settings.liftPage.noLifts")}</p>
        )}
      </Card>
    </>
  );
}
