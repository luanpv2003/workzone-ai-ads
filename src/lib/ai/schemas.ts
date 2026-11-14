import { z } from "zod";
import { LANGUAGE_CODES } from "../languages";
import { BRAND } from "../brand";

// One proposed action. Any action_type other than "manual" calls the Meta API when the user clicks Approve.
export const RecommendationSchema = z.object({
  title: z.string().describe("Short imperative title (output language). E.g. 'Pause ad Acne treatment - Video 2'"),
  rationale: z.string().describe("Reason (output language); must quote concrete numbers (spend, CPR, CTR, frequency, messages...)"),
  priority: z.enum(["high", "medium", "low"]),
  expected_impact: z.string().describe("Expected impact (output language), e.g. 'Save ~1.2M VND/week, cut overall CPR by ~15%'"),
  action_type: z
    .enum(["pause", "resume", "update_budget", "manual"])
    .describe("pause/resume/update_budget can be executed through the API. Everything else (changing creative, targeting, chat script...) uses manual."),
  target_level: z.enum(["campaign", "adset", "ad"]).nullable().describe("null if action_type = manual"),
  target_id: z.string().nullable().describe("Exact ID taken from the input data. null if manual"),
  new_daily_budget: z.number().nullable().describe("Only for update_budget: the new daily budget in the account currency. Only applies to objects that currently have a daily_budget"),
  // Optional: older saved reports do not have this field.
  replaces: z
    .array(z.string())
    .optional()
    .describe("Codes of pending cards (P1, P2…) in 'Existing recommendations' ('Đề xuất đã có') that this recommendation replaces because it is the same task but the situation has changed; [] if it is a new task"),
});
export type RecommendationOut = z.infer<typeof RecommendationSchema>;

// Health score computed by the system (lib/health-checks.ts); Claude does not score it itself.
export const AccountAuditSchema = z.object({
  summary: z.string().describe("3-5 sentence summary for the account manager, opening with the system's score and data coverage"),
  strengths: z.array(z.string()),
  issues: z.array(
    z.object({
      severity: z.enum(["critical", "warning", "info"]),
      area: z.enum(["structure", "budget", "targeting", "creative", "tracking", "funnel", "messaging"]),
      title: z.string(),
      detail: z.string(),
      evidence: z.string().describe("Supporting numbers"),
    }),
  ),
  recommendations: z.array(RecommendationSchema),
});
export type AccountAudit = z.infer<typeof AccountAuditSchema>;

export const ConversationAnalysisSchema = z.object({
  conversations: z.array(
    z.object({
      conversation_id: z.string(),
      intent: z.string().describe("The customer's main need, brief (output language). E.g. 'Asking the price of underarm hair removal'"),
      stage: z.enum(["new", "interested", "considering", "ready_to_buy", "purchased", "lost", "spam"]),
      sentiment: z.enum(["positive", "neutral", "negative"]),
      lead_score: z.number().int().describe("0-100, likelihood of closing a sale"),
      tags: z.array(z.string()).describe("Short tags in the output language, e.g. asks price, says too expensive, asks address, books appointment, compares competitors"),
      needs_reply: z.boolean().describe("true if the page has not replied or replied insufficiently and a follow-up is needed"),
      suggested_reply: z.string().nullable().describe("Suggested message for staff to send next, in Vietnamese (the customer's language), in the brand's tone. null if not needed"),
      note: z.string().describe("Note for sales, 1 sentence (output language)"),
    }),
  ),
  summary: z.string(),
  top_questions: z.array(z.object({ question: z.string(), count: z.number().int(), suggested_answer: z.string().describe("Answer to send the customer, in Vietnamese (the customer's language)") })),
  objections: z.array(z.object({ objection: z.string(), count: z.number().int(), how_to_handle: z.string() })),
  buying_signals: z.array(z.string()),
  personas: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      pain_points: z.array(z.string()),
      targeting_hint: z.string().describe("Suggested age, gender, interests and locations to target on Meta"),
    }),
  ),
  service_issues: z.array(z.string()).describe("Customer-care problems: slow replies, missed messages, not asking for the phone number, not closing..."),
  content_ideas: z.array(z.object({ angle: z.string(), hook: z.string().describe("Ad hook, in Vietnamese"), primary_text: z.string().describe("Ad primary text (Vietnamese unless the task says otherwise)") })),
  recommendations: z.array(RecommendationSchema),
  analyzed_count: z.number().int().optional(), // total conversations in the sample (when merging multiple batches / runs)
});
export type ConversationAnalysis = z.infer<typeof ConversationAnalysisSchema>;
/** Merged insight of several conversation batches: like the report but without the per-conversation list. */
export const ConversationMergeSchema = ConversationAnalysisSchema.omit({ conversations: true, analyzed_count: true });

