import { readFileSync } from "node:fs";
import { pageInboxUrl } from "../inbox-link";
import type { EditableAdSet, EditablePlan, Welcome } from "../ai/schemas";
import { toFlexibleSpec, toGeoSpec } from "../targeting";
import { LANGUAGE_BY_CODE } from "../languages";
import { uploadFilePath } from "../uploads";
import { zonedToIso } from "../format";
import { goalOf, MESSAGE_DESTINATION_OPTS } from "../ads-options";
import { PUBLISHABLE_RESULTS } from "../plan-rules";
import { CAROUSEL_MAX, CAROUSEL_MIN, carouselBlockReason, carouselLinkData, isCarousel } from "../carousel";
import { normalizePhone } from "../pii";
import { norm } from "../text";
import { getT } from "@/i18n/server";
import { DEFAULT_LOCALE } from "@/i18n/config";
import { translator } from "@/i18n/translate";
import { metaFetch } from "./rate-limit";
import { safeFetch } from "../safe-fetch";
import type {
  AccountSnapshot,
  CampaignReportData,
  ReportMetrics,
  ReportPeriod,
  Level,
  MetaClient,
  AudienceEstimate,
  MetricsRow,
  PagePost,
  PageVideo,
  PublishedIds,
  RecentThread,
  VerifyCheck,
  VerifyReport,
  VerifySection,
  PublishResult,
  SyncAd,
  SyncAdSet,
  SyncCampaign,
  SyncBreakdown,
  PostDetail,
  AdReview,
  SyncComment,
  SyncConversation,
  SyncDaily,
  CustomAudienceRef,
  AccountScopeReport,
  SyncLead,
  AdVariant,
  CreativeContent,
  CreativeRow,
  OptimizeSnapshot,
  PeriodMetrics,
  DuplicateOpts,
  SyncAdSetHistory,
  LeadForm,
  LeadFormInput,
  TargetingPatch,
  LiftInsights,
} from "./types";

// Client cho Meta Marketing API + Graph API (Messenger).
// Required permissions: ads_read, ads_management, pages_show_list, pages_read_engagement, pages_messaging.
// NOTE: not yet tried against a real account; test on a small ad account first.

const VERSION = process.env.META_API_VERSION || "v23.0";
const BASE = `https://graph.facebook.com/${VERSION}`;

// Currencies without decimal places: Meta takes budgets in the base unit. Others use "cents".
const ZERO_DECIMAL = new Set(["VND", "JPY", "KRW", "CLP", "COP", "CRC", "HUF", "ISK", "IDR", "PYG", "TWD"]);

