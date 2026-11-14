import { BRAND } from "@/lib/brand";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { db } from "@/lib/db";
import { requirePageClient } from "@/lib/access";
import { errorMessage } from "@/lib/activity";
import { buildCampaignReport, periodLabel, toReportPeriod } from "@/lib/campaign-report";
import { CampaignReportView } from "@/components/campaign-report-view";
import { PrintButton } from "@/components/print-button";
import { ReportCover } from "@/components/report-cover";
import { getT } from "@/i18n/server";

// Print / PDF version of the campaign review report (same content as the Campaign report tab).

export async function generateMetadata() {
  return { title: (await getT())("notify.campaignPrint.title") };
}

export default async function CampaignReportPrint({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ days?: string; print?: string }> }) {
  await connection();
  const t = await getT();
  const { id } = await params;
  await requirePageClient(id); // id is the client id
  const { days: d, print } = await searchParams;
  const client = await db.client.findUnique({ where: { id } });
  if (!client) notFound();
  const days = toReportPeriod(d);
  let report: Awaited<ReturnType<typeof buildCampaignReport>> | null = null;
  let error: string | null = null;
  try {
    report = await buildCampaignReport(client, days);
  } catch (err) {
    error = errorMessage(err);
  }

  return (
    <div data-theme="light" className="min-h-full bg-slate-100 text-ink print:bg-panel" style={{ printColorAdjust: "exact", WebkitPrintColorAdjust: "exact" }}>
      <style>{`
        @page { size: A4; margin: 12mm 10mm 14mm; @bottom-right { content: "${t("notify.print.page")} " counter(page) " / " counter(pages); font: 9px Inter, sans-serif; color: #94a3b8; } @bottom-left { content: "${BRAND.agency.replace(/["\\]/g, "")} · ${client.name.replace(/["\\]/g, "")}"; font: 9px Inter, sans-serif; color: #94a3b8; } }
      `}</style>
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-slate-200 bg-panel px-6 py-3 print:hidden">
        <p className="text-sm text-slate-600">
          {t("notify.print.a")}<b>{t("notify.print.b")}</b>{t("notify.print.c")}<b>{t("notify.print.d")}</b>{t("notify.print.e")}<b>{t("notify.print.f")}</b>{t("notify.print.g")}
        </p>
        {report && <PrintButton auto={print !== "0"} />}
      </div>
      <main className="@container mx-auto my-6 max-w-[210mm] space-y-6 bg-panel px-8 py-8 shadow-sm print:m-0 print:max-w-none print:p-0 print:shadow-none">
        <ReportCover name={client.name} industry={client.industry} period={periodLabel(days, t)} range={report?.range ?? null} />
        {report ? <CampaignReportView r={report} cur={client.currency} base={null} /> : <p className="text-sm text-rose-700">{t("notify.campaignPrint.error", { error: error ?? "" })}</p>}
        <footer className="border-t border-slate-200 pt-3 text-[10.5px] text-slate-400">{t("notify.campaignPrint.footer", { name: client.name })}</footer>
      </main>
    </div>
  );
}