const OBJECTIVES = ["OUTCOME_ENGAGEMENT", "OUTCOME_LEADS", "OUTCOME_SALES", "OUTCOME_TRAFFIC", "OUTCOME_AWARENESS"] as const;

const CTAS = [
  "MESSAGE_PAGE",
  "WHATSAPP_MESSAGE",
  "LEARN_MORE",
  "SHOP_NOW",
  "SIGN_UP",
  "APPLY_NOW",
  "GET_QUOTE",
  "SUBSCRIBE",
  "DOWNLOAD",
  "CONTACT_US",
  "GET_OFFER",
  "BOOK_NOW",
  "LIKE_PAGE",
  "VIEW_INSTAGRAM_PROFILE",
] as const;

/** Campaign result. engagement = post engagement; profile_visits = Instagram profile visits. */
export const RESULT_TYPES = ["messages", "leads", "purchases", "link_clicks", "reach", "engagement", "profile_visits", "video_views", "page_likes"] as const;

/** Conversion location for messaging campaigns (exactly the choices in Ads Manager). WhatsApp requires the Page to be linked to WhatsApp Business. */
const MESSAGE_DESTINATIONS = ["messenger", "instagram", "whatsapp", "both", "messenger_whatsapp", "instagram_whatsapp", "all"] as const;

const LocationSchema = z.object({
  key: z.string().describe("Location code: 'VN' for the whole country, or a key from the province/city list provided"),
  name: z.string(),
  type: z.enum(["country", "region", "city", "subcity", "neighborhood"]).describe("region = province/city (the 63 old provinces, Meta has not updated the merger); subcity = district; neighborhood = ward/commune"),
  radius_km: z.number().nullable().optional().describe("Radius around the city, 17-80 km (Meta does not accept less than 17), only for type city"),
  parent: z.string().nullable().optional().describe("Province containing the area (for display)"),
  parentKey: z.string().nullable().optional().describe("Code of the province containing the area"),
  group: z.string().nullable().optional().describe("New province (34) if this item was added from a new-province choice"),
});

const DetailedTargetingSchema = z.object({
  id: z.string().describe("Exact ID if the item is in one of the lists provided; empty string \"\" if it is an item you propose yourself (the system will search Meta by name)"),
  name: z.string().describe("Item name exactly as shown in Ads Manager (Vietnamese or English)"),
  type: z.string().describe("Type: interests, behaviors, life_events, family_statuses, industries, income, work_positions, education_statuses..."),
});

const CustomLocationSchema = z.object({
  label: z.string().describe("Pin name (output language), e.g. 'Around the restaurant'"),
  latitude: z.number(),
  longitude: z.number(),
  radius_km: z.number().describe("Radius 1-80 km"),
});

const AdSetPlanSchema = z.object({
  name: z.string(),
  daily_budget: z.number().nullable().describe("Ad set daily budget (ABO). null if the campaign budget is used (CBO)"),
  age_min: z.number().int(),
  age_max: z.number().int(),
  genders: z.enum(["all", "male", "female"]),
  locations: z.array(LocationSchema).describe("Provinces/cities/districts. May be empty if custom_locations is used"),
  custom_locations: z.array(CustomLocationSchema).describe("Coordinate pin + radius. ONLY use the store coordinates provided, never guess coordinates"),
  location_types: z
    .enum(["home_recent", "home", "recent"])
    .describe("home_recent: people living in or recently in the area (default); home: people living here; recent: people recently here (suits targeting tourists)"),
  locales: z.array(z.enum(LANGUAGE_CODES)).describe("The viewer's Facebook language. Empty = all languages. Used to separate foreign customers"),
  message_destination: z
    .enum(MESSAGE_DESTINATIONS)
    .nullable()
    .describe("Messaging campaigns only: messenger, instagram, whatsapp, both (Messenger + Instagram), messenger_whatsapp, instagram_whatsapp, all (all 3). null for other objectives"),
  detailed_targeting: z.array(DetailedTargetingSchema).describe("At least 10 items of the same direction (OR relationship)"),
  advantage_audience: z.boolean(),
  hypothesis: z.string().describe("Hypothesis being tested with this ad set (output language)"),
});

