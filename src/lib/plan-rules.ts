import type { Client } from "@prisma/client";
import type { EditablePlan } from "./ai/schemas";
import { defaultDailyBudget, money } from "./format";
import { BID_OPTS, ctasFor, MESSAGE_DESTINATION_OPTS, POSITION_OPTS } from "./ads-options";
import { targetCprOf } from "./target-cpr";
import { CAROUSEL_MAX, CAROUSEL_MIN, carouselBlockReason, isCarousel } from "./carousel";
import { BRAND } from "./brand";
import { translator, type T } from "@/i18n/translate";

// Vietnamese translator: default for callers that do not pass their own `t` (server code outside the UI).
const defaultT: T = translator("vi");

// Pure rules (no file reads) for campaign plans: usable both on the server and in the browser composer.

/** The platform's targeting method: each ad set has at least this many detailed targeting items in the same direction. */
export const MIN_TARGETING_ITEMS = 10;

/** Ad sets targeting foreigners (language filter / Expats behavior): Advantage+ must be off so it doesn't expand to Vietnamese users. */
export function isForeignAdSet(s: Pick<EditablePlan["ad_sets"][number], "locales" | "detailed_targeting">) {
  return s.locales.length > 0 || s.detailed_targeting.some((t) => /ngoại kiều|sống ở nước ngoài|đã sống tại|lived in|expat/i.test(t.name));
}

export type ClientLimits = Pick<Client, "maxDailyBudget" | "currency" | "metaPageId" | "metaInstagramId" | "storeLat" | "storeLng" | "timezone" | "primaryResult" | "targetCpr" | "autoTargetCpr">;

export const OBJECTIVE_FOR_RESULT: Record<string, EditablePlan["objective"]> = {
  messages: "OUTCOME_ENGAGEMENT",
  leads: "OUTCOME_LEADS",
  purchases: "OUTCOME_SALES",
  link_clicks: "OUTCOME_TRAFFIC",
  reach: "OUTCOME_AWARENESS",
  engagement: "OUTCOME_ENGAGEMENT",
  profile_visits: "OUTCOME_TRAFFIC",
  video_views: "OUTCOME_ENGAGEMENT",
  page_likes: "OUTCOME_ENGAGEMENT",
};

/** Campaign types the system can create automatically on Meta (Sales needs a Pixel, so it's still built manually). */
export const PUBLISHABLE_RESULTS = new Set(["messages", "leads", "link_clicks", "reach", "engagement", "profile_visits", "video_views", "page_likes"]);

/** Default CTA button by objective. */
export function defaultCta(result: string): EditablePlan["ads"][number]["call_to_action"] {
  return ctasFor(result)[0];
}

export function blankAdSet(index: number, currency = "VND", t: T = defaultT): EditablePlan["ad_sets"][number] {
  return {
    name: t("campaigns.planRules.adSetName", { n: index + 1 }),
    daily_budget: defaultDailyBudget(currency),
    age_min: 18,
    age_max: 65,
    genders: "all",
    locations: [{ key: "VN", name: t("campaigns.planRules.vietnam"), type: "country" }],
    custom_locations: [],
    location_types: "home_recent",
    locales: [],
    message_destination: "messenger",
    detailed_targeting: [],
    advantage_audience: true,
    hypothesis: "",
    placements: "advantage",
    performance_goal: null,
    lead_destination: "form",
    positions: null,
    devices: "all",
    custom_audiences: [],
    excluded_custom_audiences: [],
    excluded_locations: [],
    narrow_targeting: [],
  };
}

export function blankAd(adSetIndex: number, n: number, link?: string | null, t: T = defaultT): EditablePlan["ads"][number] {
  return {
    ad_set_index: adSetIndex,
    name: t("campaigns.planRules.adName", { n }),
    primary_text: "",
    headline: "",
    description: "",
    call_to_action: "MESSAGE_PAGE",
    creative_brief: "",
    image_path: null,
    link_url: link ?? null,
    source: "new",
    post_id: null,
    post_preview: null,
    lead_form: null,
    welcome: null,
    video_id: null,
    video_preview: null,
    format: "single",
    cards: [],
    carousel_auto_order: true,
  };
}

