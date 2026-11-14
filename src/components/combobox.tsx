"use client";

import { useMemo, useRef, useState } from "react";
import { norm } from "@/lib/text";
import { inputClass } from "./ui";
import { useT } from "@/i18n/client";

type ComboOption = { value: string; label: string; sub?: string; muted?: boolean };

/** Searchable select: type a name or ID (with or without diacritics) to filter. Supports ↑ ↓ Enter Esc keys. */
export function Combobox({
  options,
  value,
  onChange,
  placeholder,
}: {
  options: ComboOption[];
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const t = useT();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const selected = options.find((o) => o.value === value);

  const filtered = useMemo(() => {
    const k = norm(q.trim());
    if (!k) return options;
    return options.filter((o) => norm(`${o.label} ${o.value} ${o.sub ?? ""}`).includes(k));
  }, [q, options]);

  const pick = (o: ComboOption) => {
    onChange(o.value);
    setQ("");
    setOpen(false);
    input.current?.blur();
  };

  return (
    <div className="relative">
      <input
        ref={input}
        className={inputClass}
        value={open ? q : (selected?.label ?? "")}
        placeholder={selected ? selected.label : (placeholder ?? t("core.combobox.placeholder"))}
        onFocus={() => {
          setOpen(true);
          setActive(0);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, filtered.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter" && filtered[active]) {
            e.preventDefault();
            pick(filtered[active]);
          } else if (e.key === "Escape") {
            setOpen(false);
            input.current?.blur();
          }
        }}
      />
      <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-xs text-slate-400">▾</span>
      {open && (
        <ul className="absolute z-30 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-slate-200 bg-panel py-1 shadow-lg">
          {!filtered.length && <li className="px-3 py-2 text-sm text-slate-400">{t("core.combobox.notFound")}</li>}
          {filtered.map((o, i) => (
            <li key={o.value}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(o)}
                className={`flex w-full items-baseline justify-between gap-3 px-3 py-2 text-left text-sm ${i === active ? "bg-indigo-50" : ""} ${o.value === value ? "font-medium text-indigo-700" : o.muted ? "text-slate-400" : "text-slate-800"}`}
              >
                <span className="truncate">{o.label}</span>
                {o.sub && <span className="shrink-0 text-xs text-slate-400">{o.sub}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && options.length > 5 && <p className="mt-1 text-xs text-slate-400">{t("core.combobox.results", { shown: filtered.length, total: options.length })}</p>}
    </div>
  );
}
