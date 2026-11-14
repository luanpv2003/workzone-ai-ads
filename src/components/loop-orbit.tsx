"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ChevronRight, Play, X } from "lucide-react";
import type { ActionResult } from "@/app/actions";
import type { Loop, LoopCore, LoopIssue, NodeStatus } from "@/lib/workflow";
import { ActionButton } from "./action-button";
import { RecommendationCard, type RecView } from "./recommendation-card";
import { btnClass } from "./ui";
import { useLocale, useT } from "@/i18n/client";

/** Do-it-now actions in the bottleneck dialog (server actions already bound to the client id). */
export type IssueAction = { label: string; pending: string; action: () => Promise<ActionResult> };
type PendingRec = { rec: RecView; currentBudget: number | null };

// Optimization loop as an orbit: 4 main nodes on a circle, data particles flow along the arrows (green = flowing, yellow = slow / blocked),
// secondary nodes attached around the main node they feed. Colors come from the --o-* variables in globals.css (light / dark via [data-theme]).

// Coordinates in a 680 × 580 frame: center (340, 300), loop radius 150, main node radius 54.
const CORE_POS: Record<LoopCore["key"], { x: number; y: number }> = { aud: { x: 340, y: 150 }, tg: { x: 490, y: 300 }, run: { x: 340, y: 450 }, q: { x: 190, y: 300 } };
// Arc connecting node i → i + 1 (clockwise), leaving a gap around each node.
const ARC = ["M398.6 161.9 A150 150 0 0 1 478.1 241.4", "M478.1 358.6 A150 150 0 0 1 398.6 438.1", "M281.4 438.1 A150 150 0 0 1 201.9 358.6", "M201.9 241.4 A150 150 0 0 1 281.4 161.9"];
const ARC_LABEL: { x: number; y: number; end: boolean }[] = [
  { x: 476, y: 166, end: false },
  { x: 476, y: 440, end: false },
  { x: 204, y: 440, end: true },
  { x: 204, y: 160, end: true },
];
// Secondary node: rounded rectangle + connector line to the edge of the main node.
type Slot = { x: number; y: number; w: number; from: [number, number]; to: [number, number] };
const CHIP_SLOTS: Record<LoopCore["key"], Slot[]> = {
  aud: [
    { x: 155, y: 40, w: 120, from: [215, 64], to: [292.8, 116.2] },
    { x: 280, y: 40, w: 120, from: [340, 64], to: [340, 92] },
    { x: 405, y: 40, w: 120, from: [465, 64], to: [387.2, 116.2] },
  ],
  tg: [
    { x: 566, y: 258, w: 112, from: [566, 270], to: [544.5, 280.1] },
    { x: 566, y: 288, w: 112, from: [566, 300], to: [548, 300] },
    { x: 566, y: 318, w: 112, from: [566, 330], to: [544.5, 319.9] },
  ],
  run: [
    { x: 155, y: 536, w: 120, from: [215, 536], to: [292.8, 483.8] },
    { x: 280, y: 536, w: 120, from: [340, 536], to: [340, 508] },
    { x: 405, y: 536, w: 120, from: [465, 536], to: [387.2, 483.8] },
  ],
  q: [
    { x: 2, y: 258, w: 112, from: [114, 270], to: [135.5, 280.1] },
    { x: 2, y: 288, w: 112, from: [114, 300], to: [132, 300] },
    { x: 2, y: 318, w: 112, from: [114, 330], to: [135.5, 319.9] },
  ],
};
const ORDER: LoopCore["key"][] = ["aud", "tg", "run", "q"];
const STARS: [number, number][] = [[60, 90], [130, 480], [610, 120], [560, 500], [250, 565], [470, 22], [35, 400], [650, 430], [200, 30]];

