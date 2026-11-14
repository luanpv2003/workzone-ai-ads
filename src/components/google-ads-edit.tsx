"use client";

import { useState, useTransition, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { useRouter } from "next/navigation";
import type { ActionResult } from "@/app/actions";
import { googleApproveChangeAction, googleDraftGroupAction, googleManualChangeAction, googleRejectChangeAction } from "@/app/google-ads-actions";
import type { Device, GChangeParams, MatchType, NegItem } from "@/lib/google-ads-write";
import { money, num } from "@/lib/format";
import { AD_LIMITS, dayLabel, DAYS, fmtSchedule, gWidth, hhmm, type Day, type SchedSlot } from "@/lib/google-ads-text";
import { useT } from "@/i18n/client";
import { Badge, btnClass, inputClass } from "./ui";
import { Spinner } from "./action-button";

// Edit Google Ads on the web: proposal cards awaiting approval (rules / Claude, editable before approval) and a manual edit panel per campaign.

const SOURCE_TONE: Record<string, "violet" | "blue" | "gray"> = { claude: "violet", rule: "blue", manual: "gray" };

function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const go = (fn: () => Promise<ActionResult>, ok: string, ask?: string) => {
    if (ask && !window.confirm(ask)) return;
    setMsg(null);
    start(async () => {
      const r = await fn();
      setMsg(r.ok ? { ok: true, text: ok } : { ok: false, text: r.error });
      if (r.ok) router.refresh();
    });
  };
  const note = msg && <p className={`mt-2 rounded-lg px-3 py-1.5 text-xs ${msg.ok ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-700"}`}>{msg.text}</p>;
  return { pending, go, note };
}

/** Amount input: type "15000" or "15.000" or "15k". */
const parseMoney = (s: string) => {
  const t = s.trim().toLowerCase().replace(/[.,\s]/g, "");
  const k = t.endsWith("k") ? 1000 : t.endsWith("tr") ? 1_000_000 : 1;
  const n = Number(t.replace(/(k|tr)$/, ""));
  return Number.isFinite(n) && n > 0 ? n * k : null;
};

export type ChangeView = { id: string; kind: string; campaignName: string; title: string; rationale: string; params: GChangeParams; source: string; result: string | null; createdAt: string };

