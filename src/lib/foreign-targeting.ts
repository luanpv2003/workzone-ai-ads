import { catalog } from "./targeting";
import type { TargetingPatch } from "./meta/types";
import { translator, type T } from "@/i18n/translate";

const viT = translator("vi");

// Target customers are foreigners (Client.audienceOrigin = "foreign"): find where ad sets are leaking to Vietnamese people.
// Meta doesn't allow excluding by language / nationality, so filtering is only possible with conditions Vietnamese people almost never match:
// Facebook language (Korean, Japanese, Chinese, French, German...) or the behavior "Đã sống tại … (Ngoại kiều)" (Lived in … (Expats)).
// English can't be filtered: many Vietnamese people use Facebook in English.


/** Meta language codes (looked up via /search?type=adlocale) whose name the UI can show. */
const LOCALE_KEYS = [5, 6, 7, 9, 10, 11, 12, 17, 20, 21, 22, 23, 24, 27, 1001, 1002, 1003, 1004] as const;
type LocaleKey = (typeof LOCALE_KEYS)[number];
const isLocaleKey = (k: number): k is LocaleKey => (LOCALE_KEYS as readonly number[]).includes(k);
/** Name of a Meta language code in the UI language (unknown codes: "code N"). */
const localeName = (k: number, t: T = viT) => (isLocaleKey(k) ? t(`ai.foreign.locales.l${k}`) : t("ai.foreign.localeCode", { code: k }));
/** English and Vietnamese: can't separate Vietnamese people. */
const LEAKY_LOCALES = [6, 24, 1001, 27];
/** t: translator of the UI language (default Vietnamese, for callers without one). */
const localeNames = (keys: number[], t: T = viT) => (keys.length ? keys.map((k) => localeName(k, t)).join(", ") : t("ai.foreign.allLanguages"));

/** Age range of tourists / foreigners who usually message: outside it Meta tends to pour money into older Vietnamese people. */
export const FOREIGN_AGE = { min: 22, max: 45 };

/**
 * Expat behaviors in the Targeting library (real IDs). Only returns items present in the library.
 * Country names and "Đã sống tại …" / "Sống ở nước ngoài" are Meta's Vietnamese item names (data matched against the library): keep them.
 */
const EXPAT_NAMES = {
  west: ["Hoa Kỳ", "Vương quốc Anh", "Úc", "Canada", "Pháp", "Đức"],
  korea: ["Hàn Quốc"],
  china: ["Trung Quốc", "Hồng Kông"],
};
export function expatItems(group: keyof typeof EXPAT_NAMES) {
  const { items } = catalog();
  const out: { id: string; name: string; type: string }[] = [];
  for (const country of EXPAT_NAMES[group]) {
    const it = items.find((i) => i.type === "behaviors" && i.name.startsWith(`Đã sống tại ${country} (`));
    if (it && !out.some((x) => x.id === it.id)) out.push({ id: it.id, name: it.name, type: it.type });
  }
  if (group === "west") {
    const abroad = items.find((i) => i.type === "behaviors" && i.name === "Sống ở nước ngoài");
    if (abroad) out.push({ id: abroad.id, name: abroad.name, type: abroad.type });
  }
  return out;
}

type Spec = { locales?: number[]; age_min?: number; age_max?: number; age_range?: [number, number]; flexible_spec?: Record<string, { id: string; name?: string }[]>[]; targeting_automation?: { advantage_audience?: number } };

type LeakCheck = {
  issues: string[];
  patch: TargetingPatch | null; // null = cannot be auto-fixed (needs a new ad set)
  before: { locales: string; age: string };
  after: { locales: string; age: string } | null;
  hasExpat: boolean;
  advantage: boolean;
  keepLocales: number[]; // remaining languages after dropping English / Vietnamese
};

/** Check one ad set of a foreign-audience client. Returns null if the ad set is already filtered correctly. t: UI translator (default Vietnamese). */
export function checkForeignLeak(targetingJson: string, t: T = viT): LeakCheck | null {
  let spec: Spec = {};
  try {
    spec = JSON.parse(targetingJson || "{}");
  } catch {
    return null;
  }
  const locales = spec.locales ?? [];
  const flex = (spec.flexible_spec ?? []).flatMap((f) => Object.values(f).flat());
  const hasExpat = flex.some((x) => /Ngoại kiều|Sống ở nước ngoài/i.test(x.name ?? ""));
  const advantage = spec.targeting_automation?.advantage_audience === 1;
  const ageMin = spec.age_min ?? 18;
  const ageMax = spec.age_max ?? 65;
  // Advantage+ on: max age must stay 65; the actually targeted age is a "suggestion" (age_range).
  const range = advantage && spec.age_range ? spec.age_range : null;
  const effMax = range ? range[1] : ageMax;
  const ageLabel = (min: number, max: number, r: [number, number] | null) => `${min}–${max >= 65 ? "65+" : max}${r ? t("ai.foreign.suggested", { min: r[0], max: r[1] >= 65 ? "65+" : r[1] }) : ""}`;
  const leaky = locales.filter((k) => LEAKY_LOCALES.includes(k));
  const good = locales.filter((k) => !LEAKY_LOCALES.includes(k));
  const issues: string[] = [];
  if (leaky.length) issues.push(t("ai.foreign.issueLeaky", { locales: localeNames(leaky, t) }));
  if (!locales.length && !hasExpat) issues.push(t("ai.foreign.issueNoFilter"));
  const tooOld = effMax > FOREIGN_AGE.max + 5;
  if (tooOld) issues.push(t("ai.foreign.issueTooOld", { age: effMax >= 65 ? "65+" : effMax, min: FOREIGN_AGE.min, max: FOREIGN_AGE.max }));
  if (!issues.length) return null;

  const before = { locales: localeNames(locales, t), age: ageLabel(ageMin, ageMax, range) };
  // Fix in place only when, after dropping the leaking languages, filterable languages remain (Korean / Japanese / Chinese...).
  if (locales.length && !good.length) return { issues, patch: null, before, after: null, hasExpat, advantage, keepLocales: good };
  if (!locales.length && !hasExpat) return { issues, patch: null, before, after: null, hasExpat, advantage, keepLocales: good };
  const newMin = Math.max(range?.[0] ?? ageMin, FOREIGN_AGE.min);
  const patch: TargetingPatch = {
    ...(leaky.length && { removeLocales: leaky }),
    ...(tooOld && (advantage ? { ageRange: [newMin, FOREIGN_AGE.max] as [number, number] } : { ageMin: Math.max(ageMin, FOREIGN_AGE.min), ageMax: FOREIGN_AGE.max })),
  };
  const after = advantage
    ? ageLabel(ageMin, ageMax, patch.ageRange ?? range)
    : ageLabel(patch.ageMin ?? ageMin, patch.ageMax ?? ageMax, null);
  return {
    issues,
    patch,
    before,
    after: { locales: localeNames(leaky.length ? good : locales, t), age: after },
    hasExpat,
    advantage,
    keepLocales: good,
  };
}
