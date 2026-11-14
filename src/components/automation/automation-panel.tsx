"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { CircleCheck, Eye, Info, Leaf, Pause, Scale, TriangleAlert } from "lucide-react";
import { saveAutomationAction } from "@/app/schedule-actions";
import { runAutoNowAction } from "@/app/auto-actions";
import { AI_MODES, IDLE_HOURS, PRESETS, matchPreset, type PresetKey } from "@/lib/schedule";
import { DEFAULT_AUTO, type AutoMode } from "@/lib/auto-rules-config";
import { DEFAULT_THRESHOLDS, adviceFor, clockLabel, dayLanes, nextToday, summaryHour, type AutomationState, type PlanContext } from "@/lib/automation-plan";
import { btnClass, inputClass } from "@/components/ui";
import { useT } from "@/i18n/client";
import { HourPicker } from "./hour-picker";
import { DayTimeline } from "./day-timeline";
import { AutoNotifyTargets } from "./auto-notify-targets";

const PRESET_ICON: Record<PresetKey, typeof Leaf> = { save: Leaf, balanced: Scale, close: Eye, pause: Pause };
const LEVEL_KEYS: AutoMode[] = ["off", "dryrun", "on"];
const SYNC_QUICK_HOURS: { key: string; hours: number[] }[] = [
  { key: "off", hours: [] },
  { key: "once", hours: [7] },
  { key: "thrice", hours: [6, 12, 18] },
  { key: "every3h", hours: [6, 9, 12, 15, 18, 21] },
];
const OPT_QUICK_HOURS: { label: string; hours: number[] }[] = [
  { label: "", hours: [] },
  { label: "8h", hours: [8] },
  { label: "8h·20h", hours: [8, 20] },
  { label: "8h·14h·20h", hours: [8, 14, 20] },
];

export type AutomationEvent = { label: string; status: string; on: boolean; href: string };

