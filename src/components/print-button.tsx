"use client";

import { useEffect } from "react";
import { useT } from "@/i18n/client";

/** "In / Lưu PDF" (Print / Save PDF) button (opens the browser print dialog, choose "Save as PDF"). auto: open as soon as the page finishes loading. */
export function PrintButton({ auto }: { auto?: boolean }) {
  const t = useT();
  useEffect(() => {
    if (!auto) return;
    const timer = setTimeout(() => window.print(), 600); // wait for fonts and layout to settle
    return () => clearTimeout(timer);
  }, [auto]);
  return (
    <button type="button" onClick={() => window.print()} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700">
      ⬇ {t("core.print.button")}
    </button>
  );
}
