// Server + browser shared part of the Knowledge base (no fs/DB access).
import { norm } from "./text";
import type { T } from "@/i18n/translate";

export const KNOWLEDGE_CATEGORIES = [
  { key: "product", icon: "🛍️" },
  { key: "brand", icon: "🎯" },
  { key: "proposal", icon: "📋" },
  { key: "project", icon: "📁" },
  { key: "creative", icon: "🎬" },
  { key: "faq", icon: "💬" },
  { key: "report", icon: "📈" },
  { key: "other", icon: "📄" },
] as const;

type KnowledgeCategory = (typeof KNOWLEDGE_CATEGORIES)[number]["key"];
const CATEGORY_KEYS = KNOWLEDGE_CATEGORIES.map((c) => c.key) as KnowledgeCategory[];
/** Label / hint of a group in the UI language of the given translator. */
export const categoryLabel = (key: string, t: T) => (CATEGORY_KEYS.includes(key as KnowledgeCategory) ? t(`settings.knowledgeCategories.${key as KnowledgeCategory}.label`) : key);
export const categoryHint = (key: string, t: T) => (CATEGORY_KEYS.includes(key as KnowledgeCategory) ? t(`settings.knowledgeCategories.${key as KnowledgeCategory}.hint`) : "");
export const CATEGORY_ICON: Record<string, string> = Object.fromEntries(KNOWLEDGE_CATEGORIES.map((c) => [c.key, c.icon]));

export function toCategory(v: unknown): KnowledgeCategory {
  return CATEGORY_KEYS.includes(v as KnowledgeCategory) ? (v as KnowledgeCategory) : "other";
}

/** Guess the document group from the file name, so bulk uploads don't require picking per file. */
export function guessCategory(fileName: string): KnowledgeCategory {
  const n = norm(fileName);
  // Contracts checked first: "HD-Dich-vu-Quang-cao" contains "dịch vụ" (service) but is a contract.
  if (/hop dong|^hd[-_ ]|\bhd[-_ ]|phu luc|bao gia|ndnc|nghiem thu|contract/.test(n)) return "project";
  if (/de xuat|ke hoach|plan|proposal|chien luoc|slide/.test(n)) return "proposal";
  if (/menu|bang gia|san pham|dich vu|catalog|price|product/.test(n)) return "product";
  if (/kich ban|script|content|noi dung|thiet ke|design|landing/.test(n)) return "creative";
  if (/faq|hoi dap|cau hoi|chinh sach|tu van/.test(n)) return "faq";
  if (/bao cao|report|ket qua|overview/.test(n)) return "report";
  if (/thuong hieu|brand|persona|chan dung|doi thu/.test(n)) return "brand";
  return "other";
}
