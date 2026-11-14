// Per-client update schedule. scripts/daily.ts runs hourly and uses these functions to tell which clients are due.
// Shared by server + browser (no DB access).
import { DEFAULT_LOCALE } from "@/i18n/config";
import { translator, type MessageKey, type T } from "@/i18n/translate";

type Group = "aiModes" | "presets";
/** Label / hint of a mode in the UI language: call with the translator from getT() / useT(). */
export const modeText = (t: T, group: Group, key: string, part: "label" | "hint", vars?: Record<string, string | number>) => t(`settings.schedule.${group}.${key}.${part}` as MessageKey, vars);
// Default-language (Vietnamese) text stored on the constants below, for callers without a translator. Prefer modeText().
const L = (group: Group, key: string, part: "label" | "hint", vars?: Record<string, string | number>) => modeText(translator(DEFAULT_LOCALE), group, key, part, vars);

/** "idle" mode: conversations silent (neither customer nor page messaging) for this many hours are read by Claude right away, without waiting for the daily slot. */
export const IDLE_HOURS = 3;
export const AI_MODES = [
  {
    key: "idle",
    label: L("aiModes", "idle", "label", { hours: IDLE_HOURS }),
    hint: L("aiModes", "idle", "hint", { hours: IDLE_HOURS }),
  },
  { key: "daily", label: L("aiModes", "daily", "label"), hint: L("aiModes", "daily", "hint") },
  { key: "on_change", label: L("aiModes", "on_change", "label"), hint: L("aiModes", "on_change", "hint") },
  { key: "manual", label: L("aiModes", "manual", "label"), hint: L("aiModes", "manual", "hint") },
] as const;
/** "8,20" → [8, 20] (valid hours 0-23). */
export function parseHours(v: string) {
  return [...new Set(v.split(",").map((x) => Number(x.trim())).filter((h) => Number.isInteger(h) && h >= 0 && h <= 23))].sort((a, b) => a - b);
}
/** "6h, 12h, 18h". */
export const hoursLabel = (hours: number[]) => hours.map((h) => `${h}h`).join(", ");

/** Hours for automatic campaign checks ("manual": none). */
export function optimizeHourList(c: { optimizeMode: string; optimizeHours: string }) {
  return c.optimizeMode === "hours" ? parseHours(c.optimizeHours) : [];
}

/** Due for an automatic campaign check (hour in the schedule, not yet run this hour). */
export function isOptimizeDue(c: { optimizeMode: string; optimizeHours: string; timezone: string; lastOptimizeAt: Date | null }, at = new Date()) {
  const now = localTime(c.timezone, at);
  if (!optimizeHourList(c).includes(now.hour)) return false;
  if (!c.lastOptimizeAt) return true;
  const last = localTime(c.timezone, c.lastOptimizeAt);
  return !(last.date === now.date && last.hour === now.hour);
}

export type AiMode = (typeof AI_MODES)[number]["key"];

export function toAiMode(v: unknown): AiMode {
  return AI_MODES.some((m) => m.key === v) ? (v as AiMode) : "daily";
}

/** Hour and date in the client's timezone (the server may run in any timezone). */
export function localTime(tz: string, at = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return { hour: Number(parts.hour), date: `${parts.year}-${parts.month}-${parts.day}` };
}

type Sched = { syncMode: string; syncHours: string; timezone: string; lastAutoSyncAt: Date | null };

/** Hours of the day (local time) to auto-sync ("manual": none). */
export function syncHours(c: Pick<Sched, "syncMode" | "syncHours">): number[] {
  return c.syncMode === "hours" ? parseHours(c.syncHours) : [];
}

/** Due for sync: hour is in the schedule and hasn't run this hour (cron reruns don't duplicate). */
export function isSyncDue(c: Sched, at = new Date()) {
  const now = localTime(c.timezone, at);
  if (!syncHours(c).includes(now.hour)) return false;
  if (!c.lastAutoSyncAt) return true;
  const last = localTime(c.timezone, c.lastAutoSyncAt);
  return !(last.date === now.date && last.hour === now.hour);
}

/** "daily" / "idle": Claude summarizes (message analysis, then persona + audit) on the first sync from this hour on,
 *  so results are ready before the morning report / optimization. Previously it was the day's first run: with 24/7 syncing that landed at midnight. */
const AI_SUMMARY_HOUR = 6;

