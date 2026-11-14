import type { ReportSchedule as Row } from "@prisma/client";
import type { Channel } from "./client-report-vars";
import type { SendTargets } from "./client-report";
import { translator, type T } from "@/i18n/translate";
import { weekdays } from "./client-report-vars";

const VI = translator("vi");

/**
 * Report schedules for clients (ReportSchedule table): multiple per client, each with 1 report type, hour:minute, recurrence,
 * its own recipients and delivery method. The runner (DB reads, build + send) is in report-schedule-run.ts; this file also works in the browser.
 */

/** Buildable report types (createDailyReport / createClientReport). */
export const REPORT_KINDS = [{ key: "daily" }, { key: "today" }, { key: "7" }, { key: "14" }, { key: "30" }] as const;
export type ReportKind = (typeof REPORT_KINDS)[number]["key"];
export const toKind = (v: unknown): ReportKind => (REPORT_KINDS.some((k) => k.key === v) ? (v as ReportKind) : "daily");

export const REPEATS = [{ key: "daily" }, { key: "weekly" }, { key: "monthly" }] as const;
export type Repeat = (typeof REPEATS)[number]["key"];
const toRepeat = (v: unknown): Repeat => (REPEATS.some((r) => r.key === v) ? (v as Repeat) : "daily");

/** One schedule, as sent to the browser / received from the form. targets null = all current recipients. */
export type ScheduleInput = {
  kind: ReportKind;
  repeat: Repeat;
  days: number[];
  hour: number;
  minute: number;
  autoSend: boolean;
  targets: SendTargets | null;
  active: boolean;
};
export type ScheduleView = ScheduleInput & { id: string; lastRunAt: string | null; lastResult: string | null };

export const MAX_SCHEDULES = 10;

export const kindLabel = (k: string, t: T = VI) => (REPORT_KINDS.some((x) => x.key === k) ? t(`notify.report.kinds.k${k as ReportKind}.label`) : k);
export const kindDesc = (k: string, t: T = VI) => (REPORT_KINDS.some((x) => x.key === k) ? t(`notify.report.kinds.k${k as ReportKind}.desc`) : "");
export const repeatName = (k: Repeat, t: T = VI) => t(`notify.report.repeats.${k}`);
export const timeLabel = (s: Pick<ScheduleInput, "hour" | "minute">) => `${String(s.hour).padStart(2, "0")}:${String(s.minute).padStart(2, "0")}`;

export function repeatLabel(s: Pick<ScheduleInput, "repeat" | "days">, t: T = VI) {
  if (s.repeat === "daily") return t("notify.report.repeats.daily");
  if (!s.days.length) return t("notify.report.noDays");
  if (s.repeat === "weekly") return s.days.length === 7 ? t("notify.report.repeats.daily") : t("notify.report.weeklyOn", { days: s.days.map((d) => weekdays(t)[d - 1] ?? "?").join(", ") });
  return t("notify.report.monthlyOn", { days: s.days.join(", ") });
}

function parseTargets(raw: string): SendTargets | null {
  if (!raw) return null;
  try {
    const t = JSON.parse(raw) as Record<string, unknown>;
    const out: SendTargets = {};
    for (const ch of ["email", "telegram", "zalobot", "zalo"] as Channel[]) if (Array.isArray(t[ch])) out[ch] = (t[ch] as unknown[]).map(String);
    return out;
  } catch {
    return null;
  }
}

function parseDays(raw: string): number[] {
  try {
    const d = JSON.parse(raw);
    return Array.isArray(d) ? d.map(Number).filter((n) => Number.isInteger(n)) : [];
  } catch {
    return [];
  }
}

export function toView(r: Row): ScheduleView {
  return {
    id: r.id,
    kind: toKind(r.kind),
    repeat: toRepeat(r.repeat),
    days: parseDays(r.days),
    hour: r.hour,
    minute: r.minute,
    autoSend: r.autoSend,
    targets: parseTargets(r.targets),
    active: r.active,
    lastRunAt: r.lastRunAt?.toISOString() ?? null,
    lastResult: r.lastResult,
  };
}

/** Validate + normalize form data. Throws readable errors. */
export function cleanInput(v: ScheduleInput, t: T = VI): ScheduleInput {
  const repeat = toRepeat(v.repeat);
  const max = repeat === "weekly" ? 7 : 28;
  const days = repeat === "daily" ? [] : [...new Set(v.days.map(Math.round))].filter((d) => d >= 1 && d <= max).sort((a, b) => a - b);
  if (repeat !== "daily" && !days.length) throw new Error(repeat === "weekly" ? t("notify.report.pickWeekday") : t("notify.report.pickMonthDay"));
  const hour = Math.round(v.hour);
  const minute = Math.round(v.minute);
  if (!(hour >= 0 && hour <= 23) || !(minute >= 0 && minute <= 59)) throw new Error(t("notify.report.badTime"));
  return { kind: toKind(v.kind), repeat, days, hour, minute, autoSend: !!v.autoSend, targets: v.targets, active: v.active !== false };
}

/** Local time in the client's timezone: date (YYYY-MM-DD), minute of day, weekday (1 = Monday … 7 = Sunday), day of month. */
export function localClock(tz: string, at = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  const wd = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(p.weekday) + 1;
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute), weekday: wd, monthDay: Number(p.day) };
}

/** Max delay (minutes) for still running a missed slot, e.g. the background job just restarted. Beyond that, skip that day's run. */
const LATE_MIN = 60;

/** Whether this schedule is due at `at` (each schedule at most once / day). */
export function isScheduleDue(s: Pick<Row, "active" | "repeat" | "days" | "hour" | "minute" | "lastRunAt" | "updatedAt">, tz: string, at = new Date()) {
  if (!s.active) return false;
  const now = localClock(tz, at);
  const repeat = toRepeat(s.repeat);
  if (repeat === "weekly" && !parseDays(s.days).includes(now.weekday)) return false;
  if (repeat === "monthly" && !parseDays(s.days).includes(now.monthDay)) return false;
  const slot = s.hour * 60 + s.minute;
  const late = now.minutes - slot;
  if (late < 0 || late > LATE_MIN) return false;
  if (s.lastRunAt && localClock(tz, s.lastRunAt).date === now.date) return false;
  // Just created / edited after today's send time → start from the next slot, don't send unexpectedly on save.
  const edited = localClock(tz, s.updatedAt);
  return !(edited.date === now.date && edited.minutes > slot);
}

/** Next run (local time, for display on the web), searching the next 35 days. */
export function nextRunLabel(s: Pick<ScheduleInput, "active" | "repeat" | "days" | "hour" | "minute">, tz: string, at = new Date(), t: T = VI) {
  if (!s.active) return null;
  const now = localClock(tz, at);
  const slot = s.hour * 60 + s.minute;
  for (let i = 0; i < 35; i++) {
    const d = localClock(tz, new Date(at.getTime() + i * 86400_000));
    if (i === 0 && now.minutes >= slot) continue;
    if (s.repeat === "weekly" && !s.days.includes(d.weekday)) continue;
    if (s.repeat === "monthly" && !s.days.includes(d.monthDay)) continue;
    const when = i === 0 ? t("notify.report.todayWord") : i === 1 ? t("notify.report.tomorrow") : `${weekdays(t)[d.weekday - 1]} ${d.date.slice(8, 10)}/${d.date.slice(5, 7)}`;
    return `${when} ${timeLabel(s)}`;
  }
  return null;
}