const AdPlanSchema = z.object({
  ad_set_index: z.number().int().describe("Index (starting at 0) of the ad set in the ad_sets array"),
  name: z.string(),
  primary_text: z.string().describe("Ad primary text (Vietnamese unless the task says otherwise)"),
  headline: z.string().describe("Ad headline (Vietnamese unless the task says otherwise)"),
  description: z.string().describe("Ad description (Vietnamese unless the task says otherwise)"),
  call_to_action: z.enum(CTAS),
  creative_brief: z.string().describe("Description of the image/video to produce, for the designer (output language)"),
});

/** An ad in the plan Claude drafts: may use an existing Page post. */
const PlannerAdSchema = AdPlanSchema.extend({
  existing_post_id: z.string().describe('ID of an existing Page post (copy the exact id from "Existing posts available for ads") if the ad uses that post; "" if writing new content'),
});

/** Plan created by Claude. */
export const CampaignPlanSchema = z.object({
  campaign_name: z.string(),
  objective: z.enum(OBJECTIVES),
  result_type: z.enum(RESULT_TYPES),
  budget_mode: z.enum(["ABO", "CBO"]).describe("ABO: budget per ad set. CBO: one shared budget at campaign level (Advantage+ campaign budget)"),
  campaign_daily_budget: z.number().nullable().describe("Only with CBO"),
  strategy: z.string().describe("Overall strategy and reasoning, 3-6 sentences (output language)"),
  ad_sets: z.array(AdSetPlanSchema),
  ads: z.array(PlannerAdSchema),
  testing_plan: z.string().describe("Evaluation plan after 1-2 days: criteria for pausing expensive directions / moving money to cheap ones (output language)"),
  kpi_target_cpr: z.number().nullable(),
  risks: z.array(z.string()),
});
export type CampaignPlan = z.infer<typeof CampaignPlanSchema>;

const AudienceRefSchema = z.object({ id: z.string(), name: z.string(), subtype: z.string().optional(), size: z.number().nullable().optional() });
const PositionsSchema = z.object({
  facebook: z.array(z.string()).default([]),
  instagram: z.array(z.string()).default([]),
  messenger: z.array(z.string()).default([]),
  audience_network: z.array(z.string()).default([]),
});
export type Positions = z.infer<typeof PositionsSchema>;

/** Message template (Messenger/Instagram): greeting + suggested questions for the customer to tap, optionally with auto-replies. */
const WelcomeSchema = z.object({
  greeting: z.string(),
  questions: z.array(z.object({ q: z.string(), a: z.string().default("") })).default([]),
});
export type Welcome = z.infer<typeof WelcomeSchema>;

/** A card of a carousel ad: image + its own headline / description; its own link (only objectives needing a link, empty = the ad's link). */
const CarouselCardSchema = z.object({
  image_path: z.string().nullable().default(null),
  headline: z.string().default(""),
  description: z.string().default(""),
  link_url: z.string().nullable().default(null),
});
export type CarouselCard = z.infer<typeof CarouselCardSchema>;

