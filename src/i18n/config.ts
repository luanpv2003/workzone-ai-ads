// Supported UI languages. The locale lives in a cookie (no /en/... URLs: this is a logged-in tool).
export const LOCALES = ["vi", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "vi";
export const LOCALE_COOKIE = "locale";
export const isLocale = (v: unknown): v is Locale => typeof v === "string" && (LOCALES as readonly string[]).includes(v);
/** Language name used when telling the AI which language to write user-facing text in. */
export const AI_LANGUAGE: Record<Locale, string> = { vi: "Vietnamese", en: "English" };
