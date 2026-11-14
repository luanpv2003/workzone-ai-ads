import Link from "next/link";
import type { Pipeline, StepState } from "@/lib/pipeline";
import { getT } from "@/i18n/server";

const BAR: Record<StepState, string> = {
  done: "bg-emerald-500",
  stale: "bg-amber-400",
  current: "bg-indigo-500",
  todo: "bg-slate-200",
};
const TEXT: Record<StepState, string> = {
  done: "text-emerald-700",
  stale: "text-amber-700",
  current: "text-indigo-700 font-medium",
  todo: "text-slate-400",
};
const ICON: Record<StepState, string> = { done: "✓", stale: "!", current: "●", todo: "○" };
const STATE_KEY = { done: "core.pipeline.stateDone", stale: "core.pipeline.stateStale", current: "core.pipeline.stateCurrent", todo: "core.pipeline.stateTodo" } as const;

/** 7-step workflow progress bar: collapsed to one line, click to see per-step details. */
export async function PipelineBar({ p }: { p: Pipeline }) {
  const t = await getT();
  return (
    <details className="group min-w-0 flex-1">
      <summary className="flex cursor-pointer list-none items-center gap-3 text-xs text-mut" title={p.current ? `${p.current.label}: ${p.current.detail}` : t("core.pipeline.cycleDone")}>
        <span className="shrink-0">
          {t("core.pipeline.process")} <b className="text-ink">{p.done}/{p.steps.length}</b>
        </span>
        <span className="flex min-w-24 flex-1 gap-1">
          {p.steps.map((s) => (
            <span key={s.key} className={`h-1 flex-1 rounded-full ${BAR[s.state]}`} />
          ))}
        </span>
        <span className="min-w-0 truncate">{p.current ? t("core.pipeline.at", { label: p.current.label }) : t("core.pipeline.cycleDone")}</span>
        <span className="shrink-0 transition group-open:rotate-180">▾</span>
      </summary>
      <ol className="mt-3 grid grid-cols-7 gap-1">
        {p.steps.map((s, i) => (
          <li key={s.key} className="min-w-0">
            <Link href={s.href} className="group/step block" title={`${i + 1}. ${s.label}: ${t(STATE_KEY[s.state])}\n${s.detail}`}>
              <span className={`block h-1.5 rounded-full ${BAR[s.state]} group-hover/step:opacity-80`} />
              <span className={`mt-1.5 block truncate text-[11px] ${TEXT[s.state]}`}>
                {ICON[s.state]} {s.label}
              </span>
              <span className="mt-0.5 hidden text-[11px] leading-snug text-mut2 @3xl:line-clamp-3">{s.detail}</span>
            </Link>
          </li>
        ))}
      </ol>
    </details>
  );
}

/** Compact version for the Overview table. */
export async function PipelineMini({ p, href }: { p: Pipeline; href?: string }) {
  const t = await getT();
  const title = p.steps.map((s, i) => `${ICON[s.state]} ${i + 1}. ${s.label}: ${s.detail}`).join("\n");
  const body = (
    <>
      <span className="flex gap-1">
        {p.steps.map((s) => (
          <span key={s.key} className={`h-1 flex-1 rounded-full ${BAR[s.state]}`} />
        ))}
      </span>
      <span className="mt-1 block truncate text-xs text-mut">
        {p.done}/{p.steps.length} · {p.current ? p.current.label : t("core.pipeline.cycleComplete")}
      </span>
    </>
  );
  // If the card is already a link (e.g. a client card on the Today page), don't nest another link.
  return href ? (
    <Link href={href} className="block min-w-36" title={title}>
      {body}
    </Link>
  ) : (
    <span className="block min-w-36" title={title}>
      {body}
    </span>
  );
}