/** Client settings → Schedule & automation: one form for the whole page, previews the timeline + suggestions instantly on change, saves once. */
export function AutomationPanel({
  clientId,
  initial,
  ctx,
  timezone,
  maxBudgetChangePct,
  bots,
  last,
  events,
}: {
  clientId: string;
  initial: AutomationState;
  ctx: PlanContext;
  timezone: string;
  maxBudgetChangePct: number;
  bots: { zalo: string | null; telegram: string | null };
  last: { sync: string | null; ai: string | null; optimize: string | null; auto: string | null };
  events: AutomationEvent[];
}) {
  const t = useT();
  const LEVELS = LEVEL_KEYS.map((key) => ({ key, label: t(`workflow.automation.levels.${key}.label`), hint: t(`workflow.automation.levels.${key}.hint`) }));
  const SYNC_QUICK = SYNC_QUICK_HOURS.map((q) => ({ label: t(`workflow.automation.syncQuick.${q.key}` as "workflow.automation.syncQuick.off"), hours: q.hours }));
  const OPT_QUICK = OPT_QUICK_HOURS.map((q) => ({ label: q.label || t("workflow.automation.off"), hours: q.hours }));
  const [saved, setSaved] = useState(initial);
  const [v, setV] = useState(initial);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const [now, setNow] = useState<number | null>(null);
  const set = (patch: Partial<AutomationState>) => {
    setV((x) => ({ ...x, ...patch }));
    setMsg(null);
  };

  // Current time in the client's timezone (computed in the browser, updated every minute).
  useEffect(() => {
    const tick = () => {
      const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map((x) => [x.type, x.value]));
      setNow(Number(p.hour) + Number(p.minute) / 60);
    };
    tick();
    const timer = setInterval(tick, 60_000);
    return () => clearInterval(timer);
  }, [timezone]);

  const dirty = JSON.stringify(v) !== JSON.stringify(saved);
  const preset = matchPreset(v);
  const lanes = useMemo(() => dayLanes(v, ctx, t), [v, ctx, t]);
  const advice = useMemo(() => adviceFor(v, ctx, t), [v, ctx, t]);
  const next = now != null ? nextToday(lanes, now) : undefined;
  const auto = v.autoMode !== "off";

  const save = () =>
    start(async () => {
      const r = await saveAutomationAction(clientId, v);
      if (r.ok) {
        setSaved(v);
        setTimeout(() => setMsg((m) => (m?.ok ? null : m)), 4000);
      }
      setMsg(r.ok ? { ok: true, text: t("workflow.automation.saved") } : { ok: false, text: r.error });
    });

  const num = (k: keyof AutomationState, label: string, hint: string, unit: string, step = 1) => (
    <label className="block">
      <span className="text-sm font-medium text-ink2">{label}</span>
      <span className="mt-1 flex items-center gap-2">
        <input type="number" step={step} className={`${inputClass} !w-24`} value={v[k] as number} onChange={(e) => set({ [k]: Number(e.target.value) })} />
        <span className="text-sm whitespace-nowrap text-mut">{unit}</span>
      </span>
      {hint && <span className="mt-0.5 block text-xs text-mut">{hint}</span>}
    </label>
  );
  const check = (k: "autoPause" | "autoScale" | "autoNotify", label: string, hint: string) => (
    <label className="flex cursor-pointer gap-2">
      <input type="checkbox" className="mt-0.5 accent-indigo-600" checked={v[k]} onChange={(e) => set({ [k]: e.target.checked })} />
      <span>
        <span className="block font-medium text-ink">{label}</span>
        <span className="block text-xs text-mut">{hint}</span>
      </span>
    </label>
  );
  const hourSelect = (k: "autoFromHour" | "autoToHour") => (
    <select className={`${inputClass} !w-20`} value={v[k]} onChange={(e) => set({ [k]: Number(e.target.value) })}>
      {Array.from({ length: 24 }, (_, h) => (
        <option key={h} value={h}>
          {h}h
        </option>
      ))}
    </select>
  );
  const section = (title: string, sub: string | null, children: React.ReactNode, aside?: React.ReactNode) => (
    <section className="rounded-xl border border-line bg-panel">
      <header className="flex flex-wrap items-start justify-between gap-2 border-b border-line px-5 py-3">
        <div>
          <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
          {sub && <p className="mt-0.5 text-xs text-mut">{sub}</p>}
        </div>
        {aside}
      </header>
      <div className="space-y-5 p-5 text-sm">{children}</div>
    </section>
  );

  return (
    <div className="space-y-5 pb-4">
      {/* Quick mode */}
      <div>
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <h2 className="text-[15px] font-semibold text-ink">{t("workflow.automation.quickMode")}</h2>
          <span className="text-xs text-mut">{preset ? t("workflow.automation.quickModeHint") : t("workflow.automation.custom")}</span>
        </div>
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          {PRESETS.map((p) => {
            const Icon = PRESET_ICON[p.key];
            const on = preset === p.key;
            return (
              <button
                key={p.key}
                type="button"
                onClick={() => set({ sync: [...p.sync], aiMode: p.aiMode, optimize: [...p.optimize], ...(p.key === "pause" && { autoMode: "off" as const }) })}
                className={`rounded-xl border p-3 text-left transition ${on ? "border-indigo-400 bg-indigo-50 ring-1 ring-indigo-400" : "border-line bg-panel hover:bg-hover"}`}
              >
                <span className="flex items-center gap-1.5 font-medium text-ink">
                  <Icon className={`size-4 ${on ? "text-indigo-600" : "text-mut"}`} aria-hidden />
                  {t(`workflow.automation.presets.${p.key}.label`)}
                </span>
                <span className="mt-0.5 block text-xs text-mut">
                  {p.key === "balanced" && <span className="font-medium text-emerald-700">{t("workflow.automation.recommended")}</span>}
                  {t(`workflow.automation.presets.${p.key}.hint`)}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Suggestions */}
      {advice.length > 0 && (
        <ul className="space-y-1.5">
          {advice.map((a) => (
            <li key={a.text} className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg px-3 py-2 text-sm ${a.tone === "warn" ? "bg-amber-50 text-amber-800" : "bg-sky-50 text-sky-800"}`}>
              {a.tone === "warn" ? <TriangleAlert className="size-4 shrink-0" aria-hidden /> : <Info className="size-4 shrink-0" aria-hidden />}
              <span className="min-w-0 flex-1">{a.text}</span>
              {a.fix && (
                <button type="button" className="shrink-0 rounded-md border border-current/30 px-2 py-0.5 text-xs font-medium hover:bg-panel/60" onClick={() => set(a.fix!.patch)}>
                  {a.fix.label}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* A day of the client */}
      {section(
        t("workflow.automation.dayTitle"),
        t("workflow.automation.daySub"),
        <>
          <DayTimeline lanes={lanes} now={now} />
          {events.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3 text-xs">
              <span className="text-mut">{t("workflow.automation.eventTriggers")}</span>
              {events.map((e) => (
                <Link key={e.label} href={e.href} className={`rounded-full border px-2.5 py-1 hover:bg-hover ${e.on ? "border-emerald-200 text-emerald-700" : "border-line text-mut"}`}>
                  {e.label}: {e.status}
                </Link>
              ))}
            </div>
          )}
        </>,
        <span className="text-xs text-mut">
          {dirty && <span className="mr-2 rounded-full bg-amber-50 px-2 py-0.5 font-medium text-amber-700">{t("workflow.automation.previewUnsaved")}</span>}
          {next ? t("workflow.automation.next", { lane: next.lane, time: clockLabel(next.at) }) : now != null ? t("workflow.automation.noMoreToday") : ""}
        </span>,
      )}

      {/* Sync & Claude */}
      {section(
        t("workflow.automation.syncTitle"),
        t("workflow.automation.syncSub"),
        <>
          <div>
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <span className="font-medium text-ink2">{t("workflow.automation.fullSyncAt")}</span>
              {last.sync && <span className="text-xs text-mut">{t("workflow.automation.lastRun", { when: last.sync })}</span>}
            </div>
            <HourPicker value={v.sync} onChange={(sync) => set({ sync })} quick={SYNC_QUICK} />
          </div>
          <fieldset>
            <legend className="mb-1 flex w-full items-baseline justify-between gap-2">
              <span className="font-medium text-ink2">{t("workflow.automation.claudeReads")}</span>
              {last.ai && <span className="text-xs text-mut">{t("workflow.automation.lastRun", { when: last.ai })}</span>}
            </legend>
            <p className="mb-2 text-xs text-mut">
              {t("workflow.automation.onlyNewData")} {v.sync.length ? t("workflow.automation.afterSync", { hour: summaryHour(v) }) : t("workflow.automation.whenSyncOn")}
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {AI_MODES.map((m) => (
                <label key={m.key} className={`flex cursor-pointer gap-2 rounded-lg border p-3 ${v.aiMode === m.key ? "border-indigo-400 bg-indigo-50" : "border-line hover:bg-hover"}`}>
                  <input type="radio" name="aiMode" checked={v.aiMode === m.key} onChange={() => set({ aiMode: m.key })} className="mt-0.5 accent-indigo-600" />
                  <span>
                    <span className="block font-medium text-ink">{m.key === "idle" ? t("workflow.automation.whenIdle", { hours: IDLE_HOURS }) : t(`workflow.automation.aiModes.${m.key}.label`)}</span>
                    <span className="block text-xs text-mut">{t(`workflow.automation.aiModes.${m.key}.hint`, { hours: IDLE_HOURS })}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        </>,
      )}

      {/* Campaign optimization */}
      {section(
        t("workflow.automation.optTitle"),
        t("workflow.automation.optSub") + (ctx.activeCampaigns ? t("workflow.automation.optRunning", { count: ctx.activeCampaigns }) : t("workflow.automation.optNone")),
        <>
          <div>
            <div className="mb-2 font-medium text-ink2">{t("workflow.automation.autoLevel")}</div>
            <div className="grid grid-cols-3 overflow-hidden rounded-lg border border-line" role="radiogroup">
              {LEVELS.map((l) => (
                <button
                  key={l.key}
                  type="button"
                  role="radio"
                  aria-checked={v.autoMode === l.key}
                  onClick={() => set({ autoMode: l.key })}
                  className={`border-l border-line px-2 py-2 text-sm font-medium first:border-l-0 ${v.autoMode === l.key ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-hover"}`}
                >
                  {l.label}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-mut">{LEVELS.find((l) => l.key === v.autoMode)!.hint}</p>
            {v.autoMode === "on" && saved.autoMode === "off" && (
              <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">{t("workflow.automation.tryDryRun")}</p>
            )}
          </div>

          <div>
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <span className="font-medium text-ink2">{t("workflow.automation.suggestAt")}</span>
              {last.optimize && <span className="text-xs text-mut">{t("workflow.automation.lastRun", { when: last.optimize })}</span>}
            </div>
            <HourPicker value={v.optimize} onChange={(optimize) => set({ optimize })} quick={OPT_QUICK} />
            <p className="mt-1.5 text-xs text-mut">{t("workflow.automation.suggestHint")}</p>
          </div>

          {auto && (
            <div className="space-y-3 rounded-lg border border-line bg-soft/50 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-ink2">{t("workflow.automation.hourlyFrom")}</span>
                {hourSelect("autoFromHour")}
                <span className="text-ink2">{t("workflow.automation.to")}</span>
                {hourSelect("autoToHour")}
                {last.auto && <span className="ml-auto text-xs text-mut">{t("workflow.automation.lastRun", { when: last.auto })}</span>}
              </div>
              {check("autoPause", t("workflow.automation.autoPause"), t("workflow.automation.autoPauseHint"))}
              {check(
                "autoScale",
                t("workflow.automation.autoScale"),
                t("workflow.automation.autoScaleHint", { pct: Math.min(v.optBudgetStepPct, maxBudgetChangePct), cap: ctx.budgetCap ?? t("workflow.automation.capNotSet") }),
              )}
              {check("autoNotify", t("workflow.automation.autoNotify"), t("workflow.automation.autoNotifyHint"))}
              {v.autoNotify && (
                <div className="ml-6">
                  <AutoNotifyTargets clientId={clientId} targets={v.autoNotifyTargets} onChange={(autoNotifyTargets) => set({ autoNotifyTargets })} bots={bots} />
                </div>
              )}
            </div>
          )}

          <details className="group rounded-lg border border-line">
            <summary className="cursor-pointer list-none px-3 py-2.5 font-medium text-ink2 select-none">
              <span className="mr-1 inline-block transition group-open:rotate-90">›</span> {t("workflow.automation.thresholds")}
              <span className="ml-2 text-xs font-normal text-mut">
                {t("workflow.automation.thresholdsSummary", { pause: v.optPausePct, conf: v.optConfidence, step: v.optBudgetStepPct })}
              </span>
            </summary>
            <div className="space-y-5 border-t border-line p-3">
              <div>
                <p className="font-medium text-ink">{t("workflow.automation.th.expensiveTitle")}</p>
                <div className="mt-2 grid gap-4 sm:grid-cols-3">
                  {num("optWarnPct", t("workflow.automation.th.warnPct"), t("workflow.automation.th.warnPctHint"), "%")}
                  {num("optPausePct", t("workflow.automation.th.pausePct"), t("workflow.automation.th.pausePctHint"), "%")}
                  <label className="block">
                    <span className="text-sm font-medium text-ink2">{t("workflow.automation.th.overThreshold")}</span>
                    <select className={`${inputClass} mt-1`} value={v.optExpensiveMode} onChange={(e) => set({ optExpensiveMode: e.target.value })}>
                      <option value="suggest">{t("workflow.automation.th.suggestPause")}</option>
                      <option value="warn">{t("workflow.automation.th.warnOnly")}</option>
                    </select>
                  </label>
                  {num("optConfidence", t("workflow.automation.th.confidence"), t("workflow.automation.th.confidenceHint"), "%")}
                  {num("optMinSpendX", t("workflow.automation.th.minSpend"), t("workflow.automation.th.minSpendHint"), t("workflow.automation.th.cprTimes"), 0.5)}
                </div>
              </div>
              <div>
                <p className="font-medium text-ink">{t("workflow.automation.th.newTitle")}</p>
                <div className="mt-2 grid gap-4 sm:grid-cols-3">
                  {num("optEarlyPct", t("workflow.automation.th.earlyPct"), t("workflow.automation.th.earlyPctHint"), "%")}
                  {num("optEarlySpendX", t("workflow.automation.th.earlySpend"), t("workflow.automation.th.earlySpendHint"), t("workflow.automation.th.cprTimes"), 0.5)}
                  {num("optMinAgeDays", t("workflow.automation.th.minAge"), t("workflow.automation.th.minAgeHint"), t("workflow.automation.th.days"))}
                </div>
              </div>
              <div>
                <p className="font-medium text-ink">{t("workflow.automation.th.budgetTitle")}</p>
                <div className="mt-2 grid gap-4 sm:grid-cols-3">
                  {num("optBudgetStepPct", t("workflow.automation.th.step"), t("workflow.automation.th.stepHint", { pct: maxBudgetChangePct }), "%")}
                  {num("optScaleConfidence", t("workflow.automation.th.scaleConf"), t("workflow.automation.th.scaleConfHint"), "%")}
                  {num("optScaleMinResults", t("workflow.automation.th.scaleMin"), t("workflow.automation.th.scaleMinHint"), t("workflow.automation.th.results"))}
                  {num("optScaleSpendPct", t("workflow.automation.th.scaleSpend"), t("workflow.automation.th.scaleSpendHint"), "%")}
                  {num("optScaleBeforeHour", t("workflow.automation.th.scaleBefore"), t("workflow.automation.th.scaleBeforeHint"), "h")}
                  {num("optScaleGapHours", t("workflow.automation.th.scaleGap"), t("workflow.automation.th.scaleGapHint"), t("workflow.automation.th.hours"))}
                </div>
              </div>
              <div>
                <p className="font-medium text-ink">{t("workflow.automation.th.fatigueTitle")}</p>
                <div className="mt-2 grid gap-4 sm:grid-cols-3">{num("optFreqMax", t("workflow.automation.th.freq"), t("workflow.automation.th.freqHint"), t("workflow.automation.th.times"), 0.5)}</div>
              </div>
              <button
                type="button"
                className="text-xs text-mut hover:text-ink"
                onClick={() => set({ ...DEFAULT_THRESHOLDS, ...Object.fromEntries(Object.entries(DEFAULT_AUTO).filter(([k]) => k.startsWith("opt"))) })}
              >
                {t("workflow.automation.th.reset")}
              </button>
            </div>
          </details>
        </>,
        saved.autoMode !== "off" && !dirty ? (
          <button
            type="button"
            className={btnClass()}
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await runAutoNowAction(clientId);
                setMsg(r.ok ? { ok: true, text: r.text ?? t("workflow.automation.done") } : { ok: false, text: r.error });
              })
            }
          >
            {t("workflow.automation.checkNow")}
          </button>
        ) : undefined,
      )}

      {/* Save bar */}
      {(dirty || msg) && (
        // Mobile: place it above the floating Ask Claude button in the bottom corner.
        <div className="sticky bottom-16 z-10 flex sm:bottom-3 flex-wrap items-center gap-3 rounded-xl border border-line bg-panel px-4 py-3 shadow-lg">
          {msg ? (
            <span className={`flex items-center gap-1.5 text-sm ${msg.ok ? "text-emerald-600" : "text-rose-600"}`}>
              {msg.ok && <CircleCheck className="size-4" aria-hidden />}
              {msg.text}
            </span>
          ) : (
            <span className="text-sm text-ink2">{t("workflow.automation.unsaved")}</span>
          )}
          {/* Buttons on the left: the bottom-right corner holds the Ask Claude button. */}
          <span className="flex gap-2 sm:mr-36">
            {dirty && (
              <button type="button" className={btnClass("primary")} disabled={pending} onClick={save}>
                {pending ? t("workflow.automation.saving") : t("workflow.automation.save")}
              </button>
            )}
            {dirty && (
              <button type="button" className={btnClass("ghost")} disabled={pending} onClick={() => (setV(saved), setMsg(null))}>
                {t("workflow.automation.undo")}
              </button>
            )}
          </span>
        </div>
      )}
    </div>
  );
}
