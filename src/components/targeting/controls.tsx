"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  cancelTargetingRunAction,
  clearScanApiAction,
  deleteSeedSetAction,
  saveScanApiAction,
  saveSeedSetAction,
  saveTargetingSettingsAction,
  searchMetaTargetingAction,
  startTargetingRunAction,
} from "@/app/targeting-actions";
import { Check, Copy, Search } from "lucide-react";
import type { LiveHitView } from "@/app/targeting-actions";
import { btnClass, inputClass } from "../ui";
import { Spinner } from "../action-button";
import { useT } from "@/i18n/client";

type Res = { ok: true } | { ok: false; error: string };

function useAct() {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const router = useRouter();
  const run = (fn: () => Promise<Res>, okText: string) =>
    start(async () => {
      const r = await fn();
      setMsg(r.ok ? { ok: true, text: okText } : { ok: false, text: r.error });
      if (r.ok) router.refresh();
    });
  return { pending, msg, run };
}

const Msg = ({ msg }: { msg: { ok: boolean; text: string } | null }) =>
  msg && <span className={`text-sm ${msg.ok ? "text-emerald-600" : "text-rose-600"}`}>{msg.text}</span>;

/** Auto-reload the page every 5 seconds while a run is queued/running to show progress. */
export function AutoRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(t);
  }, [active, router]);
  return null;
}

export function StartRun({ seedSets, disabledReason }: { seedSets: { id: string; name: string; count: number; active: boolean }[]; disabledReason: string | null }) {
  const t = useT();
  const { pending, msg, run } = useAct();
  const [sets, setSets] = useState<string[]>(seedSets.filter((s) => s.active).map((s) => s.id));
  const [rounds, setRounds] = useState(2);
  const [maxCalls, setMaxCalls] = useState(3000);
  const [scope, setScope] = useState("weekly");
  const [findScope, setFindScope] = useState("unchecked");
  const card = "flex flex-col gap-3 rounded-xl border border-slate-200 bg-panel p-4";

  return (
    <div className="space-y-3">
      {disabledReason && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">{disabledReason}</p>}
      <div className="grid gap-3 @4xl:grid-cols-2 @7xl:grid-cols-4">
        <div className={card}>
          <div>
            <p className="font-medium text-slate-900">{t("targeting.controls.start.catalogTitle")}</p>
            <p className="mt-1 text-sm text-slate-600">{t("targeting.controls.start.catalogDesc")}</p>
          </div>
          <button type="button" className={`${btnClass("secondary")} mt-auto`} disabled={pending || !!disabledReason} onClick={() => run(() => startTargetingRunAction("catalog", {}), t("targeting.controls.start.catalogQueued"))}>
            {t("targeting.controls.start.catalogRun")}
          </button>
        </div>
        <div className={card}>
          <div>
            <p className="font-medium text-slate-900">{t("targeting.controls.start.expandTitle")}</p>
            <p className="mt-1 text-sm text-slate-600">{t("targeting.controls.start.expandDesc")}</p>
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {seedSets.map((s) => (
              <label key={s.id} className="flex items-center gap-1.5 text-sm text-slate-700">
                <input type="checkbox" className="accent-indigo-600" checked={sets.includes(s.id)} onChange={(e) => setSets(e.target.checked ? [...sets, s.id] : sets.filter((x) => x !== s.id))} />
                {s.name} <span className="text-xs text-slate-400">({s.count})</span>
              </label>
            ))}
          </div>
          <div className="flex gap-2 text-sm">
            <label className="flex-1">
              <span className="text-xs text-slate-500">{t("targeting.controls.start.rounds")}</span>
              <select className={inputClass} value={rounds} onChange={(e) => setRounds(Number(e.target.value))}>
                {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{t("targeting.controls.start.roundsOption", { n })}</option>)}
              </select>
            </label>
            <label className="flex-1">
              <span className="text-xs text-slate-500">{t("targeting.controls.start.maxCalls")}</span>
              <select className={inputClass} value={maxCalls} onChange={(e) => setMaxCalls(Number(e.target.value))}>
                {[1000, 3000, 6000, 10000].map((n) => <option key={n} value={n}>{n.toLocaleString("vi-VN")}</option>)}
              </select>
            </label>
          </div>
          <p className="text-xs text-slate-500">{t("targeting.controls.start.eta", { from: Math.round((maxCalls * 0.5) / 60), to: Math.round((maxCalls * 1) / 60) })}</p>
          <button
            type="button"
            className={`${btnClass("secondary")} mt-auto`}
            disabled={pending || !!disabledReason || !sets.length}
            onClick={() => run(() => startTargetingRunAction("expand", { seedSetIds: sets, rounds, maxCalls }), t("targeting.controls.start.expandQueued"))}
          >
            {t("targeting.controls.start.expandRun")}
          </button>
        </div>
        <div className={card}>
          <div>
            <p className="font-medium text-slate-900">{t("targeting.controls.start.reachTitle")}</p>
            <p className="mt-1 text-sm text-slate-600">{t("targeting.controls.start.reachDesc")}</p>
          </div>
          <label className="text-sm">
            <span className="text-xs text-slate-500">{t("targeting.controls.start.scope")}</span>
            <select className={inputClass} value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="new">{t("targeting.controls.start.scopeNew")}</option>
              <option value="weekly">{t("targeting.controls.start.scopeWeekly")}</option>
              <option value="all">{t("targeting.controls.start.scopeAll")}</option>
            </select>
          </label>
          <button type="button" className={`${btnClass("secondary")} mt-auto`} disabled={pending || !!disabledReason} onClick={() => run(() => startTargetingRunAction("reach", { scope }), t("targeting.controls.start.reachQueued"))}>
            {t("targeting.controls.start.reachRun")}
          </button>
        </div>
        <div className={card}>
          <div>
            <p className="font-medium text-slate-900">{t("targeting.controls.start.findTitle")}</p>
            <p className="mt-1 text-sm text-slate-600">
              {t("targeting.controls.start.findDesc")}
            </p>
          </div>
          <label className="text-sm">
            <span className="text-xs text-slate-500">{t("targeting.controls.start.scope")}</span>
            <select className={inputClass} value={findScope} onChange={(e) => setFindScope(e.target.value)}>
              <option value="unchecked">{t("targeting.controls.start.findUnchecked")}</option>
              <option value="priority">{t("targeting.controls.start.findPriority")}</option>
              <option value="all">{t("targeting.controls.start.findAll")}</option>
            </select>
          </label>
          <p className="text-xs text-slate-500">{t("targeting.controls.start.findCalls")}</p>
          <button type="button" className={`${btnClass("secondary")} mt-auto`} disabled={pending || !!disabledReason} onClick={() => run(() => startTargetingRunAction("find", { scope: findScope }), t("targeting.controls.start.findQueued"))}>
            {t("targeting.controls.start.findRun")}
          </button>
        </div>
      </div>
      <p className="flex items-center gap-2 text-xs text-slate-500">
        {pending && <Spinner />}{t("targeting.controls.start.footer")} <Msg msg={msg} />
      </p>
    </div>
  );
}