/** Plan in the editor: adds fields the user edits manually (schedule, placements, images, links...). */
export const EditablePlanSchema = CampaignPlanSchema.extend({
  // Budget & bidding (campaign level, applied to each ad set under ABO)
  budget_period: z.enum(["daily", "lifetime"]).default("daily"),
  bid_strategy: z.enum(["lowest_cost", "cost_cap", "bid_cap"]).default("lowest_cost"),
  bid_amount: z.number().nullable().default(null),
  spend_cap: z.number().nullable().default(null),
  page_id: z.string().nullable().default(null), // clients with multiple Pages: which Page the ad publishes under (null = main Page)
  ad_sets: z.array(
    AdSetPlanSchema.extend({
      // Defaults for drafts created before these fields existed.
      custom_locations: z.array(CustomLocationSchema).default([]),
      location_types: z.enum(["home_recent", "home", "recent"]).default("home_recent"),
      locales: z.array(z.enum(LANGUAGE_CODES)).default([]),
      message_destination: z.enum(MESSAGE_DESTINATIONS).nullable().default(null),
      start_time: z.string().nullable().optional(),
      end_time: z.string().nullable().optional(),
      placements: z.enum(["advantage", "manual"]).optional(),
      platforms: z.array(z.enum(["facebook", "instagram", "messenger", "audience_network"])).optional(),
      // Mirrors Ads Manager exactly
      performance_goal: z.string().nullable().default(null), // null = the objective's default
      lead_destination: z.enum(["form", "messenger"]).default("form"), // lead campaigns: Instant form or Messenger
      positions: PositionsSchema.nullable().default(null), // detailed placements when placements = manual
      devices: z.enum(["all", "mobile", "desktop"]).default("all"),
      custom_audiences: z.array(AudienceRefSchema).default([]),
      excluded_custom_audiences: z.array(AudienceRefSchema).default([]),
      excluded_locations: z.array(LocationSchema).default([]),
      narrow_targeting: z.array(DetailedTargetingSchema).default([]), // narrowing: must match THIS group too (AND)
    }),
  ),
  ads: z.array(
    AdPlanSchema.extend({
      image_path: z.string().nullable().optional(),
      link_url: z.string().nullable().optional(),
      // "existing" = use an existing Page post (keeps its likes/comments/shares).
      source: z.enum(["new", "existing"]).default("new"),
      post_id: z.string().nullable().default(null), // format {pageId}_{postId}
      post_preview: z.object({ message: z.string(), picture: z.string().nullable(), permalink: z.string(), type: z.string(), created: z.string() }).nullable().default(null),
      lead_form: z.object({ id: z.string(), name: z.string() }).nullable().default(null), // Instant form
      // New video ad: uses an existing video on the Page (null = image ad). image_path (if any) is the thumbnail.
      video_id: z.string().nullable().default(null),
      video_preview: z.object({ title: z.string(), picture: z.string().nullable(), length: z.number().nullable(), permalink: z.string() }).nullable().default(null),
      welcome: WelcomeSchema.nullable().default(null), // message template for messaging ads
      // New carousel ad (2-10 image cards). Old drafts = "single" (1 image / video as before).
      format: z.enum(["single", "carousel"]).default("single"),
      cards: z.array(CarouselCardSchema).default([]),
      carousel_auto_order: z.boolean().default(true), // Meta automatically shows the best-performing card first (multi_share_optimized)
    }),
  ),
});
export type EditablePlan = z.infer<typeof EditablePlanSchema>;
export type EditableAdSet = EditablePlan["ad_sets"][number];
export type EditableAd = EditablePlan["ads"][number];

export const CampaignBriefSchema = z.object({
  product: z.string().min(3),
  goal: z.enum(RESULT_TYPES),
  dailyBudget: z.number().positive(),
  locations: z.string(),
  ageMin: z.number().int().min(13).max(65),
  ageMax: z.number().int().min(13).max(65),
  landingUrl: z.string().optional(),
  notes: z.string().optional(),
});
export type CampaignBrief = z.infer<typeof CampaignBriefSchema>;

// ------------------------------------------------------------ Customer persona & targeting

