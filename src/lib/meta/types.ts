import type { EditableAdSet, EditablePlan } from "../ai/schemas";

export type RecentThread = {
  id: string;
  psid: string | null;
  customerName: string;
  updatedTime: Date;
  link: string | null;
  messages: { fromCustomer: boolean; text: string; createdTime: Date }[]; // old → new
};

export type Level = "campaign" | "adset" | "ad";

export type MetricsRow = {
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  results: number;
  revenue: number;
};

export type SyncCampaign = MetricsRow & {
  id: string;
  name: string;
  objective: string;
  status: string;
  dailyBudget: number | null;
  resultType: string;
  createdTime: Date | null;
};

export type SyncAdSet = MetricsRow & {
  id: string;
  campaignId: string;
  name: string;
  status: string;
  dailyBudget: number | null;
  optimizationGoal: string;
  targeting: string;
};

export type SyncAd = MetricsRow & {
  id: string;
  campaignId: string;
  adSetId: string;
  name: string;
  status: string;
  primaryText: string;
  headline: string;
};

export type SyncDaily = Omit<MetricsRow, "reach"> & { date: string };

export type SyncConversation = {
  id: string;
  customerName: string;
  updatedTime: Date;
  sourceAdId: string | null;
  link?: string | null; // conversation link in the Page inbox
  psid?: string | null; // page-scoped user id (joined with the ads webhook)
  // imageUrls: links to images the customer sent (Meta links expire; only for downloading immediately during sync)
  messages: { id: string; fromCustomer: boolean; text: string; createdTime: Date; imageUrls?: string[] }[];
};

export type PagePost = {
  id: string; // {pageId}_{postId}, used as object_story_id
  message: string;
  picture: string | null;
  permalink: string;
  type: string; // added_photos | added_video | shared_story ...
  created: string;
  eligible: boolean; // whether Meta allows promoting this post
};

/** Video posted on the Page (including Reels), used as the video for new ads. */
export type PageVideo = {
  id: string;
  title: string;
  description: string;
  picture: string | null; // largest thumbnail Meta returns, used as the ad thumbnail
  length: number | null; // seconds
  created: string;
  permalink: string;
};

/** Posts published on the Page with engagement (synced to analyze which content customers care about). */
export type SyncPost = {
  id: string;
  message: string;
  type: string;
  permalink: string;
  picture: string | null;
  createdTime: Date;
  reactions: number;
  comments: number;
  shares: number;
};
export type SyncComment = { id: string; postId: string; message: string; createdTime: Date; likes: number; fromPage: boolean };
/** Meta metrics for "Đo hiệu quả theo mã hàng" (per-SKU performance): spend, comments (action "comment") and source post of each ad, daily spend. */
export type LiftInsights = {
  spend: number;
  comments: number;
  daily: { date: string; spend: number }[];
  ads: { id: string; name: string; status: string; spend: number; comments: number; postId: string | null }[];
};
/** Ad metrics by breakdown (date range = client's analysisDays): "age_gender" (key "25-34|female"), "region" (province name), "platform" (facebook/instagram...). */
export type SyncBreakdown = { dimension: "age_gender" | "region" | "platform"; key: string; spend: number; impressions: number; reach: number; clicks: number; results: number; estimated?: boolean };

/** Ad set metrics over a long range (including paused / archived ad sets). recent* = last 30 days. */
export type SyncAdSetHistory = {
  id: string;
  campaignId: string;
  campaignName: string;
  name: string;
  status: string;
  resultType: string;
  targeting: string;
  adIds: string;
  days: number;
  spend: number;
  results: number;
  impressions: number;
  clicks: number;
  recentSpend: number;
  recentResults: number;
};

/** Which Pages the ad account runs for; the client only takes campaigns of its own Pages. */
export type AccountScopeReport = {
  pages: { id: string; name: string | null; campaigns: number; mine: boolean }[];
  kept: number; // number of the client's campaigns
  skipped: number; // campaigns of other Pages (skipped)
  unknown: number; // campaigns with no ads yet / Page could not be determined
  mixed: number; // campaigns that also have ads of other Pages
  filtered: boolean; // whether filtered or the whole account was taken
};

/** Metrics for one time range (used for optimization). */
export type PeriodMetrics = { spend: number; impressions: number; reach: number; clicks: number; results: number };

