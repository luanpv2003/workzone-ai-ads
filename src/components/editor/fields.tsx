"use client";

import type { ReactNode } from "react";
import { inputClass } from "../ui";

/** Titled content block, like the "cards" in the Ads Manager edit panel. */
export function Section({ title, hint, children, right }: { title: string; hint?: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-panel p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-slate-900">{title}</h3>
          {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
        </div>
        {right}
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

export function Label({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="mb-1 flex items-baseline justify-between gap-2">
      <span className="text-sm font-medium text-slate-700">{children}</span>
      {hint && <span className="text-xs text-slate-400">{hint}</span>}
    </div>
  );
}

export function TextInput({ value, onChange, placeholder, maxHint }: { value: string; onChange: (v: string) => void; placeholder?: string; maxHint?: number }) {
  return (
    <div>
      <input className={inputClass} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      {maxHint && <div className={`mt-1 text-right text-xs ${value.length > maxHint ? "text-amber-600" : "text-slate-400"}`}>{value.length}/{maxHint}</div>}
    </div>
  );
}

export function TextArea({ value, onChange, rows = 4, placeholder }: { value: string; onChange: (v: string) => void; rows?: number; placeholder?: string }) {
  return <textarea className={inputClass} rows={rows} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />;
}

/** Money input with dot thousands separators. */
export function MoneyInput({ value, onChange, currency }: { value: number | null; onChange: (v: number) => void; currency: string }) {
  return (
    <div className="relative">
      <input
        className={`${inputClass} pr-14 tabular-nums`}
        inputMode="numeric"
        value={value ? new Intl.NumberFormat("vi-VN").format(value) : ""}
        onChange={(e) => onChange(Number(e.target.value.replace(/\D/g, "")) || 0)}
      />
      <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-xs text-slate-400">{currency}</span>
    </div>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode }) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition ${checked ? "bg-indigo-600" : "bg-slate-300"}`}
      >
        <span className={`absolute top-0.5 size-4 rounded-full bg-panel shadow transition ${checked ? "left-4.5" : "left-0.5"}`} />
      </button>
      <span>
        <span className="block text-sm font-medium text-slate-800">{label}</span>
        {hint && <span className="block text-xs text-slate-500">{hint}</span>}
      </span>
    </label>
  );
}

export function Radio<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: ReactNode; hint?: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="space-y-2">
      {options.map((o) => (
        <label key={o.value} className="flex cursor-pointer items-start gap-2.5">
          <input type="radio" className="mt-1 accent-indigo-600" checked={value === o.value} onChange={() => onChange(o.value)} />
          <span>
            <span className="block text-sm text-slate-800">{o.label}</span>
            {o.hint && <span className="block text-xs text-slate-500">{o.hint}</span>}
          </span>
        </label>
      ))}
    </div>
  );
}

export function Chip({ children, onRemove, tone = "slate" }: { children: ReactNode; onRemove?: () => void; tone?: "slate" | "indigo" }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full py-1 pr-1.5 pl-2.5 text-xs ${tone === "indigo" ? "bg-indigo-50 text-indigo-800" : "bg-slate-100 text-slate-700"}`}>
      {children}
      {onRemove && (
        <button type="button" onClick={onRemove} className="grid size-4 place-items-center rounded-full text-slate-400 hover:bg-slate-200 hover:text-slate-700" aria-label="Xóa">
          ×
        </button>
      )}
    </span>
  );
}