export function CancelRun({ id }: { id: string }) {
  const t = useT();
  const { pending, msg, run } = useAct();
  return (
    <span className="inline-flex items-center gap-2">
      <button type="button" className={`${btnClass("ghost")} text-rose-600`} disabled={pending} onClick={() => confirm(t("targeting.controls.cancel.confirm")) && run(() => cancelTargetingRunAction(id), t("targeting.controls.cancel.done"))}>
        {t("targeting.controls.cancel.btn")}
      </button>
      <Msg msg={msg} />
    </span>
  );
}

export function SeedSetEditor({ set }: { set?: { id: string; name: string; keywords: string[]; active: boolean } }) {
  const t = useT();
  const { pending, msg, run } = useAct();
  const [name, setName] = useState(set?.name ?? "");
  const [keywords, setKeywords] = useState(set?.keywords.join("\n") ?? "");
  const [active, setActive] = useState(set?.active ?? true);
  const [open, setOpen] = useState(!set);
  const count = keywords.split(/\n|,/).filter((k) => k.trim()).length;

  if (set && !open) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-panel p-4">
        <div className="min-w-0">
          <p className="font-medium text-slate-900">
            {set.name} {!set.active && <span className="text-xs font-normal text-slate-400">{t("targeting.controls.seed.off")}</span>}
          </p>
          <p className="truncate text-xs text-slate-500">{t("targeting.controls.seed.keywords", { n: set.keywords.length, list: set.keywords.slice(0, 12).join(", ") })}</p>
        </div>
        <button type="button" className={btnClass("secondary")} onClick={() => setOpen(true)}>{t("targeting.controls.seed.edit")}</button>
      </div>
    );
  }
  return (
    <div className="space-y-3 rounded-xl border border-indigo-200 bg-panel p-4">
      <div className="flex flex-wrap items-center gap-3">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("targeting.controls.seed.namePlaceholder")} className={`${inputClass} max-w-xs`} />
        <label className="flex items-center gap-1.5 text-sm text-slate-700">
          <input type="checkbox" className="accent-indigo-600" checked={active} onChange={(e) => setActive(e.target.checked)} />
          {t("targeting.controls.seed.active")}
        </label>
      </div>
      <textarea
        value={keywords}
        onChange={(e) => setKeywords(e.target.value)}
        rows={8}
        className={`${inputClass} font-mono text-[13px]`}
        placeholder={`${t("targeting.controls.seed.keywordsPlaceholder")}\nnhà hàng\nẩm thực Việt\nVietnamese cuisine\nstreet food`}
      />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={btnClass("primary")} disabled={pending} onClick={() => run(() => saveSeedSetAction({ id: set?.id, name, keywords, active }), t("targeting.controls.seed.saved"))}>
          {pending && <Spinner />}{t("targeting.controls.seed.save", { n: count })}
        </button>
        {set && (
          <>
            <button type="button" className={btnClass("ghost")} onClick={() => setOpen(false)}>{t("targeting.controls.seed.close")}</button>
            <button type="button" className={`${btnClass("ghost")} text-rose-600`} disabled={pending} onClick={() => confirm(t("targeting.controls.seed.deleteConfirm", { name: set.name })) && run(() => deleteSeedSetAction(set.id), t("targeting.controls.seed.deleted"))}>
              {t("targeting.controls.seed.delete")}
            </button>
          </>
        )}
        <Msg msg={msg} />
      </div>
    </div>
  );
}

