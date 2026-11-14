"use client";

import Link from "next/link";
import { useState, useSyncExternalStore } from "react";
import {
  BookOpen,
  ClipboardList,
  Gauge,
  HeartPulse,
  Image as ImageIcon,
  Inbox,
  Link2,
  ListOrdered,
  Megaphone,
  MessageCircle,
  Newspaper,
  PenLine,
  Plug,
  RefreshCw,
  Repeat,
  Send,
  Sparkles,
  Target,
  Users,
  Wand2,
  type LucideIcon,
} from "lucide-react";
import type { FlowNode, NodeStatus, Workflow } from "@/lib/workflow";
import { useLocale, useT } from "@/i18n/client";
import type { T } from "@/i18n/translate";
import { btnClass } from "./ui";

const ICON: Record<string, LucideIcon> = {
  plug: Plug,
  refresh: RefreshCw,
  message: MessageCircle,
  link: Link2,
  form: ClipboardList,
  newspaper: Newspaper,
  book: BookOpen,
  sparkles: Sparkles,
  users: Users,
  target: Target,
  image: ImageIcon,
  heart: HeartPulse,
  list: ListOrdered,
  gauge: Gauge,
  pen: PenLine,
  send: Send,
  megaphone: Megaphone,
  wand: Wand2,
  inbox: Inbox,
  loop: Repeat,
};

const STATUS: Record<NodeStatus, { dot: string; ring: string; text: string }> = {
  ok: { dot: "bg-emerald-500", ring: "border-emerald-300", text: "text-emerald-700" },
  warn: { dot: "bg-amber-400", ring: "border-amber-300", text: "text-amber-700" },
  bad: { dot: "bg-rose-600", ring: "border-rose-300", text: "text-rose-700" },
  off: { dot: "bg-slate-300", ring: "border-line", text: "text-mut" },
};

// Canvas size (px): each column COL wide, each row ROW tall; blocks W × H.
const W = 196;
const H = 92;
const COL = 236;
const ROW = 108;
const PAD = 28;
const TOP = 36; // leave room for column titles

// Clock for "x minutes ago" / countdowns: ticks every 30 seconds; null when rendering on the server (avoids time mismatch on hydrate).
const subscribe = (cb: () => void) => {
  const t = setInterval(cb, 30_000);
  return () => clearInterval(t);
};
const useNow = () => useSyncExternalStore(subscribe, () => Math.floor(Date.now() / 30_000) * 30_000, () => null);

