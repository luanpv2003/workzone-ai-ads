import type { T } from "@/i18n/translate";

// Some values are stored in Vietnamese as data markers (written by background jobs, compared in code, read by Claude).
// They stay as they are in the DB; these helpers only translate them for display. Client-safe (no server imports).

/** Actor markers written by background jobs (ClientJob.triggeredBy, Recommendation.decidedBy, report creator). */
const SCHEDULE_ACTOR = "Lịch tự động";
const AUTO_ACTOR = "Tự động";

/** Display name of who ran / decided something: translates the background markers, other names unchanged. */
export const actorLabel = (v: string, t: T) => (v === SCHEDULE_ACTOR ? t("customers.nurtureLib.by.schedule") : v === AUTO_ACTOR ? t("workflow.card.autoBadge") : v);
