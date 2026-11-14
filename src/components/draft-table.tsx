"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMetaConfirm } from "./meta-confirm";
import { deleteDraftAction, duplicateDraftAction, publishAction } from "@/app/actions";
import { norm } from "@/lib/text";
import { dateTime, money } from "@/lib/format";
import { Badge, btnClass, inputClass } from "./ui";
import { Spinner } from "./action-button";
import { useT } from "@/i18n/client";

export type DraftRow = {
  id: string;
  name: string;
  objective: string;
  adSets: number;
  ads: number;
  budget: number;
  status: "draft" | "error" | "publishing" | "published";
  error: string | null;
  reviewErrors: string[];
  reviewWarnings: number;
  verify: { ok: boolean; bad: number } | null;
  updatedAt: string;
  adsManagerUrl: string | null;
};

const FILTERS = [
  { key: "all", label: "campaigns.draftTable.filterAll" },
  { key: "draft", label: "campaigns.draftTable.filterDraft" },
  { key: "error", label: "campaigns.draftTable.filterError" },
  { key: "published", label: "campaigns.draftTable.filterPublished" },
] as const;

export function DraftTable({ clientId, rows, currency, isMeta }: { clientId: string; rows: DraftRow[]; currency: string; isMeta: boolean }) {
  const t = useT();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("all");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [, start] = useTransition();
  const router = useRouter();
  const [dialog, ask] = useMetaConfirm();

  const shown = useMemo(() => {
    const k = norm(q.trim());
    return rows.filter((r) => (filter === "all" || r.status === filter) && (!k || norm(r.name).includes(k)));
  }, [rows, filter, q]);
  const count = (key: string) => (key === "all" ? rows.length : rows.filter((r) => r.status === key).length);

  const act = async (id: string, kind: "dup" | "del" | "pub", r: DraftRow) => {
    if (kind === "del" && !confirm(r.status === "published" ? t("campaigns.draftTable.confirmDeletePublished", { name: r.name }) : t("campaigns.draftTable.confirmDelete", { name: r.name }))) return;
    if (kind === "pub" && isMeta) {
      const ok = await ask({
        title: t("campaigns.draftTable.publishTitle", { name: r.name }),
        lines: [
          { label: t("campaigns.draftTable.createNew"), to: t("campaigns.draftTable.createNewValue", { adSets: r.adSets, ads: r.ads }) },
          { label: t("campaigns.draftTable.totalBudget"), to: t("campaigns.draftTable.perDay", { amount: money(r.budget, currency) }) },
          { label: t("campaigns.draftTable.status"), to: t("campaigns.draftTable.pausedValue") },
        ],
        confirmLabel: t("campaigns.draftTable.publishToMeta"),
      });
      if (!ok) return;
    }
    setBusy(`${kind}:${id}`);
    start(async () => {
      const res = kind === "dup" ? await duplicateDraftAction(id) : kind === "del" ? await deleteDraftAction(id) : await publishAction(id);
      setBusy(null);
      setMsg((m) => ({ ...m, [id]: res.ok ? { ok: true, text: kind === "pub" ? t("campaigns.draftTable.msgPublished") : kind === "dup" ? t("campaigns.draftTable.msgDuplicated") : t("campaigns.draftTable.msgDeleted") } : { ok: false, text: res.error } }));
      if (res.ok && kind === "dup" && res.id) router.push(`/clients/${clientId}/drafts/${res.id}`);
    });
  };

  return (
    <div className="space-y-3">
      {dialog}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={`rounded-md px-3 py-1 text-sm ${filter === f.key ? "bg-panel font-medium text-slate-900 shadow-sm" : "text-slate-600"}`}
            >
              {t(f.label)} <span className="text-xs text-slate-400">{count(f.key)}</span>
            </button>
          ))}
        </div>
        <input className={`${inputClass} max-w-xs`} placeholder={t("campaigns.draftTable.searchPlaceholder")} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-panel">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500">
            <tr>
              <th className="min-w-52 px-4 py-2 font-medium">{t("campaigns.draftTable.colCampaign")}</th>
              <th className="px-3 py-2 font-medium">{t("campaigns.draftTable.colObjective")}</th>
              <th className="px-3 py-2 text-right font-medium whitespace-nowrap">{t("campaigns.draftTable.colAdSetsAds")}</th>
              <th className="px-3 py-2 text-right font-medium whitespace-nowrap">{t("campaigns.draftTable.colDailyBudget")}</th>
              <th className="px-3 py-2 font-medium">{t("campaigns.draftTable.colStatus")}</th>
              <th className="min-w-32 px-3 py-2 font-medium">{t("campaigns.draftTable.colCheck")}</th>
              <th className="px-3 py-2 font-medium whitespace-nowrap">{t("campaigns.draftTable.colUpdated")}</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {shown.map((r) => (
              <tr key={r.id} className={`align-top hover:bg-slate-50/60 ${r.status === "error" ? "bg-rose-50/30" : ""}`}>
                <td className="px-4 py-3">
                  <Link href={`/clients/${clientId}/drafts/${r.id}`} className="font-medium text-slate-900 hover:text-indigo-600">
                    {r.name}
                  </Link>
                  {r.status === "error" && r.error && <p className="mt-1 line-clamp-2 text-xs text-rose-600">{r.error}</p>}
                  {msg[r.id] && <p className={`mt-1 text-xs ${msg[r.id].ok ? "text-emerald-600" : "text-rose-600"}`}>{msg[r.id].text}</p>}
                </td>
                <td className="px-3 py-3 whitespace-nowrap text-slate-600">{r.objective}</td>
                <td className="px-3 py-3 text-right tabular-nums">{r.adSets} / {r.ads}</td>
                <td className="px-3 py-3 text-right whitespace-nowrap tabular-nums">{money(r.budget, currency)}</td>
                <td className="px-3 py-3">
                  {r.status === "published" ? <Badge tone="green">{t("campaigns.draftTable.filterPublished")}</Badge> : r.status === "error" ? <Badge tone="red">{t("campaigns.draftTable.filterError")}</Badge> : r.status === "publishing" ? <Badge tone="amber">{t("campaigns.draftTable.publishing")}</Badge> : <Badge>{t("campaigns.draftTable.filterDraft")}</Badge>}
                </td>
                <td className="px-3 py-3 text-xs">
                  {r.status === "published" ? (
                    r.verify ? (
                      r.verify.ok ? <span className="text-emerald-700">{t("campaigns.draftTable.matchesMeta")}</span> : <span className="text-rose-700">{t("campaigns.draftTable.mismatches", { count: r.verify.bad })}</span>
                    ) : (
                      <span className="text-slate-400">{t("campaigns.draftTable.notChecked")}</span>
                    )
                  ) : r.reviewErrors.length ? (
                    <span className="text-rose-700" title={r.reviewErrors.join("\n")}>
                      {t("campaigns.draftTable.errorsToFix", { count: r.reviewErrors.length })}
                      <span className="mt-0.5 line-clamp-2 block text-rose-600/80">{r.reviewErrors[0]}</span>
                    </span>
                  ) : (
                    <span className="text-emerald-700">{t("campaigns.draftTable.readyToPublish")}{r.reviewWarnings ? <span className="text-amber-600"> · {t("campaigns.draftTable.notes", { count: r.reviewWarnings })}</span> : null}</span>
                  )}
                </td>
                <td className="px-3 py-3 text-xs whitespace-nowrap text-slate-500">{dateTime(r.updatedAt)}</td>
                <td className="px-4 py-3">
                  <div className="flex justify-end gap-1 whitespace-nowrap">
                    <Link href={`/clients/${clientId}/drafts/${r.id}`} className={btnClass("secondary")}>{r.status === "published" ? t("campaigns.draftTable.view") : t("campaigns.draftTable.edit")}</Link>
                    {r.status !== "published" && r.status !== "publishing" && (
                      <button type="button" className={btnClass("primary")} disabled={!!busy || r.reviewErrors.length > 0} onClick={() => act(r.id, "pub", r)} title={r.reviewErrors.length ? t("campaigns.draftTable.fixBeforePublish") : ""}>
                        {busy === `pub:${r.id}` && <Spinner />}{t("campaigns.draftTable.publish")}
                      </button>
                    )}
                    {r.adsManagerUrl && (
                      <a href={r.adsManagerUrl} target="_blank" rel="noreferrer" className={btnClass("ghost")} title={t("campaigns.draftTable.openInAdsManager")}>↗ Ads Manager</a>
                    )}
                    <button type="button" className={btnClass("ghost")} disabled={!!busy} onClick={() => act(r.id, "dup", r)} title={t("campaigns.draftTable.duplicate")}>
                      {busy === `dup:${r.id}` ? <Spinner /> : "⧉"}
                    </button>
                    <button type="button" className={btnClass("ghost")} disabled={!!busy} onClick={() => act(r.id, "del", r)} title={t("campaigns.draftTable.deleteDraft")}>
                      {busy === `del:${r.id}` ? <Spinner /> : "🗑"}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {!shown.length && (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-sm text-slate-400">
                  {rows.length ? t("campaigns.draftTable.noMatch") : t("campaigns.draftTable.empty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
