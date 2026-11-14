"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireClient } from "@/lib/access";
import { errorMessage, logActivity } from "@/lib/activity";
import { money } from "@/lib/format";
import { IDLE_HOURS, hoursLabel, modeText, parseHours, toAiMode } from "@/lib/schedule";
import { autoModes, cleanAutoTargets, toAutoMode } from "@/lib/auto-rules-config";
import type { AutomationState } from "@/lib/automation-plan";
import { getT } from "@/i18n/server";
import type { T } from "@/i18n/translate";

const num = (t: T, x: unknown, lo: number, hi: number, label: Parameters<T>[0]) => {
  const v = Number(x);
  if (!Number.isFinite(v) || v < lo || v > hi) throw new Error(t("settings.automationActions.range", { label: t(label), lo, hi }));
  return v;
};
const hours = (list: unknown) => parseHours((Array.isArray(list) ? list : []).join(","));

/** Settings → Schedule & automation: save the whole page at once (sync / Claude / optimization suggestion schedules, automation, thresholds). */
export async function saveAutomationAction(clientId: string, input: AutomationState): Promise<{ ok: true } | { ok: false; error: string }> {
  const t = await getT();
  try {
    await requireClient(clientId, "edit");
    const before = await db.client.findUniqueOrThrow({ where: { id: clientId } });
    const sync = hours(input.sync);
    const optimize = hours(input.optimize);
    const schedule = {
      syncMode: sync.length ? "hours" : "manual",
      ...(sync.length && { syncHours: sync.join(",") }),
      aiMode: toAiMode(input.aiMode),
      optimizeMode: optimize.length ? "hours" : "manual",
      ...(optimize.length && { optimizeHours: optimize.join(",") }),
    };
    const thresholds = {
      optWarnPct: Math.round(num(t, input.optWarnPct, 5, 200, "settings.automationActions.labels.optWarnPct")),
      optPausePct: Math.round(num(t, input.optPausePct, 10, 300, "settings.automationActions.labels.optPausePct")),
      optExpensiveMode: input.optExpensiveMode === "warn" ? "warn" : "suggest",
      optMinSpendX: num(t, input.optMinSpendX, 1, 10, "settings.automationActions.labels.optMinSpendX"),
      optConfidence: Math.round(num(t, input.optConfidence, 50, 99, "settings.automationActions.labels.optConfidence")),
      optFreqMax: num(t, input.optFreqMax, 1.5, 10, "settings.automationActions.labels.optFreqMax"),
      optBudgetStepPct: Math.round(num(t, input.optBudgetStepPct, 5, 100, "settings.automationActions.labels.optBudgetStepPct")),
      optMinAgeDays: Math.round(num(t, input.optMinAgeDays, 0, 14, "settings.automationActions.labels.optMinAgeDays")),
      optEarlyPct: Math.round(num(t, input.optEarlyPct, 20, 500, "settings.automationActions.labels.optEarlyPct")),
      optEarlySpendX: num(t, input.optEarlySpendX, 1, 10, "settings.automationActions.labels.optEarlySpendX"),
      optScaleGapHours: Math.round(num(t, input.optScaleGapHours, 6, 168, "settings.automationActions.labels.optScaleGapHours")),
      optScaleMinResults: Math.round(num(t, input.optScaleMinResults, 1, 100, "settings.automationActions.labels.optScaleMinResults")),
      optScaleConfidence: Math.round(num(t, input.optScaleConfidence, 50, 99, "settings.automationActions.labels.optScaleConfidence")),
      optScaleSpendPct: Math.round(num(t, input.optScaleSpendPct, 50, 100, "settings.automationActions.labels.optScaleSpendPct")),
      optScaleBeforeHour: Math.round(num(t, input.optScaleBeforeHour, 8, 23, "settings.automationActions.labels.optScaleBeforeHour")),
    };
    if (thresholds.optPausePct < thresholds.optWarnPct) throw new Error(t("settings.automationActions.pauseGteWarn"));
    const auto = {
      autoMode: toAutoMode(input.autoMode),
      autoPause: !!input.autoPause,
      autoScale: !!input.autoScale,
      autoNotify: !!input.autoNotify,
      autoNotifyTargets: JSON.stringify(cleanAutoTargets(input.autoNotifyTargets)),
      autoFromHour: Math.round(num(t, input.autoFromHour, 0, 23, "settings.automationActions.labels.autoFromHour")),
      autoToHour: Math.round(num(t, input.autoToHour, 0, 23, "settings.automationActions.labels.autoToHour")),
    };
    if (auto.autoFromHour > auto.autoToHour) throw new Error(t("settings.automationActions.fromBeforeTo"));
    if (auto.autoMode !== "off" && auto.autoScale && !before.maxDailyBudget)
      throw new Error(t("settings.automationActions.scaleNeedsCap"));

    await db.client.update({ where: { id: clientId }, data: { ...schedule, ...thresholds, ...auto } });
    // Leaving test-run mode: test-run cards become regular suggestions (the next optimization replaces them like any other card).
    if (auto.autoMode !== "dryrun") await db.recommendation.updateMany({ where: { clientId, status: "pending", auto: "dryrun" }, data: { auto: null } });

    // Log: only record what changed.
    const changed = (data: Record<string, unknown>) => Object.entries(data).some(([k, v]) => before[k as keyof typeof before] !== v);
    const lines: string[] = [];
    if (changed(schedule))
      lines.push(
        t("settings.automationActions.logSchedule", { sync: sync.length ? hoursLabel(sync) : t("settings.automationActions.manual"), ai: modeText(t, "aiModes", schedule.aiMode, "label", { hours: IDLE_HOURS }), optimize: optimize.length ? hoursLabel(optimize) : t("settings.automationActions.manual") }),
      );
    if (changed(auto))
      lines.push(
        `${t("settings.automationActions.logAutoPrefix")}: ${autoModes(t).find((m) => m.key === auto.autoMode)!.label}${auto.autoMode !== "off" ? ` (${[auto.autoPause && t("settings.automationActions.autoPause"), auto.autoScale && t("settings.automationActions.autoScale")].filter(Boolean).join(", ") || t("settings.automationActions.doNothing")}, ${auto.autoFromHour}h–${auto.autoToHour}h${before.maxDailyBudget ? `, ${t("settings.automationActions.cap", { amount: money(before.maxDailyBudget, before.currency) })}` : ""})` : ""}`,
      );
    if (changed(thresholds))
      lines.push(
        t("settings.automationActions.logThresholds", { ...thresholds, mode: thresholds.optExpensiveMode === "warn" ? t("settings.automationActions.warnOnly") : t("settings.automationActions.suggestPause") }),
      );
    if (lines.length) await logActivity(clientId, "sync", lines.join(" | "));
    revalidatePath(`/clients/${clientId}`, "layout");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