/** Running campaign, read directly from Meta for optimization: 3-day + 7-day metrics (including today) per ad set and ad, plus today alone. */
export type OptimizeSnapshot = {
  campaign: { id: string; name: string; status: string; dailyBudget: number | null; lifetimeBudget: number | null; bidStrategy: string | null; m7: PeriodMetrics; today?: PeriodMetrics };
  adSets: {
    id: string;
    name: string;
    status: string; // effective_status
    createdTime: string;
    dailyBudget: number | null;
    learning: string | null; // LEARNING | SUCCESS | FAIL
    targeting: string; // JSON
    m3: PeriodMetrics;
    m7: PeriodMetrics;
    today?: PeriodMetrics; // to know whether the ad set is exhausting its budget early in the day
  }[];
  ads: { id: string; name: string; adSetId: string; status: string; createdTime: string; storySpec: boolean; m3: PeriodMetrics; m7: PeriodMetrics }[];
  /** 7-day metrics per ad set broken down by age, gender, publisher platform (to find waste). */
  segments: { adSetId: string; dim: "age" | "gender" | "platform"; key: string; m7: PeriodMetrics }[];
};

/** Duplicated ad set settings: name, budget, new audience, and trimming waste (platform / gender / age). */
export type DuplicateOpts = {
  name: string;
  dailyBudget?: number | null;
  detailedTargeting?: { id: string; name: string; type: string }[] | null;
  advantageAudience?: boolean | null;
  excludePlatforms?: string[] | null; // VD ["audience_network"]
  genders?: number[] | null; // 1 = male, 2 = female
  ageMin?: number | null;
  ageMax?: number | null;
  locales?: number[] | null; // Meta language codes; [] = drop language filter, null = keep as in the original ad set
  ageRange?: [number, number] | null; // suggested age range (when keeping Advantage+)
};

/** Edit the audience of a running ad set (keeping everything else). */
export type TargetingPatch = {
  removeLocales?: number[];
  ageMin?: number | null;
  ageMax?: number | null;
  /** Suggested age range when Advantage+ is on (Meta doesn't allow lowering the max age, only suggesting). */
  ageRange?: [number, number] | null;
};

/** Report period: last N days (up to yesterday), "today" = today so far, "lifetime" = all time (up to today). */
export type ReportPeriod = number | "today" | "lifetime";

/** Campaign report metrics for a period (with the preceding period for comparison; for all time prevRange is empty). */
/** plays3s: 3-second video views; thruplays: complete / ≥ 15-second views (0 for image ads). */
export type ReportMetrics = PeriodMetrics & { revenue: number; plays3s: number; thruplays: number };
export type CampaignReportData = {
  range: { since: string; until: string };
  prevRange: { since: string; until: string };
  campaigns: { id: string; name: string; objective: string; status: string; dailyBudget: number | null; lifetimeBudget: number | null; resultType: string; m: ReportMetrics; prev: ReportMetrics }[];
  adSets: { id: string; name: string; campaignId: string; status: string; dailyBudget: number | null; m: ReportMetrics }[];
  ads: { id: string; name: string; adSetId: string; campaignId: string; status: string; m: ReportMetrics }[];
  /** Daily, per campaign (for trend charts and summing by result type). msgs: conversations started across all campaigns (Engagement campaigns also generate messages). */
  daily: { date: string; campaignId: string; m: ReportMetrics; msgs?: number }[];
  /** Campaigns that ran only in the previous period (so previous-period totals are complete). */
  prevOther: { resultType: string; m: ReportMetrics }[];
  /** Age / gender / platform per campaign. */
  segments: { campaignId: string; dim: "age" | "gender" | "platform"; key: string; m: ReportMetrics }[];
};

/** Per-ad performance over N days (to compare winning / losing creatives). */
export type CreativeRow = {
  adId: string;
  adName: string;
  adSetName: string;
  campaignName: string;
  resultType: string;
  spend: number;
  impressions: number;
  clicks: number;
  results: number;
  plays3s: number; // 3-second video views (0 for image ads)
  thruplays: number;
};
/** Ad content: text + image link / video frame. */
export type CreativeContent = { adId: string; format: "video" | "image" | "carousel" | "post" | "other"; text: string; headline: string; imageUrl: string | null };

/** New ad content written by the user / AI to add to a running ad set. */
export type AdVariant = { primary_text: string; headline: string; description: string };

/** One lead from an Instant Form. */
export type SyncLead = {
  id: string;
  formId: string;
  formName: string;
  adId: string | null;
  adName: string | null;
  campaignId: string | null;
  campaignName: string | null;
  createdTime: Date;
  name: string;
  phone: string | null;
  phones: string; // JSON string[]
  email: string | null;
  answers: string; // JSON [{q, a}], without phone / email
  platform: string | null;
  isOrganic: boolean;
};

