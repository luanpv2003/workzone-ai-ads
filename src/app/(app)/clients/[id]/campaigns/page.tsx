import Link from "next/link";
import { connection } from "next/server";
import { db } from "@/lib/db";
import { errorMessage } from "@/lib/activity";
import { buildCampaignReport, periodLabel, REPORT_PERIODS, toReportPeriod, type CampaignReport } from "@/lib/campaign-report";
import { CampaignReportView } from "@/components/campaign-report-view";
import { btnClass, Card, Empty } from "@/components/ui";
import { requirePageClient } from "@/lib/access";
import { getT } from "@/i18n/server";

// Review report of all of a client's campaigns per period, exported to PDF to send to the client.

export default async function CampaignsReportPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ days?: string; fresh?: string }> }) {
  await connection();
  const t = await getT();
  const { id } = await params;
  await requirePageClient(id); // check access right on the page: the layout may not re-run on client-side navigation
  const { days: d, fresh } = await searchParams;
  const days = toReportPeriod(d);
  const client = await db.client.findUniqueOrThrow({ where: { id } });
  let report: CampaignReport | null = null;
  let error: string | null = null;
  try {
    report = await buildCampaignReport(client, days, { fresh: fresh === "1" });
  } catch (err) {
    error = errorMessage(err);
  }

  return (
    <Card
      title={t("customers.campaignsPage.title")}
      action={
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg bg-slate-100 p-0.5 text-xs">
            {REPORT_PERIODS.map((x) => (
              <Link key={x} href={`?days=${x}`} scroll={false} className={`rounded-md px-2.5 py-1 ${x === days ? "bg-panel font-medium text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"}`}>
                {periodLabel(x, t)}
              </Link>
            ))}
          </div>
          <Link href={`?days=${days}&fresh=1`} scroll={false} className={btnClass("secondary")} title={t("customers.campaignsPage.refreshTitle")}>
            {t("customers.campaignsPage.refresh")}
          </Link>
          {report && (
            <a href={`/report/campaigns/${id}?days=${days}`} target="_blank" rel="noreferrer" className={btnClass("primary")}>
              {t("customers.campaignsPage.export")}
            </a>
          )}
        </div>
      }
    >
      {error ? <Empty>{t("customers.campaignsPage.error", { error })}</Empty> : report && <CampaignReportView r={report} cur={client.currency} base={`/clients/${id}`} />}
    </Card>
  );
}
