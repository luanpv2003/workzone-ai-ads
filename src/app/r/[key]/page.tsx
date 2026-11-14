import type { Metadata } from "next";
import { connection } from "next/server";
import { parseReport, reportByKey } from "@/lib/client-report";
import { periodLabel } from "@/lib/campaign-report";
import { dateTime } from "@/lib/format";
import { CampaignReportView } from "@/components/campaign-report-view";
import { ReportCover } from "@/components/report-cover";
import { DailyReportView } from "@/components/daily-report-view";
import { digestOf, isDaily } from "@/lib/client-daily-report";
import { getT } from "@/i18n/server";

// Client report link sent via Zalo: no login required (secret code in the link), shows the numbers as of creation, revocable.

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("notify.publicReport.title"), robots: { index: false, follow: false } };
}

export default async function PublicReport({ params }: { params: Promise<{ key: string }> }) {
  await connection();
  const t = await getT();
  const r = await reportByKey((await params).key);
  if (!r) {
    return (
      <div data-theme="light" className="grid min-h-full place-items-center bg-slate-100 p-6 text-center text-ink">
        <div className="max-w-sm rounded-2xl bg-panel p-8 shadow-sm">
          <p className="text-lg font-semibold">{t("notify.publicReport.notFound")}</p>
          <p className="mt-2 text-sm text-slate-600">{t("notify.publicReport.notFoundDesc")}</p>
        </div>
      </div>
    );
  }
  // Daily report: plain-language version for the client (no campaign table, CTR, CPM).
  const digest = isDaily(r) ? digestOf(r) : null;
  if (digest) {
    return (
      <div data-theme="light" className="min-h-full bg-slate-100 text-ink">
        <DailyReportView name={r.client.name} cur={r.client.currency} d={digest} createdAt={r.createdAt} />
      </div>
    );
  }
  const report = parseReport(r);
  const days = Number(r.period);
  return (
    <div data-theme="light" className="min-h-full bg-slate-100 text-ink">
      <main className="@container mx-auto max-w-[210mm] space-y-6 bg-panel px-4 py-6 shadow-sm sm:my-6 sm:px-8 sm:py-8">
        <ReportCover name={r.client.name} industry={r.client.industry} period={periodLabel(Number.isFinite(days) ? days : r.period === "today" ? "today" : "lifetime", t)} range={report.range} />
        <CampaignReportView r={report} cur={r.client.currency} base={null} />
        <footer className="border-t border-slate-200 pt-3 text-[10.5px] text-slate-400">
          {t("notify.publicReport.footer", { time: dateTime(r.createdAt), name: r.client.name })}
        </footer>
      </main>
    </div>
  );
}
