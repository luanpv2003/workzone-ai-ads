import Link from "next/link";
import { connection } from "next/server";
import { db } from "@/lib/db";
import { dateTime } from "@/lib/format";
import { localTime } from "@/lib/schedule";
import { autoMessageOf, checkData, loadReportZaloGroups, messageOf, parseEmails, parseRecipients, parseTelegram, reportKeyOf, templateData, zaloNotReady, type SendLog, type Vars } from "@/lib/client-report";
import { displayPhone } from "@/lib/client-report-vars";
import { digestOf, isDaily } from "@/lib/client-daily-report";
import { smtpStatus, telegramStatus } from "@/lib/report-channels";
import { zaloBotStatus } from "@/lib/zalo-bot";
import { loadTemplate, publicUrl } from "@/lib/zalo";
import { createClientReportAction, createDailyReportAction } from "@/app/zalo-actions";
import { ActionButton } from "@/components/action-button";
import { kindLabel, repeatLabel, timeLabel } from "@/lib/report-schedule";
import { loadSchedules } from "@/lib/report-schedule-run";
import { DailyTodoForm, ReportSendPanel, type ParamRow, type Target } from "@/components/client-report-panel";
import { Badge, Card, Empty, type Tone } from "@/components/ui";
import { requirePageClient } from "@/lib/access";
import { getT } from "@/i18n/server";

// Client reports: daily report (plain-language, yesterday's numbers) or a snapshot of the campaign report (7 / 14 / 30 days) with a private link; copy to paste into Zalo, send by email / Telegram (/ Zalo OA), auto-generate / auto-send schedule.

const STATUS: Record<string, { key: "draft" | "sent" | "partial" | "failed" | "revoked"; tone: Tone }> = {
  draft: { key: "draft", tone: "amber" },
  sent: { key: "sent", tone: "green" },
  partial: { key: "partial", tone: "amber" },
  failed: { key: "failed", tone: "red" },
  revoked: { key: "revoked", tone: "gray" },
};

