import type { EditablePlan } from "./ai/schemas";
import { geoList, lookupTargeting } from "./targeting";
import { seenMetaGeo } from "./meta/geo-search";
import { OBJECTIVE_FOR_RESULT, totalDailyBudget } from "./plan-rules";

import { translator, type T } from "@/i18n/translate";

export * from "./plan-rules";

/**
 * Normalize the plan: drop targeting/locations not in Meta's catalog, clamp ages,
 * sync budgets per ABO/CBO. Returns notes to show the user.
 */
export function normalizePlan(plan: EditablePlan, opts: { maxTotal?: number; userGeo?: boolean; t?: T } = {}): { plan: EditablePlan; notes: string[] } {
  const t = opts.t ?? translator("vi");
  const notes: string[] = [];

  const geoKeys = new Map(geoList().map((g) => [g.key, g]));

  const ad_sets = plan.ad_sets.map((s) => {
    const detailed = s.detailed_targeting.flatMap((dt) => {
      const real = lookupTargeting(dt.id, dt.type);
      if (!real) {
        notes.push(t("campaigns.plan.droppedTargeting", { name: dt.name }));
        return [];
      }
      return [{ id: real.id, name: real.name, type: real.type }];
    });
    let locations = s.locations.flatMap((l) => {
      if (l.type === "country") return [{ ...l, key: l.key.toUpperCase() }];
      // Provinces: matched against Meta's 63 provinces. City / district / ward: keys from the Meta search box (user-picked), or present in the Meta results given to Claude.
      const g = geoKeys.get(l.key);
      if (g && g.type === "region") return [{ ...l, name: g.name, type: g.type }];
      const m = seenMetaGeo(l.key);
      if (m) return [{ ...l, name: m.name, type: m.type, parent: l.parent ?? (m.region || null), parentKey: l.parentKey ?? m.regionKey }];
      if (l.type !== "region" && /^\d+$/.test(l.key) && (opts.userGeo || g)) return [l];
      notes.push(t("campaigns.plan.droppedLocation", { name: l.name }));
      return [];
    });
    const custom_locations = s.custom_locations.map((c) => ({ ...c, radius_km: Math.max(1, Math.min(80, c.radius_km)) }));
    // With a radius pin, don't auto-add "Việt Nam" (adding it would target the whole country).
    if (!locations.length && !s.custom_locations.length) locations = [{ key: "VN", name: t("campaigns.planRules.vietnam"), type: "country" }];
    if (s.custom_locations.length) locations = locations.filter((l) => l.type !== "country");
    const age_min = Math.max(18, Math.min(65, Math.round(s.age_min)));
    return {
      ...s,
      detailed_targeting: detailed,
      locations,
      custom_locations,
      message_destination: plan.result_type === "messages" ? (s.message_destination ?? "messenger") : null,
      age_min,
      age_max: Math.max(age_min, Math.min(65, Math.round(s.age_max))),
      daily_budget: plan.budget_mode === "CBO" ? null : Math.max(0, Math.round(s.daily_budget ?? 0)),
    };
  });

  const campaign_daily_budget = plan.budget_mode === "CBO" ? Math.round(plan.campaign_daily_budget ?? 0) : null;
  const next: EditablePlan = {
    ...plan,
    objective: OBJECTIVE_FOR_RESULT[plan.result_type] ?? plan.objective,
    campaign_daily_budget,
    ad_sets,
    ads: plan.ads.filter((a) => a.ad_set_index >= 0 && a.ad_set_index < ad_sets.length),
  };

  // Total budget exceeds the brief → scale down proportionally.
  const total = totalDailyBudget(next);
  if (opts.maxTotal && total > opts.maxTotal * 1.001) {
    const k = opts.maxTotal / total;
    if (next.budget_mode === "CBO") next.campaign_daily_budget = Math.floor(total * k);
    else for (const s of next.ad_sets) s.daily_budget = Math.floor((s.daily_budget ?? 0) * k);
    notes.push(t("campaigns.plan.scaledBudget", { max: opts.maxTotal }));
  }
  // Detect Vietnamese text written without diacritics.
  for (const a of next.ads) {
    if (looksUnaccented(`${a.primary_text} ${a.headline}`)) notes.push(t("campaigns.plan.unaccented", { name: a.name }));
  }
  return { plan: next, notes: [...new Set(notes)] };
}


/** Long text with almost no accented characters → most likely Vietnamese without diacritics. */
function looksUnaccented(text: string) {
  const letters = text.replace(/[^\p{L}]/gu, "");
  if (letters.length < 40) return false;
  const accented = letters.replace(/[a-zA-Z]/g, "").length;
  if (accented / letters.length >= 0.03) return false;
  // Only flag when common Vietnamese words appear without diacritics (avoid false positives on English text).
  const hits = text.toLowerCase().match(/\b(khong|duoc|cua|cho|nhung|voi|chi|em|ban|minh|mot|nay|lam|den|roi|thi|cung)\b/g);
  return (hits?.length ?? 0) >= 3;
}