/** Hour Claude summarizes during the day (first sync from AI_SUMMARY_HOUR; otherwise the day's first sync). */
export function aiStartHour(c: Pick<Sched, "syncMode" | "syncHours">) {
  const hours = syncHours(c);
  return hours.find((h) => h >= AI_SUMMARY_HOUR) ?? hours[0] ?? AI_SUMMARY_HOUR;
}

/** Whether Claude may run on this pass (still only runs steps with new data, see lib/freshness.ts).
 *  "idle": the summary part runs like "daily"; reading silent conversations runs hourly separately (scripts/daily.ts). */
export function isAiAllowed(c: Pick<Sched, "syncMode" | "syncHours" | "timezone"> & { aiMode: string; lastAutoAiAt: Date | null }, at = new Date()) {
  const mode = toAiMode(c.aiMode);
  if (mode === "manual") return false;
  if (mode === "on_change") return true;
  const now = localTime(c.timezone, at);
  if (c.lastAutoAiAt && localTime(c.timezone, c.lastAutoAiAt).date === now.date) return false;
  return now.hour >= aiStartHour(c);
}

/** The scheduler (scripts/daily.ts) runs at minute :05 every hour. */
export const CRON_MINUTE = 5;

/** Next automatic run time from a list of local hours (null if there are none). */
export function nextRunAt(hours: number[], tz: string, at = new Date()): Date | null {
  if (!hours.length) return null;
  const start = new Date(at);
  start.setMinutes(CRON_MINUTE, 0, 0);
  for (let k = 0; k <= 48; k++) {
    const t = new Date(start.getTime() + k * 3600_000);
    if (t.getTime() <= at.getTime()) continue;
    if (hours.includes(localTime(tz, t).hour)) return t;
  }
  return null;
}

/** Next auto-sync. */
export function nextSyncAt(c: Pick<Sched, "syncMode" | "syncHours" | "timezone">, at = new Date()) {
  return nextRunAt(syncHours(c), c.timezone, at);
}

/** Next automatic optimization check (null when manual). */
export function nextOptimizeAt(c: { optimizeMode: string; optimizeHours: string; timezone: string }, at = new Date()) {
  return nextRunAt(optimizeHourList(c), c.timezone, at);
}

/** Next time Claude may auto-analyze messages: first sync from AI_SUMMARY_HOUR (daily) or every sync (on_change). */
export function nextAiAt(c: Pick<Sched, "syncMode" | "syncHours" | "timezone"> & { aiMode: string; lastAutoAiAt: Date | null }, at = new Date()) {
  const mode = toAiMode(c.aiMode);
  if (mode === "manual") return null;
  let t = nextSyncAt(c, at);
  for (let i = 0; t && i < 30; i++) {
    if (isAiAllowed(c, t)) return t;
    t = nextSyncAt(c, t);
  }
  return null;
}

/**
 * Quick-pick modes on the Schedule & automation page: changes sync, Claude and the optimization recommendation schedule at once.
 * Doesn't enable automation (auto-changes on Meta) — only "Paused" turns it off. Ad metrics + messages already refresh themselves
 * every 15 / 2 minutes (background job), so full syncs needn't be frequent.
 */
export const PRESETS = [
  { key: "save", label: L("presets", "save", "label"), hint: L("presets", "save", "hint"), sync: [7], aiMode: "daily", optimize: [8] },
  { key: "balanced", label: L("presets", "balanced", "label"), hint: L("presets", "balanced", "hint"), sync: [6, 12, 18], aiMode: "idle", optimize: [8, 20] },
  { key: "close", label: L("presets", "close", "label"), hint: L("presets", "close", "hint"), sync: [6, 9, 12, 15, 18, 21], aiMode: "idle", optimize: [8, 14, 20] },
  { key: "pause", label: L("presets", "pause", "label"), hint: L("presets", "pause", "hint"), sync: [], aiMode: "manual", optimize: [] },
] as const;
export type PresetKey = (typeof PRESETS)[number]["key"];
export const DEFAULT_PRESET = PRESETS[1];

/** Currently matching mode (null = custom). "Paused" also requires automation to be off. */
export function matchPreset(v: { sync: number[]; aiMode: string; optimize: number[]; autoMode: string }): PresetKey | null {
  const same = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  const p = PRESETS.find((p) => same(p.sync, v.sync) && p.aiMode === v.aiMode && same(p.optimize, v.optimize));
  return p && (p.key !== "pause" || v.autoMode === "off") ? p.key : null;
}