export default async function ClientReportsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ r?: string }> }) {
  await connection();
  const { id } = await params;
  const t = await getT();
  await requirePageClient(id); // check access right on the page: the layout may not re-run on client-side navigation
  const { r: pick } = await searchParams;
  const [client, reports, template, zaloWhy, smtp, tgBot, bot, groups, schedules] = await Promise.all([
    db.client.findUniqueOrThrow({ where: { id } }),
    db.clientReport.findMany({ where: { clientId: id }, orderBy: { createdAt: "desc" }, take: 30, select: { id: true, period: true, since: true, until: true, status: true, trigger: true, createdBy: true, createdAt: true, sentAt: true, views: true, viewedAt: true } }),
    loadTemplate(),
    zaloNotReady(),
    smtpStatus(),
    telegramStatus(),
    zaloBotStatus().catch(() => null),
    loadReportZaloGroups(id),
    loadSchedules(id).then((l) => l.filter((x) => x.active)),
  ]);
  const recipients = parseRecipients(client.reportPhones);
  const emails = parseEmails(client.reportEmails);
  const chats = parseTelegram(client.reportTelegram);
  const targets: Target[] = [
    ...(bot ? groups.map((g) => ({ channel: "zalobot" as const, to: g.chatId, label: g.title || t("notify.clientReportsPage.zaloGroup"), sub: "" })) : []),
    ...(smtp ? emails.map((e) => ({ channel: "email" as const, to: e.email, label: e.name || e.email, sub: e.name ? e.email : "" })) : []),
    ...(tgBot ? chats.map((c) => ({ channel: "telegram" as const, to: c.chatId, label: c.title || c.chatId, sub: "" })) : []),
    ...(zaloWhy ? [] : recipients.map((r) => ({ channel: "zalo" as const, to: r.phone, label: r.name || displayPhone(r.phone), sub: r.name ? displayPhone(r.phone) : "" }))),
  ];
  const selId = reports.find((x) => x.id === pick)?.id ?? reports[0]?.id;
  const sel = selId ? await db.clientReport.findUnique({ where: { id: selId } }) : null;

  let panel = null;
  if (sel) {
    const vars = JSON.parse(sel.vars) as Vars;
    const overrides = JSON.parse(sel.overrides) as Record<string, string>;
    const key = reportKeyOf(sel);
    let rows: ParamRow[] = [];
    if (template && !zaloWhy && recipients.length) {
      const first = recipients[0] ?? null;
      const auto = templateData(template, vars, {}, first, client.name);
      const final = templateData(template, vars, overrides, first, client.name);
      const errs = new Map(checkData(template, final, t).map((e) => [e.param, e.error]));
      rows = template.params.map((p) => ({ name: p.name, type: p.type, maxLength: p.maxLength, require: p.require, auto: auto[p.name], value: final[p.name], override: overrides[p.name] != null, error: errs.get(p.name) ?? null }));
    }
    const digest = isDaily(sel) ? digestOf(sel) : null;
    const autoMessage = autoMessageOf(sel, client, t);
    panel = (
      <>
      {digest && <DailyTodoForm key={`todo-${sel.id}`} reportId={sel.id} initial={digest.todo} edited={!!sel.message} />}
      <ReportSendPanel
        key={`${sel.id}:${autoMessage}`}
        reportId={sel.id}
        link={key ? `${publicUrl()}/r/${key}` : null}
        status={sel.status}
        sent={!!sel.sentAt}
        message={messageOf(sel, client, t)}
        autoMessage={autoMessage}
        edited={!!sel.message}
        targets={targets}
        params={rows}
        templateName={template?.templateName ?? null}
        price={template?.price ?? null}
        sends={(JSON.parse(sel.sends) as SendLog[]).slice().reverse()}
        emptyHint={
          (emails.length && !smtp) || (chats.length && !tgBot) || (groups.length && !bot)
            ? t("notify.clientReportsPage.emptyHint", { list: [groups.length && !bot && t("notify.clientReportsPage.zaloBot"), emails.length && !smtp && t("notify.clientReportsPage.sendEmail"), chats.length && !tgBot && t("notify.clientReportsPage.tgBot")].filter(Boolean).join(t("notify.clientReportsPage.and")) })
            : t("notify.clientReportsPage.noRecipients")
        }
      />
      </>
    );
  }

  return (
    <div className="space-y-6">
      <Card
        title={t("notify.clientReportsPage.card")}
        action={
          <div className="flex flex-wrap gap-2">
            <ActionButton action={createDailyReportAction.bind(null, id)} variant="primary" pending={t("notify.clientReportsPage.reading")} redirectTo={`/clients/${id}/client-reports?r=`}>
              {t("notify.clientReportsPage.btnDaily")}
            </ActionButton>
            <ActionButton action={createDailyReportAction.bind(null, id, true)} variant="secondary" pending={t("notify.clientReportsPage.reading")} redirectTo={`/clients/${id}/client-reports?r=`}>
              {t("notify.clientReportsPage.btnToday")}
            </ActionButton>
            {[7, 14, 30].map((d) => (
              <ActionButton key={d} action={createClientReportAction.bind(null, id, d)} variant="secondary" pending={t("notify.clientReportsPage.reading")} redirectTo={`/clients/${id}/client-reports?r=`}>
                {t("notify.clientReportsPage.btnDays", { d })}
              </ActionButton>
            ))}
          </div>
        }
      >
        <p className="mb-4 text-sm text-slate-600">
          {t("notify.clientReportsPage.intro")}{" "}
          {schedules.length ? t("notify.clientReportsPage.schedulesN", { n: schedules.length }) : t("notify.clientReportsPage.noSchedules")}
        </p>
        {!reports.length ? (
          <Empty>{t("notify.clientReportsPage.empty")}</Empty>
        ) : (
          <div className="grid gap-5 @4xl:grid-cols-[18rem_1fr]">
            <ul className="space-y-1">
              {reports.map((x) => {
                const st = STATUS[x.status] ?? STATUS.draft;
                const isToday = x.since === localTime(client.timezone, x.createdAt).date;
                return (
                  <li key={x.id}>
                    <Link href={`?r=${x.id}`} scroll={false} className={`block rounded-lg border px-3 py-2 text-sm ${x.id === selId ? "border-indigo-400 bg-indigo-50" : "border-slate-200 hover:bg-slate-50"}`}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-slate-800">
                          {x.period === "daily" ? t("notify.clientReportsPage.dayLabel", { word: isToday ? t("notify.clientReportsPage.today") : t("notify.clientReportsPage.day"), d: `${x.since.slice(8)}/${x.since.slice(5, 7)}` }) : `${x.since.slice(8)}/${x.since.slice(5, 7)} – ${x.until.slice(8)}/${x.until.slice(5, 7)}`}
                        </span>
                        <Badge tone={st.tone}>{t(`notify.clientReportsPage.status.${st.key}`)}</Badge>
                      </div>
                      <div className="mt-0.5 text-xs text-slate-500">
                        {t("notify.clientReportsPage.built", {
                          kind: x.period === "daily" ? (isToday ? t("notify.clientReportsPage.untilBuilt") : t("notify.clientReportsPage.dailyReport")) : t("notify.clientReportsPage.periodDays", { n: x.period }),
                          time: dateTime(x.createdAt),
                          by: x.trigger === "schedule" ? t("notify.clientReportsPage.bySchedule") : x.createdBy,
                        })}
                        {x.views > 0 && t("notify.clientReportsPage.views", { n: x.views })}
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
            <div>{panel}</div>
          </div>
        )}
      </Card>

      <Card title={t("notify.clientReportsPage.schedCard")}>
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <p className="text-ink2">
            {schedules.length
              ? schedules.map((x) => t("notify.clientReportsPage.schedItem", { time: timeLabel(x), kind: kindLabel(x.kind, t), repeat: repeatLabel(x, t).toLowerCase(), auto: x.autoSend ? t("notify.clientReportsPage.autoSend") : "" })).join(" · ")
              : t("notify.clientReportsPage.noSched")}
            <span className="text-mut"> · {targets.length ? t("notify.clientReportsPage.targetsN", { n: targets.length }) : t("notify.clientReportsPage.noTargets")}</span>
          </p>
          <Link href={`/clients/${id}/notify/reports`} className="text-sm font-medium text-indigo-600 hover:underline">
            {t("notify.clientReportsPage.editLink")}
          </Link>
        </div>
      </Card>
    </div>
  );
}