export function blankPlan(client: ClientLimits, t: T = defaultT): EditablePlan {
  const result = PUBLISHABLE_RESULTS.has(client.primaryResult) ? client.primaryResult : "messages";
  const date = new Date().toLocaleDateString("vi-VN", { timeZone: client.timezone, day: "2-digit", month: "2-digit" });
  return {
    campaign_name: t("campaigns.planRules.newCampaignName", { date }),
    objective: OBJECTIVE_FOR_RESULT[result],
    result_type: result as EditablePlan["result_type"],
    budget_mode: "ABO",
    campaign_daily_budget: null,
    budget_period: "daily",
    bid_strategy: "lowest_cost",
    bid_amount: null,
    spend_cap: null,
    page_id: null,
    strategy: "",
    ad_sets: [blankAdSet(0, client.currency, t)],
    ads: [{ ...blankAd(0, 1, undefined, t), call_to_action: defaultCta(result) }],
    testing_plan: "",
    kpi_target_cpr: targetCprOf(client),
    risks: [],
  };
}

/** Total budget entered (daily, or lifetime if budget_period = lifetime). */
export function totalDailyBudget(plan: EditablePlan) {
  return plan.budget_mode === "CBO" ? (plan.campaign_daily_budget ?? 0) : plan.ad_sets.reduce((a, s) => a + (s.daily_budget ?? 0), 0);
}

/** Number of running days (for lifetime budgets): from the start date (or today) to the earliest end date. */
function runDays(plan: EditablePlan) {
  const ends = plan.ad_sets.map((s) => s.end_time).filter(Boolean) as string[];
  if (!ends.length) return null;
  const start = plan.ad_sets.map((s) => s.start_time).filter(Boolean).sort()[0];
  const ms = new Date(ends.sort()[0]).getTime() - (start ? new Date(start).getTime() : Date.now());
  return Math.max(1, Math.ceil(ms / 86400000));
}

/** Budget converted to per day, to compare with the client's daily budget limit. */
export function dailyEquivalent(plan: EditablePlan) {
  const total = totalDailyBudget(plan);
  if (plan.budget_period !== "lifetime") return total;
  const days = runDays(plan);
  return days ? total / days : total;
}

