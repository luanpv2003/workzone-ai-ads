"use client";

import { useTransition } from "react";
import { LOCALES, type Locale } from "@/i18n/config";
import { useLocale, useT } from "@/i18n/client";
import { setLocaleAction } from "@/i18n/actions";

/** VI / EN toggle in the top bar. The choice is stored in a cookie and the page re-renders on the server. */
export function LocaleSwitch() {
  const locale = useLocale();
  const t = useT();
  const [pending, start] = useTransition();
  return (
    <div role="group" aria-label={t("common.language")} className="flex h-8 items-center rounded-lg border border-line bg-panel p-0.5 text-xs font-semibold">
      {LOCALES.map((l: Locale) => (
        <button
          key={l}
          type="button"
          disabled={pending}
          aria-pressed={l === locale}
          onClick={() => start(() => setLocaleAction(l))}
          className={`h-full rounded-md px-2 uppercase ${l === locale ? "bg-ink text-panel" : "text-mut hover:text-ink"}`}
        >
          {l}
        </button>
      ))}
    </div>
  );
}