export const AudienceAnalysisSchema = z.object({
  summary: z.string().describe("3-5 sentence summary: who the brand's real customers are, and how they differ from the initial assumption"),
  personas: z
    .array(
      z.object({
        name: z.string().describe("Memorable name (output language), e.g. 'Korean tourists travelling in groups'"),
        share: z.string().describe("Estimated share and its basis, e.g. '~40% of conversations'"),
        description: z.string(),
        age_range: z.string().describe("E.g. '25-34'"),
        gender: z.enum(["female", "male", "all"]),
        locations: z.string().describe("Where they live / are staying, e.g. 'Tourists staying in District 1'"),
        motivations: z.array(z.string()).describe("Why they buy"),
        objections: z.array(z.string()).describe("What makes them hesitate"),
        message_angles: z.array(z.string()).describe("Ad messages / hooks to use for this persona"),
        evidence: z.string().describe("Concrete evidence: paraphrased messages, ads data, documents in the knowledge base"),
      }),
    )
    .describe("2-4 personas, sorted by importance"),
  demographics: z.object({
    age_min: z.number().int(),
    age_max: z.number().int(),
    genders: z.enum(["all", "female", "male"]),
    note: z.string().describe("Short explanation, including the locations/radius to target"),
  }),
  targeting: z
    .array(
      z.object({
        id: z.string().describe("Exact id if chosen from the candidate list; \"\" if it is an item you propose outside the list"),
        name: z.string().describe("Item name exactly as in Ads Manager"),
        type: z.string(),
        fit_score: z.number().int().describe("0-100: fit with the REAL customer persona (not audience size)"),
        persona: z.string().describe("Name of the persona this item targets; for expansion-direction items, the direction name"),
        reason: z.string().describe("1-sentence reason, based on evidence"),
        explore: z.boolean().describe("true if the item belongs to an expansion direction (outside the evidenced persona), used for testing"),
      }),
    )
    .describe("The 25-30 best-fitting items, sorted by fit_score descending; at least 8 of them explore=true if there are expansion-direction candidates"),
  bias_note: z
    .string()
    .describe("1-3 sentences: which parts of the persona rely only on customers brought in by the current ads (may be skewed by the old targeting), and which have independent grounds (documents, industry, data by age/gender)"),
  data_gaps: z.array(z.string()).describe("Missing data that reduces accuracy, and how to add it"),
});

/** Audience expansion direction: Claude ideates first, the system looks up the Targeting library by keyword, then scoring happens. */
export const ExpansionSchema = z.object({
  directions: z
    .array(
      z.object({
        name: z.string().describe("Short direction name (output language), e.g. 'Small business owners running their own ads'"),
        why: z.string().describe("1-2 sentences: why this direction may bring customers, based on the product / industry"),
        keywords: z
          .array(z.string())
          .describe("4-8 keywords to look up interest / behaviour / occupation names on Meta, in both English and Vietnamese, 1-3 words each (e.g. 'small business', 'entrepreneurship', 'chủ cửa hàng')"),
      }),
    )
    .describe("4-6 clearly different directions"),
});
export type AudienceAnalysis = z.infer<typeof AudienceAnalysisSchema>;
/** Reading a saved report: old versions (before expansion directions existed) lack bias_note / explore. */
export const AudienceReportSchema = AudienceAnalysisSchema.extend({
  bias_note: z.string().default(""),
  targeting: z.array(AudienceAnalysisSchema.shape.targeting.element.extend({ explore: z.boolean().default(false) })),
});

// ------------------------------------------------------------ Creating a client from documents

export const ClientSetupSchema = z.object({
  name: z.string().describe("Brand / business name, exactly as in the documents"),
  industry: z.string().describe("Short industry (output language), e.g. 'Vietnamese restaurant (F&B)', 'Study-abroad scholarship fund'"),
  brief: z
    .string()
    .describe(
      "Business description for Claude to use later (300-900 words, clear line breaks, output language): main products/services with prices, USPs, promotions, address/service area, opening hours, target customers, tone of voice, contact channels, agreed KPIs/budget. Only include what is in the documents.",
    ),
  primary_result: z.enum(RESULT_TYPES).describe("Main result to optimise for according to the documents (e.g. messages for restaurants/spas, leads for education)"),
  currency: z.string().describe("3-letter currency code, VND by default"),
  target_cpr: z.number().nullable().describe("Target cost per result if the documents state it, otherwise null"),
  max_daily_budget: z.number().nullable().describe("Maximum daily budget if the documents state it (monthly budget / 30 if only a monthly budget is given), otherwise null"),
  address: z.string().nullable().describe("Store / office address if any"),
  questions: z.array(z.string()).describe("Important things missing or contradictory in the documents that the user should supply (at most 6)"),
  documents: z
    .array(
      z.object({
        file_name: z.string().describe("Copy the exact file name provided"),
        title: z.string().describe("Short title in the output language"),
        category: z.enum(["product", "brand", "proposal", "project", "creative", "faq", "report", "other"]),
      }),
    )
    .describe("Classify each file for the Knowledge base"),
});
export type ClientSetup = z.infer<typeof ClientSetupSchema>;

// ------------------------------------------------------------ AI-proposed campaigns from the persona (before detailed drafting)

