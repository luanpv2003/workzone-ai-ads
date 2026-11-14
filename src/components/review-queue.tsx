"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Keyboard review in sequence: J / K move between cards, Enter = press the approve button of the selected card (Meta actions still open the confirmation dialog),
 * S = skip. Keys are ignored while typing in an input.
 */
export function ReviewQueue({ children, count }: { children: ReactNode; count: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    const cards = () => Array.from(ref.current?.querySelectorAll<HTMLElement>(":scope > article, :scope > div > article") ?? []);
    const mark = (i: number) => {
      cards().forEach((c, k) => c.classList.toggle("ring-2", k === i));
      cards().forEach((c, k) => c.classList.toggle("ring-indigo-400", k === i));
      cards()[i]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    };
    mark(idx);
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable], [role=alertdialog]") || e.metaKey || e.ctrlKey || e.altKey) return;
      const list = cards();
      if (!list.length) return;
      const k = e.key.toLowerCase();
      if (k === "j") setIdx((i) => Math.min(list.length - 1, i + 1));
      else if (k === "k") setIdx((i) => Math.max(0, i - 1));
      else if (k === "enter") list[idx]?.querySelector<HTMLButtonElement>("[data-approve]:not(:disabled)")?.click();
      else if (k === "s") list[idx]?.querySelector<HTMLButtonElement>("[data-skip]:not(:disabled)")?.click();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [idx, count]);
  return (
    <div ref={ref} className="space-y-3">
      {children}
    </div>
  );
}
