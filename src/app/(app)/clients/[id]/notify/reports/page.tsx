import Link from "next/link";
import { connection } from "next/server";
import { db } from "@/lib/db";
import { loadReportZaloGroups, parseEmails, parseRecipients, parseTelegram, zaloNotReady } from "@/lib/client-report";
import { displayPhone } from "@/lib/client-report-vars";
import { loadDailyOpts } from "@/lib/client-daily-report";
import { smtpStatus, telegramStatus } from "@/lib/report-channels";
import { zaloBotStatus } from "@/lib/zalo-bot";
import { parseLeadNotify } from "@/lib/lead-notify-config";
import { loadTemplate } from "@/lib/zalo";
import { nextRunLabel } from "@/lib/report-schedule";
import { loadSchedules } from "@/lib/report-schedule-run";
import { ReportSettingsForm, type ChannelState, type Target } from "@/components/client-report-panel";
import { ReportSchedules } from "@/components/report-schedules";
import { Card } from "@/components/ui";
import { requirePageClient } from "@/lib/access";
import { getT } from "@/i18n/server";

// Notifications & reports → Report schedule: multiple schedules / day (ReportSchedule table, run by the background process every minute) + recipients.

export default async function ReportSchedulePage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  const t = await getT();
  await requirePageClient(id); // check access right on the page: the layout may not re-run on client-side navigation
  const [client, template, zaloWhy, smtp, tgBot, dailyOpts, bot, groups, schedules] = await Promise.all([
    db.client.findUniqueOrThrow({ where: { id } }),
    loadTemplate(),
    zaloNotReady(),
    smtpStatus(),
    telegramStatus(),
    loadDailyOpts(id),
    zaloBotStatus().catch(() => null),
    loadReportZaloGroups(id),
    loadSchedules(id),
  ]);
  const recipients = parseRecipients(client.reportPhones);
  const emails = parseEmails(client.reportEmails);
  const chats = parseTelegram(client.reportTelegram);
  const leadGroups = parseLeadNotify(client.leadNotify).targets.filter((x) => x.channel === "zalobot").map((x) => ({ title: x.title, chatId: x.chatId }));
  const channels: ChannelState = { email: smtp?.user ?? null, telegram: tgBot?.username ?? null, zalobot: bot?.name ?? null, zalo: zaloWhy ? null : (template?.templateName ?? null), zaloNotReady: zaloWhy };
  // Deliverable destinations (connected channels), same as the Send button in Client reports.
  const targets: Target[] = [
    ...(bot ? groups.map((g) => ({ channel: "zalobot" as const, to: g.chatId, label: g.title || t("notify.report.channels.zalobot"), sub: "" })) : []),
    ...(smtp ? emails.map((e) => ({ channel: "email" as const, to: e.email, label: e.name || e.email, sub: e.name ? e.email : "" })) : []),
    ...(tgBot ? chats.map((c) => ({ channel: "telegram" as const, to: c.chatId, label: c.title || c.chatId, sub: "" })) : []),
    ...(zaloWhy ? [] : recipients.map((r) => ({ channel: "zalo" as const, to: r.phone, label: r.name || displayPhone(r.phone), sub: r.name ? displayPhone(r.phone) : "" }))),
  ];

  return (
    <div className="space-y-6">
      <Card title={t("notify.reportsPage.card")}>
        <p className="mb-4 text-sm text-mut">
          {t("notify.reportsPage.introA")}{" "}
          <Link href={`/clients/${id}/client-reports`} className="text-indigo-600 hover:underline">
            {t("notify.reportsPage.link")}
          </Link>
          .
        </p>
        <ReportSchedules clientId={id} schedules={schedules.map((x) => ({ ...x, next: nextRunLabel(x, client.timezone, undefined, t) }))} targets={targets} />
      </Card>

      <Card title={t("notify.reportsPage.recipients")}>
        <ReportSettingsForm clientId={id} initial={{ emails, telegram: chats, recipients, daily: dailyOpts, zalobot: groups }} channels={channels} leadGroups={leadGroups} />
      </Card>
    </div>
  );
}
