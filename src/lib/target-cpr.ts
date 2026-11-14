import type { Client } from "@prisma/client";
import { translator, type T } from "@/i18n/translate";

// Target CPR: if the user entered one manually (Client.targetCpr), use that.
// Otherwise the system auto-suggests it from 90-day ad set history (Client.autoTargetCpr), recomputed after each sync.
// Method: weighted CPR (last 30 days count double, like persona scoring) × 90%: set the target slightly better than the current level
// so costly ad sets stand out, without straying too far from reality. Needs ≥ minResults results of the primary result type to suggest.

export const AUTO_FACTOR = 0.9;

type TargetFields = Pick<Client, "targetCpr" | "autoTargetCpr">;

/** Target CPR in use: manual entry first, otherwise the auto-suggested level. */
export function targetCprOf(c: TargetFields): number | null {
  return c.targetCpr ?? c.autoTargetCpr ?? null;
}

/** Label with its source, so every comparison states whether the baseline was entered by a person or computed by the system. */
export function targetLabelOf(c: TargetFields, t: T = translator("vi")) {
  return c.targetCpr != null ? t("workflow.targetCpr.manual") : t("workflow.targetCpr.auto");
}

/** Round to 2 significant digits (80.190 → 80.000, 26.540 → 27.000, 1,234 → 1,2). */
export function roundNice(v: number) {
  const step = 10 ** Math.max(0, Math.floor(Math.log10(v)) - 1);
  return v >= 10 ? Math.round(v / step) * step : Math.round(v * 10) / 10;
}

