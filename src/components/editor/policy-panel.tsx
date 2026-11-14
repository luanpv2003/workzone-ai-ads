"use client";

import type { EditableAd, EditablePlan } from "@/lib/ai/schemas";
import { adContentKey, specialLabel, type DraftPolicy, type PolicyEntry, type PolicyGate } from "@/lib/draft-policy-rules";
import { btnClass } from "../ui";
import { Spinner } from "../action-button";
import { useT } from "@/i18n/client";

// Content policy check in the editor: must pass before publishing (the server also blocks it in publishDraft).

const VERDICT = {
  safe: { label: "campaigns.policyPanel.verdictSafe", cls: "border-emerald-200 bg-emerald-50 text-emerald-800" },
  fix: { label: "campaigns.policyPanel.verdictFix", cls: "border-amber-200 bg-amber-50 text-amber-800" },
  reject: { label: "campaigns.policyPanel.verdictReject", cls: "border-rose-200 bg-rose-50 text-rose-700" },
} as const;
const SEVERITY = { high: "text-rose-700", medium: "text-amber-700", low: "text-slate-500" } as const;

export type PolicyJob = { status: string; error: string | null } | null;

/** Top bar button: status + run the check. */
export function PolicyStatus({ gate, checking, failed, onCheck, onShow }: { gate: PolicyGate; checking: boolean; failed: string | null; onCheck: () => void; onShow: () => void }) {
  const t = useT();
  if (checking)
    return (
      <span className="flex items-center gap-1.5 text-sm text-slate-600">
        <Spinner /> {t("campaigns.policyPanel.checking")}
      </span>
    );
  if (gate.unchecked.length)
    return (
      <button type="button" className={btnClass("secondary")} onClick={onCheck} title={failed ? t("campaigns.policyPanel.lastFailed", { error: failed }) : undefined}>
        {t("campaigns.policyPanel.checkPolicy", { count: gate.unchecked.length })}
      </button>
    );
  const cls = gate.blocked.length ? "text-rose-600" : gate.fix.length ? "text-amber-700" : "text-emerald-700";
  const label = gate.blocked.length ? t("campaigns.policyPanel.statusBlocked", { count: gate.blocked.length }) : gate.fix.length ? t("campaigns.policyPanel.statusFix", { count: gate.fix.length }) : t("campaigns.policyPanel.statusOk");
  return (
    <button type="button" onClick={onShow} className={`text-sm font-medium hover:underline ${cls}`}>
      {label}
    </button>
  );
}

/** Campaign-level summary: each ad and its result. */
export function DraftPolicyPanel({
  plan,
  policy,
  gate,
  checking,
  failed,
  readOnly,
  onCheck,
  onSelect,
}: {
  plan: EditablePlan;
  policy: DraftPolicy | null;
  gate: PolicyGate;
  checking: boolean;
  failed: string | null;
  readOnly: boolean;
  onCheck: (force: boolean) => void;
  onSelect: (i: number) => void;
}) {
  const t = useT();
  return (
    <div className="rounded-xl border border-slate-200 bg-panel p-4 text-sm">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h4 className="font-semibold text-slate-900">{t("campaigns.policyPanel.title")}</h4>
        {!readOnly && !checking && (
          <button type="button" className="text-xs text-indigo-600 hover:underline" onClick={() => onCheck(!gate.unchecked.length)}>
            {gate.unchecked.length ? t("campaigns.policyPanel.check") : t("campaigns.policyPanel.recheckAll")}
          </button>
        )}
      </div>
      <p className="mb-2 text-xs text-slate-500">{t("campaigns.policyPanel.intro")}</p>
      {checking && (
        <p className="mb-2 flex items-center gap-1.5 text-slate-600">
          <Spinner /> {t("campaigns.policyPanel.checkingLong")}
        </p>
      )}
      {failed && !checking && <p className="mb-2 text-rose-700">{t("campaigns.policyPanel.prevFailed", { error: failed })}</p>}
      {policy?.overall && !gate.unchecked.length && <p className="mb-2 text-slate-700">{policy.overall}</p>}
      <ul className="space-y-1">
        {plan.ads.map((ad, i) => {
          const r = policy?.results[adContentKey(ad)];
          const v = r ? VERDICT[r.verdict] : null;
          return (
            <li key={i}>
              <button type="button" onClick={() => onSelect(i)} className="flex w-full items-center justify-between gap-2 rounded-md px-1 py-0.5 text-left hover:bg-slate-50">
                <span className="truncate text-slate-700">{ad.name || t("campaigns.policyPanel.adN", { n: i + 1 })}</span>
                {v ? <span className={`shrink-0 rounded border px-1.5 text-xs ${v.cls}`}>{t(v.label)}</span> : <span className="shrink-0 text-xs text-slate-400">{t("campaigns.policyPanel.notChecked")}</span>}
              </button>
            </li>
          );
        })}
      </ul>
      {gate.special.length > 0 && (
        <p className="mt-2 text-xs text-amber-700">
          {t("campaigns.policyPanel.specialCategory", { categories: [...new Set(gate.special.map((s) => specialLabel(t, s.category)))].join(", ") })}
        </p>
      )}
    </div>
  );
}

