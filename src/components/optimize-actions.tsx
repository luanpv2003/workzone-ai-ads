"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { manualOptimizeCardAction, optimizeAction } from "@/app/actions";
import { useT } from "@/i18n/client";

const linkCls = "text-[11px] font-medium text-indigo-600 hover:underline disabled:text-slate-400";

/** ✦ Optimize a campaign (runs in the background, proposals go to "Chờ duyệt" (Pending approval)). */
export function OptimizeCampaignButton({ clientId, campaignId }: { clientId: string; campaignId?: string }) {
  const t = useT();
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        className={campaignId ? linkCls : "rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-60"}
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await optimizeAction(clientId, campaignId);
            setMsg(r.ok ? t("workflow.optimizeActions.queued") : r.error);
            if (r.ok) router.refresh();
          })
        }
      >
        {pending ? t("workflow.optimizeActions.queuing") : campaignId ? t("workflow.optimizeActions.optimize") : t("workflow.optimizeActions.optimizeRunning")}
      </button>
      {msg && <span className="text-[11px] font-normal text-slate-500">{msg}</span>}
    </span>
  );
}

/** Manual action on an ad set: create a pre-filled card in "Chờ duyệt" (Pending approval) to edit, then execute. */
export function AdSetManualActions({ clientId, adSetId }: { clientId: string; adSetId: string }) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const go = (kind: "duplicate_adset" | "add_ad") =>
    start(async () => {
      setError(null);
      const r = await manualOptimizeCardAction(clientId, adSetId, kind);
      if (r.ok) router.push(`/clients/${clientId}/recommendations`);
      else setError(r.error);
    });
  return (
    <span className="ml-2 inline-flex flex-wrap items-center gap-2 font-normal">
      <button type="button" className={linkCls} disabled={pending} onClick={() => go("duplicate_adset")} title={t("workflow.optimizeActions.duplicateTitle")}>
        {t("workflow.optimizeActions.duplicate")}
      </button>
      <button type="button" className={linkCls} disabled={pending} onClick={() => go("add_ad")} title={t("workflow.optimizeActions.addAdTitle")}>
        {t("workflow.optimizeActions.addAd")}
      </button>
      {error && <span className="text-[11px] text-rose-600">{error}</span>}
    </span>
  );
}
