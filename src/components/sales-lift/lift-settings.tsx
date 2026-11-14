"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { resuggestLiftAction, saveLiftAction, type LiftInput } from "@/app/sales-lift-actions";
import { Spinner } from "@/components/action-button";
import { btnClass, Field, inputClass } from "@/components/ui";
import { norm } from "@/lib/text";
import { useT } from "@/i18n/client";

type PickProduct = { id: string; code: string; name: string; perDay: number };

/** Measurement setup: every field is pre-filled by the system; the user edits, then Saves (numbers are recomputed immediately). */
export function LiftSettings({ liftId, initial, products, baseDays }: { liftId: string; initial: LiftInput; products: PickProduct[]; baseDays: number }) {
  const t = useT();
  const [v, setV] = useState<LiftInput>(initial);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();
  const router = useRouter();
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const set = (patch: Partial<LiftInput>) => {
    setV((x) => ({ ...x, ...patch }));
    setSaved(false);
  };
  const results = useMemo(() => {
    const k = norm(q.trim());
    if (!k) return [];
    return products.filter((p) => norm(`${p.name} ${p.code}`).includes(k)).slice(0, 30);
  }, [q, products]);

  const act = (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setError(null);
    start(async () => {
      const r = await fn();
      if (!r.ok) setError(r.error ?? t("settings.liftSettings.error"));
      else {
        setSaved(true);
        router.refresh();
      }
    });
  };

  const list = (kind: "testIds" | "controlIds") => (
    <ul className="divide-y divide-line rounded-lg border border-line">
      {v[kind].length ? (
        v[kind].map((id) => {
          const p = byId.get(id);
          return (
            <li key={id} className="flex items-center gap-2 px-3 py-1.5 text-sm">
              <span className="min-w-0 flex-1">
                {p?.name ?? t("settings.liftSettings.code", { id })} <span className="text-xs text-mut">{p?.code}</span>
              </span>
              <span className="text-xs whitespace-nowrap text-mut tabular-nums">{p ? t("settings.liftSettings.perDayBase", { n: p.perDay.toLocaleString("vi-VN", { maximumFractionDigits: 1 }) }) : t("settings.liftSettings.noBaseSale")}</span>
              <button type="button" className="text-xs text-rose-600 hover:underline" onClick={() => set({ [kind]: v[kind].filter((x) => x !== id) })}>
                {t("settings.liftSettings.remove")}
              </button>
            </li>
          );
        })
      ) : (
        <li className="px-3 py-2 text-sm text-mut">{kind === "testIds" ? t("settings.liftSettings.noneSelected") : t("settings.liftSettings.noControl")}</li>
      )}
    </ul>
  );

  return (
    <div className="space-y-5">
      <Field label={t("settings.liftSettings.name")}>
        <input className={inputClass} value={v.name} onChange={(e) => set({ name: e.target.value })} />
      </Field>

      <div className="grid gap-4 @3xl:grid-cols-2">
        <fieldset className="rounded-lg border border-line p-3">
          <legend className="px-1 text-sm font-medium text-ink2">{t("settings.liftSettings.runPeriod")}</legend>
          <div className="grid grid-cols-2 gap-2">
            <Field label={t("settings.liftSettings.from")}>
              <input type="date" className={inputClass} value={v.runStart} onChange={(e) => set({ runStart: e.target.value })} />
            </Field>
            <Field label={t("settings.liftSettings.to")} hint={t("settings.liftSettings.toHint")}>
              <input type="date" className={inputClass} value={v.runEnd} onChange={(e) => set({ runEnd: e.target.value })} />
            </Field>
          </div>
        </fieldset>
        <fieldset className="rounded-lg border border-line p-3">
          <legend className="px-1 text-sm font-medium text-ink2">{t("settings.liftSettings.basePeriod")}</legend>
          <div className="grid grid-cols-2 gap-2">
            <Field label={t("settings.liftSettings.from")}>
              <input type="date" className={inputClass} value={v.baseStart} onChange={(e) => set({ baseStart: e.target.value })} />
            </Field>
            <Field label={t("settings.liftSettings.to")}>
              <input type="date" className={inputClass} value={v.baseEnd} onChange={(e) => set({ baseEnd: e.target.value })} />
            </Field>
          </div>
          <p className="mt-1 text-xs text-mut">{t("settings.liftSettings.baseHelp", { days: baseDays })}</p>
        </fieldset>
      </div>

      <div className="grid gap-4 @3xl:grid-cols-2">
        <div>
          <p className="mb-1 text-sm font-medium text-ink2">{t("settings.liftSettings.testTitle")}</p>
          {list("testIds")}
        </div>
        <div>
          <p className="mb-1 text-sm font-medium text-ink2">{t("settings.liftSettings.controlTitle")}</p>
          {list("controlIds")}
        </div>
      </div>

      <div>
        <Field label={t("settings.liftSettings.addItem")} hint={t("settings.liftSettings.addItemHint")}>
          <input className={inputClass} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("settings.liftSettings.searchPlaceholder")} />
        </Field>
        {results.length > 0 && (
          <ul className="mt-2 max-h-72 divide-y divide-line overflow-y-auto rounded-lg border border-line">
            {results.map((p) => {
              const inT = v.testIds.includes(p.id);
              const inC = v.controlIds.includes(p.id);
              return (
                <li key={p.id} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                  <span className="min-w-0 flex-1">
                    {p.name} <span className="text-xs text-mut">{p.code}</span>
                  </span>
                  <span className="text-xs whitespace-nowrap text-mut tabular-nums">{t("settings.liftSettings.perDay", { n: p.perDay.toLocaleString("vi-VN", { maximumFractionDigits: 1 }) })}</span>
                  <button type="button" disabled={inT} className="text-xs text-indigo-700 hover:underline disabled:text-mut disabled:no-underline" onClick={() => set({ testIds: [...v.testIds, p.id], controlIds: v.controlIds.filter((x) => x !== p.id) })}>
                    {inT ? t("settings.liftSettings.inTest") : t("settings.liftSettings.addTest")}
                  </button>
                  <button type="button" disabled={inC} className="text-xs text-indigo-700 hover:underline disabled:text-mut disabled:no-underline" onClick={() => set({ controlIds: [...v.controlIds, p.id], testIds: v.testIds.filter((x) => x !== p.id) })}>
                    {inC ? t("settings.liftSettings.inControl") : t("settings.liftSettings.addControl")}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <Field label={t("settings.liftSettings.branchWords")} hint={t("settings.liftSettings.branchWordsHint")}>
        <textarea className={`${inputClass} font-mono text-xs`} rows={Math.min(12, Math.max(3, v.branchWords.split("\n").length + 1))} value={v.branchWords} onChange={(e) => set({ branchWords: e.target.value })} />
      </Field>

      <div className="grid gap-4 @3xl:grid-cols-2">
        <Field label={t("settings.liftSettings.manualSpend")} hint={t("settings.liftSettings.manualSpendHint")}>
          <input className={inputClass} inputMode="numeric" value={v.manualSpend} onChange={(e) => set({ manualSpend: e.target.value })} placeholder={t("settings.liftSettings.autoMeta")} />
        </Field>
        <Field label={t("settings.liftSettings.manualOrders")} hint={t("settings.liftSettings.manualOrdersHint")}>
          <input className={inputClass} inputMode="numeric" value={v.manualOrders} onChange={(e) => set({ manualOrders: e.target.value })} placeholder={t("settings.liftSettings.autoCount")} />
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={btnClass("primary")} disabled={pending} onClick={() => act(() => saveLiftAction(liftId, v))}>
          {pending && <Spinner />} {t("settings.liftSettings.saveRecalc")}
        </button>
        <button
          type="button"
          className={btnClass("secondary")}
          disabled={pending}
          onClick={() => {
            if (!confirm(t("settings.liftSettings.confirmResuggest"))) return;
            act(async () => {
              const r = await resuggestLiftAction(liftId);
              if (r.ok) window.location.reload();
              return r;
            });
          }}
        >
          {t("settings.liftSettings.resuggest")}
        </button>
        {saved && !pending && <span className="text-xs text-emerald-700">{t("settings.liftSettings.saved")}</span>}
        {error && <span className="text-sm text-rose-600">{error}</span>}
      </div>
    </div>
  );
}