export type WebhookStatus = { appId: string | null; appName: string | null; subscribed: boolean; fields: string[] };

/** Instant Form on a Page. */
export type LeadForm = { id: string; name: string; status: string; created: string; leads: number | null; questions: string[] };
/** Form question: a Meta built-in type (FULL_NAME, PHONE...) or CUSTOM with question text. */
export type LeadFormQuestion = { type: string; label?: string; options?: string[] };
export type LeadFormInput = {
  name: string;
  higherIntent: boolean; // true = "Higher intent": adds a confirmation step before submitting
  introTitle: string;
  introText: string;
  questions: LeadFormQuestion[];
  privacyUrl: string;
  privacyText: string;
  thanksTitle: string;
  thanksBody: string;
  thanksButton: "VIEW_WEBSITE" | "CALL_BUSINESS" | "MESSAGE_BUSINESS";
  websiteUrl: string;
  phone: string;
};
/** Existing custom / lookalike audience in the ad account. */
export type CustomAudienceRef = { id: string; name: string; subtype: string; size: number | null; status: string };

export type AudienceEstimate = {
  lower: number | null; // estimated (monthly) number of people the ad set can reach
  upper: number | null;
  daily: number | null; // daily active users in the audience, if Meta returns it
  notes: string[];
};

export type AccountSnapshot = {
  campaigns: SyncCampaign[];
  adSets: SyncAdSet[];
  ads: SyncAd[];
  daily: SyncDaily[];
};

export type PublishResult = {
  campaign: SyncCampaign;
  adSets: SyncAdSet[];
  ads: SyncAd[];
  adPlanIndex: number[]; // ads[i] corresponds to plan.ads[adPlanIndex[i]]
  notes: string[];
};

/** A Page post with enough to review content: text, images (including albums), video frames, engagement. */
export type PostDetail = {
  id: string; // {pageId}_{postId}
  pageId: string;
  message: string;
  permalink: string;
  type: string;
  created: string;
  images: string[]; // image URLs (main image + album images, max 6 by default)
  video: { id: string; frames: string[]; seconds: number | null; title: string } | null;
  eligible: boolean; // Meta allows using this post as an ad
  reactions: number | null;
  comments: number | null;
  shares: number | null;
};
/** Meta review status of a published ad. */
export type AdReview = { id: string; name: string; status: string; feedback: string[] };

export type PublishedIds = { campaignId: string; adSetIds: string[]; adIds: string[]; adPlanIndex: number[] };

export type VerifyCheck = { label: string; ok: boolean; expected?: string; actual?: string };
export type VerifySection = { level: "campaign" | "adset" | "ad"; id: string; name: string; checks: VerifyCheck[]; sentences?: string[] };
export type VerifyReport = { checkedAt: string; ok: boolean; sections: VerifySection[] };

