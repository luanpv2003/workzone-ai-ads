"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { reverifyAction } from "@/app/actions";
import type { VerifyReport } from "@/lib/meta/types";
import { dateTime } from "@/lib/format";
import { ActionButton } from "../action-button";
import { useT } from "@/i18n/client";

const LEVEL_KEYS = {
  campaign: "campaigns.verify.levelCampaign",
  adset: "campaigns.verify.levelAdSet",
  ad: "campaigns.verify.levelAd",
} as const;

/** Post-publish double-check table: compare each item read from Meta against the draft. */
export function VerifyPanel({ draftId, verify }: { draftId: string; verify: VerifyReport | { error: string } | undefined }) {
  const t = useT();
  const router = useRouter();
  const [open, setOpen] = useState(!verify || "error" in verify || !verify.ok);
  const bad = verify && !("error" in verify) ? verify.sections.flatMap((s) => s.checks.filter((c) => !c.ok)).length : 0;

  return (
    <div className="rounded-xl border border-slate-200 bg-panel p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-semibold text-slate-900">{t("campaigns.verify.title")}</h3>
          {!verify && <p className="text-slate-500">{t("campaigns.verify.notChecked")}</p>}
          {verify && "error" in verify && <p className="text-rose-600">{t("campaigns.verify.readFailed", { error: verify.error })}</p>}
          {verify && !("error" in verify) && (
            <p className={verify.ok ? "text-emerald-700" : "text-rose-700"}>
              {verify.ok ? t("campaigns.verify.allMatch") : t("campaigns.verify.someMismatch", { count: bad })}{" "}
              <span className="text-xs text-slate-400">({dateTime(verify.checkedAt)})</span>
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {verify && !("error" in verify) && (
            <button type="button" className="text-xs text-slate-500 hover:text-slate-800" onClick={() => setOpen(!open)}>
              {open ? t("campaigns.verify.collapse") : t("campaigns.verify.details")}
            </button>
          )}
          <ActionButton action={async () => { const r = await reverifyAction(draftId); router.refresh(); return r; }} pending={t("campaigns.verify.reading")}>
            {t("campaigns.verify.recheck")}
          </ActionButton>
        </div>
      </div>

      {open && verify && !("error" in verify) && (
        <div className="mt-3 space-y-3">
          {verify.sections.map((s) => (
            <div key={s.id} className="rounded-lg border border-slate-100 p-3">
              <div className="mb-2 text-xs text-slate-500">
                {t(LEVEL_KEYS[s.level as keyof typeof LEVEL_KEYS])} · <span className="font-medium text-slate-800">{s.name}</span> · <span className="font-mono">{s.id}</span>
              </div>
              <table className="w-full text-xs">
                <tbody>
                  {s.checks.map((c, i) => (
                    <tr key={i} className={c.ok ? "" : "bg-rose-50"}>
                      <td className="w-5 py-1 align-top">{c.ok ? "✓" : "✕"}</td>
                      <td className="py-1 pr-2 align-top text-slate-700">{c.label}</td>
                      <td className="py-1 pr-2 align-top text-slate-500">{c.ok ? c.actual : <>{t("campaigns.verify.draft")}: <b>{c.expected}</b> · Meta: <b>{c.actual}</b></>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {s.sentences && s.sentences.length > 0 && (
                <div className="mt-2 border-t border-slate-100 pt-2 text-xs text-slate-500">
                  <div className="font-medium">{t("campaigns.verify.metaDescribes")}</div>
                  {s.sentences.map((l, i) => <p key={i}>{l}</p>)}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