export function TargetingSettings({ clients, scanClientId, autoUpdate }: { clients: { id: string; name: string; act: string }[]; scanClientId: string; autoUpdate: boolean }) {
  const t = useT();
  const { pending, msg, run } = useAct();
  const [client, setClient] = useState(scanClientId);
  const [auto, setAuto] = useState(autoUpdate);
  return (
    <div className="space-y-4">
      <label className="block max-w-md text-sm">
        <span className="mb-1 block font-medium text-slate-700">{t("targeting.controls.settings.scanClient")}</span>
        <select className={inputClass} value={client} onChange={(e) => setClient(e.target.value)}>
          <option value="">{t("targeting.controls.settings.autoPick")}</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>{c.name} · {c.act}</option>
          ))}
        </select>
        <span className="mt-1 block text-xs text-slate-500">
          {t("targeting.controls.settings.scanHint")}
        </span>
      </label>
      <label className="flex items-start gap-2 text-sm text-slate-700">
        <input type="checkbox" className="mt-0.5 accent-indigo-600" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
        <span>
          <b>{t("targeting.controls.settings.auto")}</b>
          <span className="block text-xs text-slate-500">{t("targeting.controls.settings.autoHint")}</span>
        </span>
      </label>
      <div className="flex items-center gap-3">
        <button type="button" className={btnClass("primary")} disabled={pending} onClick={() => run(() => saveTargetingSettingsAction({ scanClientId: client, autoUpdate: auto }), t("targeting.controls.settings.saved"))}>
          {pending && <Spinner />}{t("targeting.controls.settings.save")}
        </button>
        <Msg msg={msg} />
      </div>
    </div>
  );
}

/** The agency's own API for scanning (recommended): ad account ID + token, verified before saving. */
export function ScanApi({ current }: { current: { act: string; owner: string; expiresAt: string } | null }) {
  const t = useT();
  const { pending, msg, run } = useAct();
  const [act, setAct] = useState(current?.act ?? "");
  const [token, setToken] = useState("");
  const [editing, setEditing] = useState(!current);
  const exp = current?.expiresAt ? new Date(current.expiresAt) : null;

  return (
    <div className="space-y-3 rounded-xl border border-indigo-100 bg-indigo-50/40 p-4">
      <div>
        <p className="font-medium text-slate-900">{t("targeting.controls.api.title")}</p>
        <p className="text-xs text-slate-500">{t("targeting.controls.api.desc")}</p>
      </div>
      {current && !editing ? (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-emerald-700">
            {t("targeting.controls.api.current", { act: current.act, owner: "\u0001" }).split("\u0001").flatMap((part, i) => (i ? [<b key="o">{current.owner}</b>, part] : [part]))}
            {exp ? t("targeting.controls.api.expires", { date: exp.toLocaleDateString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }) }) : t("targeting.controls.api.noExpiry")}
          </span>
          <button type="button" className={btnClass("secondary")} onClick={() => setEditing(true)}>{t("targeting.controls.api.change")}</button>
          <button
            type="button"
            className={`${btnClass("ghost")} text-rose-600`}
            disabled={pending}
            onClick={() => confirm(t("targeting.controls.api.removeConfirm")) && run(() => clearScanApiAction(), t("targeting.controls.api.removed"))}
          >
            {t("targeting.controls.api.remove")}
          </button>
          <Msg msg={msg} />
        </div>
      ) : (
        <div className="space-y-2">
          <div className="grid gap-2 @2xl:grid-cols-[16rem_1fr]">
            <input value={act} onChange={(e) => setAct(e.target.value)} placeholder="act_1234567890" className={inputClass} autoComplete="off" />
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={t("targeting.controls.api.tokenPlaceholder")} className={inputClass} autoComplete="off" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={btnClass("primary")}
              disabled={pending || !act || !token}
              onClick={() =>
                run(async () => {
                  const r = await saveScanApiAction({ act, token });
                  if (r.ok) {
                    setToken("");
                    setEditing(false);
                  }
                  return r;
                }, t("targeting.controls.api.verified"))
              }
            >
              {pending && <Spinner />}{t("targeting.controls.api.verify")}
            </button>
            {current && <button type="button" className={btnClass("ghost")} onClick={() => setEditing(false)}>{t("targeting.controls.api.cancel")}</button>}
            <Msg msg={msg} />
          </div>
          <p className="text-xs text-slate-500">{t("targeting.controls.api.encrypted")}</p>
        </div>
      )}
    </div>
  );
}