/** All Meta operations go through this interface, to switch between sample data and the real API. */
export interface MetaClient {
  readonly kind: "mock" | "meta";
  fetchAccount(): Promise<AccountSnapshot>;
  /** since: only conversations updated after this point are needed (stops pagination early). */
  fetchConversations(limit: number, pageId?: string, since?: Date): Promise<SyncConversation[]>;
  /** Which Pages the ad account runs for (null in sample mode). */
  accountScope(): Promise<AccountScopeReport | null>;
  /** Estimated audience size of an ad set (null if no data, e.g. sample mode). */
  estimateAudience(adSet: EditableAdSet, resultType: string): Promise<AudienceEstimate | null>;
  /** Audience description exactly as Ads Manager shows it (targetingsentencelines). */
  describeTargeting(adSet: EditableAdSet, resultType: string): Promise<string[]>;
  /** Read back objects just created on Meta and compare with the plan. */
  verifyPublished(plan: EditablePlan, ids: PublishedIds): Promise<VerifyReport>;
  /** Recent Page posts, for "Use existing post". */
  listPosts(limit: number, pageId?: string): Promise<PagePost[]>;
  /** Videos / Reels posted on the Page (newest first). */
  listVideos(limit: number, pageId?: string): Promise<PageVideo[]>;
  /** Find a post from a Facebook link (post, photo, video, reel) among the client's Pages. null = not from any of the client's Pages. */
  resolvePostLink(link: string, pageIds: string[]): Promise<string | null>;
  /** maxImages: max images to fetch (default 6). */
  postDetail(postId: string, maxImages?: number): Promise<PostDetail>;
  /** Review status (approved / rejected + reason) of ads. */
  adReviews(adIds: string[]): Promise<AdReview[]>;
  /** Recent posts + comments of the most-commented posts. */
  fetchPageActivity(opts: { posts: number; commentPosts: number; commentsPerPost: number }, pageId?: string): Promise<{ posts: SyncPost[]; comments: SyncComment[]; missingPermission?: string }>;
  /** Ad metrics over `days` days by age/gender, region, platform. */
  fetchBreakdowns(days: number): Promise<SyncBreakdown[]>;
  /** Per-ad-set metrics over `days` days (including paused ad sets), for persona & targeting scoring. */
  fetchAdSetHistory(days: number): Promise<SyncAdSetHistory[]>;
  /** The Page's Instant Forms. */
  listLeadForms(pageId?: string): Promise<LeadForm[]>;
  /** Create a new Instant Form on the Page (forms not attached to ads cost nothing). */
  createLeadForm(input: LeadFormInput, pageId?: string): Promise<LeadForm>;
  /** Leads from all of the Page's Instant Forms in `days` days (Meta keeps at most 90 days). */
  fetchLeads(days: number, pageId?: string): Promise<{ leads: SyncLead[]; forms: number }>;
  /** Running campaign with 3/7-day metrics per ad set and ad (null when not connected). */
  fetchOptimizeSnapshot(campaignId: string): Promise<OptimizeSnapshot | null>;
  /** Same as above for many campaigns in one pass (fewer Meta calls). */
  fetchOptimizeSnapshots(campaignIds: string[]): Promise<OptimizeSnapshot[]>;
  /** Metrics of a campaign / ad set / ad from since (YYYY-MM-DD) to yesterday, to measure results after optimizing. */
  metricsSince(level: Level, id: string, since: string, resultType: string): Promise<PeriodMetrics>;
  /** Spend + comments per ad of a campaign / ad within [since, until] (null when not connected). */
  fetchLiftInsights(level: "campaign" | "ad", id: string, since: string, until: string): Promise<LiftInsights | null>;
  /** Top-level comments on a post since a point in time (newest → oldest, at most max). */
  fetchPostComments(postId: string, since: Date, max?: number): Promise<SyncComment[]>;
  /** Duplicate an ad set (with its ads) within the same campaign, always PAUSED. Returns the new ad set id. */
  duplicateAdSet(adSetId: string, opts: DuplicateOpts): Promise<string>;
  /** Edit the audience (language / age) of an existing ad set. Returns the new targeting. */
  updateAdSetTargeting(adSetId: string, patch: TargetingPatch, validateOnly?: boolean): Promise<Record<string, unknown>>;
  /** Add a new ad to an ad set (using the template ad's image / format, with new text), always PAUSED. Returns the new ad id. */
  addAdFromTemplate(adSetId: string, templateAdId: string, name: string, v: AdVariant): Promise<string>;
  /** Subscribe / check the Page's messaging webhook for the token's app. */
  subscribePageWebhook(pageId?: string): Promise<WebhookStatus>;
  pageWebhookStatus(pageId?: string): Promise<WebhookStatus>;
  /** Page sends a text message to a customer (PSID). Meta only accepts it if the customer messaged the Page in the last 24 hours. Returns the message id. */
  sendPageMessage(pageId: string, psid: string, text: string): Promise<string>;
  /** Conversations with messages from `since` → now, read directly from Meta (including image / file-only messages with empty text). */
  recentThreads(pageId: string, since: Date, limit?: number): Promise<RecentThread[]>;
  /** A customer's (PSID) conversation with the Page: id, customer name, inbox link. null if Meta doesn't return it. */
  conversationOf(pageId: string, psid: string): Promise<{ id: string; customerName: string; link: string | null; updatedTime: Date } | null>;
  /** Per-ad performance over N days (for the client's Pages) and the content of some ads. */
  fetchCreativePerformance(days: number): Promise<CreativeRow[]>;
  /** Metrics for every campaign with spend or running in the period (N days up to yesterday / today / all time) + the preceding period. */
  fetchCampaignReport(period: ReportPeriod): Promise<CampaignReportData>;
  fetchAdCreatives(adIds: string[]): Promise<CreativeContent[]>;
  /** Custom + lookalike audiences of the ad account. */
  listCustomAudiences(): Promise<CustomAudienceRef[]>;
  setStatus(level: Level, id: string, status: "ACTIVE" | "PAUSED"): Promise<void>;
  setDailyBudget(level: "campaign" | "adset", id: string, amount: number): Promise<void>;
  /** Create campaign/ad set/ad from the plan. Always created as PAUSED. */
  publishPlan(plan: EditablePlan): Promise<PublishResult>;
}
