"use client";

import { useT } from "@/i18n/client";

/** Pick hours of the day: 24 toggle cells + a few quick presets. [] = off (manual only). */
export function HourPicker({ value, onChange, quick }: { value: number[]; onChange: (v: number[]) => void; quick: { label: string; hours: number[] }[] }) {
  const t = useT();
  const same = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  const toggle = (h: number) => onChange(value.includes(h) ? value.filter((x) => x !== h) : [...value, h].sort((a, b) => a - b));
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {quick.map((q) => (
          <button
            key={q.label}
            type="button"
            onClick={() => onChange(q.hours)}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition ${same(value, q.hours) ? "border-indigo-400 bg-indigo-50 text-indigo-700" : "border-line text-slate-600 hover:bg-hover"}`}
          >
            {q.label}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-6 gap-1 sm:grid-cols-12" role="group" aria-label={t("workflow.hourPicker.ariaLabel")}>
        {Array.from({ length: 24 }, (_, h) => {
          const on = value.includes(h);
          return (
            <button
              key={h}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(h)}
              className={`h-7 rounded-md text-xs tabular-nums transition ${on ? "bg-indigo-600 font-medium text-white" : "bg-soft text-slate-500 hover:bg-hover hover:text-ink"}`}
            >
              {h}h
            </button>
          );
        })}
      </div>
    </div>
  );
}