const RESULT_ACTIONS: Record<string, string[]> = {
  messages: ["onsite_conversion.messaging_conversation_started_7d"],
  leads: ["lead", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead"],
  purchases: ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"],
  link_clicks: ["link_click"],
  engagement: ["post_engagement", "page_engagement"],
  page_likes: ["like"],
  // The action name for IG profile visits hasn't been verified on a real account; fall back to link_click if absent.
  profile_visits: ["onsite_conversion.ig_profile_visit", "link_click"],
  // ThruPlay is read from the separate field video_thruplay_watched_actions (see toMetrics), not video_view (3-second views).
};
const REVENUE_ACTIONS = ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"];

type ActionList = { action_type: string; value: string }[] | undefined;
type InsightRow = {
  spend?: string;
  impressions?: string;
  reach?: string;
  clicks?: string;
  inline_link_clicks?: string;
  actions?: ActionList;
  action_values?: ActionList;
  date_start?: string;
  campaign_id?: string;
  adset_id?: string;
  ad_id?: string;
  video_thruplay_watched_actions?: ActionList;
};

/** Apply audience edits to Meta targeting (also used when updating the DB copy). */
function applyTargetingPatch(src: Record<string, unknown>, patch: TargetingPatch) {
  const t: Record<string, unknown> = { ...src };
  if (patch.removeLocales?.length && Array.isArray(t.locales)) {
    const keep = (t.locales as number[]).filter((k) => !patch.removeLocales!.includes(k));
    // Removing all languages = targeting everyone: not allowed (the ad set would get broader than before).
    if (!keep.length) throw new MetaApiError(translator(DEFAULT_LOCALE)("targeting.graph.noLocaleFilter")); // sync export: default locale
    t.locales = keep;
  }
  if (patch.ageMin) t.age_min = patch.ageMin;
  if (patch.ageMax) t.age_max = patch.ageMax;
  if (patch.ageRange) t.age_range = patch.ageRange;
  return t;
}

export class MetaApiError extends Error {
  constructor(
    message: string,
    public code?: number,
  ) {
    super(message);
  }
}

function pickAction(list: ActionList, types: string[]): number {
  if (!list) return 0;
  for (const t of types) {
    const hit = list.find((a) => a.action_type === t);
    if (hit) return Number(hit.value) || 0;
  }
  return 0;
}

function toMetrics(row: InsightRow | undefined, resultType: string): MetricsRow {
  if (!row) return { spend: 0, impressions: 0, reach: 0, clicks: 0, results: 0, revenue: 0 };
  const reach = Number(row.reach) || 0;
  return {
    spend: Number(row.spend) || 0,
    impressions: Number(row.impressions) || 0,
    reach,
    clicks: Number(row.inline_link_clicks ?? row.clicks) || 0,
    results:
      resultType === "reach"
        ? reach
        : resultType === "video_views"
          ? pickAction(row.video_thruplay_watched_actions, ["video_view"])
          : pickAction(row.actions, RESULT_ACTIONS[resultType] ?? []),
    revenue: pickAction(row.action_values, REVENUE_ACTIONS),
  };
}

type RawLead = { id: string; created_time: string; ad_id?: string; ad_name?: string; campaign_id?: string; campaign_name?: string; field_data?: { name: string; values?: string[] }[]; platform?: string; is_organic?: boolean };

/**
 * Lead name / phone / email: standard forms use full_name, phone_number, email; forms with custom questions (e.g. "số_điện_thoại", "tên_đầy_đủ")
 * are matched by question name, then by value shape. A student's / child's name is not treated as the submitter's name.
 */
type RawFormQuestion = { key?: string; label?: string; options?: { key: string; value: string }[] };

function parseLead(l: RawLead, f: { id: string; name: string; questions?: RawFormQuestion[] }): SyncLead {
  // Custom questions (system-created forms: key q1, answer q1_2): Meta returns codes; map back to the question label + answer text.
  const qs = new Map((f.questions ?? []).filter((q) => q.key && q.label).map((q) => [q.key!, q]));
  const label = (name: string) => qs.get(name)?.label ?? name;
  const answer = (name: string, v: string) => qs.get(name)?.options?.find((o) => o.key === v)?.value ?? v;
  const fields = (l.field_data ?? [])
    .map((x) => ({ name: label(x.name), key: norm(label(x.name)).replace(/[^a-z0-9]+/g, "_"), value: (x.values ?? []).map((v) => answer(x.name, v)).join(", ").trim() }))
    .filter((x) => x.value);
  const used = new Set<string>();
  const take = (pred: (x: (typeof fields)[number]) => boolean) => {
    const x = fields.find((y) => !used.has(y.name) && pred(y));
    if (x) used.add(x.name);
    return x?.value ?? null;
  };
  const phoneRaw =
    take((x) => x.key === "phone_number") ??
    take((x) => /phone|sdt|so_dien_thoai|dien_thoai|zalo|mobile/.test(x.key) && !!normalizePhone(x.value)) ??
    take((x) => !!normalizePhone(x.value) && x.value.replace(/\D/g, "").length >= 9);
  const email = take((x) => x.key === "email") ?? take((x) => /^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(x.value));
  const child = /(^|_)(hoc_sinh|con|be|student|child)(_|$)/;
  // Other phones / emails in the form (e.g. a student's phone): collected separately, not exposed in the answers section.
  const extraPhones: string[] = [];
  for (const x of fields) {
    if (used.has(x.name)) continue;
    const p = normalizePhone(x.value);
    if (p && x.value.replace(/\D/g, "").length >= 9) {
      extraPhones.push(p);
      used.add(x.name);
    } else if (/^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(x.value)) used.add(x.name);
  }
  const name =
    take((x) => x.key === "full_name") ??
    ([take((x) => x.key === "first_name"), take((x) => x.key === "last_name")].filter(Boolean).join(" ") ||
      take((x) => /^(ho_va_ten|ho_ten|ten_day_du|ten|name|full_name|ho_ten_phu_huynh|ten_phu_huynh)$/.test(x.key) || (/(^|_)(ten|name)(_|$)/.test(x.key) && !child.test(x.key))));
  const childName = !name ? take((x) => /(^|_)(ten|name)(_|$)/.test(x.key)) : null;
  const phone = phoneRaw ? (normalizePhone(phoneRaw) ?? phoneRaw) : null;
  return {
    id: l.id,
    formId: f.id,
    formName: f.name,
    adId: l.ad_id ?? null,
    adName: l.ad_name ?? null,
    campaignId: l.campaign_id ?? null,
    campaignName: l.campaign_name ?? null,
    createdTime: new Date(l.created_time),
    name: name || (childName ? `${childName} (tên HS)` : "(không tên)"),
    phone,
    phones: JSON.stringify([...new Set([phone, ...extraPhones].filter(Boolean))]),
    email: email?.toLowerCase() ?? null,
    answers: JSON.stringify(fields.filter((x) => !used.has(x.name)).map((x) => ({ q: x.name.replace(/_/g, " "), a: x.value }))),
    platform: l.platform ?? null,
    isOrganic: !!l.is_organic,
  };
}

/** Result type of an ad set, from campaign objective + optimization goal + conversion location. */
function resultTypeFor(objective: string, goal: string, dest: string, fallback: string) {
  if (objective === "OUTCOME_LEADS" || objective === "LEAD_GENERATION") return "leads";
  if (objective === "MESSAGES" || goal === "CONVERSATIONS" || MESSAGE_DESTINATION_OPTS.some((o) => o.api === dest)) return "messages";
  const byGoal: Record<string, string> = { PAGE_LIKES: "page_likes", POST_ENGAGEMENT: "engagement", VISIT_INSTAGRAM_PROFILE: "profile_visits", THRUPLAY: "video_views" };
  if (byGoal[goal]) return byGoal[goal];
  const byObjective: Record<string, string> = {
    OUTCOME_SALES: "purchases",
    CONVERSIONS: "purchases",
    OUTCOME_TRAFFIC: "link_clicks",
    LINK_CLICKS: "link_clicks",
    OUTCOME_AWARENESS: "reach",
    REACH: "reach",
  };
  return byObjective[objective] ?? fallback;
}

function toLeadForm(f: { id: string; name: string; status: string; created_time: string; leads_count?: number; questions?: { type: string; label?: string }[] }): LeadForm {
  return { id: f.id, name: f.name, status: f.status, created: f.created_time, leads: f.leads_count ?? null, questions: (f.questions ?? []).map((q) => q.label ?? q.type) };
}

/** Excluded locations (excluded_geo_locations): same shape as geo_locations but without location_types. */
function excludedGeo(locs: EditableAdSet["excluded_locations"]) {
  if (!locs.length) return null;
  const geo: Partial<ReturnType<typeof toGeoSpec>> = toGeoSpec(locs);
  delete geo.location_types;
  return geo;
}

/** Welcome message template (format of the message template editor in Ads Manager). */
function welcomeMessage(w: Welcome) {
  return JSON.stringify({
    type: "VISUAL_EDITOR",
    version: 2,
    landing_screen_type: "welcome_message",
    media_type: "text",
    text_format: {
      customer_action_type: "ice_breakers",
      // Without auto-replies, omit "response" entirely: Meta won't auto-reply, leaving it to the Page's chatbot.
      message: { ice_breakers: w.questions.filter((q) => q.q.trim()).map((q) => ({ title: q.q.trim(), ...(q.a.trim() && { response: q.a.trim() }) })), quick_replies: [], text: w.greeting.trim() },
    },
    user_edit: true,
    surface: "visual_editor_new",
  });
}

const BID_API = { lowest_cost: "LOWEST_COST_WITHOUT_CAP", cost_cap: "COST_CAP", bid_cap: "LOWEST_COST_WITH_BID_CAP" } as const;

// A2: params that carry money. Their unit depends on the ad account currency (offset 1 or 100),
// so the configured currency must match the account's real one before they are sent.
const MONEY_PARAMS = new Set(["daily_budget", "lifetime_budget", "bid_amount", "spend_cap", "spend_cap_action"]);

export class GraphMetaClient implements MetaClient {
  readonly kind = "meta" as const;
  private offset: number;
  private currencyChecked: Promise<void> | null = null;

  /** Reads the ad account currency once per client instance and refuses to continue on mismatch. */
  private assertCurrency() {
    this.currencyChecked ??= (async () => {
      const acc = await this.handle<{ currency?: string }>(await metaFetch(`${BASE}/${this.act}?${new URLSearchParams({ fields: "currency", access_token: this.cfg.token })}`, { method: "GET" }));
      const real = (acc.currency ?? "").toUpperCase();
      if (!real) throw new Error((await getT())("targeting.graph.currencyUnreadable"));
      if (real !== this.cfg.currency.toUpperCase())
        throw new Error((await getT())("targeting.graph.currencyMismatch", { real, set: this.cfg.currency }));
    })().catch((e) => {
      this.currencyChecked = null; // allow a retry after the setting is fixed
      throw e;
    });
    return this.currencyChecked;
  }

  constructor(
    private cfg: {
      adAccountId: string;
      pageId: string | null;
      /** All of the client's Pages (main + secondary). If the ad account also runs for other Pages, only take campaigns for these Pages. */
      pageIds?: string[];
      /** Linked Instagram for each Page (so ads posted under a secondary Page use the right Instagram). */
      pageInstagram?: Record<string, string | null>;
      instagramId: string | null;
      token: string;
      currency: string;
      primaryResult: string;
      timezone: string;
    },
  ) {
    this.offset = ZERO_DECIMAL.has(cfg.currency.toUpperCase()) ? 1 : 100;
    this.activePage = cfg.pageId;
  }

  private get act() {
    return this.cfg.adAccountId.startsWith("act_") ? this.cfg.adAccountId : `act_${this.cfg.adAccountId}`;
  }

  private async request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    params: Record<string, unknown> = {},
    token = this.cfg.token,
  ): Promise<T> {
    const encoded = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      encoded.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    }
    encoded.set("access_token", token);
    if (method === "POST" && Object.keys(params).some((k) => MONEY_PARAMS.has(k) && params[k] != null)) await this.assertCurrency();
    return this.withRetry(async () =>
      this.handle<T>(method === "POST" ? await metaFetch(`${BASE}${path}`, { method: "POST", body: encoded }) : await metaFetch(`${BASE}${path}?${encoded}`, { method })),
    );
  }

  /**
   * Meta rate limits calls (errors 4, 17, 32, 613, 80000–80014): wait and retry up to 2 times (15 seconds, 45 seconds).
   * Rate-limited calls are not executed by Meta, so retrying doesn't create duplicates.
   */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const code = err instanceof MetaApiError ? err.code : undefined;
        const limited = code != null && ([4, 17, 32, 613].includes(code) || (code >= 80000 && code <= 80014));
        if (!limited || attempt >= 2) throw err;
        await new Promise((r) => setTimeout(r, attempt === 0 ? 15_000 : 45_000));
      }
    }
  }

  private async handle<T>(res: Response): Promise<T> {
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) {
      const e = json.error ?? {};
      throw new MetaApiError(e.error_user_msg || e.message || (await getT())("targeting.graph.httpError", { status: res.status }), e.code);
    }
    return json as T;
  }

  // Fetch everything by default: sync deletes from the DB anything not in the list, so a truncated list would lose data.
  // stop: end pagination early once the page just read is enough (e.g. conversations older than the previous sync).
  private async getAll<T>(path: string, params: Record<string, unknown>, maxItems = Number.POSITIVE_INFINITY, token?: string, stop?: (page: T[]) => boolean) {
    const out: T[] = [];
    let page = await this.request<{ data: T[]; paging?: { next?: string } }>("GET", path, params, token);
    out.push(...page.data);
    while (page.paging?.next && out.length < maxItems && !stop?.(page.data)) {
      const next = page.paging.next;
      page = await this.withRetry(async () => this.handle(await metaFetch(next)));
      out.push(...page.data);
    }
    return out.slice(0, maxItems);
  }

  private budget(v: string | undefined | null) {
    return v ? Number(v) / this.offset : null;
  }

  // ------------------------------------------------ Ad accounts shared across multiple Pages

  /** Page currently used to create ads (publishPlan sets it per plan). */
  private activePage: string | null = null;

  private scopeCache: Promise<{ keep: Set<string> | null; foreignAds: Set<string>; report: AccountScopeReport }> | null = null;

  /** Page of each campaign (from the ads' Page + the ad set's messaging/form Page). Computed only once per sync run. */
  private scope() {
    return (this.scopeCache ??= this.computeScope());
  }

  async accountScope(): Promise<AccountScopeReport> {
    return (await this.scope()).report;
  }

  private async computeScope() {
    const mine = new Set(this.cfg.pageIds?.length ? this.cfg.pageIds : this.cfg.pageId ? [this.cfg.pageId] : []);
    // Includes archived objects (needed for 90-day history); deleted ones are not returned by Meta.
    const effective_status = ["ACTIVE", "PAUSED", "ARCHIVED", "CAMPAIGN_PAUSED", "ADSET_PAUSED", "DISAPPROVED", "PENDING_REVIEW", "WITH_ISSUES", "IN_PROCESS", "PREAPPROVED", "PENDING_BILLING_INFO"];
    type A = { id: string; campaign_id: string; creative?: { actor_id?: string; effective_object_story_id?: string; object_story_spec?: { page_id?: string } } };
    type S = { campaign_id: string; promoted_object?: { page_id?: string } };
    const [ads, sets, camps] = await Promise.all([
      this.getAll<A>(`/${this.act}/ads`, { fields: "id,campaign_id,creative{actor_id,effective_object_story_id,object_story_spec{page_id}}", effective_status, limit: 200 }),
      this.getAll<S>(`/${this.act}/adsets`, { fields: "campaign_id,promoted_object", effective_status, limit: 200 }),
      this.getAll<{ id: string }>(`/${this.act}/campaigns`, { fields: "id", effective_status, limit: 200 }),
    ]);
    const pageOfAd = (a: A) => a.creative?.object_story_spec?.page_id ?? a.creative?.actor_id ?? a.creative?.effective_object_story_id?.split("_")[0] ?? null;
    const byCampaign = new Map<string, Set<string>>(camps.map((c) => [c.id, new Set<string>()]));
    const add = (c: string, p: string | null | undefined) => p && (byCampaign.get(c) ?? byCampaign.set(c, new Set()).get(c)!).add(p);
    for (const a of ads) add(a.campaign_id, pageOfAd(a));
    for (const st of sets) add(st.campaign_id, st.promoted_object?.page_id);

    const counts = new Map<string, number>();
    for (const pages of byCampaign.values()) for (const p of pages) counts.set(p, (counts.get(p) ?? 0) + 1);
    const foreign = [...counts.keys()].filter((p) => !mine.has(p));
    const unknown = [...byCampaign.values()].filter((p) => !p.size).length;
    // Names of other Pages in the account (to report "skipping Page X"); if the token can't read that Page, show the ID.
    const names = new Map<string, string>();
    if (foreign.length) {
      await Promise.all(
        foreign.slice(0, 10).map((id) =>
          this.request<{ name?: string }>("GET", `/${id}`, { fields: "name" })
            .then((v) => v.name && names.set(id, v.name))
            .catch(() => {}),
        ),
      );
    }
    const pages = [...counts.entries()].map(([id, campaigns]) => ({ id, name: names.get(id) ?? null, campaigns, mine: mine.has(id) })).sort((a, b) => Number(b.mine) - Number(a.mine) || b.campaigns - a.campaigns);

    // No foreign Pages (or the client hasn't chosen a Page): take the whole account as before.
    if (!mine.size || !foreign.length) {
      return { keep: null, foreignAds: new Set<string>(), report: { pages, kept: byCampaign.size, skipped: 0, unknown, mixed: 0, filtered: false } };
    }
    const keep = new Set([...byCampaign].filter(([, p]) => [...p].some((x) => mine.has(x))).map(([c]) => c));
    const foreignAds = new Set(ads.filter((a) => keep.has(a.campaign_id) && pageOfAd(a) && !mine.has(pageOfAd(a)!)).map((a) => a.id));
    const mixed = [...keep].filter((c) => [...byCampaign.get(c)!].some((p) => !mine.has(p))).length;
    return { keep, foreignAds, report: { pages, kept: keep.size, skipped: byCampaign.size - keep.size - unknown, unknown, mixed, filtered: true } };
  }

  /** Insights filter params by the client's campaigns (null = no filter needed; [] = no campaigns). */
  private async scopeFilter(): Promise<Record<string, unknown> | null> {
    const { keep } = await this.scope();
    if (!keep) return {};
    if (!keep.size) return null;
    return { filtering: [{ field: "campaign.id", operator: "IN", value: [...keep] }] };
  }

  /** 7-day metrics including today (Meta's date_preset last_7d stops at yesterday; the campaign table needs the latest numbers). */
  private insights(level: Level) {
    return this.getAll<InsightRow>(`/${this.act}/insights`, {
      level,
      time_range: { since: this.dayAgo(6), until: this.dayAgo(0) },
      fields: `${level}_id,spend,impressions,reach,clicks,inline_link_clicks,actions,action_values,video_thruplay_watched_actions`,
      limit: 500,
    });
  }

  async fetchAccount(): Promise<AccountSnapshot> {
    type RawCampaign = { id: string; name: string; objective: string; status: string; daily_budget?: string; created_time?: string };
    type RawAdSet = {
      id: string;
      name: string;
      campaign_id: string;
      status: string;
      daily_budget?: string;
      optimization_goal?: string;
      destination_type?: string;
      targeting?: unknown;
    };
    type RawAd = { id: string; name: string; adset_id: string; campaign_id: string; status: string; creative?: { body?: string; title?: string } };

    const scope = await this.scope();
    const filter = await this.scopeFilter();
    const [rawCampaigns, rawAdSets, rawAds, cIns, sIns, aIns, daily] = await Promise.all([
      this.getAll<RawCampaign>(`/${this.act}/campaigns`, { fields: "id,name,objective,status,daily_budget,created_time", limit: 200 }),
      this.getAll<RawAdSet>(`/${this.act}/adsets`, {
        fields: "id,name,campaign_id,status,daily_budget,optimization_goal,destination_type,targeting",
        limit: 200,
      }),
      this.getAll<RawAd>(`/${this.act}/ads`, { fields: "id,name,adset_id,campaign_id,status,creative{body,title}", limit: 200 }),
      this.insights("campaign"),
      this.insights("adset"),
      this.insights("ad"),
      // Daily metrics: for shared accounts only sum the client's campaigns.
      filter
        ? this.getAll<InsightRow>(`/${this.act}/insights`, {
            level: "account",
            time_increment: 1,
            time_range: { since: this.dayAgo(29), until: this.dayAgo(0) }, // 30 days including today (today's numbers fill in gradually)
            fields: "spend,impressions,reach,clicks,inline_link_clicks,actions,action_values,video_thruplay_watched_actions",
            ...filter,
          })
        : Promise.resolve([] as InsightRow[]),
    ]);
    const mineCampaign = (id: string) => !scope.keep || scope.keep.has(id);

    const live = (s: string) => s !== "ARCHIVED" && s !== "DELETED";
    const messengerCampaigns = new Set(
      rawAdSets
        .filter((s) => MESSAGE_DESTINATION_OPTS.some((o) => o.api === s.destination_type) || s.optimization_goal === "CONVERSATIONS")
        .map((s) => s.campaign_id),
    );
    const goalOf = new Map(rawAdSets.map((s) => [s.campaign_id, s.optimization_goal]));
    const resultTypeOf = (c: RawCampaign) => {
      // Leads via Messenger are still a lead-generation campaign.
      if (c.objective === "OUTCOME_LEADS" || c.objective === "LEAD_GENERATION") return "leads";
      if (messengerCampaigns.has(c.id) || c.objective === "MESSAGES") return "messages";
      if (goalOf.get(c.id) === "PAGE_LIKES") return "page_likes";
      if (goalOf.get(c.id) === "POST_ENGAGEMENT") return "engagement";
      if (goalOf.get(c.id) === "VISIT_INSTAGRAM_PROFILE") return "profile_visits";
      if (goalOf.get(c.id) === "THRUPLAY") return "video_views";
      return (
        {
          OUTCOME_LEADS: "leads",
          LEAD_GENERATION: "leads",
          OUTCOME_SALES: "purchases",
          CONVERSIONS: "purchases",
          OUTCOME_TRAFFIC: "link_clicks",
          LINK_CLICKS: "link_clicks",
          OUTCOME_AWARENESS: "reach",
          REACH: "reach",
        }[c.objective] ?? this.cfg.primaryResult
      );
    };

    const byId = (rows: InsightRow[], key: "campaign_id" | "adset_id" | "ad_id") => new Map(rows.map((r) => [r[key]!, r]));
    const cMap = byId(cIns, "campaign_id");
    const sMap = byId(sIns, "adset_id");
    const aMap = byId(aIns, "ad_id");

    const campaigns: SyncCampaign[] = rawCampaigns.filter((c) => live(c.status) && mineCampaign(c.id)).map((c) => {
      const resultType = resultTypeOf(c);
      return {
        id: c.id,
        name: c.name,
        objective: c.objective,
        status: c.status,
        dailyBudget: this.budget(c.daily_budget),
        resultType,
        createdTime: c.created_time ? new Date(c.created_time) : null,
        ...toMetrics(cMap.get(c.id), resultType),
      };
    });
    const rt = new Map(campaigns.map((c) => [c.id, c.resultType]));

    const adSets: SyncAdSet[] = rawAdSets
      .filter((s) => live(s.status) && rt.has(s.campaign_id))
      .map((s) => ({
        id: s.id,
        campaignId: s.campaign_id,
        name: s.name,
        status: s.status,
        dailyBudget: this.budget(s.daily_budget),
        optimizationGoal: s.optimization_goal ?? "",
        targeting: JSON.stringify(s.targeting ?? {}),
        ...toMetrics(sMap.get(s.id), rt.get(s.campaign_id)!),
      }));
    const adSetIds = new Set(adSets.map((s) => s.id));

    const ads: SyncAd[] = rawAds
      .filter((a) => live(a.status) && adSetIds.has(a.adset_id) && !scope.foreignAds.has(a.id))
      .map((a) => ({
        id: a.id,
        campaignId: a.campaign_id,
        adSetId: a.adset_id,
        name: a.name,
        status: a.status,
        primaryText: a.creative?.body ?? "",
        headline: a.creative?.title ?? "",
        ...toMetrics(aMap.get(a.id), rt.get(a.campaign_id)!),
      }));

    const dailyRows: SyncDaily[] = daily.map((d) => {
      const m = toMetrics(d, this.cfg.primaryResult);
      return { date: d.date_start!, spend: m.spend, impressions: m.impressions, clicks: m.clicks, results: m.results, revenue: m.revenue };
    });

    return { campaigns, adSets, ads, daily: dailyRows };
  }

  /** Page token read once per Page for the client's lifetime (one sync run calls many functions that need a page token). */
  private pageTokens = new Map<string, Promise<string>>();

  private pageToken(pageId?: string | null): Promise<string> {
    const page = pageId ?? this.cfg.pageId;
    if (!page) return getT().then((tr) => Promise.reject(new MetaApiError(tr("targeting.graph.noPageId"))));
    let t = this.pageTokens.get(page);
    if (!t) {
      t = this.loadPageToken(page);
      this.pageTokens.set(page, t);
      t.catch(() => this.pageTokens.delete(page));
    }
    return t;
  }

  private async loadPageToken(page: string): Promise<string> {
    try {
      const r = await this.request<{ access_token?: string }>("GET", `/${page}`, { fields: "access_token" });
      return r.access_token ?? this.cfg.token;
    } catch (e) {
      // Expired token / network error: report that exact error; other errors usually mean the token is already a page token.
      if (!(e instanceof MetaApiError) || e.code === 190) throw e;
      return this.cfg.token;
    }
  }

  /** since: conversations are sorted by latest update, so stop loading upon hitting a conversation unchanged since the previous sync. */
  async fetchConversations(limit: number, pageId?: string, since?: Date): Promise<SyncConversation[]> {
    const page = pageId ?? this.cfg.pageId;
    const token = await this.pageToken(page);
    type Raw = {
      id: string;
      updated_time: string;
      participants?: { data: { id: string; name: string }[] };
      messages?: {
        data: { id: string; message?: string; from?: { id: string }; created_time: string; attachments?: { data: { mime_type?: string; image_data?: { url?: string } }[] } }[];
      };
      link?: string;
    };
    const raw = await this.getAll<Raw>(
      `/${page}/conversations`,
      { platform: "messenger", fields: "id,updated_time,link,participants,messages.limit(30){id,message,from,created_time,attachments{mime_type,image_data{url}}}", limit: 25 },
      limit,
      token,
      since ? (rows) => rows.some((c) => new Date(c.updated_time) <= since) : undefined,
    );
    return raw.map((c) => ({
      id: c.id,
      customerName: c.participants?.data.find((p) => p.id !== page)?.name ?? "Khách",
      psid: c.participants?.data.find((p) => p.id !== page)?.id ?? null,
      updatedTime: new Date(c.updated_time),
      sourceAdId: null,
      link: pageInboxUrl(page),
      messages: (c.messages?.data ?? [])
        .map((m) => {
          const att = m.attachments?.data ?? [];
          // Image / file-only messages: label them like the webhook does ("[Ảnh]"…) so messages aren't lost and content stays consistent.
          const text = m.message?.trim() || att.map((a) => attachmentLabel(a.mime_type)).join(" ");
          const imageUrls = att.flatMap((a) => (a.image_data?.url ? [a.image_data.url] : []));
          return { id: m.id, fromCustomer: m.from?.id !== page, text, createdTime: new Date(m.created_time), ...(imageUrls.length && { imageUrls }) };
        })
        .filter((m) => m.text)
        .reverse(),
    }));
  }

  async describeTargeting(adSet: EditableAdSet, resultType: string): Promise<string[]> {
    const targeting = await this.targeting(adSet, resultType, []);
    return this.sentences(`/${this.act}/targetingsentencelines`, { targeting_spec: targeting });
  }

  private async sentences(path: string, params: Record<string, unknown>) {
    type L = { content: string; children: string[] };
    const r = await this.request<{ targetingsentencelines?: L[] }>("GET", path, { ...params, locale: "vi_VN" });
    return (r.targetingsentencelines ?? []).map((l) => `${l.content} ${l.children.join("; ")}`);
  }

  /** Read back the just-created campaign / ad sets / ads and compare each item with the plan. */
  async verifyPublished(plan: EditablePlan, ids: PublishedIds): Promise<VerifyReport> {
    const sections: VerifySection[] = [];
    const tr = await getT();
    const chk = (label: string, expected: unknown, actual: unknown, ok = String(expected) === String(actual)): VerifyCheck => ({
      label,
      ok,
      expected: expected == null ? "—" : String(expected),
      actual: actual == null ? "—" : String(actual),
    });
    const money = (v: string | undefined) => (v ? Number(v) / this.offset : null);

    type C = { name: string; objective: string; status: string; daily_budget?: string; lifetime_budget?: string; bid_strategy?: string; spend_cap?: string };
    const c = await this.request<C>("GET", `/${ids.campaignId}`, { fields: "name,objective,status,daily_budget,lifetime_budget,bid_strategy,spend_cap" });
    const lifetime = plan.budget_period === "lifetime";
    const budgetLabel = tr(lifetime ? "targeting.graph.verify.budgetLifetime" : "targeting.graph.verify.budgetDaily");
    sections.push({
      level: "campaign",
      id: ids.campaignId,
      name: c.name,
      checks: [
        chk(tr("targeting.graph.verify.goal"), plan.objective, c.objective),
        chk(tr("targeting.graph.verify.paused"), "PAUSED", c.status),
        ...(plan.budget_mode === "CBO"
          ? [
              chk(tr("targeting.graph.verify.campaignBudget", { period: budgetLabel }), plan.campaign_daily_budget, money(lifetime ? c.lifetime_budget : c.daily_budget)),
              chk(tr("targeting.graph.verify.bidStrategy"), BID_API[plan.bid_strategy], c.bid_strategy),
            ]
          : []),
        ...(plan.spend_cap && plan.spend_cap > 0 ? [chk(tr("targeting.graph.verify.spendCap"), plan.spend_cap, money(c.spend_cap))] : []),
        chk(tr("targeting.graph.verify.adSetCount"), plan.ad_sets.length, ids.adSetIds.length),
        chk(tr("targeting.graph.verify.adCount"), plan.ads.length, ids.adIds.length),
      ],
    });

    type T = {
      age_min?: number;
      age_max?: number;
      age_range?: number[];
      genders?: number[];
      locales?: number[];
      geo_locations?: { countries?: string[]; regions?: { key: string }[]; cities?: { key: string; radius?: number }[]; subcities?: { key: string }[]; neighborhoods?: { key: string }[]; custom_locations?: { latitude: number; longitude: number; radius: number }[]; location_types?: string[] };
      flexible_spec?: Record<string, { id: string }[]>[];
      publisher_platforms?: string[];
      custom_audiences?: { id: string }[];
      excluded_custom_audiences?: { id: string }[];
      targeting_automation?: { advantage_audience?: number };
    };
    type S = {
      name: string;
      status: string;
      daily_budget?: string;
      lifetime_budget?: string;
      bid_strategy?: string;
      bid_amount?: number;
      optimization_goal: string;
      destination_type?: string;
      targeting: T;
    };
    for (const [i, id] of ids.adSetIds.entries()) {
      const p = plan.ad_sets[i];
      const s = await this.request<S>("GET", `/${id}`, { fields: "name,status,daily_budget,lifetime_budget,bid_strategy,bid_amount,optimization_goal,destination_type,targeting" });
      const expGoal = this.goalParams(plan.result_type, p);
      const t = s.targeting ?? {};
      const g = t.geo_locations ?? {};
      const pins = (g.custom_locations ?? []).map((x) => `${x.latitude.toFixed(4)},${x.longitude.toFixed(4)} +${x.radius}km`).sort().join(" | ");
      const expPins = p.custom_locations.map((x) => `${x.latitude.toFixed(4)},${x.longitude.toFixed(4)} +${x.radius_km}km`).sort().join(" | ");
      const expLocTypes = { home_recent: "home,recent", home: "home", recent: "recent" }[p.location_types];
      const detailedIds = (t.flexible_spec ?? []).flatMap((f) => Object.values(f).flat().map((x) => (typeof x === "object" ? x.id : String(x)))).sort().join(",");
      const expDetailed = [...p.detailed_targeting, ...p.narrow_targeting].map((d) => d.id).sort().join(",");
      const ids_ = (l?: { id: string }[]) => (l ?? []).map((x) => x.id).sort().join(",") || "—";
      const age = t.age_range ? `${t.age_range[0]}–${t.age_range[1]} ${tr("targeting.graph.verify.hint")}` : `${t.age_min}–${t.age_max}`;
      const expAge = p.advantage_audience && (p.age_min > 25 || p.age_max < 65) ? `${p.age_min}–${p.age_max} ${tr("targeting.graph.verify.hint")}` : `${p.age_min}–${p.age_max}`;
      const expGender = tr(p.genders === "all" ? "targeting.graph.verify.all" : p.genders === "male" ? "targeting.graph.verify.male" : "targeting.graph.verify.female");
      const gender = tr(!t.genders?.length ? "targeting.graph.verify.all" : t.genders[0] === 1 ? "targeting.graph.verify.male" : "targeting.graph.verify.female");
      sections.push({
        level: "adset",
        id,
        name: s.name,
        sentences: await this.sentences(`/${id}/targetingsentencelines`, {}).catch(() => []),
        checks: [
          chk(tr("targeting.graph.verify.paused"), "PAUSED", s.status),
          ...(plan.budget_mode === "ABO"
            ? [chk(tr("targeting.graph.verify.adSetBudget", { period: budgetLabel }), p.daily_budget, money(lifetime ? s.lifetime_budget : s.daily_budget)), chk(tr("targeting.graph.verify.bidStrategy"), BID_API[plan.bid_strategy], s.bid_strategy)]
            : []),
          ...(plan.bid_strategy !== "lowest_cost" ? [chk(tr("targeting.graph.verify.bidAmount"), plan.bid_amount, s.bid_amount != null ? s.bid_amount / this.offset : null)] : []),
          chk(tr("targeting.graph.verify.optimization"), expGoal.optimization_goal, s.optimization_goal),
          ...("destination_type" in expGoal ? [chk(tr("targeting.graph.verify.conversionLocation"), expGoal.destination_type, s.destination_type)] : []),
          ...(p.custom_locations.length ? [chk(tr("targeting.graph.verify.pins"), expPins, pins)] : []),
          chk(
            tr("targeting.graph.verify.areas"),
            p.locations.length || p.custom_locations.length ? [...p.locations.map((l) => l.key)].sort().join(",") : "VN",
            [...(g.countries ?? []), ...[...(g.regions ?? []), ...(g.cities ?? []), ...(g.subcities ?? []), ...(g.neighborhoods ?? [])].map((r) => r.key)].sort().join(","),
          ),
          ...(p.locations.some((l) => l.type === "city")
            ? [
                chk(
                  tr("targeting.graph.verify.cityRadius"),
                  p.locations.filter((l) => l.type === "city").map((l) => `${l.key}+${Math.min(80, Math.max(17, l.radius_km ?? 17))}`).sort().join(","),
                  (g.cities ?? []).map((c) => `${c.key}+${c.radius ?? "?"}`).sort().join(","),
                ),
              ]
            : []),
          chk(tr("targeting.graph.verify.locationTypes"), expLocTypes, (g.location_types ?? []).slice().sort().join(",")),
          chk(tr("targeting.graph.verify.localeCount"), p.locales.length, (t.locales ?? []).length),
          chk(tr("targeting.graph.verify.age"), expAge, age),
          chk(tr("targeting.graph.verify.gender"), expGender, gender),
          chk(tr("targeting.graph.verify.detailed"), expDetailed || "—", detailedIds || "—"),
          ...(p.custom_audiences.length || p.excluded_custom_audiences.length
            ? [
                chk(tr("targeting.graph.verify.customAudiences"), ids_(p.custom_audiences), ids_(t.custom_audiences)),
                chk(tr("targeting.graph.verify.excludedAudiences"), ids_(p.excluded_custom_audiences), ids_(t.excluded_custom_audiences)),
              ]
            : []),
          chk(tr("targeting.graph.verify.advantage"), p.advantage_audience ? tr("targeting.graph.verify.on") : tr("targeting.graph.verify.off"), t.targeting_automation?.advantage_audience === 1 ? tr("targeting.graph.verify.on") : tr("targeting.graph.verify.off")),
        ],
      });
    }

    type A = {
      name: string;
      status: string;
      creative?: {
        object_story_id?: string;
        effective_object_story_id?: string;
        image_hash?: string;
        object_story_spec?: { link_data?: { child_attachments?: unknown[]; page_welcome_message?: unknown; call_to_action?: { type?: string } } };
      };
    };
    for (const [i, id] of ids.adIds.entries()) {
      const p = plan.ads[ids.adPlanIndex[i]];
      const carousel = p ? isCarousel(p) : false;
      const a = await this.request<A>("GET", `/${id}`, {
        fields: `name,status,creative{object_story_id,effective_object_story_id,image_hash${carousel ? ",object_story_spec" : ""}}`,
      });
      const ld = a.creative?.object_story_spec?.link_data;
      const story = a.creative?.object_story_id ?? a.creative?.effective_object_story_id;
      sections.push({
        level: "ad",
        id,
        name: a.name,
        checks: [
          chk(tr("targeting.graph.verify.paused"), "PAUSED", a.status),
          p?.source === "existing"
            ? chk(tr("targeting.graph.verify.existingPost"), p.post_id, story)
            : chk(tr("targeting.graph.verify.creative"), tr("targeting.graph.verify.yes"), story || a.creative?.image_hash ? tr("targeting.graph.verify.yes") : tr("targeting.graph.verify.no")),
          ...(carousel && p
            ? [
                chk(tr("targeting.graph.verify.cardCount"), p.cards.length, ld?.child_attachments?.length ?? 0),
                ...(plan.result_type === "messages" && p.welcome?.greeting.trim() ? [chk(tr("targeting.graph.verify.welcome"), tr("targeting.graph.verify.yes"), ld?.page_welcome_message ? tr("targeting.graph.verify.yes") : tr("targeting.graph.verify.no"))] : []),
              ]
            : []),
        ],
      });
    }

    return { checkedAt: new Date().toISOString(), ok: sections.every((s) => s.checks.every((c) => c.ok)), sections };
  }

  async estimateAudience(adSet: EditableAdSet, resultType: string): Promise<AudienceEstimate> {
    const notes: string[] = [];
    const targeting = await this.targeting(adSet, resultType, notes);
    const { optimization_goal } = this.goalParams(resultType, adSet);
    try {
      type D = { estimate_mau_lower_bound?: number; estimate_mau_upper_bound?: number; estimate_dau?: number };
      const r = await this.request<{ data: D[] }>("GET", `/${this.act}/delivery_estimate`, {
        targeting_spec: targeting,
        optimization_goal,
        ...(["messages", "leads", "page_likes"].includes(resultType) && { promoted_object: { page_id: this.cfg.pageId } }),
      });
      const d = r.data[0] ?? {};
      if (d.estimate_mau_upper_bound != null) {
        return { lower: d.estimate_mau_lower_bound ?? null, upper: d.estimate_mau_upper_bound, daily: d.estimate_dau ?? null, notes };
      }
    } catch (err) {
      notes.push((await getT())("targeting.graph.deliveryEstimateError", { detail: err instanceof Error ? err.message : String(err) }));
    }
    // Fallback: the old estimate API, only needs targeting.
    const r = await this.request<{ data: { users_lower_bound?: number; users_upper_bound?: number } }>("GET", `/${this.act}/reachestimate`, { targeting_spec: targeting });
    return { lower: r.data.users_lower_bound ?? null, upper: r.data.users_upper_bound ?? null, daily: null, notes };
  }

  async listPosts(limit: number, pageId?: string): Promise<PagePost[]> {
    const page = pageId ?? this.cfg.pageId;
    const token = await this.pageToken(page);
    type Raw = { id: string; message?: string; full_picture?: string; permalink_url?: string; status_type?: string; created_time: string; is_eligible_for_promotion?: boolean };
    const raw = await this.getAll<Raw>(
      `/${page}/published_posts`,
      { fields: "id,message,full_picture,permalink_url,status_type,created_time,is_eligible_for_promotion", limit: 25 },
      limit,
      token,
    );
    return raw.map((p) => ({
      id: p.id,
      message: p.message ?? "",
      picture: p.full_picture ?? null,
      permalink: p.permalink_url?.startsWith("/") ? `https://www.facebook.com${p.permalink_url}` : (p.permalink_url ?? ""),
      type: p.status_type ?? "",
      created: p.created_time,
      eligible: p.is_eligible_for_promotion !== false,
    }));
  }

  async listVideos(limit: number, pageId?: string): Promise<PageVideo[]> {
    const page = pageId ?? this.cfg.pageId;
    const token = await this.pageToken(page);
    type Raw = { id: string; title?: string; description?: string; picture?: string; length?: number; created_time: string; permalink_url?: string; thumbnails?: { data: { uri: string; width: number; is_preferred?: boolean }[] } };
    const raw = await this.getAll<Raw>(
      `/${page}/videos`,
      { fields: "id,title,description,picture,length,created_time,permalink_url,thumbnails{uri,width,is_preferred}", limit: 25 },
      limit,
      token,
    );
    return raw.map((v) => {
      // Cover image: prefer the Page's chosen image, then the largest image ("picture" is only a small image).
      const thumbs = v.thumbnails?.data ?? [];
      const thumb = thumbs.find((t) => t.is_preferred) ?? [...thumbs].sort((a, b) => b.width - a.width)[0];
      return {
        id: v.id,
        title: v.title ?? "",
        description: v.description ?? "",
        picture: thumb?.uri ?? v.picture ?? null,
        length: v.length ?? null,
        created: v.created_time,
        permalink: v.permalink_url?.startsWith("/") ? `https://www.facebook.com${v.permalink_url}` : (v.permalink_url ?? ""),
      };
    });
  }

  /**
   * Facebook link → post id {pageId}_{postId}. Accepts: /posts/{id or pfbid}, permalink.php?story_fbid=&id=, /photo?fbid=, /photos/…/{id},
   * /videos/{id}, /reel/{id}, watch?v=, short links share/… (follows the redirect). Only accepts posts of the given Pages.
   */
  async resolvePostLink(link: string, pageIds: string[], hops = 0): Promise<string | null> {
    let url: URL;
    try {
      url = new URL(link.trim());
    } catch {
      return null;
    }
    // Short links (fb.watch, fb.me, facebook.com/share/…): read the real address from the redirect.
    // Only Facebook's own hosts are fetched (the link is user input), at most 3 hops, each re-checked by safeFetch.
    const fbHost = /(^|\.)(facebook\.com|fb\.watch|fb\.me)$/.test(url.hostname) && url.protocol === "https:";
    if (fbHost && (/fb\.(watch|me)$/.test(url.hostname) || /^\/share\//.test(url.pathname))) {
      if (hops >= 3) return null;
      const res = await safeFetch(url, { maxRedirects: 0, readBody: false, timeoutMs: 10_000 }).catch(() => null);
      const loc = res?.location;
      if (loc && !/login/.test(loc)) return this.resolvePostLink(new URL(loc, url).toString(), pageIds, hops + 1);
      return null;
    }
    const q = url.searchParams;
    const path = url.pathname;
    const ids: string[] = [];
    const storyFbid = q.get("story_fbid");
    if (storyFbid && q.get("id")) ids.push(`${q.get("id")}_${storyFbid}`);
    const objectId = path.match(/\/(?:posts|videos|reel|reels)\/(?:[^/]+\/)?(\d{6,})/)?.[1] ?? q.get("v") ?? q.get("fbid") ?? path.match(/\/photos\/[^/]+\/(\d{6,})/)?.[1] ?? null;
    if (objectId) {
      ids.push(...pageIds.map((p) => `${p}_${objectId}`));
      // Photo (page_story_id) / video, reel (post_id): ask Meta for the post containing it. Each type has only one of the two fields.
      const token = await this.pageToken(pageIds[0]);
      try {
        const r = await this.request<{ post_id?: string; from?: { id: string } }>("GET", `/${objectId}`, { fields: "post_id,from" }, token);
        if (r.post_id && r.from?.id) ids.unshift(r.post_id.includes("_") ? r.post_id : `${r.from.id}_${r.post_id}`);
      } catch {}
      try {
        const r = await this.request<{ page_story_id?: string }>("GET", `/${objectId}`, { fields: "page_story_id" }, token);
        if (r.page_story_id) ids.unshift(r.page_story_id);
      } catch {}
    }
    for (const id of ids) {
      if (!pageIds.includes(id.split("_")[0])) continue;
      try {
        const r = await this.request<{ id: string }>("GET", `/${id}`, { fields: "id" }, await this.pageToken(id.split("_")[0]));
        if (r.id) return r.id;
      } catch {}
    }
    // pfbid… or other forms: compare against links of recent posts.
    const pfbid = path.match(/(pfbid\w+)/)?.[1];
    const norm = (u: string) => u.replace(/^https?:\/\/(www\.|m\.|web\.)?facebook\.com/, "").replace(/[?#].*$/, "").replace(/\/$/, "");
    for (const page of pageIds) {
      const posts = await this.listPosts(200, page).catch(() => []);
      const hit = posts.find((p) => (pfbid && p.permalink.includes(pfbid)) || norm(p.permalink) === norm(url.toString()));
      if (hit) return hit.id;
    }
    return null;
  }

  async postDetail(postId: string, maxImages = 6): Promise<PostDetail> {
    const pageId = postId.split("_")[0];
    const token = await this.pageToken(pageId);
    type Media = { media?: { image?: { src?: string } }; media_type?: string; type?: string; target?: { id?: string }; title?: string };
    type Raw = {
      id: string;
      message?: string;
      full_picture?: string;
      permalink_url?: string;
      status_type?: string;
      created_time: string;
      is_eligible_for_promotion?: boolean;
      shares?: { count?: number };
      reactions?: { summary?: { total_count?: number } };
      comments?: { summary?: { total_count?: number } };
      attachments?: { data: (Media & { subattachments?: { data: Media[] } })[] };
    };
    const base = "id,message,full_picture,permalink_url,status_type,created_time,is_eligible_for_promotion,shares,attachments{media,media_type,type,target,title,subattachments{media,media_type,type,target}}";
    let p: Raw;
    let counted = true;
    try {
      p = await this.request<Raw>("GET", `/${postId}`, { fields: `${base},reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)` }, token);
    } catch {
      counted = false; // missing pages_read_user_content permission: posts are still readable, without reaction / comment counts
      p = await this.request<Raw>("GET", `/${postId}`, { fields: base }, token);
    }
    const att = p.attachments?.data ?? [];
    const all = att.flatMap((a) => [a, ...(a.subattachments?.data ?? [])]);
    // Album posts: only take photos in the album (main image / full_picture is a copy of the first photo with a different link, so it can't be deduplicated).
    const subs = att.flatMap((a) => a.subattachments?.data ?? []);
    const sources = subs.length ? subs.map((a) => a.media?.image?.src) : [p.full_picture, ...att.map((a) => a.media?.image?.src)];
    const images = [...new Set(sources.filter((x): x is string => !!x))].slice(0, maxImages);
    const v = all.find((a) => /video/.test(a.media_type ?? a.type ?? ""));
    let video: PostDetail["video"] = null;
    if (v?.target?.id) {
      const frames: string[] = [];
      let seconds: number | null = null;
      try {
        const t = await this.request<{ data: { uri: string }[] }>("GET", `/${v.target.id}/thumbnails`, { fields: "uri" }, token);
        frames.push(...t.data.map((x) => x.uri));
        const info = await this.request<{ length?: number }>("GET", `/${v.target.id}`, { fields: "length" }, token);
        seconds = info.length ?? null;
      } catch {}
      video = { id: v.target.id, frames: frames.slice(0, 8), seconds, title: v.title ?? "" };
    }
    return {
      id: p.id,
      pageId,
      message: p.message ?? "",
      permalink: p.permalink_url?.startsWith("/") ? `https://www.facebook.com${p.permalink_url}` : (p.permalink_url ?? ""),
      type: p.status_type ?? "",
      created: p.created_time,
      images,
      video,
      eligible: p.is_eligible_for_promotion !== false,
      reactions: counted ? (p.reactions?.summary?.total_count ?? 0) : null,
      comments: counted ? (p.comments?.summary?.total_count ?? 0) : null,
      shares: p.shares?.count ?? 0,
    };
  }

  async adReviews(adIds: string[]): Promise<AdReview[]> {
    type Raw = { id: string; name: string; effective_status: string; ad_review_feedback?: { global?: Record<string, string>; placement_specific?: Record<string, Record<string, string>> }; issues_info?: { error_summary?: string; error_message?: string }[] };
    const out: AdReview[] = [];
    for (const id of adIds) {
      const r = await this.request<Raw>("GET", `/${id}`, { fields: "id,name,effective_status,ad_review_feedback,issues_info" });
      const fb = r.ad_review_feedback;
      out.push({
        id: r.id,
        name: r.name,
        status: r.effective_status,
        feedback: [
          ...Object.entries(fb?.global ?? {}).map(([k, v]) => `${k}: ${v}`),
          ...Object.entries(fb?.placement_specific ?? {}).flatMap(([pl, m]) => Object.entries(m).map(([k, v]) => `${pl} · ${k}: ${v}`)),
          ...(r.issues_info ?? []).map((i) => [i.error_summary, i.error_message].filter(Boolean).join(": ")),
        ],
      });
    }
    return out;
  }

  async fetchPageActivity(opts: { posts: number; commentPosts: number; commentsPerPost: number }, pageId?: string) {
    const page = pageId ?? this.cfg.pageId;
    const token = await this.pageToken(page);
    type Count = { summary?: { total_count?: number } };
    type Raw = {
      id: string;
      message?: string;
      full_picture?: string;
      permalink_url?: string;
      status_type?: string;
      created_time: string;
      shares?: { count?: number };
      reactions?: Count;
      comments?: Count;
    };
    // Counting reactions / comments and reading comments requires pages_read_user_content.
    // Token lacks this permission: still fetch the post list (without engagement metrics) and report back so the user adds the permission.
    const base = "id,message,full_picture,permalink_url,status_type,created_time,shares";
    let missingPermission: string | undefined;
    let raw: Raw[];
    try {
      raw = await this.getAll<Raw>(
        `/${page}/published_posts`,
        { fields: `${base},reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)`, limit: 25 },
        opts.posts,
        token,
      );
    } catch (err) {
      if (!(err instanceof MetaApiError) || !(err.code === 10 || /pages_read_user_content/.test(err.message))) throw err;
      missingPermission = "pages_read_user_content";
      raw = await this.getAll<Raw>(`/${page}/published_posts`, { fields: base, limit: 25 }, opts.posts, token);
    }
    const posts = raw.map((p) => ({
      id: p.id,
      message: p.message ?? "",
      type: p.status_type ?? "",
      permalink: p.permalink_url?.startsWith("/") ? `https://www.facebook.com${p.permalink_url}` : (p.permalink_url ?? ""),
      picture: p.full_picture ?? null,
      createdTime: new Date(p.created_time),
      reactions: p.reactions?.summary?.total_count ?? 0,
      comments: p.comments?.summary?.total_count ?? 0,
      shares: p.shares?.count ?? 0,
    }));
    // Comments on the most-commented posts (commenter names are not stored).
    type RawC = { id: string; message?: string; created_time: string; like_count?: number; from?: { id: string } };
    const comments: SyncComment[] = [];
    for (const p of missingPermission ? [] : [...posts].sort((a, b) => b.comments - a.comments).filter((p) => p.comments > 0).slice(0, opts.commentPosts)) {
      const list = await this.getAll<RawC>(
        `/${p.id}/comments`,
        { fields: "id,message,created_time,like_count,from", filter: "toplevel", order: "reverse_chronological", limit: 50 },
        opts.commentsPerPost,
        token,
      ).catch(() => [] as RawC[]);
      for (const c of list) {
        if (!c.message) continue;
        comments.push({ id: c.id, postId: p.id, message: c.message, createdTime: new Date(c.created_time), likes: c.like_count ?? 0, fromPage: c.from?.id === page });
      }
    }
    return { posts, comments, missingPermission };
  }

  /** Range [days ago, yesterday] in the client's timezone, as an Insights API time_range. */
  private range(days: number) {
    return { since: this.dayAgo(days), until: this.dayAgo(1) };
  }

  /** The date `days` days (and `months` months) from today in the client's timezone, as YYYY-MM-DD. */
  private dayAgo(days: number, months = 0) {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: this.cfg.timezone }).format(new Date());
    const [y, m, d] = today.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1 - months, d - days)).toISOString().slice(0, 10);
  }

  /**
   * Report period and the preceding period for comparison. N days: up to yesterday (finalized numbers).
   * Today: live numbers, compared with yesterday. All time: last 36 months (Insights only keeps ~37 months), no previous period.
   */
  private reportRanges(period: ReportPeriod) {
    if (period === "today") {
      const t = this.dayAgo(0);
      const y = this.dayAgo(1);
      return { range: { since: t, until: t }, prevRange: { since: y, until: y } };
    }
    if (period === "lifetime") return { range: { since: this.dayAgo(-1, 36), until: this.dayAgo(0) }, prevRange: { since: "", until: "" } };
    const range = this.range(period);
    return { range, prevRange: { since: this.dayAgo(period * 2), until: this.dayAgo(period + 1) } };
  }

  async fetchBreakdowns(days: number) {
    const filter = await this.scopeFilter();
    if (!filter) return [];
    const dims: [SyncBreakdown["dimension"], string][] = [
      ["age_gender", "age,gender"],
      ["region", "region"],
      ["platform", "publisher_platform"],
    ];
    const out: SyncBreakdown[] = [];
    // For location breakdowns, Meta doesn't return "conversations started", only "messaging connections". In that case the result is estimated
    // = connections × (started / connections ratio measured in the age-gender table), and flagged as an estimate.
    const CONN = ["onsite_conversion.total_messaging_connection"];
    let started = 0;
    let conns = 0;
    for (const [dimension, breakdowns] of dims) {
      type Row = InsightRow & { age?: string; gender?: string; region?: string; publisher_platform?: string };
      const rows = await this.getAll<Row>(`/${this.act}/insights`, {
        level: "account",
        time_range: this.range(days),
        breakdowns,
        ...filter,
        fields: "spend,impressions,reach,clicks,inline_link_clicks,actions,video_thruplay_watched_actions",
        limit: 500,
      });
      const metrics = rows.map((r) => ({ r, m: toMetrics(r, this.cfg.primaryResult), conn: pickAction(r.actions, CONN) }));
      if (dimension === "age_gender")
        for (const x of metrics) {
          started += x.m.results;
          conns += x.conn;
        }
      const estimate = this.cfg.primaryResult === "messages" && dimension !== "age_gender" && conns > 0 && !metrics.some((x) => x.m.results > 0) && metrics.some((x) => x.conn > 0);
      for (const { r, m, conn } of metrics) {
        const key = dimension === "age_gender" ? `${r.age}|${r.gender}` : dimension === "region" ? (r.region ?? "?") : (r.publisher_platform ?? "?");
        const results = estimate ? Math.round(conn * Math.min(1, started / conns) * 10) / 10 : m.results;
        out.push({ dimension, key, spend: m.spend, impressions: m.impressions, reach: m.reach, clicks: m.clicks, results, estimated: estimate });
      }
    }
    return out;
  }

  async listLeadForms(pageId?: string): Promise<LeadForm[]> {
    const page = pageId ?? this.cfg.pageId;
    const token = await this.pageToken(page);
    type Raw = { id: string; name: string; status: string; created_time: string; leads_count?: number; questions?: { type: string; label?: string }[] };
    const raw = await this.getAll<Raw>(`/${page}/leadgen_forms`, { fields: "id,name,status,created_time,leads_count,questions", limit: 50 }, 200, token);
    return raw.map(toLeadForm);
  }

  async createLeadForm(f: LeadFormInput, pageId?: string): Promise<LeadForm> {
    const page = pageId ?? this.cfg.pageId;
    const token = await this.pageToken(page);
    let n = 0;
    const questions = f.questions.map((q) =>
      q.type === "CUSTOM"
        ? { type: "CUSTOM", key: `q${++n}`, label: q.label, ...(q.options?.length && { options: q.options.map((value, i) => ({ key: `q${n}_${i + 1}`, value })) }) }
        : { type: q.type },
    );
    const thank_you_page = {
      title: f.thanksTitle,
      body: f.thanksBody,
      button_type: f.thanksButton,
      ...(f.thanksButton === "VIEW_WEBSITE" && { website_url: f.websiteUrl, button_text: "Xem website" }),
      ...(f.thanksButton === "CALL_BUSINESS" && { business_phone_number: f.phone, button_text: "Gọi ngay" }),
      ...(f.thanksButton === "MESSAGE_BUSINESS" && { button_text: "Nhắn tin" }),
    };
    const r = await this.request<{ id: string }>(
      "POST",
      `/${page}/leadgen_forms`,
      {
        name: f.name,
        locale: "vi_VN",
        questions,
        privacy_policy: { url: f.privacyUrl, link_text: f.privacyText || "Chính sách quyền riêng tư" },
        follow_up_action_url: f.websiteUrl || f.privacyUrl,
        thank_you_page,
        is_optimized_for_quality: f.higherIntent,
        ...(f.introTitle.trim() && { context_card: { title: f.introTitle, style: "PARAGRAPH_STYLE", content: [f.introText || f.introTitle] } }),
      },
      token,
    );
    return { id: r.id, name: f.name, status: "ACTIVE", created: new Date().toISOString(), leads: 0, questions: f.questions.map((q) => q.label ?? q.type) };
  }

  // ------------------------------------------------ Optimizing running campaigns (phase 3)

  async fetchOptimizeSnapshot(campaignId: string): Promise<OptimizeSnapshot | null> {
    return (await this.fetchOptimizeSnapshots([campaignId]))[0] ?? null;
  }

  /** Optimization metrics for many campaigns in one pass (calls Meta at account level, filtered by campaign: ~11 calls instead of 8 per campaign). */
  async fetchOptimizeSnapshots(campaignIds: string[]): Promise<OptimizeSnapshot[]> {
    if (!campaignIds.length) return [];
    type C = { id: string; name: string; effective_status: string; objective: string; daily_budget?: string; lifetime_budget?: string; bid_strategy?: string };
    type S = {
      id: string;
      name: string;
      campaign_id: string;
      effective_status: string;
      created_time: string;
      daily_budget?: string;
      learning_stage_info?: { status?: string };
      targeting?: unknown;
      optimization_goal?: string;
      destination_type?: string;
    };
    type A = { id: string; name: string; adset_id: string; campaign_id: string; effective_status: string; created_time: string; creative?: { object_story_spec?: unknown } };
    const filtering = [{ field: "campaign.id", operator: "IN", value: campaignIds }];
    // Don't use the "ids" param (Meta dropped it in newer API versions): filter on the account's campaign list.
    const camps = await this.getAll<C>(`/${this.act}/campaigns`, {
      fields: "id,name,effective_status,objective,daily_budget,lifetime_budget,bid_strategy",
      filtering: [{ field: "id", operator: "IN", value: campaignIds }],
      limit: 200,
    });
    const [sets, ads] = await Promise.all([
      this.getAll<S>(`/${this.act}/adsets`, { fields: "id,name,campaign_id,effective_status,created_time,daily_budget,learning_stage_info,targeting,optimization_goal,destination_type", filtering, limit: 200 }),
      this.getAll<A>(`/${this.act}/ads`, { fields: "id,name,adset_id,campaign_id,effective_status,created_time,creative{object_story_spec}", filtering, limit: 200 }),
    ]);
    const fields = "campaign_id,spend,impressions,reach,clicks,inline_link_clicks,actions,video_thruplay_watched_actions";
    type Row = InsightRow & { age?: string; gender?: string; publisher_platform?: string };
    // Includes today (Meta's date_preset last_7d stops at yesterday): campaigns that started today still have numbers for early cuts / budget increases.
    const days = (n: number) => ({ since: this.dayAgo(n - 1), until: this.dayAgo(0) });
    const ins = (level: "adset" | "ad" | "campaign", time_range: { since: string; until: string }, breakdowns?: string) =>
      this.getAll<Row>(`/${this.act}/insights`, { level, time_range, filtering, fields: `${level === "ad" ? "ad_id,adset_id," : level === "adset" ? "adset_id," : ""}${fields}`, ...(breakdowns && { breakdowns }), limit: 500 }).catch((err) => {
        if (breakdowns) return [] as Row[]; // breakdown metrics are secondary: ignore errors
        throw err;
      });
    const [s3, s7, a3, a7, c7, s1, c1, sAge, sGender, sPlat] = await Promise.all([
      ins("adset", days(3)),
      ins("adset", days(7)),
      ins("ad", days(3)),
      ins("ad", days(7)),
      ins("campaign", days(7)),
      ins("adset", days(1)),
      ins("campaign", days(1)),
      ins("adset", days(7), "age"),
      ins("adset", days(7), "gender"),
      ins("adset", days(7), "publisher_platform"),
    ]);
    const by = (rows: Row[], k: "adset_id" | "ad_id" | "campaign_id") => new Map(rows.map((r) => [r[k]!, r]));
    const [ms3, ms7, ma3, ma7, mc7, ms1, mc1] = [by(s3, "adset_id"), by(s7, "adset_id"), by(a3, "ad_id"), by(a7, "ad_id"), by(c7, "campaign_id"), by(s1, "adset_id"), by(c1, "campaign_id")];
    return camps.map((c) => {
      const cSets = sets.filter((x) => x.campaign_id === c.id);
      const rt = resultTypeFor(c.objective, cSets[0]?.optimization_goal ?? "", cSets[0]?.destination_type ?? "", this.cfg.primaryResult);
      const pm = (r?: InsightRow): PeriodMetrics => {
        const m = toMetrics(r, rt);
        return { spend: m.spend, impressions: m.impressions, reach: m.reach, clicks: m.clicks, results: m.results };
      };
      const setIds = new Set(cSets.map((x) => x.id));
      const segs = (rows: Row[], dim: "age" | "gender" | "platform", key: (r: Row) => string | undefined) =>
        rows.filter((r) => setIds.has(r.adset_id!)).map((r) => ({ adSetId: r.adset_id!, dim, key: key(r) ?? "?", m7: pm(r) }));
      return {
        campaign: { id: c.id, name: c.name, status: c.effective_status, dailyBudget: this.budget(c.daily_budget), lifetimeBudget: this.budget(c.lifetime_budget), bidStrategy: c.bid_strategy ?? null, m7: pm(mc7.get(c.id)), today: pm(mc1.get(c.id)) },
        adSets: cSets.map((s) => ({
          id: s.id,
          name: s.name,
          status: s.effective_status,
          createdTime: s.created_time,
          dailyBudget: this.budget(s.daily_budget),
          learning: s.learning_stage_info?.status ?? null,
          targeting: JSON.stringify(s.targeting ?? {}),
          m3: pm(ms3.get(s.id)),
          m7: pm(ms7.get(s.id)),
          today: pm(ms1.get(s.id)),
        })),
        ads: ads
          .filter((a) => a.campaign_id === c.id)
          .map((a) => ({ id: a.id, name: a.name, adSetId: a.adset_id, status: a.effective_status, createdTime: a.created_time, storySpec: !!a.creative?.object_story_spec, m3: pm(ma3.get(a.id)), m7: pm(ma7.get(a.id)) })),
        segments: [...segs(sAge, "age", (r) => r.age), ...segs(sGender, "gender", (r) => r.gender), ...segs(sPlat, "platform", (r) => r.publisher_platform)],
      };
    });
  }

  async metricsSince(level: Level, id: string, since: string, resultType: string): Promise<PeriodMetrics> {
    const until = this.range(1).until;
    if (since > until) return { spend: 0, impressions: 0, reach: 0, clicks: 0, results: 0 };
    const r = await this.request<{ data: InsightRow[] }>("GET", `/${id}/insights`, {
      time_range: { since, until },
      fields: "spend,impressions,reach,clicks,inline_link_clicks,actions,video_thruplay_watched_actions",
      level,
    });
    const m = toMetrics(r.data[0], resultType);
    return { spend: m.spend, impressions: m.impressions, reach: m.reach, clicks: m.clicks, results: m.results };
  }

  async fetchLiftInsights(level: "campaign" | "ad", id: string, since: string, until: string): Promise<LiftInsights> {
    type Row = { ad_id?: string; ad_name?: string; spend?: string; actions?: ActionList; date_start?: string };
    type RawAd = { id: string; name: string; effective_status?: string; creative?: { effective_object_story_id?: string; object_story_id?: string } };
    const time_range = { since, until };
    const adFields = "id,name,effective_status,creative{effective_object_story_id,object_story_id}";
    const [rows, days, list] = await Promise.all([
      this.getAll<Row>(`/${id}/insights`, { level: "ad", time_range, fields: "ad_id,ad_name,spend,actions", limit: 500 }),
      this.getAll<Row>(`/${id}/insights`, { time_range, time_increment: 1, fields: "spend", limit: 500 }),
      level === "ad" ? this.request<RawAd>("GET", `/${id}`, { fields: adFields }).then((a) => [a]) : this.getAll<RawAd>(`/${id}/ads`, { fields: adFields, limit: 200 }),
    ]);
    const byAd = new Map(rows.map((r) => [r.ad_id!, r]));
    const ads = list.map((a) => {
      const r = byAd.get(a.id);
      return {
        id: a.id,
        name: a.name,
        status: a.effective_status ?? "",
        spend: Number(r?.spend ?? 0),
        comments: pickAction(r?.actions, ["comment"]),
        postId: a.creative?.effective_object_story_id ?? a.creative?.object_story_id ?? null,
      };
    });
    // Ads deleted from the list but still with metrics in the period.
    for (const r of rows) if (!list.some((a) => a.id === r.ad_id)) ads.push({ id: r.ad_id!, name: r.ad_name ?? r.ad_id!, status: "DELETED", spend: Number(r.spend ?? 0), comments: pickAction(r.actions, ["comment"]), postId: null });
    return {
      spend: ads.reduce((s, a) => s + a.spend, 0),
      comments: ads.reduce((s, a) => s + a.comments, 0),
      daily: days.map((d) => ({ date: d.date_start!, spend: Number(d.spend ?? 0) })).sort((a, b) => a.date.localeCompare(b.date)),
      ads,
    };
  }

  async fetchPostComments(postId: string, since: Date, max = 3000): Promise<SyncComment[]> {
    const page = postId.split("_")[0];
    const token = await this.pageToken(page);
    type RawC = { id: string; message?: string; created_time: string; like_count?: number; from?: { id: string } };
    const list = await this.getAll<RawC>(
      `/${postId}/comments`,
      { fields: "id,message,created_time,like_count,from", filter: "toplevel", order: "reverse_chronological", limit: 100 },
      max,
      token,
      (rows) => !!rows.length && new Date(rows.at(-1)!.created_time) < since,
    );
    return list
      .filter((c) => c.message && new Date(c.created_time) >= since)
      .map((c) => ({ id: c.id, postId, message: c.message!, createdTime: new Date(c.created_time), likes: c.like_count ?? 0, fromPage: c.from?.id === page }));
  }

  async updateAdSetTargeting(adSetId: string, patch: TargetingPatch, validateOnly = false) {
    const src = await this.request<{ targeting?: Record<string, unknown> }>("GET", `/${adSetId}`, { fields: "targeting" });
    const t = applyTargetingPatch(src.targeting ?? {}, patch);
    delete t.targeting_optimization;
    // validateOnly: Meta only validates, changes nothing (e.g. campaigns created via guided flows lock audience edits on old ad sets).
    await this.request("POST", `/${adSetId}`, { targeting: t, ...(validateOnly && { execution_options: ["validate_only"] }) });
    return t;
  }

  async duplicateAdSet(adSetId: string, opts: DuplicateOpts): Promise<string> {
    // Create a new ad set from the original's settings (not /copies: Meta refuses to copy deprecated fields like targeting_optimization),
    // always PAUSED; then copy up to 3 running ads over.
    type Src = {
      campaign_id: string;
      daily_budget?: string;
      lifetime_budget?: string;
      end_time?: string;
      bid_strategy?: string;
      bid_amount?: number;
      billing_event?: string;
      optimization_goal?: string;
      destination_type?: string;
      promoted_object?: unknown;
      targeting?: Record<string, unknown>;
      is_dynamic_creative?: boolean;
    };
    const src = await this.request<Src>("GET", `/${adSetId}`, {
      fields: "campaign_id,daily_budget,lifetime_budget,end_time,bid_strategy,bid_amount,billing_event,optimization_goal,destination_type,promoted_object,targeting,is_dynamic_creative",
    });
    const t: Record<string, unknown> = { ...(src.targeting ?? {}) };
    delete t.targeting_optimization;
    if (opts.detailedTargeting) {
      const fs = toFlexibleSpec(opts.detailedTargeting);
      if (fs) t.flexible_spec = fs;
      else delete t.flexible_spec;
    }
    if (opts.advantageAudience != null) t.targeting_automation = { advantage_audience: opts.advantageAudience ? 1 : 0 };
    // Advantage+ off: the suggested age (age_range) is meaningless, the real age is age_min / age_max.
    if (opts.advantageAudience === false) delete t.age_range;
    // Remove the waste: publisher platforms (switch to manual placements), gender, age.
    if (opts.excludePlatforms?.length) {
      const all = ["facebook", "instagram", "messenger", "audience_network"];
      const cur = (t.publisher_platforms as string[] | undefined) ?? all;
      const keep = cur.filter((p) => !opts.excludePlatforms!.includes(p));
      if (!keep.length) throw new MetaApiError((await getT())("targeting.graph.cannotRemoveAllPlatforms"));
      t.publisher_platforms = keep;
      for (const p of opts.excludePlatforms) delete t[`${p}_positions`];
    }
    if (opts.genders?.length) t.genders = opts.genders;
    if (opts.ageMin) t.age_min = opts.ageMin;
    if (opts.ageMax) t.age_max = opts.ageMax;
    if (opts.ageRange) t.age_range = opts.ageRange;
    if (opts.locales) {
      if (opts.locales.length) t.locales = opts.locales;
      else delete t.locales;
    }
    const budget =
      opts.dailyBudget && opts.dailyBudget > 0
        ? { daily_budget: Math.round(opts.dailyBudget * this.offset) }
        : src.daily_budget
          ? { daily_budget: src.daily_budget }
          : src.lifetime_budget
            ? { lifetime_budget: src.lifetime_budget, end_time: src.end_time }
            : {}; // budget at campaign level (CBO)
    const created = await this.request<{ id: string }>("POST", `/${this.act}/adsets`, {
      name: opts.name,
      campaign_id: src.campaign_id,
      status: "PAUSED",
      targeting: t,
      ...budget,
      ...(src.bid_strategy && { bid_strategy: src.bid_strategy }),
      ...(src.bid_amount && { bid_amount: src.bid_amount }),
      ...(src.billing_event && { billing_event: src.billing_event }),
      ...(src.optimization_goal && { optimization_goal: src.optimization_goal }),
      ...(src.destination_type && { destination_type: src.destination_type }),
      ...(src.promoted_object ? { promoted_object: src.promoted_object } : {}),
      ...(src.is_dynamic_creative && { is_dynamic_creative: true }),
    });
    const newId = created.id;
    try {
      type A = { id: string; effective_status: string };
      const ads = (await this.getAll<A>(`/${adSetId}/ads`, { fields: "id,effective_status", limit: 50 })).filter((x) => x.effective_status === "ACTIVE").slice(0, 3);
      for (const x of ads) await this.request("POST", `/${x.id}/copies`, { adset_id: newId, status_option: "PAUSED" });
    } catch (err) {
      // Mid-way error: delete the just-created ad set (paused, nothing spent) so nothing half-done is left.
      await this.request("DELETE", `/${newId}`).catch(() => {});
      throw err;
    }
    return newId;
  }

  async addAdFromTemplate(adSetId: string, templateAdId: string, name: string, v: AdVariant): Promise<string> {
    type Spec = Record<string, unknown> & { link_data?: Record<string, unknown>; photo_data?: Record<string, unknown>; video_data?: Record<string, unknown> };
    const t = await this.request<{ creative?: { object_story_spec?: Spec } }>("GET", `/${templateAdId}`, { fields: "creative{object_story_spec}" });
    const spec = t.creative?.object_story_spec;
    if (!spec) throw new MetaApiError((await getT())("targeting.graph.templateExistingPost"));
    const next: Spec = JSON.parse(JSON.stringify(spec));
    if (next.link_data) {
      next.link_data.message = v.primary_text;
      if (v.headline) next.link_data.name = v.headline;
      if (v.description) next.link_data.description = v.description;
      if (next.link_data.image_hash) delete next.link_data.picture; // Meta doesn't accept both
    } else if (next.photo_data) {
      next.photo_data.caption = v.primary_text;
      if (next.photo_data.image_hash) delete next.photo_data.url;
    } else if (next.video_data) {
      next.video_data.message = v.primary_text;
      if (v.headline) next.video_data.title = v.headline;
      if (v.description) next.video_data.link_description = v.description;
      if (next.video_data.image_hash) delete next.video_data.image_url;
    } else {
      throw new MetaApiError((await getT())("targeting.graph.templateUnsupported"));
    }
    const creative = await this.request<{ id: string }>("POST", `/${this.act}/adcreatives`, { name: `${name} - creative`, object_story_spec: next });
    try {
      const ad = await this.request<{ id: string }>("POST", `/${this.act}/ads`, { name, adset_id: adSetId, creative: { creative_id: creative.id }, status: "PAUSED" });
      return ad.id;
    } catch (err) {
      await this.request("DELETE", `/${creative.id}`).catch(() => {});
      throw err;
    }
  }

  async fetchLeads(days: number, pageId?: string): Promise<{ leads: SyncLead[]; forms: number }> {
    const page = pageId ?? this.cfg.pageId;
    const token = await this.pageToken(page);
    const since = Math.floor(Date.now() / 1000) - Math.min(90, days) * 86400;
    const forms = await this.getAll<{ id: string; name: string; questions?: RawFormQuestion[] }>(`/${page}/leadgen_forms`, { fields: "id,name,questions", limit: 100 }, 500, token);
    const leads: SyncLead[] = [];
    for (const f of forms) {
      const raw = await this.getAll<RawLead>(
        `/${f.id}/leads`,
        { fields: "id,created_time,ad_id,ad_name,campaign_id,campaign_name,field_data,platform,is_organic", filtering: [{ field: "time_created", operator: "GREATER_THAN", value: since }], limit: 100 },
        5000,
        token,
      );
      for (const l of raw) leads.push(parseLead(l, f));
    }
    return { leads, forms: forms.length };
  }

  // ------------------------------------------------ Winning / losing ad creatives

  async fetchCampaignReport(period: ReportPeriod): Promise<CampaignReportData> {
    const filter = await this.scopeFilter();
    const { range, prevRange } = this.reportRanges(period);
    const empty: CampaignReportData = { range, prevRange, campaigns: [], adSets: [], ads: [], daily: [], segments: [], prevOther: [] };
    if (!filter) return empty;
    type C = { id: string; name: string; effective_status: string; objective: string; daily_budget?: string; lifetime_budget?: string };
    type S = { id: string; name: string; campaign_id: string; effective_status: string; daily_budget?: string; optimization_goal?: string; destination_type?: string };
    type Row = InsightRow & { campaign_id?: string; adset_id?: string; adset_name?: string; ad_id?: string; ad_name?: string; date_start?: string; age?: string; gender?: string; publisher_platform?: string };
    const fields = "campaign_id,spend,impressions,reach,clicks,inline_link_clicks,actions,action_values,video_thruplay_watched_actions";
    const ins = (level: "campaign" | "adset" | "ad", time_range: { since: string; until: string }, extra: Record<string, unknown> = {}) =>
      this.getAll<Row>(`/${this.act}/insights`, {
        level,
        time_range,
        fields: `${level === "ad" ? "ad_id,ad_name,adset_id," : level === "adset" ? "adset_id,adset_name," : ""}${fields}`,
        limit: 500,
        ...filter,
        ...extra,
      });
    const seg = (breakdowns: string) => ins("campaign", range, { breakdowns }).catch(() => [] as Row[]); // secondary: ignore errors
    // Call sequentially (not in parallel) and batch calls: accounts with low API access tiers hit call limits easily.
    // Campaign period totals summed from daily metrics; age + gender fetched in one call.
    // All time: aggregate by month (daily over 36 months makes Meta return "unknown error").
    const daily = await ins("campaign", range, { time_increment: period === "lifetime" ? "monthly" : 1 });
    const cPrev = prevRange.since ? await ins("campaign", prevRange) : [];
    const sNow = await ins("adset", range);
    const aNow = await ins("ad", range);
    const sAgeGender = await seg("age,gender");
    const sPlat = await seg("publisher_platform");
    const { keep } = await this.scope();
    const all = await this.getAll<C>(`/${this.act}/campaigns`, { fields: "id,name,effective_status,objective,daily_budget,lifetime_budget", limit: 200 });
    const spentIds = new Set(daily.map((r) => r.campaign_id!));
    // Campaigns with spend in the period + active campaigns (possibly no spend yet).
    const camps = all.filter((c) => spentIds.has(c.id) || (c.effective_status === "ACTIVE" && (!keep || keep.has(c.id))));
    if (!camps.length) return empty;
    const sets = await this.getAll<S>(`/${this.act}/adsets`, {
      fields: "id,name,campaign_id,effective_status,daily_budget,optimization_goal,destination_type",
      filtering: [{ field: "campaign.id", operator: "IN", value: camps.map((c) => c.id) }],
      limit: 500,
    });
    const rt = new Map(
      camps.map((c) => {
        const s = sets.find((x) => x.campaign_id === c.id);
        return [c.id, resultTypeFor(c.objective, s?.optimization_goal ?? "", s?.destination_type ?? "", this.cfg.primaryResult)];
      }),
    );
    const rm = (r: Row | undefined, campaignId: string, type = rt.get(campaignId) ?? this.cfg.primaryResult): ReportMetrics => {
      const m = toMetrics(r, type);
      return {
        spend: m.spend,
        impressions: m.impressions,
        reach: m.reach,
        clicks: m.clicks,
        results: m.results,
        revenue: m.revenue,
        plays3s: pickAction(r?.actions, ["video_view"]),
        thruplays: pickAction(r?.video_thruplay_watched_actions, ["video_view"]),
      };
    };
    const mPrev = new Map(cPrev.map((r) => [r.campaign_id!, r]));
    const dailyRows = daily.map((r) => ({ date: r.date_start!, campaignId: r.campaign_id!, m: rm(r, r.campaign_id!), msgs: pickAction(r.actions, RESULT_ACTIONS.messages) }));
    const mNow = new Map<string, ReportMetrics>();
    for (const d of dailyRows) {
      const x = mNow.get(d.campaignId) ?? { spend: 0, impressions: 0, reach: 0, clicks: 0, results: 0, revenue: 0, plays3s: 0, thruplays: 0 };
      for (const k of ["spend", "impressions", "clicks", "results", "revenue", "plays3s", "thruplays"] as const) x[k] += d.m[k];
      mNow.set(d.campaignId, x);
    }
    // Reach can't be summed across days: take the total reach of ad sets (approximate, may double-count people across ad sets).
    for (const r of sNow) {
      const x = mNow.get(r.campaign_id!);
      if (x) x.reach += Number(r.reach) || 0;
    }
    const setInfo = new Map(sets.map((s) => [s.id, s]));
    const segs = (rows: Row[], dim: "age" | "gender" | "platform", key: (r: Row) => string | undefined) => rows.map((r) => ({ campaignId: r.campaign_id!, dim, key: key(r) ?? "?", m: rm(r, r.campaign_id!) }));
    return {
      range,
      prevRange,
      campaigns: camps.map((c) => ({
        id: c.id,
        name: c.name,
        objective: c.objective,
        status: c.effective_status,
        dailyBudget: this.budget(c.daily_budget),
        lifetimeBudget: this.budget(c.lifetime_budget),
        resultType: rt.get(c.id) ?? this.cfg.primaryResult,
        m: mNow.get(c.id) ?? rm(undefined, c.id),
        prev: rm(mPrev.get(c.id), c.id),
      })),
      // Ad sets / ads: only items with impressions in the period.
      adSets: sNow.map((r) => ({
        id: r.adset_id!,
        name: r.adset_name ?? setInfo.get(r.adset_id!)?.name ?? r.adset_id!,
        campaignId: r.campaign_id!,
        status: setInfo.get(r.adset_id!)?.effective_status ?? "",
        dailyBudget: this.budget(setInfo.get(r.adset_id!)?.daily_budget),
        m: rm(r, r.campaign_id!),
      })),
      ads: aNow.map((r) => ({ id: r.ad_id!, name: r.ad_name ?? r.ad_id!, adSetId: r.adset_id!, campaignId: r.campaign_id!, status: "", m: rm(r, r.campaign_id!) })),
      daily: dailyRows,
      prevOther: cPrev
        .filter((r) => !rt.has(r.campaign_id!) && (!keep || keep.has(r.campaign_id!)))
        .map((r) => {
          const t = resultTypeFor(all.find((c) => c.id === r.campaign_id)?.objective ?? "", "", "", this.cfg.primaryResult);
          return { resultType: t, m: rm(r, r.campaign_id!, t) };
        }),
      segments: [...segs(sAgeGender, "age", (r) => r.age), ...segs(sAgeGender, "gender", (r) => r.gender), ...segs(sPlat, "platform", (r) => r.publisher_platform)],
    };
  }

  async fetchCreativePerformance(days: number): Promise<CreativeRow[]> {
    const filter = await this.scopeFilter();
    if (!filter) return [];
    type Row = InsightRow & { ad_name?: string; adset_name?: string; campaign_name?: string };
    const rows = await this.getAll<Row>(`/${this.act}/insights`, {
      level: "ad",
      time_range: this.range(days),
      fields: "ad_id,ad_name,adset_name,campaign_id,campaign_name,spend,impressions,reach,clicks,inline_link_clicks,actions,video_thruplay_watched_actions",
      limit: 500,
      ...filter,
    });
    // Result type by campaign objective (don't compare message CPR with reach CPR).
    const campIds = [...new Set(rows.map((r) => r.campaign_id!).filter(Boolean))];
    const objective = new Map<string, string>();
    for (let i = 0; i < campIds.length; i += 50) {
      const cs = await this.getAll<{ id: string; objective: string }>(`/${this.act}/campaigns`, { fields: "id,objective", filtering: [{ field: "id", operator: "IN", value: campIds.slice(i, i + 50) }], limit: 100 }).catch(() => []);
      for (const c of cs) objective.set(c.id, c.objective);
    }
    return rows
      .filter((r) => Number(r.spend) > 0)
      .map((r) => {
        const rt = resultTypeFor(objective.get(r.campaign_id!) ?? "", "", "", this.cfg.primaryResult);
        const m = toMetrics(r, rt);
        return {
          adId: r.ad_id!,
          adName: r.ad_name ?? r.ad_id!,
          adSetName: r.adset_name ?? "",
          campaignName: r.campaign_name ?? "",
          resultType: rt,
          spend: m.spend,
          impressions: m.impressions,
          clicks: m.clicks,
          results: m.results,
          plays3s: pickAction(r.actions, ["video_view"]),
          thruplays: pickAction(r.video_thruplay_watched_actions, ["video_view"]),
        };
      });
  }

  async fetchAdCreatives(adIds: string[]): Promise<CreativeContent[]> {
    if (!adIds.length) return [];
    type Spec = { link_data?: { message?: string; name?: string; picture?: string; child_attachments?: unknown[] }; photo_data?: { caption?: string; url?: string }; video_data?: { message?: string; title?: string; image_url?: string } };
    type A = { id: string; creative?: { body?: string; title?: string; object_type?: string; thumbnail_url?: string; image_url?: string; video_id?: string; object_story_spec?: Spec } };
    const out: CreativeContent[] = [];
    for (let i = 0; i < adIds.length; i += 50) {
      const ads = await this.getAll<A>(`/${this.act}/ads`, {
        fields: "id,creative{body,title,object_type,thumbnail_url,image_url,video_id,object_story_spec}",
        filtering: [{ field: "id", operator: "IN", value: adIds.slice(i, i + 50) }],
        thumbnail_width: 600,
        thumbnail_height: 600,
        limit: 100,
      });
      for (const a of ads) {
        const c = a.creative ?? {};
        const sp = c.object_story_spec ?? {};
        const format = c.video_id || sp.video_data ? "video" : sp.link_data?.child_attachments?.length ? "carousel" : c.image_url || sp.photo_data || sp.link_data ? "image" : c.object_type === "SHARE" || c.object_type === "STATUS" ? "post" : "other";
        out.push({
          adId: a.id,
          format,
          text: c.body ?? sp.link_data?.message ?? sp.video_data?.message ?? sp.photo_data?.caption ?? "",
          headline: c.title ?? sp.link_data?.name ?? sp.video_data?.title ?? "",
          imageUrl: c.image_url ?? sp.video_data?.image_url ?? sp.link_data?.picture ?? c.thumbnail_url ?? null,
        });
      }
    }
    return out;
  }

  /** Subscribe the Page to send messaging webhooks to the token's app (to know which ad a customer messaged from). */
  async subscribePageWebhook(pageId?: string) {
    const page = pageId ?? this.cfg.pageId;
    const token = await this.pageToken(page);
    await this.request("POST", `/${page}/subscribed_apps`, { subscribed_fields: "messages,message_echoes,messaging_referrals,messaging_postbacks" }, token);
    return this.pageWebhookStatus(page ?? undefined);
  }

  /** Whether the token's app is receiving the Page's webhooks. */
  async pageWebhookStatus(pageId?: string) {
    const page = pageId ?? this.cfg.pageId;
    const token = await this.pageToken(page);
    const [apps, me] = await Promise.all([
      this.request<{ data: { id: string; name?: string; subscribed_fields?: string[] }[] }>("GET", `/${page}/subscribed_apps`, {}, token),
      this.request<{ id: string; name?: string }>("GET", "/app", {}).catch(() => null),
    ]);
    const mine = me ? apps.data.find((a) => a.id === me.id) : undefined;
    return { appId: me?.id ?? null, appName: me?.name ?? null, subscribed: !!mine, fields: mine?.subscribed_fields ?? [] };
  }

  /**
   * Send a text message from the Page (Send API, messaging_type RESPONSE: within 24 hours of the customer's last message).
   * No retry on rate-limit errors (withRetry only retries errors Meta didn't execute, so no duplicates are sent).
   */
  async sendPageMessage(pageId: string, psid: string, text: string): Promise<string> {
    const token = await this.pageToken(pageId);
    const r = await this.request<{ message_id?: string }>("POST", `/${pageId}/messages`, { recipient: { id: psid }, messaging_type: "RESPONSE", message: { text } }, token);
    return r.message_id ?? "";
  }

  async recentThreads(pageId: string, since: Date, limit = 300): Promise<RecentThread[]> {
    const token = await this.pageToken(pageId);
    type Raw = {
      id: string;
      updated_time: string;
      link?: string;
      participants?: { data: { id: string; name: string }[] };
      messages?: { data: { message?: string; from?: { id: string }; created_time: string }[] };
    };
    const raw = await this.getAll<Raw>(
      `/${pageId}/conversations`,
      { platform: "messenger", fields: "id,updated_time,link,participants,messages.limit(15){message,from,created_time}", limit: 25 },
      limit,
      token,
      (rows) => rows.some((c) => new Date(c.updated_time) < since),
    );
    return raw
      .filter((c) => new Date(c.updated_time) >= since)
      .map((c) => {
        const who = c.participants?.data.find((p) => p.id !== pageId);
        return {
          id: c.id,
          psid: who?.id ?? null,
          customerName: who?.name ?? "Khách",
          updatedTime: new Date(c.updated_time),
          link: pageInboxUrl(pageId),
          messages: (c.messages?.data ?? []).map((m) => ({ fromCustomer: m.from?.id !== pageId, text: m.message ?? "", createdTime: new Date(m.created_time) })).reverse(),
        };
      });
  }

  async conversationOf(pageId: string, psid: string) {
    const token = await this.pageToken(pageId);
    const r = await this.request<{ data: { id: string; updated_time: string; link?: string; participants?: { data: { id: string; name: string }[] } }[] }>(
      "GET",
      `/${pageId}/conversations`,
      { platform: "messenger", user_id: psid, fields: "id,updated_time,link,participants" },
      token,
    );
    const c = r.data[0];
    if (!c) return null;
    return {
      id: c.id,
      customerName: c.participants?.data.find((p) => p.id !== pageId)?.name ?? "Khách",
      link: pageInboxUrl(pageId),
      updatedTime: new Date(c.updated_time),
    };
  }

  async listCustomAudiences(): Promise<CustomAudienceRef[]> {
    type Raw = { id: string; name: string; subtype?: string; approximate_count_lower_bound?: number; operation_status?: { description?: string }; delivery_status?: { code?: number } };
    const raw = await this.getAll<Raw>(`/${this.act}/customaudiences`, { fields: "id,name,subtype,approximate_count_lower_bound,operation_status,delivery_status", limit: 100 }, 500);
    const notReady = (await getT())("targeting.graph.audienceNotReady");
    return raw.map((a) => ({
      id: a.id,
      name: a.name,
      subtype: a.subtype ?? "CUSTOM",
      size: a.approximate_count_lower_bound != null && a.approximate_count_lower_bound > 0 ? a.approximate_count_lower_bound : null,
      status: a.delivery_status?.code === 200 ? "ready" : (a.operation_status?.description ?? notReady),
    }));
  }

  async fetchAdSetHistory(days: number): Promise<SyncAdSetHistory[]> {
    type Row = InsightRow & { adset_id?: string; adset_name?: string; campaign_id?: string; campaign_name?: string; ad_id?: string };
    const fields = "adset_id,adset_name,campaign_id,campaign_name,spend,impressions,reach,clicks,inline_link_clicks,actions,video_thruplay_watched_actions";
    const filter = await this.scopeFilter();
    if (!filter) return [];
    const [total, recent, adRows] = await Promise.all([
      this.getAll<Row>(`/${this.act}/insights`, { level: "adset", time_range: this.range(days), fields, limit: 500, ...filter }),
      this.getAll<Row>(`/${this.act}/insights`, { level: "adset", time_range: this.range(Math.min(30, days)), fields, limit: 500, ...filter }),
      this.getAll<Row>(`/${this.act}/insights`, { level: "ad", time_range: this.range(days), fields: "ad_id,adset_id,spend", limit: 500, ...filter }),
    ]);
    const ids = total.filter((r) => Number(r.spend) > 0).map((r) => r.adset_id!);
    // Ad set config (including paused / archived ones): batch calls of 50; if a batch fails (some ad set was deleted), call each individually.
    type Info = { id: string; status?: string; effective_status?: string; optimization_goal?: string; destination_type?: string; targeting?: unknown; campaign?: { objective?: string } };
    const fieldsInfo = "status,effective_status,optimization_goal,destination_type,targeting,campaign{objective}";
    const info = new Map<string, Info>();
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      try {
        // Filter on the account's ad set list (including paused / archived), not the "ids" param Meta removed.
        const rows = await this.getAll<Info>(`/${this.act}/adsets`, {
          fields: `id,${fieldsInfo}`,
          filtering: [{ field: "id", operator: "IN", value: chunk }],
          effective_status: ["ACTIVE", "PAUSED", "ARCHIVED", "CAMPAIGN_PAUSED", "ADSET_PAUSED", "DISAPPROVED", "PENDING_REVIEW", "WITH_ISSUES", "IN_PROCESS"],
          limit: 100,
        });
        for (const v of rows) info.set(v.id, v);
      } catch {
        for (const id of chunk) {
          const v = await this.request<Info>("GET", `/${id}`, { fields: fieldsInfo }).catch(() => null);
          if (v) info.set(id, v);
        }
      }
    }
    const adsBySet = new Map<string, string[]>();
    for (const a of adRows) if (a.adset_id && a.ad_id) (adsBySet.get(a.adset_id) ?? adsBySet.set(a.adset_id, []).get(a.adset_id)!).push(a.ad_id);
    const recentBy = new Map(recent.map((r) => [r.adset_id!, r]));
    return ids.flatMap((id) => {
      const t = total.find((r) => r.adset_id === id)!;
      const s = info.get(id);
      if (!s) return []; // ad set permanently deleted: targeting can't be read
      const resultType = resultTypeFor(s.campaign?.objective ?? "", s.optimization_goal ?? "", s.destination_type ?? "", this.cfg.primaryResult);
      const m = toMetrics(t, resultType);
      const r = recentBy.get(id);
      const rm = r ? toMetrics(r, resultType) : null;
      return [
        {
          id,
          campaignId: t.campaign_id ?? "",
          campaignName: t.campaign_name ?? "",
          name: t.adset_name ?? id,
          status: s.effective_status ?? s.status ?? "",
          resultType,
          targeting: JSON.stringify(s.targeting ?? {}),
          adIds: JSON.stringify(adsBySet.get(id) ?? []),
          days,
          spend: m.spend,
          results: m.results,
          impressions: m.impressions,
          clicks: m.clicks,
          recentSpend: rm?.spend ?? 0,
          recentResults: rm?.results ?? 0,
        },
      ];
    });
  }

  async setStatus(_level: Level, id: string, status: "ACTIVE" | "PAUSED") {
    await this.request("POST", `/${id}`, { status });
  }

  async setDailyBudget(_level: "campaign" | "adset", id: string, amount: number) {
    await this.request("POST", `/${id}`, { daily_budget: Math.round(amount * this.offset) });
  }

  private imageHashes = new Map<string, string>();

  /** Upload an image (stored in data/uploads) to the ad account's image library, returns image_hash (reuses images already uploaded in this run). */
  private async uploadImage(imagePath: string): Promise<string> {
    const cached = this.imageHashes.get(imagePath);
    if (cached) return cached;
    const bytes = readFileSync(uploadFilePath(imagePath)).toString("base64");
    const r = await this.request<{ images: Record<string, { hash: string }> }>("POST", `/${this.act}/adimages`, { bytes });
    const hash = Object.values(r.images)[0]?.hash;
    if (!hash) throw new MetaApiError((await getT())("targeting.graph.noImageHash"));
    this.imageHashes.set(imagePath, hash);
    return hash;
  }

  private localeKeys = new Map<string, number | null>();

  /** Look up Meta's real "locale key" by language name (no guessing codes). */
  private async resolveLocales(codes: string[], notes: string[]) {
    const keys: number[] = [];
    for (const code of codes) {
      const lang = LANGUAGE_BY_CODE.get(code);
      if (!lang) continue;
      if (!this.localeKeys.has(code)) {
        const r = await this.request<{ data: { key: number; name: string }[] }>("GET", "/search", { type: "adlocale", q: lang.query, locale: "en_US", limit: 10 });
        const hit = r.data.find((d) => d.name.toLowerCase() === lang.query.toLowerCase()) ?? r.data[0];
        this.localeKeys.set(code, hit?.key ?? null);
      }
      const key = this.localeKeys.get(code);
      if (key == null) notes.push((await getT())("targeting.graph.languageNotFound", { label: lang.label }));
      else keys.push(key);
    }
    return keys;
  }

  private async targeting(s: EditableAdSet, goal: string, notes: string[]) {
    const locales = await this.resolveLocales(s.locales, notes);
    const pos = s.placements === "manual" ? s.positions : null;
    // Instagram profile visits can only run on Instagram.
    const platforms =
      goal === "profile_visits"
        ? ["instagram"]
        : pos
          ? (Object.keys(pos) as (keyof typeof pos)[]).filter((k) => pos[k].length)
          : s.placements === "manual"
            ? s.platforms
            : undefined;
    const flexible = [...(toFlexibleSpec(s.detailed_targeting) ?? []), ...(toFlexibleSpec(s.narrow_targeting) ?? [])];
    const excluded = excludedGeo(s.excluded_locations);
    return {
      geo_locations: toGeoSpec(s.locations, s.custom_locations, s.location_types),
      ...(excluded && { excluded_geo_locations: excluded }),
      // Advantage+ audience: Meta only allows the minimum age (≤ 25) as a hard constraint; max age must be 65;
      // the desired age range is sent as a suggestion (age_range).
      ...(s.advantage_audience
        ? { age_min: Math.min(s.age_min, 25), age_max: 65, ...((s.age_min > 25 || s.age_max < 65) && { age_range: [s.age_min, s.age_max] }) }
        : { age_min: s.age_min, age_max: s.age_max }),
      ...(s.genders !== "all" && { genders: [s.genders === "male" ? 1 : 2] }),
      ...(locales.length && { locales }),
      // Group 1 = detailed targeting (OR), group 2 = narrowing (must also match this group).
      ...(flexible.length && { flexible_spec: flexible }),
      ...(s.custom_audiences.length && { custom_audiences: s.custom_audiences.map((a) => ({ id: a.id })) }),
      ...(s.excluded_custom_audiences.length && { excluded_custom_audiences: s.excluded_custom_audiences.map((a) => ({ id: a.id })) }),
      ...(platforms?.length && { publisher_platforms: platforms }),
      ...(pos &&
        goal !== "profile_visits" && {
          ...(pos.facebook.length && { facebook_positions: pos.facebook }),
          ...(pos.instagram.length && { instagram_positions: pos.instagram }),
          ...(pos.messenger.length && { messenger_positions: pos.messenger }),
          ...(pos.audience_network.length && { audience_network_positions: pos.audience_network }),
        }),
      ...(goal === "profile_visits" && pos?.instagram.length && { instagram_positions: pos.instagram }),
      ...(s.devices !== "all" && { device_platforms: [s.devices] }),
      targeting_automation: { advantage_audience: s.advantage_audience ? 1 : 0 },
    };
  }

  /** Ad set optimization & destination config by objective (the "Conversion location" + "Performance goal" sections in Ads Manager). */
  private goalParams(goal: string, s: EditableAdSet): Record<string, unknown> & { optimization_goal: string } {
    const page = { page_id: this.activePage };
    const optimization_goal = goalOf(goal, s);
    switch (goal) {
      case "messages": {
        const dest = MESSAGE_DESTINATION_OPTS.find((o) => o.value === (s.message_destination ?? "messenger")) ?? MESSAGE_DESTINATION_OPTS[0];
        return { optimization_goal, destination_type: dest.api, promoted_object: page };
      }
      case "leads":
        // Instant Form (ON_AD) or lead capture via Messenger conversation.
        return { optimization_goal, destination_type: s.lead_destination === "messenger" ? "MESSENGER" : "ON_AD", promoted_object: page };
      case "engagement":
        return { optimization_goal, destination_type: "ON_POST" };
      case "page_likes":
        return { optimization_goal, destination_type: "ON_PAGE", promoted_object: page };
      case "video_views":
        return { optimization_goal, destination_type: "ON_VIDEO" };
      case "profile_visits":
        return { optimization_goal, destination_type: "INSTAGRAM_PROFILE" };
      case "link_clicks":
        return { optimization_goal, destination_type: "WEBSITE" };
      default:
        return { optimization_goal };
    }
  }

  /** Creative content by objective. */
  private objectStorySpec(goal: string, a: EditablePlan["ads"][number], s: EditableAdSet, image_hash: string) {
    const igId = this.activePage === this.cfg.pageId ? this.cfg.instagramId : (this.cfg.pageInstagram?.[this.activePage ?? ""] ?? null);
    const ig = igId ? { instagram_user_id: igId } : {};
    const base = { page_id: this.activePage, ...ig };
    const text = { message: a.primary_text, name: a.headline, description: a.description, image_hash };
    if (goal === "engagement" || (goal === "reach" && !a.link_url)) {
      // Regular photo post (engagement on the post; awareness without a link also uses this form).
      return { ...base, photo_data: { image_hash, caption: a.primary_text } };
    }
    if (goal === "page_likes") {
      return { ...base, link_data: { ...text, link: `https://www.facebook.com/${this.activePage}`, call_to_action: { type: "LIKE_PAGE", value: { page: this.activePage } } } };
    }
    if (goal === "leads" && s.lead_destination !== "messenger") {
      return { ...base, link_data: { ...text, link: "http://fb.me/", call_to_action: { type: a.call_to_action, value: { lead_gen_form_id: a.lead_form?.id } } } };
    }
    if (goal === "messages" || goal === "leads") {
      const dest = goal === "leads" ? "messenger" : (s.message_destination ?? "messenger");
      if (dest === "whatsapp") {
        return { ...base, link_data: { ...text, link: "https://api.whatsapp.com/send", call_to_action: { type: "WHATSAPP_MESSAGE", value: { app_destination: "WHATSAPP" } } } };
      }
      return {
        ...base,
        link_data: {
          ...text,
          link: "https://fb.com/messenger_doc/",
          call_to_action: { type: "MESSAGE_PAGE", value: { app_destination: dest === "instagram" ? "INSTAGRAM_DIRECT" : "MESSENGER" } },
          ...(a.welcome?.greeting.trim() && { page_welcome_message: welcomeMessage(a.welcome) }),
        },
      };
    }
    if (goal === "profile_visits") {
      return {
        ...base,
        link_data: { message: a.primary_text, name: a.headline, link: "https://www.instagram.com/", image_hash, call_to_action: { type: "VIEW_INSTAGRAM_PROFILE" } },
      };
    }
    const link = a.link_url ?? "";
    return { ...base, link_data: { ...text, link, call_to_action: { type: a.call_to_action, value: { link } } } };
  }

  /**
   * Video ads: use an existing video on the Page (video_id). Reuse the CTA, form and message template of the image format for the same objective,
   * then convert to video_data. Thumbnail: the user's uploaded image (image_hash) or the video's cover image.
   */
  private async videoStorySpec(goal: string, a: EditablePlan["ads"][number], s: EditableAdSet, image_hash: string) {
    const { link_data, photo_data, ...base } = this.objectStorySpec(goal, a, s, image_hash) as Record<string, unknown> & {
      link_data?: { message?: string; name?: string; description?: string; link?: string; call_to_action?: { type: string; value?: Record<string, unknown> }; page_welcome_message?: unknown };
      photo_data?: { caption?: string };
    };
    const cta = link_data?.call_to_action;
    // Instant forms on video need a dummy link "http://fb.me/" in the CTA (like an existing Reel post with an attached form).
    const ctaValue = cta && (cta.value?.lead_gen_form_id ? { ...cta.value, link: "http://fb.me/" } : (cta.value ?? (link_data?.link ? { link: link_data.link } : undefined)));
    const thumb = image_hash ? { image_hash } : a.video_preview?.picture ? { image_url: a.video_preview.picture } : null;
    if (!thumb) throw new MetaApiError((await getT())("targeting.graph.videoNoThumb", { name: a.name }));
    return {
      ...base,
      video_data: {
        video_id: a.video_id,
        message: link_data?.message ?? photo_data?.caption ?? a.primary_text,
        ...(link_data?.name && { title: link_data.name }),
        ...(link_data?.description && { link_description: link_data.description }),
        ...thumb,
        ...(cta && { call_to_action: { type: cta.type, ...(ctaValue && { value: ctaValue }) } }),
        ...(link_data?.page_welcome_message ? { page_welcome_message: link_data.page_welcome_message } : {}),
      },
    };
  }

  async publishPlan(plan: EditablePlan): Promise<PublishResult> {
    const goal = plan.result_type;
    if (!PUBLISHABLE_RESULTS.has(goal)) {
      throw new MetaApiError((await getT())("targeting.graph.goalUnsupported", { goal }));
    }
    // Ads are posted under the Page chosen in the composer (multi-Page clients), defaulting to the main Page.
    this.activePage = plan.page_id && this.cfg.pageIds?.includes(plan.page_id) ? plan.page_id : this.cfg.pageId;
    if (!this.activePage) throw new MetaApiError((await getT())("targeting.graph.noPageIdShort"));

    const cbo = plan.budget_mode === "CBO";
    const budgetField = plan.budget_period === "lifetime" ? "lifetime_budget" : "daily_budget";
    const bidStrategy = BID_API[plan.bid_strategy];
    const bidAmount = plan.bid_strategy !== "lowest_cost" && plan.bid_amount ? { bid_amount: Math.round(plan.bid_amount * this.offset) } : {};
    const notes: string[] = [];
    // Pre-check to avoid half-created objects: Meta won't create ads when the account has no payment method.
    const acct = await this.request<{ account_status?: number; funding_source?: string; funding_source_details?: unknown }>("GET", `/${this.act}`, {
      fields: "account_status,funding_source,funding_source_details",
    });
    if (acct.account_status !== 1) throw new MetaApiError((await getT())("targeting.graph.accountInactive"));
    if (!acct.funding_source && !acct.funding_source_details) {
      throw new MetaApiError((await getT())("targeting.graph.noPayment"));
    }

    // Invalid carousel: report before creating anything on Meta.
    for (const a of plan.ads.filter(isCarousel)) {
      const why = carouselBlockReason(goal, await getT());
      if (why) throw new MetaApiError(`"${a.name}": ${why}`);
      if (a.cards.length < CAROUSEL_MIN || a.cards.length > CAROUSEL_MAX || a.cards.some((c) => !c.image_path)) {
        throw new MetaApiError((await getT())("targeting.graph.carouselCards", { name: a.name, min: CAROUSEL_MIN, max: CAROUSEL_MAX }));
      }
      if (goal === "reach" && !a.link_url) throw new MetaApiError((await getT())("targeting.graph.carouselUrl", { name: a.name }));
    }

    const created: string[] = [];
    const creativeIds: string[] = []; // creatives aren't inside the campaign, so deleting the campaign doesn't remove them
    let campaignId: string | null = null;
    const ZERO = { spend: 0, impressions: 0, reach: 0, clicks: 0, results: 0, revenue: 0 };
    try {
      const c = await this.request<{ id: string }>("POST", `/${this.act}/campaigns`, {
        name: plan.campaign_name,
        objective: plan.objective,
        status: "PAUSED",
        special_ad_categories: [],
        ...(cbo
          ? { [budgetField]: Math.round((plan.campaign_daily_budget ?? 0) * this.offset), bid_strategy: bidStrategy }
          : { is_adset_budget_sharing_enabled: false }),
        ...(plan.spend_cap && plan.spend_cap > 0 && { spend_cap: Math.round(plan.spend_cap * this.offset) }),
      });
      created.push(`campaign ${c.id}`);
      campaignId = c.id;

      const adSets: SyncAdSet[] = [];
      for (const s of plan.ad_sets) {
        const targeting = await this.targeting(s, goal, notes);
        const goalParams = this.goalParams(goal, s);
        const r = await this.request<{ id: string }>("POST", `/${this.act}/adsets`, {
          name: s.name,
          campaign_id: c.id,
          ...(!cbo && { [budgetField]: Math.round((s.daily_budget ?? 0) * this.offset), bid_strategy: bidStrategy }),
          ...bidAmount,
          billing_event: "IMPRESSIONS",
          status: "PAUSED",
          targeting,
          ...(s.start_time && { start_time: zonedToIso(s.start_time, this.cfg.timezone) }),
          ...(s.end_time && { end_time: zonedToIso(s.end_time, this.cfg.timezone) }),
          ...goalParams,
        });
        created.push(`adset ${r.id}`);
        adSets.push({
          ...ZERO,
          id: r.id,
          campaignId: c.id,
          name: s.name,
          status: "PAUSED",
          dailyBudget: cbo || plan.budget_period === "lifetime" ? null : s.daily_budget,
          optimizationGoal: goalParams.optimization_goal,
          targeting: JSON.stringify(targeting),
        });
      }

      const ads: SyncAd[] = [];
      const adPlanIndex: number[] = [];
      for (const [ai, a] of plan.ads.entries()) {
        const adSet = adSets[a.ad_set_index];
        if (!adSet) continue;
        if (a.source === "existing") {
          if (!a.post_id) continue;
          // Use the existing Page post as is: keeps likes, comments, shares.
          const creative = await this.request<{ id: string }>("POST", `/${this.act}/adcreatives`, {
            name: `${a.name} - bài có sẵn`,
            object_story_id: a.post_id,
          });
          creativeIds.push(creative.id);
          const ad = await this.request<{ id: string }>("POST", `/${this.act}/ads`, {
            name: a.name,
            adset_id: adSet.id,
            creative: { creative_id: creative.id },
            status: "PAUSED",
          });
          created.push(`ad ${ad.id}`);
          ads.push({ ...ZERO, id: ad.id, campaignId: c.id, adSetId: adSet.id, name: a.name, status: "PAUSED", primaryText: a.post_preview?.message ?? "", headline: "" });
          adPlanIndex.push(ai);
          continue;
        }
        const carousel = isCarousel(a);
        if (!carousel && !a.image_path && !a.video_id) {
          notes.push((await getT())("targeting.graph.noMedia", { name: a.name }));
          continue;
        }
        if (goal === "link_clicks" && !a.link_url) {
          notes.push((await getT())("targeting.graph.noLink", { name: a.name }));
          continue;
        }
        if (goal === "leads" && plan.ad_sets[a.ad_set_index].lead_destination !== "messenger" && !a.lead_form) {
          notes.push((await getT())("targeting.graph.noForm", { name: a.name }));
          continue;
        }
        const s = plan.ad_sets[a.ad_set_index];
        let object_story_spec: Record<string, unknown>;
        if (carousel) {
          const hashes: string[] = [];
          for (const c of a.cards) hashes.push(await this.uploadImage(c.image_path!));
          const { link_data, ...base } = this.objectStorySpec(goal, a, s, hashes[0]) as Record<string, unknown> & { link_data?: Parameters<typeof carouselLinkData>[0] };
          if (!link_data) throw new MetaApiError(`"${a.name}": ${carouselBlockReason("engagement", await getT())}`); // the photo-post form (photo_data) has no carousel
          object_story_spec = { ...base, link_data: carouselLinkData(link_data, a, hashes, goal) };
        } else {
          const image_hash = a.image_path ? await this.uploadImage(a.image_path) : "";
          object_story_spec = a.video_id ? await this.videoStorySpec(goal, a, s, image_hash) : this.objectStorySpec(goal, a, s, image_hash);
        }
        const creative = await this.request<{ id: string }>("POST", `/${this.act}/adcreatives`, {
          name: `${a.name} - creative`,
          object_story_spec,
        });
        creativeIds.push(creative.id);
        const ad = await this.request<{ id: string }>("POST", `/${this.act}/ads`, {
          name: a.name,
          adset_id: adSet.id,
          creative: { creative_id: creative.id },
          status: "PAUSED",
        });
        created.push(`ad ${ad.id}`);
        ads.push({ ...ZERO, id: ad.id, campaignId: c.id, adSetId: adSet.id, name: a.name, status: "PAUSED", primaryText: a.primary_text, headline: a.headline });
        adPlanIndex.push(ai);
      }

      notes.push((await getT())("targeting.graph.allPaused"));
      return {
        campaign: {
          ...ZERO,
          id: c.id,
          name: plan.campaign_name,
          objective: plan.objective,
          status: "PAUSED",
          dailyBudget: cbo && plan.budget_period !== "lifetime" ? plan.campaign_daily_budget : null,
          resultType: goal,
          createdTime: new Date(),
        },
        adSets,
        ads,
        adPlanIndex,
        notes,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = err instanceof MetaApiError ? err.code : undefined; // keep the error code (190 = broken token) for the caller
      // Mid-way error: delete the just-created campaign (taking its ad sets and ads with it) so nothing half-done is left.
      if (campaignId) {
        let rollbackError: string | null = null;
        await this.request("DELETE", `/${campaignId}`).catch((e) => (rollbackError = e instanceof Error ? e.message : String(e)));
        // Orphaned creatives cost nothing; delete them to keep the library tidy; ignore errors.
        await Promise.all(creativeIds.map((id) => this.request("DELETE", `/${id}`).catch(() => {})));
        if (rollbackError) {
          throw new MetaApiError((await getT())("targeting.graph.rollbackFailed", { msg, error: rollbackError, created: created.join(", ") }), code);
        }
        throw new MetaApiError((await getT())("targeting.graph.rolledBack", { msg }), code);
      }
      throw new MetaApiError(msg, code);
    }
  }
}

/** Attachment label by type (like the webhook): image/* → [Ảnh], video → [Video], audio → [Ghi âm], others [Tệp]. */
function attachmentLabel(mime?: string) {
  const t = (mime ?? "").split("/")[0];
  return t === "image" ? "[Ảnh]" : t === "video" ? "[Video]" : t === "audio" ? "[Ghi âm]" : "[Tệp]";
}