export const CampaignIdeasSchema = z.object({
  summary: z.string().describe("2-3 sentences: the current situation and the proposed direction (based on data, persona, the plan already sent to the client)"),
  ideas: z
    .array(
      z.object({
        title: z.string().describe("Short idea name (output language), e.g. 'Korean customers around Ben Thanh – table-booking messages'"),
        result_type: z.enum(RESULT_TYPES),
        personas: z.array(z.string()).describe("Names of the targeted personas (copy the exact names from the persona)"),
        daily_budget: z.number().nullable().describe("Proposed daily budget (client currency), within the limit; null if it needs to be asked"),
        locations: z.string().describe("Target area, e.g. '3 km radius around the venue' or 'TP.HCM, Hà Nội'"),
        age_min: z.number().int(),
        age_max: z.number().int(),
        offer: z.string().describe("Main product / offer / message to push (taken from the Knowledge base)"),
        creative: z.string().describe("Content: prefer an existing Page post (give the date + first few words of the post, why it was chosen); if none fits, suggest new content + the main hook"),
        structure: z.string().describe("Targeting directions (H1 Right need, H2 Cross-industry...), who each direction targets, each ad set's budget"),
        why: z.string().describe("Why it is proposed: evidence from data / persona / commitments to the client"),
        success: z.string().describe("Success threshold measured after 1-2 days, e.g. 'cost per message under 40,000 VND, ≥30% of messages ask for price / place an order'"),
        priority: z.enum(["high", "medium", "low"]),
      }),
    )
    .describe("2-3 clearly different ideas, sorted by priority"),
  questions: z
    .array(
      z.object({
        id: z.string().describe("Short ASCII code, e.g. 'budget', 'offer', 'landing'"),
        question: z.string(),
        why: z.string().describe("Why it is needed (1 sentence)"),
        options: z.array(z.string()).describe("2-4 suggested options for the user to click quickly"),
        suggested: z.string().describe("The answer the AI proposes if the user does not change it"),
      }),
    )
    .describe("0-5 questions ONLY when truly important information is missing (budget, offer, landing page, run dates, priority product). If there is enough information, return an empty array"),
});
export type CampaignIdeas = z.infer<typeof CampaignIdeasSchema>;

// ------------------------------------------------------------ Optimizing running campaigns (phase 3)

const AdVariantSchema = z.object({
  primary_text: z.string().describe("Primary text, in Vietnamese with full diacritics, in the brand's voice, addressing frequent questions / objections"),
  headline: z.string().describe("Headline ≤ 40 characters (Vietnamese)"),
  description: z.string().describe("Short description (Vietnamese), may be empty"),
});

export const OptimizeAiSchema = z.object({
  summary: z.string().describe("2-3 sentences: the state of the running campaigns and what to do first"),
  findings: z.array(
    z.object({
      id: z.string().describe("Copy the exact finding id provided"),
      title: z.string().describe("Short imperative title including the ad set / ad name. E.g. 'Raise the budget of ad set B1 Education by 25%'"),
      rationale: z.string().describe("2-3 sentence reason, quoting the numbers provided exactly (spend, results, CPR, frequency). Never invent numbers"),
      expected_impact: z.string().describe("Brief, cautious expected impact"),
      ad_variants: z.array(AdVariantSchema).describe("Only for add_ad findings: 2 new content variants with different angles. Otherwise empty"),
      targeting_ids: z.array(z.string()).describe("Only for duplicate_adset: 1-3 ids COPIED FROM the candidate list, on one theme, to test a new audience. Empty = keep the old audience, Advantage+ on"),
      new_adset_name: z.string().describe("Only for duplicate_adset: a short new ad set name stating the audience being tested. Otherwise empty"),
    }),
  ),
  extra: z
    .array(
      z.object({
        title: z.string(),
        rationale: z.string().describe("Based on the numbers provided"),
        priority: z.enum(["high", "medium", "low"]),
        kind: z.enum(["new_draft", "manual"]).describe("new_draft: a new campaign should be created (e.g. test a new persona / offer); manual: work to do by hand (edit the chat script, landing page...)"),
        brief: z.string().describe("Only for new_draft: description of the campaign to draft (product/offer, persona, objective). Otherwise empty"),
      }),
    )
    .describe("At most 2 extra proposals beyond the findings (may be empty)"),
});
export type OptimizeAi = z.infer<typeof OptimizeAiSchema>;