/** Result for the selected ad + a button to apply Claude's fix. */
export function AdPolicyPanel({
  ad,
  entry,
  sameCount,
  checking,
  readOnly,
  onApply,
  onCheck,
}: {
  ad: EditableAd;
  entry: PolicyEntry | undefined;
  sameCount: number;
  checking: boolean;
  readOnly: boolean;
  onApply: (rewrite: { primary_text: string; headline: string }) => void;
  onCheck: () => void;
}) {
  const t = useT();
  if (!entry)
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
        {checking ? (
          <span className="flex items-center gap-1.5">
            <Spinner /> {t("campaigns.policyPanel.checking")}
          </span>
        ) : (
          <>
            <p>{t("campaigns.policyPanel.adUnchecked")}</p>
            {!readOnly && (
              <button type="button" className="mt-2 text-sm font-medium text-indigo-700 hover:underline" onClick={onCheck}>
                {t("campaigns.policyPanel.checkPolicyBtn")}
              </button>
            )}
          </>
        )}
      </div>
    );
  const v = VERDICT[entry.verdict];
  const existing = ad.source === "existing";
  return (
    <div className={`rounded-xl border p-3 text-sm ${v.cls}`}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <b>{t("campaigns.policyPanel.policyLabel", { verdict: t(v.label) })}</b>
        <span className="text-xs opacity-70">{new Date(entry.at).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" })}</span>
      </div>
      <p>{entry.summary}</p>
      {entry.issues.length > 0 && (
        <ul className="mt-2 space-y-2 text-slate-800">
          {entry.issues.map((x, i) => (
            <li key={i} className="rounded-md bg-white/70 p-2">
              <div className={`text-xs font-semibold ${SEVERITY[x.severity]}`}>
                {x.policy} · {x.severity === "high" ? t("campaigns.policyPanel.sevHigh") : x.severity === "medium" ? t("campaigns.policyPanel.sevMedium") : t("campaigns.policyPanel.sevLow")}
              </div>
              <div className="italic">“{x.quote}”</div>
              <div className="text-xs text-slate-600">{x.explain}</div>
              <div className="text-xs">→ {x.fix}</div>
            </li>
          ))}
        </ul>
      )}
      {entry.special_category !== "none" && <p className="mt-2 text-xs">{t("campaigns.policyPanel.specialEntry", { category: specialLabel(t, entry.special_category) })}</p>}
      {entry.creative_notes && <p className="mt-2 text-xs text-slate-600">{t("campaigns.policyPanel.creativeNotes", { notes: entry.creative_notes })}</p>}
      {entry.rewrite && !readOnly && (
        <div className="mt-2">
          {existing ? (
            <p className="text-xs">{t("campaigns.policyPanel.existingPost")}</p>
          ) : (
            <>
              <details className="text-xs">
                <summary className="cursor-pointer">{t("campaigns.policyPanel.viewRewrite")}</summary>
                <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded bg-white/70 p-2 font-sans text-slate-800">{entry.rewrite.primary_text}</pre>
                {entry.rewrite.headline && <p className="mt-1 text-slate-800">{t("campaigns.policyPanel.headline", { headline: entry.rewrite.headline })}</p>}
              </details>
              <button type="button" className={`${btnClass("secondary")} mt-2`} onClick={() => onApply(entry.rewrite!)}>
                {sameCount > 1 ? t("campaigns.policyPanel.useRewriteMany", { count: sameCount }) : t("campaigns.policyPanel.useRewrite")}
              </button>
              <p className="mt-1 text-xs opacity-70">{t("campaigns.policyPanel.recheckAfter")}</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