function dur(t: T, ms: number, short = false) {
  const m = Math.round(Math.abs(ms) / 60_000);
  if (m < 1) return short ? t("workflow.view.dur.lessThanMinShort") : t("workflow.view.dur.lessThanMin");
  if (m < 60) return short ? t("workflow.view.dur.minShort", { m }) : t("workflow.view.dur.min", { m });
  const h = Math.floor(m / 60);
  if (h < 24)
    return short
      ? t("workflow.view.dur.hourShort", { h }) + (m % 60 ? t("workflow.view.dur.minShort", { m: m % 60 }) : "")
      : t("workflow.view.dur.hour", { h }) + (m % 60 ? " " + t("workflow.view.dur.min", { m: m % 60 }) : "");
  const d = Math.floor(h / 24);
  return short ? t("workflow.view.dur.dayShort", { d }) : t("workflow.view.dur.day", { d }) + (h % 24 ? " " + t("workflow.view.dur.hour", { h: h % 24 }) : "");
}
const clock = (iso: string, locale: string) => new Date(iso).toLocaleString(locale === "en" ? "en-GB" : "vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
const agoText = (t: T, locale: string, iso: string, now: number | null, short = false) => (now == null ? clock(iso, locale) : t("workflow.view.ago", { dur: dur(t, now - new Date(iso).getTime(), short) }));
const leftText = (t: T, locale: string, iso: string, now: number | null, short = false) => {
  if (now == null) return clock(iso, locale);
  const ms = new Date(iso).getTime() - now;
  return ms <= 0 ? t("workflow.view.dueNow") : t("workflow.view.left", { dur: dur(t, ms, short) });
};

const pos = (n: FlowNode) => ({ x: PAD + n.col * COL, y: TOP + n.row * ROW });

export function WorkflowView({ wf }: { wf: Workflow }) {
  const t = useT();
  const locale = useLocale();
  const ago = (iso: string, now: number | null, short = false) => agoText(t, locale, iso, now, short);
  const left = (iso: string, now: number | null, short = false) => leftText(t, locale, iso, now, short);
  const fmt = (iso: string) => clock(iso, locale);
  const [sel, setSel] = useState<string | null>(null);
  const now = useNow();
  const byId = new Map(wf.nodes.map((n) => [n.id, n]));
  const rows = Math.max(...wf.nodes.map((n) => n.row)) + 1;
  const width = PAD * 2 + (wf.columns.length - 1) * COL + W;
  const height = TOP + rows * ROW + 40;
  const near = new Set(sel ? [sel, ...wf.edges.filter((e) => e.from === sel || e.to === sel).flatMap((e) => [e.from, e.to])] : []);
  const issues = wf.nodes.filter((n) => n.status === "bad" || n.status === "warn").sort((a, b) => (a.status === b.status ? 0 : a.status === "bad" ? -1 : 1));
  const count = (s: NodeStatus) => wf.nodes.filter((n) => n.status === s).length;
  const selected = sel ? byId.get(sel) : null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {(["ok", "warn", "bad", "off"] as NodeStatus[]).map((s) => (
          <span key={s} className="inline-flex items-center gap-1.5 rounded-full border border-line bg-panel px-3 py-1">
            <span className={`size-2 rounded-full ${STATUS[s].dot}`} />
            {t(`workflow.status.${s}`)} <b className="tabular-nums">{count(s)}</b>
          </span>
        ))}
        <span className="text-xs text-mut">{t("workflow.view.hint")}</span>
      </div>

      {/* Canvas: horizontal scroll on small screens */}
      <div className="overflow-x-auto rounded-2xl border border-line bg-[radial-gradient(circle,var(--line)_1px,transparent_1px)] [background-size:18px_18px]">
        <div className="relative" style={{ width, height }} onClick={() => setSel(null)}>
          {wf.columns.map((c, i) => (
            <div key={c} className="absolute text-[11px] font-semibold tracking-wide text-mut uppercase" style={{ left: PAD + i * COL, top: 10, width: W }}>
              {i + 1}. {c}
            </div>
          ))}
          <svg className="pointer-events-none absolute inset-0" width={width} height={height}>
            <defs>
              <marker id="wf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" className="fill-slate-400" />
              </marker>
              <marker id="wf-arrow-on" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" className="fill-indigo-500" />
              </marker>
            </defs>
            {wf.edges.map((e) => {
              const a = byId.get(e.from);
              const b = byId.get(e.to);
              if (!a || !b) return null;
              const p = pos(a);
              const q = pos(b);
              const on = sel != null && (e.from === sel || e.to === sel);
              const dim = sel != null && !on;
              let d: string;
              let lx: number;
              let ly: number;
              if (b.col === a.col && !e.loop) {
                // Same column: adjacent ones connect straight down; when rows apart, route around the left so it doesn't cross the blocks in between.
                if (Math.abs(b.row - a.row) === 1) {
                  const x = p.x + W / 2;
                  d = b.row > a.row ? `M${x},${p.y + H} L${x},${q.y}` : `M${x},${p.y} L${x},${q.y + H}`;
                  lx = x + 30;
                  ly = (p.y + H + q.y) / 2 + 4;
                } else {
                  const x = p.x;
                  const y1 = p.y + H / 2;
                  const y2 = q.y + H / 2;
                  d = `M${x},${y1} C${x - 22},${y1} ${x - 22},${y2} ${x},${y2}`;
                  lx = x - 4;
                  ly = (y1 + y2) / 2;
                }
              } else if (e.loop || b.col < a.col) {
                // Loop back: route around below the frame.
                const yb = height - 14;
                const x1 = p.x + W / 2;
                const x2 = q.x + W / 2;
                d = `M${x1},${p.y + H} C${x1},${yb} ${x2},${yb} ${x2},${q.y + H}`;
                lx = (x1 + x2) / 2;
                ly = yb - 6;
              } else {
                const x1 = p.x + W;
                const y1 = p.y + H / 2;
                const x2 = q.x;
                const y2 = q.y + H / 2;
                const dx = Math.max(40, (x2 - x1) / 2);
                d = `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
                lx = (x1 + x2) / 2;
                ly = (y1 + y2) / 2;
              }
              return (
                <g key={`${e.from}-${e.to}`} opacity={dim ? 0.15 : 1}>
                  <path d={d} fill="none" strokeWidth={on ? 2 : 1.5} strokeDasharray={e.loop ? "6 5" : undefined} className={on ? "stroke-indigo-500" : "stroke-slate-300"} markerEnd={`url(#${on ? "wf-arrow-on" : "wf-arrow"})`} />
                  {e.label && (on || !sel) && (
                    <text x={lx} y={ly - 4} textAnchor="middle" className={`text-[10px] ${on ? "fill-indigo-700" : "fill-slate-400"}`} style={{ paintOrder: "stroke", stroke: "var(--bg)", strokeWidth: 4 }}>
                      {e.label}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
          {wf.nodes.map((n) => {
            const p = pos(n);
            const s = STATUS[n.status];
            const Icon = ICON[n.icon] ?? Sparkles;
            const dim = sel != null && !near.has(n.id);
            return (
              <button
                key={n.id}
                type="button"
                onClick={(ev) => {
                  ev.stopPropagation();
                  setSel(sel === n.id ? null : n.id);
                }}
                className={`absolute flex flex-col rounded-xl border-2 bg-panel px-3 py-2 text-left shadow-sm transition hover:shadow-md ${sel === n.id ? "border-indigo-500 ring-2 ring-indigo-200" : s.ring} ${dim ? "opacity-30" : ""}`}
                style={{ left: p.x, top: p.y, width: W, height: H }}
                title={n.issue ?? n.metric}
              >
                <span className="flex items-center gap-2">
                  <span className={`grid size-6 shrink-0 place-items-center rounded-md ${n.status === "off" ? "bg-soft text-mut" : "bg-indigo-50 text-indigo-700"}`}>
                    <Icon className="size-3.5" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">{n.title}</span>
                  <span className={`size-2.5 shrink-0 rounded-full ${s.dot}`} />
                </span>
                <span className="mt-1 line-clamp-2 text-xs text-ink2">{n.metric}</span>
                {(n.updatedAt || n.nextAt) && (
                  <span className="mt-auto flex gap-2 truncate text-[10px] text-mut tabular-nums">
                    {n.updatedAt && <span title={`${n.updatedLabel ?? t("workflow.view.updated")}: ${fmt(n.updatedAt)}`}>⟳ {ago(n.updatedAt, now, true)}</span>}
                    {n.nextAt && (
                      <span className="text-indigo-700" title={`${n.nextLabel ?? t("workflow.view.next")}: ${fmt(n.nextAt)}`}>
                        ⏱ {left(n.nextAt, now, true)}
                      </span>
                    )}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {selected && (
        <div className={`rounded-2xl border-2 bg-panel p-4 ${STATUS[selected.status].ring}`}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="flex items-center gap-2 font-semibold text-ink">
              <span className={`size-2.5 rounded-full ${STATUS[selected.status].dot}`} />
              {selected.title} <span className={`text-xs font-medium ${STATUS[selected.status].text}`}>· {t(`workflow.status.${selected.status}`)}</span>
            </p>
            {selected.href && (
              <Link href={selected.href} className={btnClass("secondary")}>
                {selected.cta ?? t("workflow.view.open")}
              </Link>
            )}
          </div>
          <p className="mt-2 text-sm text-ink">{selected.metric}</p>
          <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm">
            <span className="text-ink2">
              {t("workflow.view.lastTime", { label: selected.updatedLabel ?? t("workflow.view.updated") })} {selected.updatedAt ? <b className="text-ink">{fmt(selected.updatedAt)} · {ago(selected.updatedAt, now)}</b> : <b className="text-ink">{t("workflow.view.none")}</b>}
            </span>
            {selected.nextAt ? (
              <span className="text-ink2">
                {selected.nextLabel ?? t("workflow.view.next")}: <b className="text-indigo-700">{fmt(selected.nextAt)} · {left(selected.nextAt, now)}</b>
                {selected.nextNote && <span className="text-mut"> ({selected.nextNote})</span>}
              </span>
            ) : (
              selected.nextNote && <span className="text-ink2">{t("workflow.view.next")}: {selected.nextNote}</span>
            )}
            {selected.mode && <span className="text-mut">{t("workflow.view.mode")}: {selected.mode}</span>}
          </div>
          {selected.lines.length > 0 && (
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-ink2">
              {selected.lines.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          )}
          {selected.issue && <p className={`mt-2 text-sm ${STATUS[selected.status].text}`}>→ {selected.issue}</p>}
          <p className="mt-2 text-xs text-mut">
            {t("workflow.view.receivesFrom")}: {wf.edges.filter((e) => e.to === selected.id).map((e) => byId.get(e.from)?.title).join(", ") || "—"} · {t("workflow.view.feeds")}: {wf.edges.filter((e) => e.from === selected.id).map((e) => byId.get(e.to)?.title).join(", ") || "—"}
          </p>
        </div>
      )}

      <div className="rounded-2xl border border-line bg-panel p-4">
        <p className="mb-2 text-sm font-semibold text-ink">{t("workflow.view.issues", { count: issues.length })}</p>
        {issues.length ? (
          <ul className="divide-y divide-line">
            {issues.map((n) => (
              <li key={n.id} className="flex flex-wrap items-start gap-3 py-2.5">
                <span className={`mt-1.5 size-2.5 shrink-0 rounded-full ${STATUS[n.status].dot}`} />
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setSel(n.id)}>
                  <span className="block text-sm font-medium text-ink">{n.title}</span>
                  <span className="block text-sm text-ink2">{n.issue ?? n.metric}</span>
                </button>
                {n.href && (
                  <Link href={n.href} className="shrink-0 text-sm font-medium text-indigo-700 hover:underline">
                    {n.cta ?? t("workflow.view.open")} →
                  </Link>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-emerald-700">{t("workflow.view.allOk")}</p>
        )}
      </div>
    </div>
  );
}