/** Proposal card awaiting approval. */
export function GoogleChangeCard({ change, canEdit }: { change: ChangeView; canEdit: boolean }) {
  const t = useT();
  const { pending, go, note } = useRun();
  const p0 = change.params;
  const [picked, setPicked] = useState<boolean[]>(() =>
    p0.kind === "negatives" ? p0.items.map(() => true) : p0.kind === "keyword_status" ? p0.keywords.map(() => true) : p0.kind === "ad_group_switch" ? p0.pauseKeywords.map(() => true) : [],
  );
  const [group, setGroup] = useState<GroupDraft | null>(() => (p0.kind === "ad_group_create" ? { ...p0, keywords: p0.keywords.map((k) => ({ ...k, on: true })) } : null));
  const [match, setMatch] = useState<MatchType[]>(() => (p0.kind === "negatives" ? p0.items.map((x) => x.matchType) : []));
  const [value, setValue] = useState(() => (p0.kind === "budget" ? String(p0.amount) : p0.kind === "target_cpa" && p0.value != null ? String(p0.value) : ""));
  const [sched, setSched] = useState<SchedDraft | null>(() => (p0.kind === "ad_schedule" ? { days: p0.days, start: p0.startHour * 60 + p0.startMinute, end: p0.endHour * 60 + p0.endMinute } : null));

  const edited = (): GChangeParams | string => {
    if (p0.kind === "negatives") {
      const items = p0.items.flatMap((x, i) => (picked[i] ? [{ ...x, matchType: match[i] }] : []));
      return items.length ? { kind: "negatives", items } : t("settings.googleEdit.noTermsPicked");
    }
    if (p0.kind === "keyword_status") {
      const keywords = p0.keywords.filter((_, i) => picked[i]);
      return keywords.length ? { ...p0, keywords } : t("settings.googleEdit.noKeywordsPicked");
    }
    if (p0.kind === "budget") {
      const v = parseMoney(value);
      return v ? { kind: "budget", amount: v } : t("settings.googleEdit.badBudget");
    }
    if (p0.kind === "target_cpa") {
      if (!value.trim()) return { kind: "target_cpa", value: null };
      const v = parseMoney(value);
      return v ? { kind: "target_cpa", value: v } : t("settings.googleEdit.badCpa");
    }
    if (p0.kind === "ad_group_switch") return { ...p0, pauseKeywords: p0.pauseKeywords.filter((_, i) => picked[i]) };
    if (p0.kind === "ad_schedule" && sched) return schedParams(sched);
    if (p0.kind === "ad_group_create" && group) {
      const headlines = group.headlines.map((h) => h.trim()).filter(Boolean);
      const descriptions = group.descriptions.map((d) => d.trim()).filter(Boolean);
      const keywords = group.keywords.filter((k) => k.on && k.text.trim()).map((k) => ({ text: k.text.trim(), matchType: k.matchType }));
      if (headlines.some((h) => gWidth(h) > AD_LIMITS.headline) || descriptions.some((d) => gWidth(d) > AD_LIMITS.description)) return t("settings.googleEdit.tooLong");
      if (headlines.length < AD_LIMITS.minHeadlines || descriptions.length < AD_LIMITS.minDescriptions) return t("settings.googleEdit.needAtLeast", { h: AD_LIMITS.minHeadlines, d: AD_LIMITS.minDescriptions });
      if (!keywords.length) return t("settings.googleEdit.noKeywordsPicked");
      return { kind: "ad_group_create", name: group.name.trim(), finalUrl: group.finalUrl.trim(), path1: group.path1.trim(), path2: group.path2.trim(), headlines, descriptions, keywords, why: group.why };
    }
    return p0;
  };
  const approve = () => {
    const p = edited();
    if (typeof p === "string") return window.alert(p);
    const n = p.kind === "negatives" ? p.items.length : p.kind === "keyword_status" ? p.keywords.length : p.kind === "ad_group_switch" ? p.pauseKeywords.length : 0;
    go(() => googleApproveChangeAction(change.id, p), t("settings.googleEdit.editedOnGoogle"), `${t("settings.googleEdit.confirmSend")}\n\n${change.campaignName}\n${change.title}${n ? ` (${t("settings.googleEdit.itemsPicked", { n })})` : ""}`);
  };

  // Approve buttons: top corner on desktop; at the bottom of the card on mobile (read then tap), large, split into two halves.
  const buttons = (cls: string) =>
    canEdit && (
      <div className={cls}>
        <button type="button" className={`${btnClass("primary")} @max-2xl:h-11 @max-2xl:min-w-0 @max-2xl:flex-1 @max-2xl:shrink @max-2xl:text-center @max-2xl:leading-tight @max-2xl:whitespace-normal`} disabled={pending} onClick={approve}>
          {pending && <Spinner />}{t("settings.googleEdit.approve")}
        </button>
        <button type="button" className={`${btnClass("secondary")} @max-2xl:h-11`} disabled={pending} onClick={() => go(() => googleRejectChangeAction(change.id), t("settings.googleEdit.dismissed"))}>
          {t("settings.googleEdit.dismiss")}
        </button>
      </div>
    );

  return (
    <div className="rounded-xl border border-line p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={SOURCE_TONE[change.source] ?? "gray"}>{change.source in SOURCE_TONE ? t(`settings.googleEdit.source.${change.source as "claude" | "rule" | "manual"}`) : change.source}</Badge>
            <span className="font-medium text-ink">{change.title}</span>
          </div>
          <p className="mt-0.5 text-xs text-mut">{change.campaignName}</p>
        </div>
        {buttons("hidden gap-2 @2xl:flex")}
      </div>
      <p className="mt-2 text-sm whitespace-pre-line text-ink2">{change.rationale}</p>
      {change.result && <p className="mt-1 text-xs text-rose-700">{change.result}</p>}

      {p0.kind === "negatives" && (
        <div className="mt-3 max-h-80 overflow-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-panel text-left text-xs text-slate-400">
              <tr>
                <th className="w-8 px-2 py-1">
                  <input type="checkbox" checked={picked.every(Boolean)} onChange={(e) => setPicked(picked.map(() => e.target.checked))} disabled={!canEdit} />
                </th>
                <th className="py-1 pr-2 font-medium">{t("settings.googleEdit.colNegative")}</th>
                <th className="py-1 pr-2 font-medium">{t("settings.googleEdit.colMatch")}</th>
                <th className="hidden py-1 pr-2 text-right font-medium @3xl:table-cell">{t("settings.googleEdit.colSpend30")}</th>
                <th className="hidden py-1 pr-2 text-right font-medium @3xl:table-cell">{t("settings.googleEdit.colClicks")}</th>
                <th className="hidden py-1 pr-2 text-right font-medium @3xl:table-cell">{t("settings.googleEdit.colConv")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {p0.items.map((x: NegItem, i) => (
                <tr key={`${x.text}-${i}`} className={picked[i] ? "" : "text-mut"}>
                  <td className="px-2 py-1">
                    <input type="checkbox" checked={picked[i]} disabled={!canEdit} onChange={(e) => setPicked(picked.map((v, j) => (j === i ? e.target.checked : v)))} />
                  </td>
                  <td className="py-1 pr-2">
                    <span className="font-medium">{x.text}</span>
                    {x.reason && <span className="block text-xs text-mut">{x.reason}</span>}
                    {x.spend != null && (
                      <span className="block text-xs text-mut tabular-nums @3xl:hidden">
                        {t("settings.googleEdit.rowStats", { spend: money(x.spend, "VND"), clicks: num(x.clicks ?? null), conv: num(x.conversions ?? null, 1) })}
                      </span>
                    )}
                  </td>
                  <td className="py-1 pr-2">
                    <select className="rounded border border-line bg-panel px-1 py-0.5 text-xs" value={match[i]} disabled={!canEdit} onChange={(e) => setMatch(match.map((v, j) => (j === i ? (e.target.value as MatchType) : v)))}>
                      {(["EXACT", "PHRASE"] as const).map((m) => (
                        <option key={m} value={m}>
                          {t(`settings.googleEdit.match.${m}`)}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="hidden py-1 pr-2 text-right tabular-nums whitespace-nowrap @3xl:table-cell">{money(x.spend ?? null, "VND")}</td>
                  <td className="hidden py-1 pr-2 text-right tabular-nums @3xl:table-cell">{num(x.clicks ?? null)}</td>
                  <td className="hidden py-1 pr-2 text-right tabular-nums @3xl:table-cell">{num(x.conversions ?? null, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {p0.kind === "ad_group_create" && group && <GroupEditor value={group} onChange={setGroup} disabled={!canEdit} />}
      {p0.kind === "ad_schedule" && sched && (
        <div className="mt-3">
          <ScheduleInputs value={sched} onChange={setSched} disabled={!canEdit} />
        </div>
      )}
      {p0.kind === "ad_group_switch" && p0.pauseKeywords.length > 0 && (
        <div className="mt-2 text-sm">
          <p className="mb-1 text-xs text-slate-600">{t("settings.googleEdit.pauseInOld")}</p>
          <ul className="flex flex-wrap gap-2">
            {p0.pauseKeywords.map((k, i) => (
              <li key={k.id}>
                <label className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2 py-1">
                  <input type="checkbox" checked={picked[i]} disabled={!canEdit} onChange={(e) => setPicked(picked.map((v, j) => (j === i ? e.target.checked : v)))} />
                  {k.text}
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
      {p0.kind === "keyword_status" && (
        <ul className="mt-2 flex flex-wrap gap-2 text-sm">
          {p0.keywords.map((k, i) => (
            <li key={k.id}>
              <label className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2 py-1">
                <input type="checkbox" checked={picked[i]} disabled={!canEdit} onChange={(e) => setPicked(picked.map((v, j) => (j === i ? e.target.checked : v)))} />
                {k.text}
              </label>
            </li>
          ))}
        </ul>
      )}
      {(p0.kind === "budget" || p0.kind === "target_cpa") && canEdit && (
        <label className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          <span className="whitespace-nowrap">{p0.kind === "budget" ? t("settings.googleEdit.budgetLabel") : t("settings.googleEdit.cpaLabel")}</span>
          <input className={`${inputClass} w-36!`} value={value} onChange={(e) => setValue(e.target.value)} placeholder={p0.kind === "target_cpa" ? t("settings.googleEdit.emptyRemoves") : ""} />
          {p0.kind === "target_cpa" && <span className="text-xs text-mut">{t("settings.googleEdit.cpaHint")}</span>}
        </label>
      )}
      {note}
      {buttons("mt-3 flex gap-2 @2xl:hidden")}
    </div>
  );
}

type GroupDraft = Omit<Extract<GChangeParams, { kind: "ad_group_create" }>, "kind" | "keywords"> & { keywords: { text: string; matchType: MatchType; on: boolean }[] };

/** Text input with a Google-style character counter (red when over the limit). */
function CountedInput({ value, max, onChange, disabled, onRemove }: { value: string; max: number; onChange: (v: string) => void; disabled: boolean; onRemove?: () => void }) {
  const t = useT();
  const w = gWidth(value);
  return (
    <div className="flex items-center gap-1.5">
      <input className={`${inputClass} py-1 ${w > max ? "border-rose-400 focus:border-rose-500" : ""}`} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
      <span className={`w-12 shrink-0 text-right text-xs tabular-nums ${w > max ? "font-medium text-rose-600" : "text-mut"}`}>
        {w}/{max}
      </span>
      {onRemove && !disabled && (
        <button type="button" className="text-xs text-mut hover:text-rose-600" title={t("settings.googleEdit.remove")} onClick={onRemove}>
          ✕
        </button>
      )}
    </div>
  );
}

/** Edit a new ad group before creating it: name, URL, paths, headlines, descriptions, keywords. */
function GroupEditor({ value: g, onChange, disabled }: { value: GroupDraft; onChange: (g: GroupDraft) => void; disabled: boolean }) {
  const t = useT();
  const set = (patch: Partial<GroupDraft>) => onChange({ ...g, ...patch });
  const list = (key: "headlines" | "descriptions", max: number, limit: number, label: string) => (
    <div>
      <p className="mb-1 text-xs text-slate-600">
        {label} · {g[key].filter((x) => x.trim()).length}/{limit}
      </p>
      <div className="space-y-1">
        {g[key].map((h, i) => (
          <CountedInput key={i} value={h} max={max} disabled={disabled} onChange={(v) => set({ [key]: g[key].map((x, j) => (j === i ? v : x)) })} onRemove={() => set({ [key]: g[key].filter((_, j) => j !== i) })} />
        ))}
      </div>
      {!disabled && g[key].length < limit && (
        <button type="button" className="mt-1 text-xs text-indigo-600 hover:underline" onClick={() => set({ [key]: [...g[key], ""] })}>
          {t("settings.googleEdit.addItem")}
        </button>
      )}
    </div>
  );
  return (
    <div className="mt-3 space-y-3 rounded-lg border border-line p-3 text-sm">
      <div className="grid gap-2 @3xl:grid-cols-[1fr_1.4fr]">
        <label className="block">
          <span className="text-xs text-slate-600">{t("settings.googleEdit.groupName")}</span>
          <input className={`${inputClass} py-1`} value={g.name} disabled={disabled} onChange={(e) => set({ name: e.target.value })} />
        </label>
        <label className="block">
          <span className="text-xs text-slate-600">{t("settings.googleEdit.landingUrl")}</span>
          <input className={`${inputClass} py-1`} value={g.finalUrl} disabled={disabled} onChange={(e) => set({ finalUrl: e.target.value })} />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
        {t("settings.googleEdit.displayPath")} <span className="text-mut">{(() => { try { return new URL(g.finalUrl).hostname; } catch { return "…"; } })()}/</span>
        <div className="w-40">
          <CountedInput value={g.path1} max={AD_LIMITS.path} disabled={disabled} onChange={(v) => set({ path1: v })} />
        </div>
        /
        <div className="w-40">
          <CountedInput value={g.path2} max={AD_LIMITS.path} disabled={disabled} onChange={(v) => set({ path2: v })} />
        </div>
      </div>
      <div className="grid gap-4 @4xl:grid-cols-2">
        {list("headlines", AD_LIMITS.headline, AD_LIMITS.maxHeadlines, t("settings.googleEdit.headlinesLabel"))}
        <div className="space-y-4">
          {list("descriptions", AD_LIMITS.description, AD_LIMITS.maxDescriptions, t("settings.googleEdit.descriptionsLabel"))}
          <div>
            <p className="mb-1 text-xs text-slate-600">{t("settings.googleEdit.keywordsPicked", { n: g.keywords.filter((k) => k.on).length })}</p>
            <ul className="max-h-60 space-y-1 overflow-y-auto">
              {g.keywords.map((k, i) => (
                <li key={i} className="flex items-center gap-1.5">
                  <input type="checkbox" checked={k.on} disabled={disabled} onChange={(e) => set({ keywords: g.keywords.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)) })} />
                  <input className={`${inputClass} py-0.5`} value={k.text} disabled={disabled} onChange={(e) => set({ keywords: g.keywords.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)) })} />
                  <select className="rounded border border-line bg-panel px-1 py-0.5 text-xs" value={k.matchType} disabled={disabled} onChange={(e) => set({ keywords: g.keywords.map((x, j) => (j === i ? { ...x, matchType: e.target.value as MatchType } : x)) })}>
                    {(["EXACT", "PHRASE", "BROAD"] as const).map((m) => (
                      <option key={m} value={m}>
                        {t(`settings.googleEdit.match.${m}`)}
                      </option>
                    ))}
                  </select>
                </li>
              ))}
            </ul>
            {!disabled && (
              <button type="button" className="mt-1 text-xs text-indigo-600 hover:underline" onClick={() => set({ keywords: [...g.keywords, { text: "", matchType: "PHRASE", on: true }] })}>
                {t("settings.googleEdit.addKeyword")}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

type SchedDraft = { days: Day[]; start: number; end: number }; // minutes of the day
const schedParams = (d: SchedDraft): GChangeParams => ({ kind: "ad_schedule", days: d.days, startHour: Math.floor(d.start / 60), startMinute: d.start % 60, endHour: Math.floor(d.end / 60), endMinute: d.end % 60 });
/** Current schedule → edit fields: the most common time window + the days it runs (no schedule = every day 10:00–21:30). */
function schedOf(slots: SchedSlot[]): SchedDraft {
  if (!slots.length) return { days: [...DAYS], start: 600, end: 1290 };
  const s = slots[0];
  return { days: [...new Set(slots.map((x) => x.day as Day))], start: s.startHour * 60 + s.startMinute, end: s.endHour * 60 + s.endMinute };
}
const TIMES = Array.from({ length: 97 }, (_, i) => i * 15);

function ScheduleInputs({ value: v, onChange, disabled }: { value: SchedDraft; onChange: (v: SchedDraft) => void; disabled: boolean }) {
  const t = useT();
  const sel = (key: "start" | "end") => (
    <select className="rounded border border-line bg-panel px-1.5 py-1 text-sm" value={v[key]} disabled={disabled} onChange={(e) => onChange({ ...v, [key]: Number(e.target.value) })}>
      {TIMES.filter((tm) => (key === "start" ? tm < 1440 : tm > 0)).map((tm) => (
        <option key={tm} value={tm}>
          {hhmm(Math.floor(tm / 60), tm % 60)}
        </option>
      ))}
    </select>
  );
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      {sel("start")} – {sel("end")}
      <span className="ml-1 inline-flex gap-1">
        {DAYS.map((d) => (
          <label key={d} className={`cursor-pointer rounded border px-1.5 py-0.5 text-xs ${v.days.includes(d) ? "border-indigo-300 bg-indigo-50 text-indigo-700" : "border-line text-mut"}`}>
            <input
              type="checkbox"
              className="sr-only"
              checked={v.days.includes(d)}
              disabled={disabled}
              onChange={(e) => onChange({ ...v, days: e.target.checked ? DAYS.filter((x) => x === d || v.days.includes(x)) : v.days.filter((x) => x !== d) })}
            />
            {dayLabel(d, t)}
          </label>
        ))}
      </span>
      {v.start >= v.end && <span className="text-xs text-rose-600">{t("settings.googleEdit.offAfterOn")}</span>}
    </div>
  );
}

/** By hour: conversions + cost/conversion over 30 days, and yesterday's spend (to see when the budget ran out). */
function HourTable({ hours, lastDay, budget }: { hours: CampaignEdit["hours"]; lastDay: Record<string, number>; budget: number | null }) {
  const t = useT();
  const hs = Array.from({ length: 24 }, (_, h) => h).filter((h) => (hours[h]?.spend ?? 0) > 0 || (lastDay[h] ?? 0) > 0);
  if (!hs.length) return null;
  const maxConv = Math.max(...hs.map((h) => hours[h]?.conversions ?? 0), 1);
  const maxDay = Math.max(...hs.map((h) => lastDay[h] ?? 0), 1);
  const dayTotal = Object.values(lastDay).reduce((a, v) => a + v, 0);
  let acc = 0;
  return (
    <div className="mt-3 overflow-x-auto">
      {budget ? (
        <p className="mb-1 text-xs text-mut">
          {t("settings.googleEdit.yesterday", { budget: money(budget, "VND"), spent: money(dayTotal, "VND") })}
        </p>
      ) : null}
      <table className="w-full min-w-[20rem] text-xs">
        <thead className="text-left whitespace-nowrap text-slate-400">
          <tr>
            <th className="py-1 pr-2 font-medium">{t("settings.googleEdit.colHour")}</th>
            <th className="py-1 pr-2 font-medium">{t("settings.googleEdit.colConv30")}</th>
            <th className="py-1 pr-2 text-right font-medium">{t("settings.googleEdit.colCpc")}</th>
            <th className="py-1 font-medium">{t("settings.googleEdit.colYesterday")}</th>
          </tr>
        </thead>
        <tbody>
          {hs.map((h) => {
            const x = hours[h];
            const d = lastDay[h] ?? 0;
            acc += d;
            const cpa = x?.conversions ? x.spend / x.conversions : null;
            return (
              <tr key={h} className={h >= 17 ? "bg-amber-50/40" : ""}>
                <td className="py-0.5 pr-2 tabular-nums">{hhmm(h, 0)}</td>
                <td className="py-0.5 pr-2">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="inline-block h-2 rounded bg-indigo-400" style={{ width: `${Math.max(2, ((x?.conversions ?? 0) / maxConv) * 56)}px` }} />
                    <span className="tabular-nums">{num(x?.conversions ?? 0)}</span>
                  </span>
                </td>
                <td className="py-0.5 pr-2 text-right tabular-nums">{money(cpa, "VND")}</td>
                <td className="py-0.5">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="inline-block h-2 rounded bg-slate-400" style={{ width: `${Math.max(d ? 2 : 0, (d / maxDay) * 56)}px` }} />
                    <span className="whitespace-nowrap tabular-nums text-mut">
                      {d ? money(d, "VND") : "—"}
                      {budget && d && acc >= 0.9 * budget && acc - d < 0.9 * budget ? ` · ${t("settings.googleEdit.nearlyOut")}` : ""}
                    </span>
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export type CampaignEdit = {
  id: string;
  name: string;
  status: string;
  channelType: string;
  biddingStrategy: string;
  dailyBudget: number | null;
  targetCpa: number | null;
  budgetShared: boolean;
  hasBudget: boolean;
  spend: number;
  conversions: number;
  devices: Partial<Record<Device, { spend: number; clicks: number; conversions: number; bidModifier: number | null }>>;
  negatives: { text: string; matchType: string }[];
  schedule: SchedSlot[];
  hours: Record<string, { spend: number; clicks: number; conversions: number }>;
  lastDayHours: Record<string, number>;
};

/** Panel with a tap-to-collapse/expand header on mobile (collapsed by default to see all 4 sections); always open on desktop, no tappable header. */
function Fold({ title, sub, className = "", children }: { title: string; sub?: string; className?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-w-0 rounded-lg border border-line">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-full items-center justify-between gap-3 px-3 py-3 text-left @3xl:hidden">
        <span className="min-w-0">
          <span className="block font-medium text-ink">{title}</span>
          {sub && <span className="block truncate text-xs text-mut">{sub}</span>}
        </span>
        <ChevronDown className={`size-4 shrink-0 text-mut transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      <div className={`${open ? "block border-t border-line" : "hidden"} p-3 @3xl:block @3xl:border-t-0 ${className}`}>{children}</div>
    </div>
  );
}

/** Manually edit a campaign: on/off, budget, target CPA, devices, add negatives. Sent to Google right after confirmation. */
export function GoogleCampaignEditor({ clientId, campaigns }: { clientId: string; campaigns: CampaignEdit[] }) {
  const t = useT();
  const { pending, go, note } = useRun();
  const [id, setId] = useState(campaigns[0]?.id ?? "");
  const c = campaigns.find((x) => x.id === id);
  const [budget, setBudget] = useState("");
  const [tcpa, setTcpa] = useState("");
  const [negText, setNegText] = useState("");
  const [negMatch, setNegMatch] = useState<MatchType>("PHRASE");
  const [sched, setSched] = useState<SchedDraft>(() => schedOf(c?.schedule ?? []));
  if (!c) return <p className="text-sm text-mut">{t("settings.googleEdit.noCampaigns")}</p>;

  const send = (p: GChangeParams, ask: string, ok = t("settings.googleEdit.editedOnGoogle")) => go(() => googleManualChangeAction(clientId, c.id, p), ok, `${c.name}\n\n${ask}`);
  const canCpa = ["MAXIMIZE_CONVERSIONS", "TARGET_CPA"].includes(c.biddingStrategy);
  const negLines = [...new Set(negText.split(/\n/).map((s) => s.trim()).filter(Boolean))];

  return (
    <div className="space-y-4 text-sm">
      <select
        className={`${inputClass} max-w-xl`}
        value={id}
        onChange={(e) => {
          setId(e.target.value);
          setBudget("");
          setTcpa("");
          setSched(schedOf(campaigns.find((x) => x.id === e.target.value)?.schedule ?? []));
        }}
      >
        {campaigns.map((x) => (
          <option key={x.id} value={x.id}>
            {x.status === "ENABLED" ? "● " : "○ "}
            {x.name}
          </option>
        ))}
      </select>

      <div className="grid gap-4 @3xl:grid-cols-2">
        <Fold
          title={t("settings.googleEdit.statusBudget")}
          sub={`${c.status === "ENABLED" ? t("settings.googleEdit.on") : c.status === "PAUSED" ? t("settings.googleEdit.paused") : c.status} · ${money(c.dailyBudget, "VND")}${t("settings.googleEdit.perDay")}${c.targetCpa ? ` · ${t("settings.googleEdit.targetCpa")} ${money(c.targetCpa, "VND")}` : ""}`}
          className="space-y-3"
        >
          <div className="flex items-center justify-between gap-2">
            <span>
              {t("settings.googleEdit.statusLabel")} <b>{c.status === "ENABLED" ? t("settings.googleEdit.on") : c.status === "PAUSED" ? t("settings.googleEdit.paused") : c.status}</b>
            </span>
            <button
              type="button"
              className={btnClass(c.status === "ENABLED" ? "secondary" : "primary")}
              disabled={pending}
              onClick={() => send({ kind: "campaign_status", status: c.status === "ENABLED" ? "PAUSED" : "ENABLED" }, c.status === "ENABLED" ? t("settings.googleEdit.confirmPause") : t("settings.googleEdit.confirmEnable"))}
            >
              {c.status === "ENABLED" ? t("settings.googleEdit.pause") : t("settings.googleEdit.enable")}
            </button>
          </div>
          <div>
            <p className="mb-1 text-xs text-slate-600">
              {t("settings.googleEdit.dailyBudget")} <b>{money(c.dailyBudget, "VND")}</b>
              {c.budgetShared && <span className="text-amber-700"> · {t("settings.googleEdit.sharedBudget")}</span>}
            </p>
            <div className="flex gap-2">
              <input className={`${inputClass} w-36!`} value={budget} onChange={(e) => setBudget(e.target.value)} placeholder={t("settings.googleEdit.budgetExample")} disabled={!c.hasBudget} />
              <button
                type="button"
                className={btnClass("secondary")}
                disabled={pending || !c.hasBudget || !parseMoney(budget)}
                onClick={() => send({ kind: "budget", amount: parseMoney(budget)! }, t("settings.googleEdit.confirmBudget", { from: money(c.dailyBudget, "VND"), to: money(parseMoney(budget), "VND") }))}
              >
                {t("settings.googleEdit.save")}
              </button>
            </div>
          </div>
          <div>
            <p className="mb-1 text-xs text-slate-600">
              {t("settings.googleEdit.targetCpa")}: <b>{c.targetCpa ? money(c.targetCpa, "VND") : t("settings.googleEdit.notSet")}</b>
              {c.conversions > 0 && <span className="text-mut"> · {t("settings.googleEdit.actual30", { amount: money(c.spend / c.conversions, "VND") })}</span>}
            </p>
            {canCpa ? (
              <div className="flex flex-wrap gap-2">
                <input className={`${inputClass} w-36!`} value={tcpa} onChange={(e) => setTcpa(e.target.value)} placeholder={t("settings.googleEdit.cpaExample")} />
                <button type="button" className={btnClass("secondary")} disabled={pending || !parseMoney(tcpa)} onClick={() => send({ kind: "target_cpa", value: parseMoney(tcpa)! }, t("settings.googleEdit.confirmSetCpa", { amount: money(parseMoney(tcpa), "VND") }))}>
                  {t("settings.googleEdit.save")}
                </button>
                {c.targetCpa != null && c.biddingStrategy === "MAXIMIZE_CONVERSIONS" && (
                  <button type="button" className={btnClass("ghost")} disabled={pending} onClick={() => send({ kind: "target_cpa", value: null }, t("settings.googleEdit.confirmRemoveCpa", { amount: money(c.targetCpa, "VND") }))}>
                    {t("settings.googleEdit.removeCpa")}
                  </button>
                )}
              </div>
            ) : (
              <p className="text-xs text-mut">{t("settings.googleEdit.notMaxConv")}</p>
            )}
          </div>
        </Fold>

        <Fold
          title={t("settings.googleEdit.devices")}
          sub={(["MOBILE", "DESKTOP", "TABLET"] as const).filter((d) => c.devices[d]?.bidModifier === 0).map((d) => t("settings.googleEdit.deviceOff", { device: t(`settings.googleWrite.device.${d}`) })).join(" · ") || t("settings.googleEdit.allDevices")}
          className="space-y-3"
        >
          <p className="hidden text-xs text-slate-600 @3xl:block">{t("settings.googleEdit.devices30")}</p>
          <div className="-mx-3 overflow-x-auto px-3">
          <table className="w-full text-sm">
            <tbody className="divide-y divide-slate-100">
              {(["MOBILE", "DESKTOP", "TABLET"] as const).map((d) => {
                const x = c.devices[d];
                const off = x?.bidModifier === 0;
                return (
                  <tr key={d} className={off ? "text-mut" : ""}>
                    <td className="py-1 pr-2">
                      {t(`settings.googleWrite.device.${d}`)}
                      {off ? ` · ${t("settings.googleEdit.turnedOff")}` : x?.bidModifier != null && x.bidModifier !== 1 ? ` · ${x.bidModifier > 1 ? "+" : ""}${Math.round((x.bidModifier - 1) * 100)}%` : ""}
                      <span className="block text-xs text-mut tabular-nums @3xl:hidden">
                        {money(x?.spend ?? 0, "VND")} · {num(x?.conversions ?? 0, 1)} {t("settings.googleEdit.convShort")}{x?.conversions ? ` · ${money(x.spend / x.conversions, "VND")}/${t("settings.googleEdit.convShort")}` : ""}
                      </span>
                    </td>
                    <td className="hidden py-1 pr-2 text-right tabular-nums whitespace-nowrap @3xl:table-cell">{money(x?.spend ?? 0, "VND")}</td>
                    <td className="hidden py-1 pr-2 text-right tabular-nums @3xl:table-cell">{num(x?.conversions ?? 0, 1)} {t("settings.googleEdit.convShort")}</td>
                    <td className="hidden py-1 pr-2 text-right tabular-nums whitespace-nowrap @3xl:table-cell">{x?.conversions ? money(x.spend / x.conversions, "VND") : "—"}</td>
                    <td className="py-1 text-right">
                      <button
                        type="button"
                        className={btnClass("ghost")}
                        disabled={pending}
                        onClick={() => send({ kind: "device", device: d, bidModifier: off ? null : 0 }, off ? t("settings.googleEdit.confirmDeviceOn", { device: t(`settings.googleWrite.device.${d}`).toLowerCase() }) : t("settings.googleEdit.confirmDeviceOff", { device: t(`settings.googleWrite.device.${d}`).toLowerCase() }))}
                      >
                        {off ? t("settings.googleEdit.turnBackOn") : t("settings.googleEdit.turnOff")}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </Fold>
      </div>

      <Fold title={t("settings.googleEdit.schedule")} sub={fmtSchedule(c.schedule, t)}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-xs text-slate-600">
            {t("settings.googleEdit.schedule")}: <b className="text-ink">{fmtSchedule(c.schedule, t)}</b>
          </p>
          <p className="text-xs text-mut">{t("settings.googleEdit.scheduleHint")}</p>
        </div>
        <div className="mt-2 flex flex-wrap items-end gap-3">
          <ScheduleInputs value={sched} onChange={setSched} disabled={pending} />
          <button
            type="button"
            className={btnClass("secondary")}
            disabled={pending || !sched.days.length || sched.start >= sched.end}
            onClick={() => send(schedParams(sched), `${t("settings.googleEdit.confirmSchedule")}\n${fmtSchedule(c.schedule, t)}\n→ ${fmtSchedule(sched.days.map((day) => ({ day, startHour: Math.floor(sched.start / 60), startMinute: sched.start % 60, endHour: Math.floor(sched.end / 60), endMinute: sched.end % 60 })), t)}`)}
          >
            {t("settings.googleEdit.saveSchedule")}
          </button>
        </div>
        <HourTable hours={c.hours} lastDay={c.lastDayHours} budget={c.dailyBudget} />
      </Fold>

      {c.channelType === "SEARCH" || c.channelType === "PERFORMANCE_MAX" ? (
        <Fold title={t("settings.googleEdit.addNegatives")} sub={t("settings.googleEdit.haveN", { n: c.negatives.length })}>
          <p className="mb-1 text-xs text-slate-600">
            {t("settings.googleEdit.addNegativesHelp", { n: c.negatives.length })}
          </p>
          <div className="flex flex-wrap items-start gap-2">
            <textarea className={`${inputClass} min-h-20 max-w-md`} value={negText} onChange={(e) => setNegText(e.target.value)} placeholder={t("settings.googleEdit.negExamples")} />
            <select className={`${inputClass} w-32!`} value={negMatch} onChange={(e) => setNegMatch(e.target.value as MatchType)}>
              {(["PHRASE", "EXACT", "BROAD"] as const).map((m) => (
                <option key={m} value={m}>
                  {t(`settings.googleEdit.match.${m}`)}
                </option>
              ))}
            </select>
            <button
              type="button"
              className={btnClass("secondary")}
              disabled={pending || !negLines.length}
              onClick={() => {
                send({ kind: "negatives", items: negLines.map((text) => ({ text, matchType: negMatch })) }, `${t("settings.googleEdit.confirmNegatives", { n: negLines.length, match: t(`settings.googleEdit.match.${negMatch}`) })}\n${negLines.slice(0, 15).join(", ")}${negLines.length > 15 ? "…" : ""}`);
                setNegText("");
              }}
            >
              {t("settings.googleEdit.addNegBtn")}
            </button>
          </div>
          {c.negatives.length > 0 && (
            <details className="mt-2 text-xs text-mut">
              <summary className="cursor-pointer">{t("settings.googleEdit.viewNegatives")}</summary>
              <p className="mt-1">{c.negatives.map((x) => `${x.text}${x.matchType === "EXACT" ? ` [${t("settings.googleEdit.exactTag")}]` : x.matchType === "PHRASE" ? ` "${t("settings.googleEdit.phraseTag")}"` : ""}`).join(" · ")}</p>
            </details>
          )}
        </Fold>
      ) : null}
      {pending && (
        <p className="flex items-center gap-2 text-xs text-mut">
          <Spinner /> {t("settings.googleEdit.sending")}
        </p>
      )}
      {note}
    </div>
  );
}

/** Auto-draft a new ad group for a Search campaign (creates a pre-filled card awaiting approval). */
export function DraftGroupButton({ clientId, campaigns }: { clientId: string; campaigns: { id: string; name: string }[] }) {
  const t = useT();
  const { pending, go, note } = useRun();
  const [id, setId] = useState(campaigns[0]?.id ?? "");
  if (!campaigns.length) return null;
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {campaigns.length > 1 && (
          <select className={`${inputClass} w-64! py-1`} value={id} onChange={(e) => setId(e.target.value)}>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
        <button type="button" className={btnClass("secondary")} disabled={pending || !id} onClick={() => go(() => googleDraftGroupAction(clientId, id), t("settings.googleEdit.draftCreated"))}>
          {pending && <Spinner />}{t("settings.googleEdit.draftBtn")}
        </button>
      </div>
      {note}
    </div>
  );
}