/** "Chép" (Copy) button: copies the exact text that was verified to exist in Ads Manager. */
export function CopyText({ text, label }: { text: string; label?: string }) {
  const t = useT();
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      title={t("targeting.controls.copy.title", { text })}
      className={`inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium transition ${done ? "border-emerald-300 bg-emerald-50 text-emerald-700" : "border-line bg-panel text-ink2 hover:border-indigo-300 hover:text-indigo-700"}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {}
      }}
    >
      {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {done ? t("targeting.controls.copy.done") : (label ?? t("targeting.controls.copy.label"))}
    </button>
  );
}

/** Filter select: changing it filters immediately, no button needed. */
export function FilterSelect({ name, value, options, label }: { name: string; value: string; label: string; options: { value: string; label: string; group?: string }[] }) {
  const groups = [...new Set(options.map((o) => o.group ?? ""))];
  const opt = (o: { value: string; label: string }) => <option key={o.value} value={o.value}>{o.label}</option>;
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-[11px] font-medium text-mut">{label}</span>
      <select
        name={name}
        defaultValue={value}
        className={`${inputClass} w-full min-w-0 @2xl:w-auto`}
        onChange={(e) => {
          const f = e.currentTarget.form;
          f?.querySelector<HTMLInputElement>("input[name=page]")?.remove();
          f?.requestSubmit();
        }}
      >
        {groups.map((g) => (g ? <optgroup key={g} label={g}>{options.filter((o) => o.group === g).map(opt)}</optgroup> : options.filter((o) => !o.group).map(opt)))}
      </select>
    </label>
  );
}

/** Search Meta directly (the Ads Manager search box) when the Library lacks the needed item. Items found and usable are added to the Library automatically. */
export function MetaSearch({ q }: { q: string }) {
  const t = useT();
  const [pending, start] = useTransition();
  const [res, setRes] = useState<{ q: string; hits: LiveHitView[] } | { q: string; error: string } | null>(null);
  const router = useRouter();
  const shown = res?.q === q ? res : null;
  return (
    <div className="rounded-xl border border-dashed border-indigo-200 bg-indigo-50/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink">{t("targeting.controls.search.title")}</p>
          <p className="text-xs text-mut">{t("targeting.controls.search.desc", { q })}</p>
        </div>
        <button
          type="button"
          className={btnClass("secondary")}
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await searchMetaTargetingAction(q);
              setRes(r.ok ? { q, hits: r.hits } : { q, error: r.error });
              if (r.ok && r.hits.some((h) => h.isNew)) router.refresh();
            })
          }
        >
          {pending ? <Spinner /> : <Search className="size-4" />}
          {t("targeting.controls.search.btn")}
        </button>
      </div>
      {shown && "error" in shown && <p className="mt-3 text-sm text-rose-600">{shown.error}</p>}
      {shown && "hits" in shown && (
        shown.hits.length ? (
          <ul className="mt-3 divide-y divide-line rounded-lg border border-line bg-panel">
            {shown.hits.map((h) => (
              <li key={h.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-ink">
                    {h.name} {h.isNew && <span className="ml-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">{t("targeting.controls.search.added")}</span>}
                  </p>
                  <p className="truncate text-xs text-mut">{h.typeLabel}{h.path && ` · ${h.path}`}</p>
                </div>
                {h.size && <span className="text-xs text-mut tabular-nums">{t("targeting.controls.search.global", { size: h.size })}</span>}
                <span className="text-xs text-mut">{t("targeting.controls.search.rank", { rank: h.rank })}</span>
                <CopyText text={h.copy} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-mut">{t("targeting.controls.search.none", { q })}</p>
        )
      )}
    </div>
  );
}
