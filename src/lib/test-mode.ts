import { db } from "./db";
import { isVerified, type RankedTargeting } from "./audience";
import { money, viT } from "./format";
import { BRAND } from "./brand";
import { getT } from "@/i18n/server";
import type { T } from "@/i18n/translate";
import type { EditablePlan } from "./ai/schemas";
import { targetCprOf } from "./target-cpr";
import { isForeignAdSet, MIN_TARGETING_ITEMS } from "./plan-rules";

// Direction-testing mode for new clients / clients without proven targeting: split ad sets by direction to learn within 1-2 days which one produces results.
// new: no ads run yet (primary result); learning: has run but no item is "Đã kiểm chứng" (proven); proven: has some.

type TestMode = {
  mode: "new" | "learning" | "proven";
  label: string;
  reason: string;
  refCpr: number | null; // Reference CPR: the client's target CPR, otherwise the historical actual CPR
  verified: number;
};

export async function testModeFor(clientId: string): Promise<TestMode> {
  const t = await getT();
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId } });
  const [hist, ranking] = await Promise.all([
    db.adSetHistory.findMany({ where: { clientId, resultType: client.primaryResult, spend: { gt: 0 } }, select: { spend: true, results: true } }),
    db.targetingRanking.findFirst({ where: { clientId }, orderBy: { createdAt: "desc" } }),
  ]);
  const spend = hist.reduce((a, h) => a + h.spend, 0);
  const results = hist.reduce((a, h) => a + h.results, 0);
  const refCpr = targetCprOf(client) ?? (results ? spend / results : null);
  const verified = ranking ? (JSON.parse(ranking.items) as RankedTargeting[]).filter(isVerified).length : 0;
  if (!hist.length) {
    return { mode: "new", label: t("core.testMode.newLabel"), reason: t("core.testMode.newReason", { days: client.analysisDays }), refCpr, verified };
  }
  if (!verified) {
    return {
      mode: "learning",
      label: t("core.testMode.learningLabel"),
      reason: t("core.testMode.learningReason", { sets: hist.length, results: Math.round(results), min: client.minResults }),
      refCpr,
      verified,
    };
  }
  return { mode: "proven", label: t("core.testMode.provenLabel"), reason: t("core.testMode.provenReason", { n: verified }), refCpr, verified };
}

/** Number of directions (ad sets) to test: each needs a daily budget ≥ ~2.5× the reference CPR to show results within 1-2 days. null = CPR unknown. */
function testGroups(dailyBudget: number | null | undefined, refCpr: number | null) {
  if (!dailyBudget || !refCpr) return null;
  return Math.max(2, Math.min(4, Math.floor(dailyBudget / (2.5 * refCpr))));
}

/** Prompt section for campaign structure by mode: without a winning audience, test directions; with one, concentrate spend on the winner. */
export function testModePrompt(t: TestMode, currency: string, dailyBudget?: number | null) {
  if (t.mode === "proven") {
    return `# Mode: ${t.label} (${t.reason})
Put most of the budget on the proven directions / targeting (still ≥ 10 items per ad set, Advantage+ on); you may add 1 ad set with a new Cross-industry direction to find new audiences.`;
  }
  const groups = testGroups(dailyBudget, t.refCpr);
  const perGroup = t.refCpr ? money(Math.round(2.5 * t.refCpr), currency) : null;
  return `# DIRECTION TEST MODE · ${t.label}: ${t.reason}
Purpose: within 1-2 days, learn which direction brings cheap results so spend can be concentrated there. Required:
- Budget per ad set (ABO), split EVENLY so the comparison is fair.
- Number of ad sets: ${
    groups
      ? `${groups} ad sets, based on the budget of ${money(dailyBudget!, currency)}/day and the reference CPR of ${money(Math.round(t.refCpr!), currency)} (each ad set ≥ ~${perGroup}/day)`
      : `each ad set needs a daily budget ≥ 2-3x the target CPR; if the target CPR is unknown, ask the user (id "target_cpr") and default to 2-3 ad sets`
  }: Direction 1 "Right need" ("Đúng nhu cầu") + "Cross-industry" ("Lệch ngành") directions. Budget too small: 2 ad sets (H1 + H2).
- Every ad set uses the SAME ad content (1-2 variants, identical across ad sets) so only the targeting direction differs.
- hypothesis of each ad set: the direction being tested + the thresholds after 1-2 days: turn it off if it has spent ≥ 2x the target CPR with no result, or its cost per result is more than 130% of the cheapest ad set; raise the cheapest ad set's budget by 20-30%.
- testing_plan: on days 1-2 look at direct results (messages, order comments), turn off the expensive directions, move spend to the cheap ones.`;
}

/** After Claude composes: apply the platform's targeting method (Advantage+ on, flag ad sets lacking items). Doesn't add / remove items itself. */
export function enforceTargetingRules(plan: EditablePlan, t: T = viT): EditablePlan {
  const notes: string[] = [];
  let fixed = 0;
  const ad_sets = plan.ad_sets.map((s) => {
    const n = s.detailed_targeting.length;
    if (!n && !s.custom_audiences.length) notes.push(t("core.testMode.broadSet", { name: s.name, min: MIN_TARGETING_ITEMS, app: BRAND.app }));
    else if (n && n < MIN_TARGETING_ITEMS) notes.push(t("core.testMode.fewItems", { name: s.name, n, min: MIN_TARGETING_ITEMS }));
    if (n && !s.advantage_audience && !isForeignAdSet(s)) {
      fixed++;
      return { ...s, advantage_audience: true };
    }
    return s;
  });
  if (fixed) notes.push(t("core.testMode.advantageOn", { n: fixed, app: BRAND.app }));
  return notes.length ? { ...plan, ad_sets, risks: [...plan.risks, ...notes] } : plan;
}
