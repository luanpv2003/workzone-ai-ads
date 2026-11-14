"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { channelLabels, weekdays, type Channel } from "@/lib/client-report-vars";
import { kindDesc, kindLabel, MAX_SCHEDULES, REPEATS, REPORT_KINDS, repeatLabel, repeatName, timeLabel, type ScheduleInput, type ScheduleView } from "@/lib/report-schedule";
import type { T } from "@/i18n/translate";
import { deleteReportScheduleAction, runReportScheduleNowAction, saveReportScheduleAction, toggleReportScheduleAction } from "@/app/report-schedule-actions";
import type { Target } from "./client-report-panel";
import { Spinner } from "./action-button";
import { Badge, btnClass, inputClass } from "./ui";
import { useT } from "@/i18n/client";

// Notifications & reports → Report schedule: list of schedules (multiple per day), add / edit / toggle / test-build / delete.

type Row = ScheduleView & { next: string | null };
type Msg = { ok: boolean; text: string } | null;

const EMPTY: ScheduleInput = { kind: "daily", repeat: "daily", days: [], hour: 9, minute: 0, autoSend: false, targets: null, active: true };
/** Quick suggestions when adding a schedule. */
const PRESETS: { key: "morning" | "afternoon" | "monday" | "first"; v: Partial<ScheduleInput> }[] = [
  { key: "morning", v: { kind: "daily", repeat: "daily", hour: 8, minute: 30 } },
  { key: "afternoon", v: { kind: "today", repeat: "daily", hour: 17, minute: 0 } },
  { key: "monday", v: { kind: "7", repeat: "weekly", days: [1], hour: 9, minute: 0 } },
  { key: "first", v: { kind: "30", repeat: "monthly", days: [1], hour: 9, minute: 0 } },
];

const keyOf = (t: Pick<Target, "channel" | "to">) => `${t.channel}:${t.to}`;

function targetsSummary(sel: ScheduleInput["targets"], all: Target[], t: T) {
  if (!sel) return all.length ? t("notify.schedulesUi.all", { n: all.length }) : null;
  const picked = all.filter((x) => sel[x.channel]?.includes(x.to));
  return picked.length ? picked.map((x) => x.label).join(", ") : null;
}

