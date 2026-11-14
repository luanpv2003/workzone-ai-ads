// A client's Schedule & automation page: form state, suggested fixes for unreasonable schedules, a one-day timeline.
// Shared by server + browser (no DB access): the UI recomputes immediately when the user changes options, before saving.

import type { AutoSettings } from "./auto-rules-config";
import type { T } from "@/i18n/translate";
import { CRON_MINUTE, DEFAULT_PRESET, IDLE_HOURS, aiStartHour, hoursLabel, type AiMode } from "./schedule";

export type Thresholds = {
  optWarnPct: number;
  optPausePct: number;
  optExpensiveMode: string;
  optMinSpendX: number;
  optConfidence: number;
  optFreqMax: number;
  optBudgetStepPct: number;
};
export const DEFAULT_THRESHOLDS: Thresholds = { optWarnPct: 20, optPausePct: 40, optExpensiveMode: "suggest", optMinSpendX: 2, optConfidence: 90, optFreqMax: 3, optBudgetStepPct: 25 };

/** Whole page: full sync hours ([] = manual only), Claude mode, optimization proposal hours ([] = off), automation + thresholds. */
export type AutomationState = { sync: number[]; aiMode: AiMode; optimize: number[] } & AutoSettings & Thresholds;

export type ReportSlot = { label: string; hour: number; minute: number; autoSend: boolean };
export type PlanContext = {
  connected: boolean;
  activeCampaigns: number;
  budgetCap: string | null;
  /** Report schedules running today (Notifications & reports → Report schedule). */
  reportsToday: ReportSlot[];
};

type Advice = { tone: "warn" | "info"; text: string; fix?: { label: string; patch: Partial<AutomationState> } };

/** Full syncs more frequent than this overlap with the automatic refresh (metrics every 15 minutes, messages every 2 minutes). */
const MAX_USEFUL_SYNCS = 8;

const syncState = (v: Pick<AutomationState, "sync">) => ({ syncMode: v.sync.length ? "hours" : "manual", syncHours: v.sync.join(",") });
/** Hours Claude aggregates (daily / idle) under the selected sync schedule. */
export const summaryHour = (v: Pick<AutomationState, "sync">) => aiStartHour(syncState(v));

/** Unreasonable / overlapping schedule spots, with one-tap fixes. */
export function adviceFor(v: AutomationState, ctx: PlanContext, t: T): Advice[] {
  const out: Advice[] = [];
  const auto = v.autoMode !== "off";
  if (!ctx.connected) out.push({ tone: "info", text: t("workflow.plan.advice.notConnected") });
  if (v.sync.length > MAX_USEFUL_SYNCS)
    out.push({
      tone: "warn",
      text: t("workflow.plan.advice.tooManySyncs", { count: v.sync.length }),
      fix: { label: t("workflow.plan.advice.switchTo", { hours: hoursLabel([...DEFAULT_PRESET.sync]) }), patch: { sync: [...DEFAULT_PRESET.sync] } },
    });
  if (!v.sync.length && (v.aiMode === "daily" || v.aiMode === "on_change"))
    out.push({ tone: "warn", text: t("workflow.plan.advice.syncOff"), fix: { label: t("workflow.plan.advice.enableSync"), patch: { sync: [...DEFAULT_PRESET.sync] } } });
  if (v.aiMode === "on_change" && v.sync.length > 3)
    out.push({ tone: "warn", text: t("workflow.plan.advice.claudeEverySync", { count: v.sync.length }), fix: { label: t("workflow.plan.advice.readWhenIdle", { hours: IDLE_HOURS }), patch: { aiMode: "idle" } } });
  if (v.aiMode === "daily" && v.sync.length)
    out.push({
      tone: "info",
      text: t("workflow.plan.advice.dailyRead", { hour: summaryHour(v) }),
      fix: { label: t("workflow.plan.advice.readWhenIdle", { hours: IDLE_HOURS }), patch: { aiMode: "idle" } },
    });
  if (ctx.activeCampaigns && !v.optimize.length && !auto)
    out.push({ tone: "warn", text: t("workflow.plan.advice.noCheckSchedule", { count: ctx.activeCampaigns }), fix: { label: t("workflow.plan.advice.suggestAt"), patch: { optimize: [8, 20] } } });
  if (auto && !v.optimize.length)
    out.push({
      tone: "info",
      text: t("workflow.plan.advice.autoLimited"),
      fix: { label: t("workflow.plan.advice.suggestAt"), patch: { optimize: [8, 20] } },
    });
  if (auto && v.autoScale && !ctx.budgetCap)
    out.push({ tone: "warn", text: t("workflow.plan.advice.needBudgetCap"), fix: { label: t("workflow.plan.advice.dropAutoScale"), patch: { autoScale: false } } });
  if (auto && v.autoFromHour > v.autoToHour) out.push({ tone: "warn", text: t("workflow.plan.advice.badWindow") });
  if (auto && v.autoNotify && !v.autoNotifyTargets.length) out.push({ tone: "info", text: t("workflow.plan.advice.noRecipients") });
  return out;
}

export type LaneColor = "slate" | "sky" | "violet" | "emerald" | "orange";
/** at / from / to: hour of day as a real number (8.08 = 8:05). */
export type Lane = { key: string; label: string; note: string; color: LaneColor; dots: { at: number; title: string }[]; bands: { from: number; to: number; title: string }[] };