/** Pre-publish check, like Ads Manager's "Review" step. errors block publishing, warnings only remind. */
export function reviewPlan(plan: EditablePlan, client: ClientLimits, isMeta: boolean, t: T = defaultT) {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!plan.campaign_name.trim()) errors.push(t("campaigns.planRules.errNoName"));
  if (isMeta && !PUBLISHABLE_RESULTS.has(plan.result_type)) {
    errors.push(t("campaigns.planRules.errSalesUnsupported"));
  }
  if (!isMeta) errors.push(t("campaigns.planRules.errNoMeta"));
  if (isMeta && !client.metaPageId) errors.push(t("campaigns.planRules.errNoPageId"));
  const dest = (s: EditablePlan["ad_sets"][number]) => MESSAGE_DESTINATION_OPTS.find((o) => o.value === (s.message_destination ?? "messenger"));
  const needsIg = plan.result_type === "profile_visits" || (plan.result_type === "messages" && plan.ad_sets.some((s) => dest(s)?.needsIg));
  if (plan.result_type === "messages" && plan.ad_sets.some((s) => dest(s)?.needsWa)) {
    warnings.push(t("campaigns.planRules.warnWhatsapp"));
  }
  if (isMeta && needsIg && !client.metaInstagramId) errors.push(t("campaigns.planRules.errNoInstagramId"));
  if (plan.budget_mode === "CBO" && !(plan.campaign_daily_budget && plan.campaign_daily_budget > 0)) errors.push(t("campaigns.planRules.errNoCampaignBudget"));
  const total = dailyEquivalent(plan);
  if (client.maxDailyBudget && total > client.maxDailyBudget) {
    errors.push(t("campaigns.planRules.errOverLimit", { total: money(total, client.currency), lifetime: plan.budget_period === "lifetime" ? t("campaigns.planRules.lifetimeNote") : "", limit: money(client.maxDailyBudget, client.currency) }));
  }
  if (plan.budget_period === "lifetime" && plan.ad_sets.some((s) => !s.end_time)) errors.push(t("campaigns.planRules.errLifetimeNeedsEnd"));
  if (BID_OPTS.find((b) => b.value === plan.bid_strategy)?.needsAmount && !(plan.bid_amount && plan.bid_amount > 0)) {
    errors.push(t("campaigns.planRules.errBidAmount"));
  }
  if (plan.bid_strategy === "cost_cap" && plan.result_type === "messages") {
    errors.push(t("campaigns.planRules.errCostCapMessages"));
  }
  if (plan.spend_cap != null && plan.spend_cap > 0 && plan.spend_cap < total) warnings.push(t("campaigns.planRules.warnSpendCap"));
  if (!plan.ad_sets.length) errors.push(t("campaigns.planRules.errNoAdSets"));
  // Learning phase (Meta optimization handbook, sections A/K): an ad set needs ~50 results/week ≈ 50 × target CPR ÷ 7 per day. Reminder only, not blocking.
  const cprTarget = plan.result_type === client.primaryResult ? targetCprOf(client) : null;
  if (cprTarget && plan.budget_period !== "lifetime" && plan.ad_sets.length) {
    const need = (50 * cprTarget) / 7;
    const per = plan.ad_sets.map((s) => (plan.budget_mode === "CBO" ? (plan.campaign_daily_budget ?? 0) / plan.ad_sets.length : (s.daily_budget ?? 0)));
    const low = per.filter((b) => b > 0 && b < need).length;
    if (low) {
      const fit = Math.max(1, Math.floor(total / need));
      warnings.push(
        t("campaigns.planRules.warnLearning", { low, total: plan.ad_sets.length, need: money(need, client.currency), cpr: money(cprTarget, client.currency), fit }),
      );
    }
  }
  plan.ad_sets.forEach((s, i) => {
    const label = t("campaigns.planRules.adSetLabel", { name: s.name || i + 1 });
    if (plan.budget_mode === "ABO" && !(s.daily_budget && s.daily_budget > 0)) errors.push(`${label}: ${t("campaigns.planRules.errAdSetNoBudget")}`);
    if (!plan.ads.some((a) => a.ad_set_index === i)) errors.push(`${label}: ${t("campaigns.planRules.errAdSetNoAds")}`);
    if (s.placements === "manual") {
      const pos = s.positions;
      const count = pos ? Object.values(pos).reduce((a, l) => a + l.length, 0) : (s.platforms?.length ?? 0);
      if (!count) errors.push(`${label}: ${t("campaigns.planRules.errNoPlacement")}`);
      if (pos) {
        for (const g of POSITION_OPTS) {
          for (const it of g.items) {
            if (it.needs && pos[g.platform].includes(it.value) && !pos[g.platform].includes(it.needs)) {
              errors.push(`${label}: ${t("campaigns.planRules.errPlacementNeeds", { pos: `${g.label} · ${t(it.label)}`, needs: `${g.label} · ${t(g.items.find((x) => x.value === it.needs)!.label)}` })}`);
            }
          }
        }
      }
    }
    if (plan.result_type === "leads" && s.lead_destination === "messenger" && isMeta && !client.metaPageId) errors.push(`${label}: ${t("campaigns.planRules.errLeadNeedsPage")}`);
    if (s.end_time && s.start_time && s.end_time <= s.start_time) errors.push(`${label}: ${t("campaigns.planRules.errEndBeforeStart")}`);
    if (!s.locations.length && !s.custom_locations.length) errors.push(`${label}: ${t("campaigns.planRules.errNoLocation")}`);
    for (const c of s.custom_locations) {
      if (!(c.radius_km >= 1 && c.radius_km <= 80)) errors.push(`${label}: ${t("campaigns.planRules.errPinRadius", { label: c.label })}`);
      if (Math.abs(c.latitude) > 90 || Math.abs(c.longitude) > 180) errors.push(`${label}: ${t("campaigns.planRules.errPinCoords", { label: c.label })}`);
    }
    // The platform's method: one direction per ad set, ≥ 10 items, Advantage+ on (handbook sections E/K).
    const n = s.detailed_targeting.length;
    if (n && n < MIN_TARGETING_ITEMS && !s.custom_audiences.length) warnings.push(`${label}: ${t("campaigns.planRules.warnFewTargeting", { n, app: BRAND.app, min: MIN_TARGETING_ITEMS })}`);
    // Foreign customers: en_all defeats the filter; interests in a country's culture/language are Vietnamese fans, not people from that country.
    const foreign = s.locales.filter((l) => l !== "en_all");
    if (foreign.length && s.locales.includes("en_all")) warnings.push(`${label}: ${t("campaigns.planRules.warnEnAll", { langs: foreign.join(", ") })}`);
    const culture = s.detailed_targeting.filter((t) => t.type === "interests" && /hàn quốc|nhật bản|trung quốc|k-?pop|anime|ngôn ngữ|korea|japan|chinese/i.test(t.name));
    if (culture.length) warnings.push(`${label}: ${t("campaigns.planRules.warnCulture", { names: culture.map((c) => c.name).join('", "') })}`);
    if (n && !s.advantage_audience && !isForeignAdSet(s)) warnings.push(`${label}: ${t("campaigns.planRules.warnAdvantageOff", { app: BRAND.app })}`);
    if (plan.result_type === "profile_visits" && s.placements === "manual" && !(s.positions ? s.positions.instagram.length : s.platforms?.includes("instagram"))) {
      errors.push(`${label}: ${t("campaigns.planRules.errIgProfileNeedsIg")}`);
    }
  });
  const seen = new Set<string>();
  plan.ads.forEach((a) => {
    const label = t("campaigns.planRules.adLabel", { name: a.name || "?" });
    if (a.source === "existing" && a.post_id) {
      const k = `${a.ad_set_index}:${a.post_id}`;
      if (seen.has(k)) warnings.push(`${label}: ${t("campaigns.planRules.warnDupPost")}`);
      seen.add(k);
    }
    if (a.source === "existing") {
      if (!a.post_id) errors.push(`${label}: ${t("campaigns.planRules.errNoPost")}`);
      if (plan.result_type === "video_views" && a.post_preview && !/video|reel/i.test(a.post_preview.type)) {
        errors.push(`${label}: ${t("campaigns.planRules.errThruplayNeedsVideoPost")}`);
      }
      if (plan.result_type === "leads" && plan.ad_sets[a.ad_set_index]?.lead_destination !== "messenger") {
        errors.push(`${label}: ${t("campaigns.planRules.errInstantFormNeedsNew")}`);
      }
      if (plan.result_type === "messages") warnings.push(`${label}: ${t("campaigns.planRules.warnMessagesExistingPost")}`);
      return;
    }
    if (plan.result_type === "video_views") errors.push(`${label}: ${t("campaigns.planRules.errThruplayNeedsExisting")}`);
    const adSet = plan.ad_sets[a.ad_set_index];
    if (plan.result_type === "leads" && adSet?.lead_destination !== "messenger" && !a.lead_form) errors.push(`${label}: ${t("campaigns.planRules.errNeedsLeadForm")}`);
    if (plan.result_type === "messages" && a.welcome && !a.welcome.greeting.trim()) errors.push(`${label}: ${t("campaigns.planRules.errNoGreeting")}`);
    if (plan.result_type === "messages" && a.welcome && a.welcome.questions.length > 4) errors.push(`${label}: ${t("campaigns.planRules.errMaxQuestions")}`);
    if (!a.primary_text.trim()) errors.push(`${label}: ${t("campaigns.planRules.errNoPrimaryText")}`);
    if (plan.result_type === "link_clicks" && !a.link_url) errors.push(`${label}: ${t("campaigns.planRules.errNeedsUrl")}`);
    if (isCarousel(a)) {
      const why = carouselBlockReason(plan.result_type, t);
      if (why) errors.push(`${label}: ${t("campaigns.planRules.errCarouselBlocked", { why })}`);
      if (a.cards.length < CAROUSEL_MIN) errors.push(`${label}: ${t("campaigns.planRules.errCarouselMin", { min: CAROUSEL_MIN })}`);
      if (a.cards.length > CAROUSEL_MAX) errors.push(`${label}: ${t("campaigns.planRules.errCarouselMax", { max: CAROUSEL_MAX })}`);
      const noImg = a.cards.flatMap((c, k) => (c.image_path ? [] : [k + 1]));
      if (noImg.length) errors.push(`${label}: ${t("campaigns.planRules.errCardsNoImage", { cards: noImg.join(", ") })}`);
      if (plan.result_type === "reach" && !a.link_url) errors.push(`${label}: ${t("campaigns.planRules.errCarouselNeedsUrl")}`);
      if (a.cards.length > 5) warnings.push(`${label}: ${t("campaigns.planRules.warnIgFiveCards")}`);
      const blank = a.cards.flatMap((c, k) => (c.headline.trim() ? [] : [k + 1]));
      if (blank.length && !a.headline.trim()) warnings.push(`${label}: ${t("campaigns.planRules.warnCardsNoHeadline", { cards: blank.join(", ") })}`);
      a.cards.forEach((c, k) => {
        if (c.headline.length > 32) warnings.push(`${label}: ${t("campaigns.planRules.warnCardHeadlineLong", { n: k + 1 })}`);
        if (c.link_url && !/^https?:\/\//.test(c.link_url)) errors.push(`${label}: ${t("campaigns.planRules.errCardLink", { n: k + 1 })}`);
      });
      return;
    }
    if (!a.image_path && !a.video_id) warnings.push(`${label}: ${t("campaigns.planRules.warnNoMedia")}`);
    if (a.video_id && !a.image_path && !a.video_preview?.picture) errors.push(`${label}: ${t("campaigns.planRules.errVideoNoCover")}`);
    if (a.headline.length > 40) warnings.push(`${label}: ${t("campaigns.planRules.warnHeadlineLong")}`);
  });
  return { errors, warnings };
}
