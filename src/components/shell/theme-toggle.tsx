"use client";

import { Moon, Sun } from "lucide-react";
import { useSyncExternalStore } from "react";
import { useT } from "@/i18n/client";

const subscribe = (cb: () => void) => {
  const o = new MutationObserver(cb);
  o.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => o.disconnect();
};

/** Toggle light / dark. Stored in the browser (localStorage "wz-theme"); a script in the root layout applies it before paint to avoid flashing. */
export function ThemeToggle({ className = "" }: { className?: string }) {
  const t = useT();
  const dark = useSyncExternalStore(subscribe, () => document.documentElement.dataset.theme === "dark", () => false);
  const toggle = () => {
    const next = !dark;
    document.documentElement.dataset.theme = next ? "dark" : "light";
    try {
      localStorage.setItem("wz-theme", next ? "dark" : "light");
    } catch {}
  };
  return (
    <button type="button" onClick={toggle} title={dark ? t("system.shell.themeLight") : t("system.shell.themeDark")} aria-label={dark ? t("system.shell.themeLight") : t("system.shell.themeDark")} className={`grid size-8 place-items-center rounded-lg border border-line bg-panel text-ink2 hover:bg-hover ${className}`}>
      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
}
