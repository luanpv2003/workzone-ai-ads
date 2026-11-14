import { connection } from "next/server";
import { db } from "@/lib/db";
import { requirePageClient } from "@/lib/access";
import { AutomationPanel, type AutomationEvent } from "@/components/automation/automation-panel";
import { parseAutoTargets, toAutoMode } from "@/lib/auto-rules-config";
import { optimizeHourList, syncHours, toAiMode } from "@/lib/schedule";
import { loadSchedules } from "@/lib/report-schedule-run";
import { kindLabel, localClock } from "@/lib/report-schedule";
import { parseLeadNotify } from "@/lib/lead-notify-config";
import type { AutomationState, PlanContext } from "@/lib/automation-plan";
import { zaloBotStatus } from "@/lib/zalo-bot";
import { telegramStatus } from "@/lib/report-channels";
import { money } from "@/lib/format";
import { getT } from "@/i18n/server";

// Client settings → Schedule & automation: quick mode, schedule fix suggestions, one-day timeline, sync & Claude, campaign optimization (suggestions + auto-apply + thresholds).

async function botNames() {
  const [zalo, tg] = await Promise.all([zaloBotStatus().catch(() => null), telegramStatus().catch(() => null)]);
  return { zalo: zalo?.name ?? null, telegram: tg?.username ?? null };
}

export default async function AutomationPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const t = await getT();
  const { id } = await params;
  await requirePageClient(id); // check access right on the page: the layout may not re-run on client-side navigation
  const c = await db.client.findUniqueOrThrow({ where: { id } });
  const [activeCampaigns, schedules, nurtureActive, bots] = await Promise.all([
    db.campaign.count({ where: { clientId: id, status: "ACTIVE" } }),
    loadSchedules(id),
    db.nurtureFlow.count({ where: { clientId: id, status: "active" } }),
    botNames(),
  ]);

  const today = localClock(c.timezone);
  const reportsToday = schedules
    .filter((s) => s.active && (s.repeat === "daily" || s.days.includes(s.repeat === "weekly" ? today.weekday : today.monthDay)))
    .map((s) => ({ label: kindLabel(s.kind), hour: s.hour, minute: s.minute, autoSend: s.autoSend }));
  const ctx: PlanContext = {
    connected: c.dataSource === "meta",
    activeCampaigns,
    budgetCap: c.maxDailyBudget ? `${money(c.maxDailyBudget, c.currency)}${t("settings.automationPage.perDay")}` : null,
    reportsToday,
  };

  const initial: AutomationState = {
    sync: syncHours(c),
    aiMode: toAiMode(c.aiMode),
    optimize: optimizeHourList(c),
    autoMode: toAutoMode(c.autoMode),
    autoPause: c.autoPause,
    autoScale: c.autoScale,
    autoFromHour: c.autoFromHour,
    autoToHour: c.autoToHour,
    autoNotify: c.autoNotify,
    autoNotifyTargets: parseAutoTargets(c.autoNotifyTargets),
    optWarnPct: c.optWarnPct,
    optPausePct: c.optPausePct,
    optExpensiveMode: c.optExpensiveMode,
    optMinSpendX: c.optMinSpendX,
    optConfidence: c.optConfidence,
    optFreqMax: c.optFreqMax,
    optBudgetStepPct: c.optBudgetStepPct,
    optMinAgeDays: c.optMinAgeDays,
    optEarlyPct: c.optEarlyPct,
    optEarlySpendX: c.optEarlySpendX,
    optScaleGapHours: c.optScaleGapHours,
    optScaleMinResults: c.optScaleMinResults,
    optScaleConfidence: c.optScaleConfidence,
    optScaleSpendPct: c.optScaleSpendPct,
    optScaleBeforeHour: c.optScaleBeforeHour,
  };

  const when = (d: Date | null) => (d ? d.toLocaleString("vi-VN", { timeZone: c.timezone, hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }) : null);
  const base = `/clients/${id}`;
  const lead = parseLeadNotify(c.leadNotify);
  const activeReports = schedules.filter((s) => s.active).length;
  const events: AutomationEvent[] = [
    { label: t("settings.automationPage.leadNotify"), status: lead.on ? t("settings.automationPage.leadOn") : t("settings.automationPage.off"), on: lead.on, href: `${base}/lead-notify` },
    { label: t("settings.automationPage.nurture"), status: nurtureActive ? t("settings.automationPage.nurtureRunning", { count: nurtureActive }) : t("settings.automationPage.off"), on: nurtureActive > 0, href: `${base}/nurture` },
    { label: t("settings.automationPage.reportSchedule"), status: activeReports ? t("settings.automationPage.schedules", { count: activeReports }) : t("settings.automationPage.none"), on: activeReports > 0, href: `${base}/notify/reports` },
  ];

  return (
    <AutomationPanel
      clientId={id}
      initial={initial}
      ctx={ctx}
      timezone={c.timezone}
      maxBudgetChangePct={c.maxBudgetChangePct}
      bots={bots}
      last={{ sync: when(c.lastAutoSyncAt), ai: when(c.lastAutoAiAt), optimize: when(c.lastOptimizeAt), auto: when(c.lastAutoRunAt) }}
      events={events}
    />
  );
}
