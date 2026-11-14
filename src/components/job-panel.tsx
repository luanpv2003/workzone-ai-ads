import Link from "next/link";
import { AlertTriangle, Check, Loader2, Sparkles } from "lucide-react";
import type { JobStep } from "@/lib/client-jobs";
import { jobLabels, stepLabel } from "@/lib/client-jobs";
import { getLocale, getT } from "@/i18n/server";
import { DEFAULT_LOCALE } from "@/i18n/config";
import { dateTime } from "@/lib/format";
import { actorLabel } from "@/lib/stored-labels";
import { ActionButton } from "./action-button";
import { AutoRefresh } from "./targeting/controls";
import { cancelClientJobAction } from "@/app/actions";

type Job = { id: string; kind: string; status: string; steps: string; error: string | null; triggeredBy: string | null; createdAt: Date; finishedAt: Date | null };

const DOT: Record<JobStep["status"], string> = {
  pending: "border-slate-300 bg-panel text-slate-400",
  running: "border-sky-500 bg-sky-500 text-white animate-pulse",
  done: "border-emerald-500 bg-emerald-500 text-white",
  skipped: "border-slate-300 bg-slate-100 text-slate-400",
  failed: "border-rose-500 bg-rose-500 text-white",
};
const MARK: Record<JobStep["status"], string> = { pending: "", running: "", done: "✓", skipped: "–", failed: "!" };

