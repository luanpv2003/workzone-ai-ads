import type { EditableAd, EditablePlan, PolicyCheck } from "./ai/schemas";
import { isCarousel } from "./carousel";
import type { T } from "@/i18n/translate";

// Content policy check for drafts: usable both in the browser (editor) and on the server (gating the Publish button).
// Each ad has a content "fingerprint"; editing text / image / video / message template requires re-checking that ad.

export type PolicyEntry = Omit<PolicyCheck["items"][number], "index"> & { at: string; model?: string };
export type DraftPolicy = { at: string; overall: string; results: Record<string, PolicyEntry> };

/** The content Meta reviews + viewers can read. */
function contentOf(ad: EditableAd) {
  return {
    t: ad.primary_text.trim(),
    h: ad.headline.trim(),
    d: ad.description.trim(),
    c: ad.call_to_action,
    l: ad.link_url ?? null,
    i: ad.image_path ?? null,
    v: ad.video_id ?? null,
    p: ad.source === "existing" ? ad.post_id : null,
    w: ad.welcome ? { g: ad.welcome.greeting.trim(), q: ad.welcome.questions.map((x) => [x.q.trim(), x.a.trim()]) } : null,
    // Carousel: every image + text + link of each card, in order. Single-image ads lack this field, so their old fingerprint stays unchanged.
    ...(isCarousel(ad) && { k: ad.cards.map((c) => [c.image_path, c.headline.trim(), c.description.trim(), c.link_url?.trim() || null]) }),
  };
}

function fnv(s: string, seed: number) {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function adContentKey(ad: EditableAd) {
  const s = JSON.stringify(contentOf(ad));
  return fnv(s, 2166136261) + fnv(s, 0x9e3779b9);
}

export function parseDraftPolicy(s: string | null | undefined): DraftPolicy | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as DraftPolicy;
  } catch {
    return null;
  }
}

export type PolicyGate = {
  ok: boolean;
  /** Ads not yet checked or whose content was edited after the check. */
  unchecked: number[];
  /** Likely to be rejected (verdict reject or high-severity issue): red warning, does not block publishing. */
  blocked: number[];
  /** Should fix (medium / low issues): yellow warning. */
  fix: number[];
  special: { i: number; category: string }[];
};

/** Policy check result (advisory only, does not block publishing — since 28/10/2026): ok = every ad was checked against its current content and none are likely to be rejected. */
export function policyGate(plan: EditablePlan, policy: DraftPolicy | null): PolicyGate {
  const g: PolicyGate = { ok: false, unchecked: [], blocked: [], fix: [], special: [] };
  plan.ads.forEach((ad, i) => {
    const r = policy?.results[adContentKey(ad)];
    if (!r) return g.unchecked.push(i);
    if (r.verdict === "reject" || r.issues.some((x) => x.severity === "high")) g.blocked.push(i);
    else if (r.verdict === "fix") g.fix.push(i);
    if (r.special_category !== "none") g.special.push({ i, category: r.special_category });
  });
  g.ok = plan.ads.length > 0 && !g.unchecked.length && !g.blocked.length;
  return g;
}

const SPECIAL_KEYS = {
  credit: "campaigns.policyRules.special.credit",
  employment: "campaigns.policyRules.special.employment",
  housing: "campaigns.policyRules.special.housing",
  social_issues: "campaigns.policyRules.special.social_issues",
  financial_products: "campaigns.policyRules.special.financial_products",
} as const;

/** Localised name of a Meta special ad category (falls back to the raw category). */
export function specialLabel(t: T, category: string): string {
  return category in SPECIAL_KEYS ? t(SPECIAL_KEYS[category as keyof typeof SPECIAL_KEYS]) : category;
}

export function policyGateMessage(t: T, plan: EditablePlan, g: PolicyGate) {
  const names = (ids: number[]) => ids.map((i) => `"${plan.ads[i].name || t("campaigns.policyRules.adN", { n: i + 1 })}"`).join(", ");
  const out: string[] = [];
  if (g.blocked.length) out.push(t("campaigns.policyRules.likelyRejected", { names: names(g.blocked) }));
  if (g.unchecked.length) out.push(t("campaigns.policyRules.unchecked", { names: names(g.unchecked) }));
  return out.join(" ");
}