const col = (s: NodeStatus | "off") => `var(--o-${s})`;
const clock = (iso: string, locale: string) => new Date(iso).toLocaleString(locale === "en" ? "en-GB" : "vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
const KPI_TONE = { good: "text-[var(--o-ok-ink)]", bad: "text-[var(--o-bad-ink)]", warn: "text-[var(--o-warn-ink)]" };

export function LoopOrbit({ loop, fullHref, actions, recs, currency }: { loop: Loop; fullHref: string; actions: Record<string, IssueAction>; recs: PendingRec[]; currency: string }) {
  const t = useT();
  const svgRef = useRef<SVGSVGElement>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [sel, setSel] = useState<LoopCore["key"] | null>(null);
  const [done, setDone] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const openIssue = open ? loop.issues.find((x) => x.node === open) : null;

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) svgRef.current?.pauseAnimations();
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, []);

  const pick = (k: LoopCore["key"] | null) => {
    if (timer.current) clearInterval(timer.current);
    setDone(false);
    setSel(k);
  };
  // Replay 1 loop: light up each main node in turn with an explanation.
  const play = () => {
    pick("aud");
    let i = 0;
    timer.current = setInterval(() => {
      i++;
      if (i >= ORDER.length) {
        if (timer.current) clearInterval(timer.current);
        setSel(null);
        setDone(true);
        return;
      }
      setSel(ORDER[i]);
    }, 1800);
  };

  const selIdx = sel ? ORDER.indexOf(sel) : -1;
  const core = sel ? loop.cores.find((c) => c.key === sel)! : null;

  return (
    <div className="wz-orbit space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-ink">{t("workflow.orbit.title")}</h2>
          <p className="text-sm text-mut">{t("workflow.orbit.subtitle")}</p>
        </div>
        <div className="flex gap-2">
          <button type="button" className={btnClass("secondary")} onClick={play}>
            <Play /> {t("workflow.orbit.playLoop")}
          </button>
          <Link href={fullHref} className={btnClass("ghost")}>
            {t("workflow.orbit.viewAll")}
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {loop.kpis.map((k) => (
          <div key={k.label} className="rounded-xl border border-[var(--o-chip-line)] bg-[var(--o-kpi)] px-4 py-3">
            <p className="text-xs text-[var(--o-mut)]">{k.label}</p>
            <p className={`text-xl font-semibold tabular-nums ${k.tone === "warn" ? KPI_TONE.warn : "text-[var(--o-text)]"}`}>{k.value}</p>
            <p className={`text-xs ${k.tone && k.tone !== "warn" ? KPI_TONE[k.tone] : "text-[var(--o-mut)]"}`}>{k.sub}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="rounded-2xl border border-[var(--o-chip-line)] bg-[var(--o-bg)] p-3 sm:p-5">
          <svg ref={svgRef} viewBox="0 0 680 580" className="mx-auto block w-full max-w-[760px]" role="img" aria-label={t("workflow.orbit.ariaLabel")} onClick={() => pick(null)}>
            <defs>
              <marker id="orb-ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </marker>
            </defs>

            {/* Background: stars + slowly rotating orbits, dark theme only */}
            <g className="hidden dark:inline" fill="var(--o-star)">
              {STARS.map(([x, y]) => (
                <circle key={`${x}-${y}`} cx={x} cy={y} r={1.1} />
              ))}
            </g>
            <circle cx="340" cy="300" r="222" fill="none" stroke="var(--o-line)" strokeWidth="0.5" className="hidden dark:inline" />
            <g className="wz-spin hidden dark:inline">
              <circle cx="340" cy="300" r="190" fill="none" stroke="var(--o-line)" strokeWidth="0.5" strokeDasharray="1 7" />
              <circle cx="340" cy="110" r="2" fill="var(--o-star)" />
            </g>
            <circle cx="340" cy="300" r="150" fill="none" stroke="var(--o-ring)" strokeWidth="10" />

            {/* Arrows + data particles */}
            {loop.arrows.map((a, i) => {
              const c = col(a.status);
              const lp = ARC_LABEL[i];
              const on = selIdx < 0 || selIdx === i;
              return (
                <g key={i} opacity={on ? 1 : 0.2} className="transition-opacity">
                  {a.status !== "off" && <path d={ARC[i]} fill="none" stroke={c} strokeWidth="8" opacity="0.15" />}
                  <path d={ARC[i]} fill="none" stroke={c} strokeWidth="2" strokeDasharray={a.status === "ok" ? undefined : "6 5"} markerEnd="url(#orb-ah)" />
                  {a.status === "ok" &&
                    [0, 0.73, 1.46].map((b) => (
                      <circle key={b} r="3" fill="var(--o-spark-ok)">
                        <animateMotion dur="2.2s" begin={`${b}s`} repeatCount="indefinite" path={ARC[i]} />
                      </circle>
                    ))}
                  {a.status === "warn" && (
                    <circle r="3" fill="var(--o-spark-warn)">
                      <animateMotion dur="6s" repeatCount="indefinite" path={ARC[i]} />
                    </circle>
                  )}
                  {a.label.map((line, j) => (
                    <text key={j} x={lp.x} y={lp.y + j * 16} textAnchor={lp.end ? "end" : "start"} fontSize="12" fill={a.status === "ok" ? "var(--o-mut)" : col(a.status)}>
                      {line}
                    </text>
                  ))}
                </g>
              );
            })}

            {/* Center: number of arrows flowing */}
            <circle cx="340" cy="300" r="70" fill="var(--o-hub-fill)" stroke="var(--o-line)" strokeWidth="0.5" />
            <circle cx="340" cy="300" r="58" fill="none" stroke="var(--o-hub-track)" strokeWidth="6" />
            {loop.flowing > 0 && (
              <circle cx="340" cy="300" r="58" fill="none" stroke="var(--o-ok)" strokeWidth="6" strokeLinecap="round" pathLength={100} strokeDasharray={`${loop.flowing * 25} 100`} transform="rotate(-90 340 300)" />
            )}
            <text x="340" y="292" textAnchor="middle" dominantBaseline="central" fontSize="30" fontWeight="600" fill="var(--o-text)">
              {loop.flowing}/4
            </text>
            <text x="340" y="320" textAnchor="middle" dominantBaseline="central" fontSize="12" fill="var(--o-mut)">
              {t("workflow.orbit.arrowsFlowing")}
            </text>

            {/* Secondary nodes */}
            {loop.cores.map((c) => {
              const on = !sel || sel === c.key;
              return (
                <g key={c.key} opacity={on ? 1 : 0.15} className="transition-opacity">
                  {c.chips.map((ch, j) => {
                    const s = CHIP_SLOTS[c.key][j];
                    return (
                      <g key={ch.node}>
                        <title>{ch.text}</title>
                        <line x1={s.from[0]} y1={s.from[1]} x2={s.to[0]} y2={s.to[1]} stroke="var(--o-chip-line)" strokeWidth="0.8" strokeDasharray="3 3" />
                        <rect x={s.x} y={s.y} width={s.w} height="24" rx="12" fill="var(--o-chip)" stroke="var(--o-chip-line)" strokeWidth="0.8" />
                        <circle cx={s.x + 13} cy={s.y + 12} r="3.2" fill={col(ch.status)} />
                        <text x={s.x + 22} y={s.y + 12} dominantBaseline="central" fontSize="11.5" fill="var(--o-text)">
                          {ch.text}
                        </text>
                      </g>
                    );
                  })}
                </g>
              );
            })}

            {/* Main nodes */}
            {loop.cores.map((c, i) => {
              const p = CORE_POS[c.key];
              const on = !sel || sel === c.key;
              const alert = c.status === "warn" || c.status === "bad";
              return (
                <g
                  key={c.key}
                  role="button"
                  tabIndex={0}
                  aria-label={`${c.title}: ${c.metric}, ${c.sub}`}
                  className="cursor-pointer transition-opacity outline-none"
                  opacity={on ? 1 : 0.3}
                  onClick={(e) => {
                    e.stopPropagation();
                    pick(c.key);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") pick(c.key);
                  }}
                >
                  {alert && <circle className="wz-pulse" style={{ animationDelay: `${i * 0.8}s` }} cx={p.x} cy={p.y} r="56" fill="none" stroke={col(c.status)} strokeWidth="1.5" />}
                  <circle cx={p.x} cy={p.y} r="60" fill="none" stroke={col(c.status)} strokeWidth="6" opacity="0.13" />
                  <circle cx={p.x} cy={p.y} r="54" fill={`var(--o-${c.status}-fill)`} stroke={col(c.status)} strokeWidth={sel === c.key ? 2.5 : 1.2} />
                  <text x={p.x} y={p.y - 22} textAnchor="middle" dominantBaseline="central" fontSize="12" fontWeight="500" fill={`var(--o-${c.status}-ink)`}>
                    {c.title}
                  </text>
                  <text x={p.x} y={p.y} textAnchor="middle" dominantBaseline="central" fontSize="17" fontWeight="600" fill="var(--o-text)">
                    {c.metric}
                  </text>
                  <text x={p.x} y={p.y + 22} textAnchor="middle" dominantBaseline="central" fontSize="11.5" fill="var(--o-mut)">
                    {c.sub}
                  </text>
                </g>
              );
            })}
          </svg>
          <div className="mt-2 flex flex-wrap justify-center gap-4 text-xs text-[var(--o-mut)]">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-0.5 w-5 rounded bg-[var(--o-ok)]" /> {t("workflow.orbit.legendFlowing")}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-0.5 w-5 rounded bg-[var(--o-warn)]" /> {t("workflow.orbit.legendSlow")}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-0.5 w-5 rounded bg-[var(--o-off)]" /> {t("workflow.orbit.legendNoData")}
            </span>
          </div>
        </div>

        <div className="space-y-4">
          <div className="min-h-24 rounded-2xl border border-[var(--o-chip-line)] bg-[var(--o-kpi)] p-4 text-sm">
            {core ? (
              <>
                <p className="font-semibold text-[var(--o-text)]">{core.name}</p>
                <p className="mt-1 text-[var(--o-mut)]">{core.detail.charAt(0).toUpperCase() + core.detail.slice(1)}</p>
                <Link href={core.href} className="mt-3 inline-block text-sm font-medium text-indigo-700 hover:underline">
                  {core.cta} →
                </Link>
              </>
            ) : (
              <p className="text-[var(--o-mut)]">
                {done ? t("workflow.orbit.loopDone") : t("workflow.orbit.clickHint")}
              </p>
            )}
          </div>

          <div className="rounded-2xl border border-[var(--o-chip-line)] bg-panel p-4">
            <p className="mb-2 text-sm font-semibold text-ink">{t("workflow.orbit.bottlenecks", { count: loop.issues.length })}</p>
            {loop.issues.length ? (
              <ul className="divide-y divide-line">
                {loop.issues.map((x) => (
                  <li key={x.node}>
                    <button type="button" onClick={() => setOpen(x.node)} className="group -mx-2 flex w-[calc(100%+1rem)] items-start gap-3 rounded-lg px-2 py-2.5 text-left hover:bg-hover">
                      <span className="mt-1.5 size-2.5 shrink-0 rounded-full" style={{ background: col(x.status) }} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium text-ink">{x.title}</span>
                        <span className="line-clamp-2 block text-xs text-ink2">{x.text}</span>
                      </span>
                      <span className="flex shrink-0 items-center text-xs font-medium text-indigo-700">
                        {x.node === "approve" && recs.length ? t("workflow.orbit.approve") : t("workflow.orbit.view")} <ChevronRight className="size-3.5 transition group-hover:translate-x-0.5" />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-emerald-700">{t("workflow.orbit.smooth")}</p>
            )}
          </div>
        </div>
      </div>
      {openIssue && <IssueDialog issue={openIssue} action={actions[openIssue.node]} recs={openIssue.node === "approve" ? recs : []} currency={currency} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** Detail dialog for a bottleneck: why, data, schedule; act now (run analysis, approve proposals) or open the full page. */
function IssueDialog({ issue, action, recs, currency, onClose }: { issue: LoopIssue; action?: IssueAction; recs: PendingRec[]; currency: string; onClose: () => void }) {
  const t = useT();
  const locale = useLocale();
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    // The Meta change confirmation dialog (higher z) handles its own Escape; here we only close when no other dialog is open.
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !document.querySelector("[role=alertdialog]") && onClose();
    window.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[85] grid place-items-center bg-[var(--overlay)] p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby="issue-title" className="flex max-h-[88vh] w-full max-w-3xl flex-col rounded-[14px] border border-line bg-panel shadow-pop" style={{ animation: "wz-in .15s ease-out" }}>
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <p className="flex items-center gap-1.5 text-xs font-medium" style={{ color: col(issue.status) }}>
              <span className="size-2 rounded-full" style={{ background: col(issue.status) }} /> {t(`workflow.status.${issue.status}`)}
            </p>
            <h2 id="issue-title" className="mt-0.5 text-[17px] font-semibold text-ink">
              {issue.title}
            </h2>
          </div>
          <button ref={closeRef} type="button" aria-label={t("workflow.orbit.close")} className={btnClass("ghost")} onClick={onClose}>
            <X />
          </button>
        </div>

        <div className="space-y-4 overflow-y-auto px-5 py-4">
          <p className="rounded-xl border border-line bg-soft p-3 text-sm text-ink">{issue.text}</p>
          <div className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            <p className="text-ink2">
              {t("workflow.orbit.metric")}: <b className="font-medium text-ink">{issue.metric}</b>
            </p>
            {issue.mode && <p className="text-ink2">{t("workflow.view.mode")}: {issue.mode}</p>}
            <p className="text-ink2">
              {t("workflow.view.lastTime", { label: issue.updatedLabel ?? t("workflow.view.updated") })} <b className="font-medium text-ink">{issue.updatedAt ? clock(issue.updatedAt, locale) : t("workflow.view.none")}</b>
            </p>
            {(issue.nextAt || issue.nextNote) && (
              <p className="text-ink2">
                {issue.nextLabel ?? t("workflow.view.next")}: <b className="font-medium text-indigo-700">{issue.nextAt ? clock(issue.nextAt, locale) : issue.nextNote}</b>
              </p>
            )}
          </div>
          {issue.lines.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-5 text-sm text-ink2">
              {issue.lines.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          )}

          {recs.length > 0 && (
            <div className="space-y-3">
              <p className="text-sm font-semibold text-ink">{t("workflow.orbit.pendingRecs", { count: recs.length })}</p>
              {recs.map((r) => (
                <RecommendationCard key={r.rec.id} rec={r.rec} currency={currency} currentBudget={r.currentBudget} />
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3">
          {issue.href && (
            <Link href={issue.href} className={btnClass("ghost")}>
              {t("workflow.orbit.openFull")} →
            </Link>
          )}
          {action && (
            <ActionButton action={action.action} pending={action.pending} variant="primary">
              {action.label}
            </ActionButton>
          )}
          <button type="button" className={btnClass("secondary")} onClick={onClose}>
            {t("workflow.orbit.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