/** Strip links and technical error codes; truncate to keep the panel compact. */
const tidy = (s?: string) => s?.replace(/\s*Refer to[\s\S]*$/i, "").replace(/https?:\/\/\S+/g, "").replace(/\(#\d+\)\s*/g, "").trim().slice(0, 180);

/** Background job progress (Full analysis): a compact 3-step bar, notes shown separately below. */
/** waiting: other jobs for this client queued behind the one being shown. */
export async function JobPanel({ job, base, waiting = [] }: { job: Job; base: string; waiting?: string[] }) {
  const t = await getT();
  const JOB_LABEL = jobLabels(t);
  // Vietnamese UI shows the stored step labels as they are; other languages re-translate known steps.
  const relabel = (await getLocale()) !== DEFAULT_LOCALE;
  const steps: JobStep[] = (JSON.parse(job.steps) as JobStep[]).map((s) => (relabel ? { ...s, label: stepLabel(job.kind, s, t) } : s));
  const active = job.status === "queued" || job.status === "running";
  const notes = steps.flatMap((s) => (s.note ? [{ label: s.label, text: tidy(s.note)! }] : []));
  const status =
    job.status === "queued" ? t("core.jobPanel.queued") : job.status === "running" ? t("core.jobPanel.running") : job.status === "done" ? t("core.jobPanel.done", { at: dateTime(job.finishedAt) }) : job.status === "failed" ? t("core.jobPanel.failed") : t("core.jobPanel.cancelled");

  const cur = steps.find((x) => x.status === "running") ?? steps.find((x) => x.status === "pending");
  const doneN = steps.filter((x) => x.status === "done" || x.status === "skipped").length;
  const chipTone = job.status === "failed" ? "border-rose-200 bg-rose-50 text-rose-700" : job.status === "done" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-violet-200 bg-violet-50 text-violet-700";
  return (
    // Compact chip next to the workflow bar; click to open per-step details.
    <details className="group shrink-0 open:w-full" open={job.status === "failed"}>
      <summary className={`inline-flex h-7 max-w-full cursor-pointer list-none items-center gap-1.5 rounded-full border px-3 text-xs font-medium ${chipTone}`}>
        {active ? <Loader2 className="size-3.5 animate-spin" /> : job.status === "done" ? <Check className="size-3.5" /> : <AlertTriangle className="size-3.5" />}
        <span className="truncate">
          {JOB_LABEL[job.kind] ?? job.kind}
          {active ? ` · ${job.status === "queued" ? t("core.jobPanel.chipWaiting") : `${t("core.jobPanel.chipSteps", { done: doneN, total: steps.length })}${cur?.detail ? ` · ${tidy(cur.detail)?.slice(0, 40)}` : ""}`}` : job.status === "done" ? ` · ${t("core.jobPanel.chipDone")}` : job.status === "failed" ? ` · ${t("core.jobPanel.chipError")}` : ` · ${t("core.jobPanel.chipCancelled")}`}
          {waiting.length > 0 && ` · ${t("core.jobPanel.moreWaiting", { n: waiting.length })}`}
        </span>
      </summary>
    <div className="mt-2 rounded-xl border border-line bg-panel px-4 py-3">
      <AutoRefresh active={active} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-ink">
          <Sparkles className="size-4 text-violet-600" /> {JOB_LABEL[job.kind] ?? job.kind}
        </span>
        <span className={`text-xs ${job.status === "failed" ? "text-rose-600" : job.status === "done" ? "text-emerald-700" : "text-slate-500"}`}>
          {status}
          {job.triggeredBy && ` · ${actorLabel(job.triggeredBy, t)}`}
          {waiting.length > 0 && ` · ${t("core.jobPanel.waitingAfter", { jobs: waiting.map((k) => JOB_LABEL[k] ?? k).join(", ") })}`}
        </span>
        {job.status === "done" && job.kind !== "sync" && (
          <Link
            href={job.kind === "full_analysis" || job.kind === "propose_campaigns" ? `${base}/create` : job.kind === "conv_idle" ? `${base}/messages` : job.kind === "conversations" || job.kind === "creative" ? `${base}/audits` : job.kind === "optimize" ? `${base}/recommendations` : `${base}/drafts`}
            className="ml-auto rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
          >
            {job.kind === "full_analysis" ? t("core.jobPanel.nextProposal") : job.kind === "propose_campaigns" ? t("core.jobPanel.pickIdeas") : job.kind === "conv_idle" ? t("core.jobPanel.viewMessages") : job.kind === "conversations" || job.kind === "creative" ? t("core.jobPanel.viewAnalysis") : job.kind === "optimize" ? t("core.jobPanel.viewRecs") : t("core.jobPanel.openDraft")}
          </Link>
        )}
        {active && (
          <span className="ml-auto">
            <ActionButton action={cancelClientJobAction.bind(null, job.id)} variant="ghost" confirm={t("core.jobPanel.cancelConfirm")}>
              {t("core.jobPanel.cancel")}
            </ActionButton>
          </span>
        )}
      </div>

      <ol className="mt-3 flex items-start">
        {steps.map((s, i) => (
          <li key={s.key} className="relative flex min-w-0 flex-1 flex-col items-center px-2 text-center">
            {/* Connector line to the next step (after the dot) */}
            {i < steps.length - 1 && (
              <span className={`absolute top-3 left-1/2 h-0.5 w-full ${s.status === "done" || s.status === "skipped" ? "bg-emerald-300" : "bg-slate-200"}`} />
            )}
            <span className={`relative grid size-6 place-items-center rounded-full border-2 text-[11px] font-bold ${DOT[s.status]}`}>{MARK[s.status] || i + 1}</span>
            <span className={`mt-1 text-xs font-medium ${s.status === "pending" || s.status === "skipped" ? "text-slate-400" : s.status === "failed" ? "text-rose-700" : "text-slate-800"}`}>{s.label}</span>
            {s.detail && <span className="mt-0.5 line-clamp-2 max-w-52 text-[11px] text-slate-500" title={s.detail}>{tidy(s.detail)}</span>}
          </li>
        ))}
      </ol>

      {/* Per-step detail report: which channel, how much data */}
      {steps.some((s) => s.items?.length) && (
        <div className="mt-3 grid gap-3 border-t border-slate-100 pt-3 @3xl:grid-cols-3">
          {steps.map((s) => (
            <div key={s.key} className="min-w-0">
              {s.items?.length ? (
                <>
                  <p className="mb-1 text-[11px] font-semibold tracking-wide text-slate-400 uppercase">{s.label}</p>
                  <ul className="space-y-1">
                    {s.items.map((it) => (
                      <li key={it.label} className="text-xs leading-snug">
                        <span className={it.warn ? "text-amber-700" : "text-emerald-700"}>{it.warn ? "⚠" : "✓"}</span>{" "}
                        <span className="font-medium text-slate-700">{it.label}:</span> <span className="text-slate-600">{it.value}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {notes.map((n) => (
        <p key={n.label} className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          ⚠ {n.text}
        </p>
      ))}
      {job.error && <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{tidy(job.error)}</p>}
    </div>
    </details>
  );
}
