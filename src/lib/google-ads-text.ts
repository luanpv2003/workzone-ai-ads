// Google ad text limits (usable in the browser too: no DB import).
import type { T } from "@/i18n/translate";

/** Length as Google counts it: Chinese / Japanese / Korean and full-width characters count as 2. */
export function gWidth(s: string) {
  let n = 0;
  for (const ch of s) n += /[\u1100-\u11ff\u2e80-\ua4cf\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1;
  return n;
}
export const AD_LIMITS = { headline: 30, description: 90, path: 15, minHeadlines: 3, maxHeadlines: 15, minDescriptions: 2, maxDescriptions: 4 };
/** Headlines: Google rejects ! in headlines, repeated characters (!!, ??), and all caps. */
export const cleanHeadline = (t: string) => t.replace(/!/g, "").replace(/([?.,])\1+/g, "$1").replace(/\s+/g, " ").trim();
export const cleanDescription = (t: string) => t.replace(/!{2,}/g, "!").replace(/([?.,])\1+/g, "$1").replace(/\s+/g, " ").trim();
/** Google forbids phone numbers in ad text (use call assets instead): ≥ 9 consecutive digits (spaces, dots, dashes, + allowed). */
export const hasPhone = (t: string) => /(?:\+?\d[\s.-]?){9,}/.test(t);
/** Price mentions in a sentence (e.g. 89K, 199k, 150.000đ) to cross-check against real documents. */
export const priceTokens = (t: string) => [...t.matchAll(/(\d[\d.,]*)\s?(k|K|nghìn|ngàn|đ|₫|vnd|VND)(?![a-zà-ỹ])/g)].map((m) => m[1].replace(/[.,]/g, "") + (/k|nghìn|ngàn/i.test(m[2]) ? "000" : ""));

// ------------------------------------------------------------------ Ad schedule
export const DAYS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"] as const;
export type Day = (typeof DAYS)[number];
const DAY_LABEL: Record<Day, string> = { MONDAY: "T2", TUESDAY: "T3", WEDNESDAY: "T4", THURSDAY: "T5", FRIDAY: "T6", SATURDAY: "T7", SUNDAY: "CN" };
export type SchedSlot = { id?: string; day: string; startHour: number; startMinute: number; endHour: number; endMinute: number };
export const hhmm = (h: number, m: number) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
/** Day label in the UI language (T2…CN in Vietnamese, Mon…Sun in English). */
export const dayLabel = (d: Day, t: T) => t(`settings.days.${d}`);
/** "Every day 10:00–21:15" / "Mon, Tue 10:00–21:00 · Sat 09:00–22:00" / "All day, every day" (no schedule). */
export function fmtSchedule(slots: SchedSlot[], t: T) {
  if (!slots.length) return t("settings.days.allDay");
  const byWindow = new Map<string, string[]>();
  for (const s of [...slots].sort((a, b) => DAYS.indexOf(a.day as Day) - DAYS.indexOf(b.day as Day))) {
    const w = `${hhmm(s.startHour, s.startMinute)}–${hhmm(s.endHour, s.endMinute)}`;
    byWindow.set(w, [...(byWindow.get(w) ?? []), s.day]);
  }
  return [...byWindow]
    .map(([w, days]) => `${days.length === 7 ? t("settings.days.everyDay") : days.map((d) => (d in DAY_LABEL ? dayLabel(d as Day, t) : d)).join(", ")} ${w}`)
    .join(" · ");
}