// ------------------------------------------------------------ Winning / losing ad creative analysis

export const CreativeAnalysisSchema = z.object({
  summary: z.string().describe("3-4 sentences: which content is winning, why, what to do next"),
  winning_patterns: z.array(
    z.object({
      pattern: z.string().describe("What the winning ads have in common (hook, angle, imagery, format, text length, CTA...)"),
      evidence: z.string().describe("Evidence: which ads, which numbers"),
    }),
  ),
  losing_patterns: z.array(z.object({ pattern: z.string(), evidence: z.string() })),
  per_ad: z.array(
    z.object({
      ad_id: z.string().describe("Copy the exact ad_id"),
      verdict: z.string().describe("1 sentence: why it wins / loses"),
      fix: z.string().describe("For a losing ad: what to fix; for a winning ad: empty"),
    }),
  ),
  video_notes: z.string().describe("Video notes: first-3-second retention, completion; empty if there is no video"),
  new_ads: z
    .array(
      z.object({
        angle: z.string().describe("Angle, based on the winning patterns"),
        format: z.enum(["image", "video", "carousel"]),
        visual_brief: z.string().describe("Image description / short video script for the designer (output language)"),
        primary_text: z.string().describe("Ad primary text, in Vietnamese"),
        headline: z.string().describe("≤ 40 characters, in Vietnamese"),
        description: z.string().describe("In Vietnamese"),
        based_on: z.string().describe("Which ad / winning pattern it is based on"),
      }),
    )
    .describe("3-4 new ad variants worth making"),
  tests: z.array(z.object({ hypothesis: z.string(), how: z.string() })).describe("1-3 content tests to run next"),
});
export type CreativeAnalysis = z.infer<typeof CreativeAnalysisSchema>;

// ------------------------------------------------------------ Content approval → run ads

export const PolicyCheckSchema = z.object({
  overall: z.string().describe("Overall 1-3 sentence conclusion for the whole batch of content"),
  items: z.array(
    z.object({
      index: z.number().int().describe("Content number (starting at 0) exactly as in the list provided"),
      verdict: z.enum(["safe", "fix", "reject"]).describe("safe: can run; fix: should be edited before running; reject: likely to be rejected by Meta / get the account restricted"),
      summary: z.string().describe("1-2 sentences: why this verdict"),
      special_category: z
        .enum(["none", "credit", "employment", "housing", "social_issues", "financial_products"])
        .describe("Meta special ad category that must be declared (credit, employment, housing, social/political issues, financial products). none if not applicable"),
      issues: z.array(
        z.object({
          where: z.enum(["text", "image", "video", "offer", "landing"]),
          quote: z.string().describe("VERBATIM quote of the problematic sentence/words, or a short description of the detail in the image/frame"),
          policy: z.string().describe("Name of the rule (output language), e.g. 'Meta · Personal attributes', 'Meta · Health & fitness', 'VN Advertising Law · Health supplements'"),
          severity: z.enum(["high", "medium", "low"]).describe("high: almost certainly rejected; medium: likely rejected or delivery reduced; low: minor risk / worth optimising"),
          explain: z.string().describe("Why it is a problem, 1-2 sentences"),
          fix: z.string().describe("Concrete fix"),
        }),
      ),
      rewrite: z
        .object({ primary_text: z.string(), headline: z.string() })
        .nullable()
        .describe("Rewrite with every text problem fixed, in the same language as the original, keeping the main message and brand voice. null if the text needs no edit"),
      creative_notes: z.string().describe("Notes on ad quality beyond policy (hook, image, CTA), 1-3 sentences"),
    }),
  ),
});
export type PolicyCheck = z.infer<typeof PolicyCheckSchema>;

export const ContentPlanSchema = z.object({
  summary: z.string().describe("3-6 sentence summary of the plan, easy for a business owner to understand: what runs, for whom, how much money, what to expect"),
  changes: z.string().describe("What changed from the previous version according to the feedback. Empty in the first version"),
  content_use: z.array(
    z.object({
      index: z.number().int(),
      use: z.enum(["existing", "new_fixed", "skip"]).describe("existing: run the existing Page post directly (keeps its engagement); new_fixed: create a new ad with the fixed text + the content's image; skip: do not run"),
      reason: z.string(),
    }),
  ),
  plan: CampaignPlanSchema.extend({
    ads: z.array(AdPlanSchema.extend({ content_index: z.number().int().describe("Which content number this ad uses") })),
  }),
  questions: z.array(z.string()).describe("Things the user must confirm before finalising (at most 4). Empty if there is enough information"),
});
export type ContentPlan = z.infer<typeof ContentPlanSchema>;

