"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useT } from "@/i18n/client";

// Arrow to collapse / expand child rows in the campaign table (child rows have data-parent containing the parent row id).
export function RowToggle({ id, label }: { id: string; label: string }) {
  const t = useT();
  const [open, setOpen] = useState(true);
  return (
    <button
      type="button"
      aria-label={t(open ? "core.rowToggle.collapse" : "core.rowToggle.expand", { label })}
      className="mr-1 inline-grid size-5 shrink-0 place-items-center rounded text-slate-500 align-middle hover:bg-hover"
      onClick={() => {
        const next = !open;
        setOpen(next);
        document.querySelectorAll<HTMLElement>(`tr[data-parent~="${id}"]`).forEach((tr) => {
          // Re-expanding a parent: only show children whose own group is also expanded.
          if (next) {
            const own = tr.dataset.parent!.split(" ").filter((p) => p !== id);
            if (own.some((p) => document.querySelector(`[data-collapsed="${p}"]`))) return;
            tr.hidden = false;
          } else tr.hidden = true;
        });
        const self = document.querySelector<HTMLElement>(`tr[data-row="${id}"]`);
        if (self) {
          if (next) delete self.dataset.collapsed;
          else self.dataset.collapsed = id;
        }
      }}
    >
      {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
    </button>
  );
}
