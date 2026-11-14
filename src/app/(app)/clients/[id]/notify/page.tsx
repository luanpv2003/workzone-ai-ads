import { connection } from "next/server";
import { db } from "@/lib/db";
import { MERGED_NOTICE, parseLeadNotify } from "@/lib/lead-notify-config";
import { BRAND } from "@/lib/brand";
import { zaloBotStatus } from "@/lib/zalo-bot";
import { telegramStatus } from "@/lib/report-channels";
import { LeadNotifyForm } from "@/components/lead-notify-form";
import { Card } from "@/components/ui";
import { requirePageClient } from "@/lib/access";
import { getT } from "@/i18n/server";

// Notify new leads into the Zalo (Zalo Bot) / Telegram group shared with the client. See lib/lead-notify.ts.

export async function generateMetadata() {
  return { title: (await getT())("notify.leadPage.title", { app: BRAND.app }) };
}

const DAY = 86400_000;

export default async function LeadNotifyPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  const t = await getT();
  await requirePageClient(id); // check access right on the page: the layout may not re-run on client-side navigation
  const [client, zalo, tg, week] = await Promise.all([
    db.client.findUniqueOrThrow({ where: { id }, select: { leadNotify: true } }),
    zaloBotStatus(),
    telegramStatus(),
    db.leadNotice.count({ where: { clientId: id, createdAt: { gt: new Date(new Date().getTime() - 7 * DAY) }, NOT: { text: MERGED_NOTICE } } }),
  ]);
  const cfg = parseLeadNotify(client.leadNotify);

  return (
    <div className="space-y-6">
      <div className={`flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border px-4 py-3 text-sm ${cfg.on ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-line bg-panel text-ink2"}`}>
        <b>{cfg.on ? t("notify.leadPage.on") : t("notify.leadPage.off")}</b>
        <span>{cfg.targets.length ? t("notify.leadPage.targets", { n: cfg.targets.length }) : t("notify.leadPage.noTargets")}</span>
        <span>{t("notify.leadPage.week", { n: week })}</span>
      </div>
      <Card title={t("notify.leadPage.card")}>
        <p className="mb-4 text-sm text-mut">
          {t("notify.leadPage.intro")}
        </p>
        <LeadNotifyForm clientId={id} initial={cfg} bots={{ zalo: zalo?.name ?? null, telegram: tg?.username ?? null }} />
      </Card>
    </div>
  );
}