/** "Claude đề xuất cho chiến dịch này" (Claude's suggestions for this campaign; Targeting step of the campaign builder). */
export const TargetIdeasSchema = z.object({
  summary: z.string().describe("2-4 sentences: the main hypothesis about this campaign's real customers and how to target them"),
  ideas: z
    .array(
      z.object({
        name: z.string().describe("Item name exactly as in Ads Manager (interest / behaviour / demographic / job title…), in Vietnamese or English"),
        type: z.string().describe("interests, behaviors, life_events, family_statuses, industries, income, work_positions, education_statuses…"),
        role: z.enum(["core", "explore", "narrow"]).describe("core: main targeting; explore: a new direction worth testing; narrow: used to narrow (AND)"),
        fit: z.number().int().describe("0-100: confidence that it brings real customers"),
        persona: z.string().describe("Which persona / customer group it targets"),
        why: z.string().describe("1-sentence reason, with evidence from the data if any"),
        hypothesis: z.string().describe("Verifiable hypothesis + right/wrong threshold, e.g. 'This ad set brings messages under 40k VND and ≥30% good customers'"),
      }),
    )
    .describe("8-15 items, sorted by fit descending"),
});

// ------------------------------------------------------------ Step-by-step guide for manual proposals

const GUIDE_TOOLS = ["none", "wizard", "drafts", "audiences", "knowledge", "settings", "content_review", "report", "recommendations", "connections"] as const;
export const RecGuideSchema = z.object({
  goal: z.string().describe("1-2 sentences: what is achieved once done"),
  time_estimate: z.string().describe("Estimated time, e.g. '20-30 minutes'"),
  prepare: z.array(z.string()).describe("What to prepare first (permissions, documents, images, client information to confirm)"),
  steps: z
    .array(
      z.object({
        title: z.string().describe("Short step name, starting with a verb"),
        where: z.enum(["ads_manager", "business_suite", "events_manager", "business_settings", "wzone", "crm", "website", "other"]).describe("Where it is done"),
        instructions: z.array(z.string()).describe("Concrete actions in order: where to click (button / menu names exactly as in the Ads Manager interface in the output language), what to choose"),
        values: z.array(z.object({ label: z.string(), value: z.string() })).describe("Exact copy-paste values (campaign name, budget, UTM, form questions…). Empty if none"),
        check: z.string().describe("How to check this step was done correctly"),
        tool: z.enum(GUIDE_TOOLS).describe(`If ${BRAND.app} can do this step, choose the matching tool, otherwise none`),
      }),
    )
    .describe("4-10 steps in the exact order to do them"),
  pitfalls: z.array(z.string()).describe("Common mistakes / things to avoid (e.g. making the ad set re-learn, overlapping audiences)"),
  verify_after: z.string().describe("Afterwards: which metrics to watch, and how long before evaluating"),
});
export type RecGuide = z.infer<typeof RecGuideSchema>;

export const NurtureWriteSchema = z.object({
  variants: z.array(z.object({ message: z.string().describe("Message text in Vietnamese, may contain {ten}"), why: z.string().describe("Which customer group it is for and why, 1 sentence (output language)") })),
});

export const NurtureCheckSchema = z.object({
  verdict: z.enum(["safe", "fix", "reject"]),
  summary: z.string().describe("1-2 sentence conclusion"),
  issues: z.array(
    z.object({
      quote: z.string().describe("VERBATIM quote of the problematic part"),
      policy: z.string().describe("Name of the rule (output language), e.g. 'Meta · Messenger policy · Spam'"),
      severity: z.enum(["high", "medium", "low"]),
      explain: z.string(),
      fix: z.string(),
    }),
  ),
  rewrite: z.string().nullable().describe("Fixed rewrite (Vietnamese); null if not needed"),
});
export type NurtureCheck = z.infer<typeof NurtureCheckSchema>;
