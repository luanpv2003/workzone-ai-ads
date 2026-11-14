"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Check, ClipboardCopy, ListChecks, RefreshCw } from "lucide-react";
import type { RecGuide } from "@/lib/ai/schemas";
import { recGuideAction, toggleGuideStepAction } from "@/app/actions";
import { btnClass } from "./ui";
import { Spinner } from "./action-button";
import { useT } from "@/i18n/client";
import { BRAND } from "@/lib/brand";

// Step-by-step guide for manual proposals: Claude writes it for the specific client / proposal; tick each step when done.

// "where" values with a translated label; anything else is shown as-is.
const WHERE_KEYS = ["ads_manager", "business_suite", "events_manager", "business_settings", "crm", "website", "other"];
const TOOL: Record<string, string> = {
  wizard: "/create/new",
  drafts: "/drafts",
  audiences: "/audiences",
  knowledge: "/knowledge",
  settings: "/settings",
  content_review: "/content",
  report: "/campaigns",
  recommendations: "/recommendations",
  connections: "",
};

function CopyValue({ label, value }: { label: string; value: string }) {
  const t = useT();
  const [done, setDone] = useState(false);
  return (
    <div className="flex items-start gap-2 rounded-md bg-soft px-2.5 py-1.5 text-xs">
      <span className="shrink-0 text-mut">{label}:</span>
      <code className="min-w-0 flex-1 break-all text-ink">{value}</code>
      <button
        type="button"
        className="shrink-0 text-indigo-700"
        title={t("workflow.recGuide.copy")}
        onClick={() => {
          void navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        }}
      >
        {done ? <Check className="size-3.5" /> : <ClipboardCopy className="size-3.5" />}
      </button>
    </div>
  );
}

export function RecGuidePanel({ recId, clientId, initial, initialDone }: { recId: string; clientId?: string; initial: RecGuide | null; initialDone: number[] }) {
  const t = useT();
  const whereLabel = (w: string) => (w === "wzone" ? BRAND.app : WHERE_KEYS.includes(w) ? t(`workflow.recGuide.where.${w}` as "workflow.recGuide.where.crm") : w);
  const [guide, setGuide] = useState<RecGuide | null>(initial);
  const [done, setDone] = useState<number[]>(initialDone);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const base = clientId ? `/clients/${clientId}` : "";

  const generate = () =>
    start(async () => {
      setError(null);
      const r = await recGuideAction(recId);
      if (!r.ok) return setError(r.error);
      setGuide(r.guide);
      setDone([]);
      setOpen(true);
    });
  const toggle = (i: number) => {
    setDone((d) => (d.includes(i) ? d.filter((x) => x !== i) : [...d, i]));
    void toggleGuideStepAction(recId, i);
  };

  if (!guide)
    return (
      <div className="mt-3">
        <button type="button" className={btnClass("secondary")} disabled={pending} onClick={generate}>
          {pending ? <Spinner /> : <ListChecks className="size-4" />}
          {pending ? t("workflow.recGuide.writing") : t("workflow.recGuide.stepByStep")}
        </button>
        {error && <p className="mt-2 text-sm text-rose-700">{error}</p>}
      </div>
    );

  const total = guide.steps.length;
  return (
    <div className="mt-3 rounded-xl border border-line">
      <button type="button" className="flex w-full items-center gap-2 px-3 py-2.5 text-left" onClick={() => setOpen(!open)}>
        <ListChecks className="size-4 text-indigo-700" />
        <span className="flex-1 text-sm font-medium text-ink">
          {t("workflow.recGuide.header", { done: done.length, total })} · {guide.time_estimate}
        </span>
        <span className="h-1.5 w-24 overflow-hidden rounded-full bg-soft">
          <span className="block h-full rounded-full bg-emerald-500" style={{ width: `${(done.length / Math.max(1, total)) * 100}%` }} />
        </span>
        <span className="text-xs text-mut">{open ? t("workflow.recGuide.collapse") : t("workflow.recGuide.open")}</span>
      </button>
      {open && (
        <div className="space-y-4 border-t border-line px-3 py-3 text-sm">
          <p className="text-ink2">{guide.goal}</p>
          {guide.prepare.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-semibold tracking-wide text-mut uppercase">{t("workflow.recGuide.prepare")}</p>
              <ul className="list-disc space-y-0.5 pl-5 text-ink2">
                {guide.prepare.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            </div>
          )}
          <ol className="space-y-3">
            {guide.steps.map((s, i) => {
              const ok = done.includes(i);
              const toolPath = s.tool !== "none" ? TOOL[s.tool] : undefined;
              return (
                <li key={i} className={`rounded-lg border p-3 ${ok ? "border-emerald-200 bg-emerald-50/40" : "border-line"}`}>
                  <label className="flex cursor-pointer items-start gap-2.5">
                    <input type="checkbox" className="mt-1 size-4" checked={ok} onChange={() => toggle(i)} />
                    <span className="min-w-0 flex-1">
                      <span className={`font-medium ${ok ? "text-mut line-through" : "text-ink"}`}>
                        {i + 1}. {s.title}
                      </span>
                      <span className="ml-2 rounded bg-soft px-1.5 py-0.5 text-[11px] text-mut">{whereLabel(s.where)}</span>
                    </span>
                  </label>
                  <ul className="mt-2 ml-7 list-disc space-y-0.5 pl-4 text-ink2">
                    {s.instructions.map((x, k) => (
                      <li key={k}>{x}</li>
                    ))}
                  </ul>
                  {s.values.length > 0 && (
                    <div className="mt-2 ml-7 space-y-1">
                      {s.values.map((v, k) => (
                        <CopyValue key={k} label={v.label} value={v.value} />
                      ))}
                    </div>
                  )}
                  <p className="mt-2 ml-7 text-xs text-emerald-800">✓ {t("workflow.recGuide.check")}: {s.check}</p>
                  {toolPath !== undefined && base && (
                    <Link href={toolPath ? `${base}${toolPath}` : "/connections"} className="mt-2 ml-7 inline-block text-xs font-medium text-indigo-700 hover:underline">
                      {t("workflow.recGuide.openIn", { tool: t(`workflow.recGuide.tools.${s.tool}` as "workflow.recGuide.tools.wizard"), app: BRAND.app })} →
                    </Link>
                  )}
                </li>
              );
            })}
          </ol>
          {guide.pitfalls.length > 0 && (
            <div className="rounded-lg bg-amber-50 p-3">
              <p className="mb-1 text-xs font-semibold text-amber-800">{t("workflow.recGuide.avoid")}</p>
              <ul className="list-disc space-y-0.5 pl-5 text-amber-900">
                {guide.pitfalls.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-ink2">
            <span className="font-medium text-ink">{t("workflow.recGuide.afterDoing")}</span> {guide.verify_after}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            {done.length === total && <span className="text-sm font-medium text-emerald-700">{t("workflow.recGuide.allDone")}</span>}
            <button type="button" className="inline-flex items-center gap-1 text-xs text-mut hover:text-ink" disabled={pending} onClick={generate}>
              {pending ? <Spinner /> : <RefreshCw className="size-3.5" />} {t("workflow.recGuide.rewrite")}
            </button>
          </div>
          {error && <p className="text-sm text-rose-700">{error}</p>}
        </div>
      )}
    </div>
  );
}
