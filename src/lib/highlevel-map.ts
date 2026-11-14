import type { GhlPipeline } from "./highlevel";
import type { MessageKey, T } from "@/i18n/translate";

// HighLevel stage ↔ sales rating mapping: pure functions, used both on the server (highlevel-sync.ts) and in the browser
// (highlevel-connect.tsx re-suggests when the pipeline changes). No db / crypto imports.

export type StageFeedback = { contact?: string; quality?: string; outcome?: string };
export type StageMap = Record<string, StageFeedback>;
/** "<field>:<value>" (e.g. "quality:Tốt") → stageId | "won" | "lost" ("" = no change on HighLevel). */
export type ReverseMap = Record<string, string>;
// Feedback values are DATA (stored in the DB / Google Sheet). This maps each known value to its UI translation.
const OPTION_KEYS: Record<string, MessageKey> = {
  "Được": "customers.feedback.options.answered",
  "Không nghe máy": "customers.feedback.options.noAnswer",
  "Hẹn gọi lại": "customers.feedback.options.callBack",
  "Sai số": "customers.feedback.options.wrongNumber",
  "Tốt": "customers.feedback.options.good",
  "Trung bình": "customers.feedback.options.average",
  "Kém": "customers.feedback.options.poor",
  "Sai tệp": "customers.feedback.options.wrongAudience",
  "Đang chăm": "customers.feedback.options.nurturing",
  "Đã chốt": "customers.feedback.options.closed",
  "Không mua": "customers.feedback.options.notBuy",
  "Bỏ lead": "customers.feedback.options.dropped",
};
/** Display text of a stored feedback value in the UI language (unknown values are shown as stored). */
export const feedbackOptionLabel = (t: T, value: string) => (OPTION_KEYS[value] ? t(OPTION_KEYS[value]) : value);
const REVERSE_FIELDS = ["outcome", "quality", "contact"] as const; // priority order when several columns have values

/** Suggest the reverse mapping from the forward mapping: value → first stage (in pipeline order) that maps to it; Đã chốt (Closed) = Won, Không mua / Bỏ lead (Didn't buy / Dropped lead) = Lost. */
export function suggestReverse(pipeline: GhlPipeline | undefined, map: StageMap, options: Record<string, readonly string[]>): ReverseMap {
  const out: ReverseMap = {};
  for (const field of REVERSE_FIELDS)
    for (const v of options[field] ?? []) {
      const key = `${field}:${v}`;
      if (field === "outcome" && v === "Đã chốt") out[key] = "won";
      else if (field === "outcome" && (v === "Không mua" || v === "Bỏ lead")) out[key] = "lost";
      else out[key] = pipeline?.stages.find((s) => map[s.id]?.[field as keyof StageFeedback] === v)?.id ?? "";
    }
  return out;
}

/** HighLevel target for a rating: Result column first, then Quality, then Contact. */
export function reverseTarget(fb: StageFeedback, rev: ReverseMap): string {
  for (const field of REVERSE_FIELDS) {
    const v = fb[field];
    if (v && rev[`${field}:${v}`]) return rev[`${field}:${v}`];
  }
  return "";
}
