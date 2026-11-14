"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { btnClass } from "./ui";
import { useT } from "@/i18n/client";

/** "Thêm ▾" (More) button: groups secondary actions into a dropdown menu. */
export function MoreMenu({ label, children }: { label?: string; children: ReactNode }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button type="button" className={btnClass("secondary")} onClick={() => setOpen((x) => !x)} aria-expanded={open}>
        {label ?? t("core.moreMenu.more")} <ChevronDown />
      </button>
      {/* Keep in the DOM when closed so a running button (spinner) isn't destroyed mid-way. */}
      <div className={`absolute right-0 z-40 mt-1 w-80 rounded-[14px] border border-line bg-panel p-1.5 shadow-pop ${open ? "" : "hidden"}`}>
        <div className="flex flex-col items-stretch gap-0.5 [&_button]:h-9 [&_button]:w-full [&_button]:justify-start [&_button]:border-0 [&_button]:bg-transparent [&_button]:text-ink [&_button:hover]:bg-hover [&>div]:items-stretch">{children}</div>
      </div>
    </div>
  );
}