function Editor({ clientId, id, initial, targets, onDone }: { clientId: string; id: string | null; initial: ScheduleInput; targets: Target[]; onDone: () => void }) {
  const router = useRouter();
  const t = useT();
  const channels = channelLabels(t);
  const days = weekdays(t);
  const [v, setV] = useState<ScheduleInput>(initial);
  const [msg, setMsg] = useState<Msg>(null);
  const [pending, start] = useTransition();
  const picked = new Set(targets.filter((x) => v.targets?.[x.channel]?.includes(x.to)).map(keyOf));
  const setPicked = (next: Set<string>) => {
    const out: Partial<Record<Channel, string[]>> = {};
    for (const x of targets) if (next.has(keyOf(x))) (out[x.channel] ??= []).push(x.to);
    setV({ ...v, targets: out });
  };
  const toggleDay = (d: number) => setV({ ...v, days: v.days.includes(d) ? v.days.filter((x) => x !== d) : [...v.days, d].sort((a, b) => a - b) });
  const save = () =>
    start(async () => {
      const r = await saveReportScheduleAction(clientId, id, v);
      if (!r.ok) return setMsg({ ok: false, text: r.error });
      router.refresh();
      onDone();
    });
  const chip = (on: boolean) => `inline-flex h-8 min-w-10 items-center justify-center rounded-lg border px-2.5 text-sm ${on ? "border-indigo-500 bg-indigo-50 font-medium text-indigo-700" : "border-line bg-panel text-ink2 hover:bg-hover"}`;

  return (
    <div className="space-y-5 rounded-xl border border-indigo-200 bg-indigo-50/30 p-4 text-sm">
      {!id && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-mut">{t("notify.schedulesUi.hint")}</span>
          {PRESETS.map((p) => (
            <button key={p.key} type="button" className="rounded-full border border-line bg-panel px-2.5 py-1 text-xs text-ink2 hover:bg-hover" onClick={() => setV({ ...v, days: [], ...p.v })}>
              {t(`notify.schedulesUi.presets.${p.key}`)}
            </button>
          ))}
        </div>
      )}

      <fieldset>
        <legend className="mb-2 font-medium text-ink">{t("notify.schedulesUi.s1")}</legend>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {REPORT_KINDS.map((k) => (
            <label key={k.key} className={`flex cursor-pointer gap-2 rounded-lg border p-2.5 ${v.kind === k.key ? "border-indigo-500 bg-panel" : "border-line bg-panel/60"}`}>
              <input type="radio" className="mt-0.5" checked={v.kind === k.key} onChange={() => setV({ ...v, kind: k.key })} />
              <span>
                <span className="font-medium text-ink">{kindLabel(k.key, t)}</span>
                <span className="block text-xs text-mut">{kindDesc(k.key, t)}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-2 font-medium text-ink">{t("notify.schedulesUi.s2")}</legend>
        <div className="flex flex-wrap items-center gap-3">
          <div className="w-32">
            <input
              type="time"
              className={inputClass}
              value={timeLabel(v)}
              onChange={(e) => {
                const [h, m] = e.target.value.split(":").map(Number);
                if (Number.isFinite(h) && Number.isFinite(m)) setV({ ...v, hour: h, minute: m });
              }}
            />
          </div>
          <div className="flex flex-wrap gap-1">
            {REPEATS.map((r) => (
              <button key={r.key} type="button" className={chip(v.repeat === r.key)} onClick={() => setV({ ...v, repeat: r.key, days: r.key === v.repeat ? v.days : r.key === "weekly" ? [1] : r.key === "monthly" ? [1] : [] })}>
                {repeatName(r.key, t)}
              </button>
            ))}
          </div>
        </div>
        {v.repeat === "weekly" && (
          <div className="mt-2 flex flex-wrap gap-1">
            {days.map((d, i) => (
              <button key={d} type="button" className={chip(v.days.includes(i + 1))} onClick={() => toggleDay(i + 1)}>
                {d}
              </button>
            ))}
          </div>
        )}
        {v.repeat === "monthly" && (
          <div className="mt-2 flex flex-wrap gap-1">
            {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
              <button key={d} type="button" className={chip(v.days.includes(d))} onClick={() => toggleDay(d)}>
                {d}
              </button>
            ))}
          </div>
        )}
        <p className="mt-1.5 text-xs text-mut">{t("notify.schedulesUi.clientTime", { repeat: repeatLabel(v, t), time: timeLabel(v) })}</p>
      </fieldset>

      <fieldset>
        <legend className="mb-2 font-medium text-ink">{t("notify.schedulesUi.s3")}</legend>
        <label className="flex items-center gap-2">
          <input type="radio" checked={!v.targets} onChange={() => setV({ ...v, targets: null })} />
          {t("notify.schedulesUi.allRecipients", { n: targets.length ? t("notify.schedulesUi.nPlaces", { n: targets.length }) : "" })}
          <span className="text-xs text-mut">{t("notify.schedulesUi.followList")}</span>
        </label>
        <label className="mt-1 flex items-center gap-2">
          <input type="radio" checked={!!v.targets} onChange={() => setV({ ...v, targets: {} })} disabled={!targets.length} />
          {t("notify.schedulesUi.onlySome")}
        </label>
        {v.targets && (
          <div className="mt-2 ml-6 space-y-1">
            {targets.map((x) => {
              const k = keyOf(x);
              return (
                <label key={k} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={picked.has(k)}
                    onChange={(e) => {
                      const next = new Set(picked);
                      if (e.target.checked) next.add(k);
                      else next.delete(k);
                      setPicked(next);
                    }}
                  />
                  <span className="text-xs text-mut">{channels[x.channel] ?? x.channel}</span> {x.label}
                  {x.sub && <span className="text-xs text-mut2">{x.sub}</span>}
                </label>
              );
            })}
          </div>
        )}
        {!targets.length && <p className="mt-1 text-xs text-amber-700">{t("notify.schedulesUi.noRecipients")}</p>}
      </fieldset>

      <fieldset>
        <legend className="mb-2 font-medium text-ink">{t("notify.schedulesUi.s4")}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {[
            [false, t("notify.schedulesUi.draftLabel"), t("notify.schedulesUi.draftHint")],
            [true, t("notify.schedulesUi.autoLabel"), t("notify.schedulesUi.autoHint")],
          ].map(([auto, label, hint]) => (
            <label key={String(auto)} className={`flex cursor-pointer gap-2 rounded-lg border p-2.5 ${v.autoSend === auto ? "border-indigo-500 bg-panel" : "border-line bg-panel/60"}`}>
              <input type="radio" className="mt-0.5" checked={v.autoSend === auto} onChange={() => setV({ ...v, autoSend: auto as boolean })} />
              <span>
                <span className="font-medium text-ink">{label}</span>
                <span className="block text-xs text-mut">{hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {msg && <p className={`rounded-lg px-3 py-2 ${msg.ok ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-700"}`}>{msg.text}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={btnClass("primary")} disabled={pending} onClick={save}>
          {pending && <Spinner />} {id ? t("notify.schedulesUi.saveSchedule") : t("notify.schedulesUi.addSchedule")}
        </button>
        <button type="button" className={btnClass("secondary")} disabled={pending} onClick={onDone}>
          {t("notify.schedulesUi.cancel")}
        </button>
      </div>
    </div>
  );
}

export function ReportSchedules({ clientId, schedules, targets }: { clientId: string; schedules: Row[]; targets: Target[] }) {
  const router = useRouter();
  const t = useT();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [, start] = useTransition();
  const act = (id: string, fn: () => Promise<{ ok: true; id?: string } | { ok: false; error: string }>, done?: (id?: string) => void) => {
    setBusy(id);
    start(async () => {
      const r = await fn();
      setBusy(null);
      if (!r.ok) return setMsg({ ok: false, text: r.error });
      setMsg(null);
      router.refresh();
      done?.(r.id);
    });
  };

  return (
    <div className="space-y-3">
      {msg && <p className={`rounded-lg px-3 py-2 text-sm ${msg.ok ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-700"}`}>{msg.text}</p>}

      {!schedules.length && editing !== "new" && (
        <div className="rounded-xl border border-dashed border-line p-6 text-center text-sm text-mut">
          <CalendarClock className="mx-auto mb-2 size-6 text-mut2" />
          {t("notify.schedulesUi.empty")}
        </div>
      )}

      {schedules.map((s) =>
        editing === s.id ? (
          <Editor key={s.id} clientId={clientId} id={s.id} initial={s} targets={targets} onDone={() => setEditing(null)} />
        ) : (
          <div key={s.id} className={`flex flex-wrap items-center gap-x-5 gap-y-3 rounded-xl border border-line px-4 py-3 ${s.active ? "bg-panel" : "bg-soft opacity-70"}`}>
            <div className="w-16 text-xl font-semibold text-ink tabular-nums">{timeLabel(s)}</div>
            <div className="min-w-48 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-ink">{kindLabel(s.kind, t)}</span>
                <span className="text-sm text-mut">· {repeatLabel(s, t)}</span>
                <Badge tone={s.autoSend ? "good" : "warn"}>{s.autoSend ? t("notify.schedulesUi.autoBadge") : t("notify.schedulesUi.awaitingBadge")}</Badge>
                {!s.active && <Badge tone="mut">{t("notify.schedulesUi.offBadge")}</Badge>}
              </div>
              <div className="mt-0.5 text-xs text-mut">
                {t("notify.schedulesUi.sendTo", { desc: kindDesc(s.kind, t) })}{targetsSummary(s.targets, targets, t) ?? <span className="text-rose-700">{t("notify.schedulesUi.noRecipientsShort")}</span>}
              </div>
              <div className="mt-0.5 text-xs text-mut2">
                {s.active && s.next ? t("notify.schedulesUi.next", { v: s.next }) : t("notify.schedulesUi.notRunning")}
                {s.lastResult && t("notify.schedulesUi.last", { v: s.lastResult })}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <label className="mr-1 inline-flex cursor-pointer items-center gap-1.5 text-xs text-mut" title={s.active ? t("notify.schedulesUi.turnOffTitle") : t("notify.schedulesUi.turnOnTitle")}>
                <input type="checkbox" checked={s.active} disabled={busy === s.id} onChange={(e) => act(s.id, () => toggleReportScheduleAction(s.id, e.target.checked))} />
                {t("notify.schedulesUi.on")}
              </label>
              <button type="button" className={btnClass("ghost")} title={t("notify.schedulesUi.testTitle")} disabled={busy === s.id} onClick={() => act(s.id, () => runReportScheduleNowAction(s.id), (rid) => rid && router.push(`/clients/${clientId}/client-reports?r=${rid}`))}>
                {busy === s.id ? <Spinner /> : <Play />} {t("notify.schedulesUi.testBtn")}
              </button>
              <button type="button" className={btnClass("ghost")} onClick={() => setEditing(s.id)}>
                <Pencil /> {t("notify.schedulesUi.edit")}
              </button>
              <button type="button" className={btnClass("ghost")} disabled={busy === s.id} onClick={() => confirm(t("notify.schedulesUi.deleteConfirm", { kind: kindLabel(s.kind, t), time: timeLabel(s) })) && act(s.id, () => deleteReportScheduleAction(s.id))}>
                <Trash2 /> {t("notify.schedulesUi.delete")}
              </button>
            </div>
          </div>
        ),
      )}

      {editing === "new" ? (
        <Editor clientId={clientId} id={null} initial={EMPTY} targets={targets} onDone={() => setEditing(null)} />
      ) : (
        schedules.length < MAX_SCHEDULES && (
          <button type="button" className={btnClass(schedules.length ? "secondary" : "primary")} onClick={() => setEditing("new")}>
            <Plus /> {t("notify.schedulesUi.add")}
          </button>
        )
      )}
    </div>
  );
}
