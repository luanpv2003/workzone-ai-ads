import { translator, type T } from "@/i18n/translate";

// Targeting languages. Meta needs a numeric "locale key"; the system looks up the real key via the API
// (/search?type=adlocale) at publish time, never guessing codes. query: Meta's English name used for that lookup (data).
const RAW = [
  { code: "en_all", query: "English (All)" },
  { code: "ko", query: "Korean" },
  { code: "ja", query: "Japanese" },
  { code: "zh_all", query: "Chinese (All)" },
  { code: "zh_tw", query: "Traditional Chinese (Taiwan)" },
  { code: "zh_hk", query: "Traditional Chinese (Hong Kong)" },
  { code: "zh_cn", query: "Simplified Chinese (China)" },
  { code: "fr_all", query: "French (All)" },
  { code: "de", query: "German" },
  { code: "es_all", query: "Spanish (All)" },
  { code: "ru", query: "Russian" },
  { code: "th", query: "Thai" },
  { code: "id", query: "Indonesian" },
  { code: "ms", query: "Malay" },
  { code: "tl", query: "Filipino" },
  { code: "it", query: "Italian" },
  { code: "pt_all", query: "Portuguese (All)" },
  { code: "nl", query: "Dutch" },
  { code: "ar", query: "Arabic" },
  { code: "hi", query: "Hindi" },
  { code: "vi", query: "Vietnamese" },
] as const;

type LanguageCode = (typeof RAW)[number]["code"];

/** Label of a targeting language in the UI language (unknown codes are shown as is). */
export const languageLabel = (code: string, t: T) => (RAW.some((l) => l.code === code) ? t(`ai.languages.${code as LanguageCode}`) : code);

const viT = translator("vi");
/** label: Vietnamese label, kept for existing importers; in the UI prefer languageLabel(code, t). */
export const LANGUAGES = RAW.map((l) => ({ ...l, label: viT(`ai.languages.${l.code}`) }));

export const LANGUAGE_CODES = RAW.map((l) => l.code) as [LanguageCode, ...LanguageCode[]];
export const LANGUAGE_BY_CODE = new Map(LANGUAGES.map((l) => [l.code as string, l]));
