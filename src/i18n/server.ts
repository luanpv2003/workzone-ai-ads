import { cookies } from "next/headers";
import { DEFAULT_LOCALE, isLocale, LOCALE_COOKIE, type Locale } from "./config";
import { translator } from "./translate";

/**
 * UI language of the current request: the user's choice (cookie), otherwise Vietnamese.
 * The browser language is deliberately ignored: Vietnamese is the default for everyone.
 * Outside a request (cron, background workers) there is no cookie, so this returns the default.
 */
export async function getLocale(): Promise<Locale> {
  try {
    const c = (await cookies()).get(LOCALE_COOKIE)?.value;
    return isLocale(c) ? c : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

/** Translator for server components, server actions, route handlers and library code. */
export async function getT() {
  return translator(await getLocale());
}
