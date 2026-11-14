// Hồ Quốc Bảo's playbook: the 56 numbered rules the app applies ("Luật Bảo #n" / "Bảo's rule #n").
// Rule text lives in the i18n catalogues (playbook.rules.r<n>); RULES.md documents where each rule is enforced.
// status: "code" = enforced by the system, "prompt" = an instruction the AI must follow, "partial" = only part of it is enforced.

export type RuleStatus = "code" | "prompt" | "partial";
export type RuleArea = "persona" | "targeting" | "messages" | "leads" | "content" | "optimize" | "followup" | "reports";

export const RULE_AREAS: RuleArea[] = ["persona", "targeting", "content", "optimize", "messages", "leads", "followup", "reports"];

const P = (n: number, area: RuleArea, status: RuleStatus) => ({ n, area, status });

export const RULES = [
  P(1, "persona", "prompt"), P(2, "persona", "prompt"), P(3, "persona", "code"), P(4, "persona", "code"), P(5, "persona", "prompt"), P(6, "persona", "code"),
  P(7, "targeting", "code"), P(8, "targeting", "code"), P(9, "targeting", "code"), P(10, "targeting", "code"),
  P(11, "messages", "partial"), P(12, "messages", "prompt"), P(13, "messages", "code"),
  P(14, "leads", "code"), P(15, "leads", "code"), P(16, "leads", "code"), P(17, "leads", "code"),
  P(18, "content", "code"), P(19, "content", "prompt"),
  P(20, "optimize", "code"), P(21, "optimize", "prompt"), P(22, "optimize", "code"), P(23, "optimize", "code"),
  P(24, "targeting", "code"), P(25, "optimize", "code"), P(26, "targeting", "code"), P(27, "targeting", "code"), P(28, "content", "prompt"),
  P(29, "content", "code"), P(30, "content", "prompt"),
  P(31, "optimize", "code"), P(32, "optimize", "partial"), P(33, "optimize", "code"), P(34, "optimize", "code"), P(35, "optimize", "code"),
  P(36, "optimize", "code"), P(37, "optimize", "code"), P(38, "optimize", "code"), P(39, "optimize", "code"), P(40, "optimize", "code"),
  P(41, "followup", "code"), P(42, "followup", "code"), P(43, "followup", "code"), P(44, "followup", "code"),
  P(45, "reports", "code"), P(46, "reports", "code"), P(47, "reports", "code"), P(48, "reports", "code"), P(49, "reports", "partial"),
  P(50, "leads", "code"), P(51, "leads", "code"), P(52, "leads", "code"), P(53, "leads", "partial"),
  P(54, "content", "prompt"), P(55, "content", "partial"), P(56, "targeting", "prompt"),
] as const;

export type RuleNumber = (typeof RULES)[number]["n"];

/** Which playbook rules produced an optimisation suggestion (Recommendation.rule). Unlisted keys show no badge. */
export const RULES_BY_KEY: Record<string, number[]> = {
  adset_zero: [34, 31, 36],
  adset_zero_warn: [34],
  adset_early: [34, 31],
  adset_early_warn: [34],
  adset_expensive: [34, 31, 36],
  adset_warn: [34],
  campaign_expensive: [36, 25],
  campaign_zero: [36, 25],
  campaign_warn: [25],
  ad_fatigue: [20],
  learning_limited: [23],
  consolidate: [23],
  segment_waste: [22],
  segment_warn: [22],
  adset_winner: [31, 32, 33, 40],
  adset_duplicate: [27],
  explore_new: [4],
  ad_expensive: [31, 36],
  ad_low_quality: [35, 17],
  ad_low_quality_warn: [35],
  foreign_leak: [10],
  foreign_expat: [10, 27],
};

export const rulesFor = (key: string | null | undefined): number[] => (key ? (RULES_BY_KEY[key] ?? []) : []);
