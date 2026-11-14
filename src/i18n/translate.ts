import type { Locale } from "./config";
import { vi } from "./messages/vi";
import { en } from "./messages/en";
import { BRAND } from "../lib/brand";

// Vietnamese is the source catalogue; English must have exactly the same keys (enforced by the
// Messages type in messages/en.ts), so a missing translation is a compile error, not a blank UI.
export type Messages = typeof vi;
const CATALOGUES: Record<Locale, Messages> = { vi, en };

type Leaf<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaf<T[K], `${P}${K}.`>;
}[keyof T & string];
/** Dotted key of any message, e.g. "nav.today". */
export type MessageKey = Leaf<Messages>;
export type Vars = Record<string, string | number>;

function lookup(m: Messages, key: string): string | undefined {
  let cur: unknown = m;
  for (const part of key.split(".")) cur = (cur as Record<string, unknown> | undefined)?.[part];
  return typeof cur === "string" ? cur : undefined;
}

/** Translator for one locale. `{name}` placeholders are filled from vars. Falls back to Vietnamese, then the key. */
export function translator(locale: Locale) {
  const m = CATALOGUES[locale];
  return (key: MessageKey, vars?: Vars) => {
    const s = lookup(m, key) ?? lookup(vi, key) ?? key;
    // {operator} (who runs the ads) and {app} are filled everywhere unless the caller passes its own.
    const all: Vars = { operator: BRAND.agency, app: BRAND.app, ...vars };
    return s.includes("{") ? s.replace(/\{(\w+)\}/g, (raw, k: string) => (k in all ? String(all[k]) : raw)) : s;
  };
}
export type T = ReturnType<typeof translator>;
