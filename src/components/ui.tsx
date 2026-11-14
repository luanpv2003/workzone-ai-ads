import Link from "next/link";
import type { ReactNode } from "react";
import type { T } from "@/i18n/translate";

export function Card({ title, action, children, className = "", id }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  return (
    <section id={id} className={`rounded-xl border border-line bg-panel ${id ? "scroll-mt-16 md:scroll-mt-28" : ""} ${className}`}>
      {title && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3">
          <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
          {action}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

/** Label tones per the design system: each color has one meaning. Old names (gray/green/…) are kept for compatibility. */
const TONES = {
  gray: "bg-slate-100 text-slate-700",
  mut: "bg-slate-100 text-slate-600",
  green: "bg-emerald-50 text-emerald-700",
  good: "bg-emerald-50 text-emerald-700",
  red: "bg-rose-50 text-rose-700",
  bad: "bg-rose-50 text-rose-700",
  amber: "bg-amber-50 text-amber-700",
  warn: "bg-amber-50 text-amber-700",
  blue: "bg-sky-50 text-sky-700",
  info: "bg-sky-50 text-sky-700",
  violet: "bg-violet-50 text-violet-700",
  ai: "bg-violet-50 text-violet-700",
  meta: "bg-orange-50 text-orange-700",
  pri: "bg-indigo-50 text-indigo-700",
};
export type Tone = keyof typeof TONES;

export function Badge({ tone = "gray", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${TONES[tone]}`}>{children}</span>;
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "good" | "bad" }) {
  return (
    <div className={`rounded-xl border bg-panel px-4 py-3.5 ${tone === "bad" ? "border-rose-300" : "border-line"}`}>
      <div className="text-[13px] text-mut">{label}</div>
      <div className={`mt-1 text-lg leading-tight font-semibold break-words @md:text-[22px] tracking-tight tabular-nums ${tone === "good" ? "text-emerald-700" : tone === "bad" ? "text-rose-700" : "text-ink"}`}>
        {value}
      </div>
      {hint && <div className="mt-1 text-xs text-mut">{hint}</div>}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-mut">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-slate-300 bg-panel p-8 text-center text-sm text-mut">{children}</div>;
}

export function LinkButton({ href, children, variant = "secondary" }: { href: string; children: ReactNode; variant?: BtnVariant }) {
  return (
    <Link href={href} className={btnClass(variant)}>
      {children}
    </Link>
  );
}

/**
 * Button per the design system (32px tall, 8px radius):
 * primary · secondary · ghost · danger (only for deleting in the system) · dark (ink) ·
 * ai (Claude / long-running, with estimated time) · meta (changes live ads on Meta - always opens a confirmation dialog).
 */
export type BtnVariant = "primary" | "secondary" | "danger" | "ghost" | "dark" | "ai" | "meta";
export function btnClass(variant: BtnVariant = "secondary") {
  const base =
    "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-medium whitespace-nowrap transition disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0";
  return {
    primary: `${base} bg-indigo-600 text-white hover:opacity-90`,
    secondary: `${base} border border-line bg-panel text-ink hover:bg-hover`,
    danger: `${base} bg-rose-600 text-white hover:opacity-90`,
    ghost: `${base} text-slate-600 hover:bg-hover hover:text-ink`,
    dark: `${base} bg-ink text-panel hover:opacity-90`,
    ai: `${base} border border-violet-200 bg-violet-50 text-violet-700 hover:bg-violet-100`,
    meta: `${base} bg-orange-600 text-white hover:opacity-90`,
  }[variant];
}

export const inputClass =
  "w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm text-ink placeholder:text-mut2 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-100";

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-ink2">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-mut">{hint}</span>}
    </label>
  );
}

export function statusTone(s: string): Tone {
  return s === "ACTIVE" ? "green" : s === "PAUSED" ? "gray" : "amber";
}

export function priorityTone(p: string): Tone {
  return p === "high" ? "red" : p === "medium" ? "amber" : "gray";
}

export const priorityLabels = (t: T): Record<string, string> => ({ high: t("system.ui.priorityHigh"), medium: t("system.ui.priorityMedium"), low: t("system.ui.priorityLow") });
