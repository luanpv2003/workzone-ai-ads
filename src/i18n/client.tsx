"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { Locale } from "./config";
import { translator, type T } from "./translate";

const Ctx = createContext<{ locale: Locale; t: T } | null>(null);

/** Put once in the root layout with the request locale; client components then call useT(). */
export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const value = useMemo(() => ({ locale, t: translator(locale) }), [locale]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useT(): T {
  const v = useContext(Ctx);
  if (!v) throw new Error("useT() must be used inside <I18nProvider>.");
  return v.t;
}

export function useLocale(): Locale {
  const v = useContext(Ctx);
  if (!v) throw new Error("useLocale() must be used inside <I18nProvider>.");
  return v.locale;
}