const at = (h: number, m = CRON_MINUTE) => h + m / 60;
const hm = (x: number) => `${Math.floor(x)}:${String(Math.round((x % 1) * 60)).padStart(2, "0")}`;

/** A day of the client: one row per automatic task, dot = runs once, bar = runs continuously / hourly within the window. */
export function dayLanes(v: AutomationState, ctx: PlanContext, t: T): Lane[] {
  const on = v.sync.length > 0;
  const start = summaryHour(v);
  const syncDots = v.sync.map((h) => ({ at: at(h), title: t("workflow.plan.lanes.syncAt", { time: hm(at(h)) }) }));
  const all = { from: 0, to: 24 };
  const ai: Pick<Lane, "note" | "dots" | "bands"> =
    v.aiMode === "manual"
      ? { note: t("workflow.plan.lanes.manualOnly"), dots: [], bands: [] }
      : v.aiMode === "idle"
        ? { note: t("workflow.plan.lanes.idleNote", { hours: IDLE_HOURS }), dots: [], bands: [{ ...all, title: t("workflow.plan.lanes.idleTitle", { hours: IDLE_HOURS }) }] }
        : v.aiMode === "on_change"
          ? { note: t("workflow.plan.lanes.afterSync"), dots: syncDots.map((d) => ({ ...d, title: t("workflow.plan.lanes.claudeReads", { time: hm(d.at) }) })), bands: [] }
          : { note: on ? t("workflow.plan.lanes.dailyNote", { hour: start }) : t("workflow.plan.lanes.noRunSyncOff"), dots: on ? [{ at: at(start), title: t("workflow.plan.lanes.claudeReads", { time: `${start}:05` }) }] : [], bands: [] };
  const summary = v.aiMode === "manual" || !on ? [] : v.aiMode === "on_change" ? v.sync : [start];
  return [
    {
      key: "quick",
      label: t("workflow.plan.lanes.quickLabel"),
      note: on ? t("workflow.plan.lanes.quickNote") : t("workflow.plan.lanes.quickOff"),
      color: "slate",
      dots: [],
      bands: on ? [{ ...all, title: t("workflow.plan.lanes.quickTitle") }] : [],
    },
    { key: "sync", label: t("workflow.plan.lanes.syncLabel"), note: !on ? t("workflow.plan.lanes.manualOnly") : v.sync.length > 6 ? t("workflow.plan.lanes.perDay", { count: v.sync.length }) : hoursLabel(v.sync), color: "sky", dots: syncDots, bands: [] },
    { key: "ai", label: t("workflow.plan.lanes.aiLabel"), color: "violet", ...ai },
    {
      key: "summary",
      label: t("workflow.plan.lanes.summaryLabel"),
      note: summary.length ? t("workflow.plan.lanes.summaryNote") : t("workflow.plan.lanes.noAutoRun"),
      color: "violet",
      dots: summary.map((h) => ({ at: at(h) + 0.5, title: t("workflow.plan.lanes.summaryTitle", { hour: h }) })),
      bands: [],
    },
    {
      key: "optimize",
      label: t("workflow.plan.lanes.optimizeLabel"),
      note: v.optimize.length ? t("workflow.plan.lanes.optimizeNote", { hours: hoursLabel(v.optimize) }) : t("workflow.plan.lanes.manualOnly"),
      color: "emerald",
      dots: v.optimize.map((h) => ({ at: at(h), title: t("workflow.plan.lanes.optimizeTitle", { hour: h }) })),
      bands: [],
    },
    {
      key: "auto",
      label: t("workflow.plan.lanes.autoLabel"),
      note: v.autoMode === "off" ? t("workflow.plan.lanes.off") : t("workflow.plan.lanes.autoNote", { from: v.autoFromHour, to: v.autoToHour }) + (v.autoMode === "dryrun" ? t("workflow.plan.lanes.dryRunSuffix") : ""),
      color: "emerald",
      dots: [],
      bands: v.autoMode === "off" ? [] : [{ from: v.autoFromHour, to: v.autoToHour + 1, title: v.autoMode === "dryrun" ? t("workflow.plan.lanes.dryRunTitle") : t("workflow.plan.lanes.autoTitle") }],
    },
    {
      key: "report",
      label: t("workflow.plan.lanes.reportLabel"),
      note: ctx.reportsToday.length ? ctx.reportsToday.map((r) => `${hm(at(r.hour, r.minute))}${r.autoSend ? t("workflow.plan.lanes.autoSendShort") : t("workflow.plan.lanes.awaitShort")}`).join(", ") : t("workflow.plan.lanes.noneToday"),
      color: "orange",
      dots: ctx.reportsToday.map((r) => ({ at: at(r.hour, r.minute), title: `${r.label} ${hm(at(r.hour, r.minute))}${r.autoSend ? t("workflow.plan.lanes.autoSendLong") : t("workflow.plan.lanes.awaitLong")}` })),
      bands: [],
    },
  ];
}

/** Next one-time task today (after `now`, real time). */
export function nextToday(lanes: Lane[], now: number) {
  return lanes
    .flatMap((l) => l.dots.map((d) => ({ ...d, lane: l.label })))
    .filter((d) => d.at > now)
    .sort((a, b) => a.at - b.at)[0];
}

export { hm as clockLabel };
