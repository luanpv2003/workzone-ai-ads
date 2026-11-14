import { db } from "./db";
import { formatCustomerId, gaql } from "./google-ads";
import { getT } from "@/i18n/server";

// Sync Google Ads → DB for 1 client (read-only, changes nothing on Google).
// 16 searchStream calls: account info, campaigns (attributes + metrics + by device + device/negative criteria), daily metrics,
// ad groups (attributes + metrics), keywords (attributes + 3-part quality score + metrics), search terms, RSA ads (attributes + metrics). Aggregate metrics = last 30 days; daily = 90 days.
// Attributes and metrics are separated because Google drops rows without impressions when querying with metrics (paused campaigns must still show).

const DAYS_DAILY = 90;
const SEARCH_TERM_LIMIT = 500;

type Metrics = { costMicros?: string; impressions?: string; clicks?: string; conversions?: number; conversionsValue?: number };
const m = (x: Metrics | undefined) => ({
  spend: Number(x?.costMicros ?? 0) / 1e6,
  impressions: Number(x?.impressions ?? 0),
  clicks: Number(x?.clicks ?? 0),
  conversions: Number(x?.conversions ?? 0),
});
const share = (v: unknown) => (typeof v === "number" ? v : null);
/** One component of the quality score; UNSPECIFIED / UNKNOWN (not yet scored by Google) → null. */
const qPart = (v?: string) => (v === "BELOW_AVERAGE" || v === "AVERAGE" || v === "ABOVE_AVERAGE" ? v : null);
/** bidModifier: null = no adjustment, 0 = device excluded (-100%), 1.2 = +20%. */
const DEVICES = ["DESKTOP", "MOBILE", "TABLET"];
export type DeviceStat = { spend: number; clicks: number; conversions: number; bidModifier: number | null };

/** Date YYYY-MM-DD in the Google account's timezone (Google counts days in the account's timezone). */
function ymd(d: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

const METRICS = "metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions";
const LAST_30 = "segments.date DURING LAST_30_DAYS";

export async function syncGoogleAds(clientId: string) {
  const t = await getT();
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId } });
  const cid = client.googleCustomerId;
  if (!cid) throw new Error(t("settings.googleSync.noAccount"));
  try {
    const r = await pullGoogleAds(cid);
    // A4: a read with no campaigns while campaigns are stored is treated as a failed read,
    // so the replace-all below never wipes good data.
    if (!r.campaigns.length && (await db.gAdsCampaign.count({ where: { clientId } })))
      throw new Error(t("settings.googleSync.zeroCampaigns"));
    await db.$transaction([
      db.gAdsCampaign.deleteMany({ where: { clientId } }),
      db.gAdsAdGroup.deleteMany({ where: { clientId } }),
      db.gAdsKeyword.deleteMany({ where: { clientId } }),
      db.gAdsSearchTerm.deleteMany({ where: { clientId } }),
      db.gAdsDaily.deleteMany({ where: { clientId } }),
      db.gAdsAd.deleteMany({ where: { clientId } }),
      db.gAdsAd.createMany({ data: r.ads.map((x) => ({ ...x, clientId })) }),
      db.gAdsCampaign.createMany({ data: r.campaigns.map((x) => ({ ...x, clientId })) }),
      db.gAdsAdGroup.createMany({ data: r.adGroups.map((x) => ({ ...x, clientId })) }),
      db.gAdsKeyword.createMany({ data: r.keywords.map((x) => ({ ...x, clientId })) }),
      db.gAdsSearchTerm.createMany({ data: r.searchTerms.map((x) => ({ ...x, clientId })) }),
      db.gAdsDaily.createMany({ data: r.daily.map((x) => ({ ...x, clientId })) }),
      db.client.update({
        where: { id: clientId },
        data: { googleAccountName: r.account.name, googleCurrency: r.account.currency, googleSyncedAt: new Date(), googleSyncError: null },
      }),
    ]);
    return { campaigns: r.campaigns.length, keywords: r.keywords.length, searchTerms: r.searchTerms.length, spend30: r.campaigns.reduce((a, c) => a + c.spend, 0), currency: r.account.currency };
  } catch (err) {
    await db.client.update({ where: { id: clientId }, data: { googleSyncError: err instanceof Error ? err.message : String(err) } });
    throw err;
  }
}

/** Read all Google metrics of 1 account (no DB writes). */
async function pullGoogleAds(cid: string) {
  type Cust = { customer: { descriptiveName?: string; currencyCode?: string; timeZone?: string } };
  const [cust] = await gaql<Cust>(cid, "SELECT customer.descriptive_name, customer.currency_code, customer.time_zone FROM customer LIMIT 1");
  // A2: never assume VND when Google does not report a currency (writes are refused instead).
  const account = { name: cust?.customer.descriptiveName || formatCustomerId(cid), currency: cust?.customer.currencyCode || "", timeZone: cust?.customer.timeZone || "Asia/Ho_Chi_Minh" };

  // --- Campaigns
  type CampAttr = {
    campaign: {
      id: string;
      name: string;
      status: string;
      advertisingChannelType?: string;
      biddingStrategyType?: string;
      maximizeConversions?: { targetCpaMicros?: string };
      targetCpa?: { targetCpaMicros?: string };
    };
    campaignBudget?: { id?: string; amountMicros?: string; explicitlyShared?: boolean };
  };
  type CampMet = { campaign: { id: string }; metrics?: Metrics & { searchImpressionShare?: number; searchBudgetLostImpressionShare?: number; searchRankLostImpressionShare?: number } };
  const campAttr = await gaql<CampAttr>(
    cid,
    `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type,
       campaign.maximize_conversions.target_cpa_micros, campaign.target_cpa.target_cpa_micros,
       campaign_budget.id, campaign_budget.amount_micros, campaign_budget.explicitly_shared
     FROM campaign WHERE campaign.status != 'REMOVED'`,
  );
  const campMet = await gaql<CampMet>(
    cid,
    `SELECT campaign.id, ${METRICS}, metrics.conversions_value, metrics.search_impression_share,
       metrics.search_budget_lost_impression_share, metrics.search_rank_lost_impression_share
     FROM campaign WHERE ${LAST_30} AND campaign.status != 'REMOVED'`,
  );
  const cm = new Map(campMet.map((r) => [String(r.campaign.id), r.metrics]));

  // By device (30 days) + device bid adjustments (0 = excluded, -100%) + campaign-level negative keywords.
  type DevMet = { campaign: { id: string }; segments: { device: string }; metrics?: Metrics };
  type Crit = {
    campaign: { id: string };
    campaignCriterion: { type: string; negative?: boolean; bidModifier?: number; device?: { type?: string }; keyword?: { text?: string; matchType?: string } };
  };
  const devMet = await gaql<DevMet>(cid, `SELECT campaign.id, segments.device, ${METRICS} FROM campaign WHERE ${LAST_30} AND campaign.status != 'REMOVED'`);
  // Negatives only from active campaigns: old paused campaigns can carry thousands of items (XÈO ~13,000).
  const crits = [
    ...(await gaql<Crit>(
      cid,
      `SELECT campaign.id, campaign_criterion.type, campaign_criterion.bid_modifier, campaign_criterion.device.type
       FROM campaign_criterion WHERE campaign_criterion.type = 'DEVICE' AND campaign.status != 'REMOVED'`,
    )),
    ...(await gaql<Crit>(
      cid,
      `SELECT campaign.id, campaign_criterion.type, campaign_criterion.negative, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type
       FROM campaign_criterion WHERE campaign_criterion.type = 'KEYWORD' AND campaign_criterion.negative = TRUE AND campaign.status = 'ENABLED'
         AND campaign_criterion.status != 'REMOVED'`,
    )),
  ];
  const devices = new Map<string, Record<string, DeviceStat>>();
  const devOf = (campId: string, dev: string) => {
    const d = devices.get(campId) ?? {};
    devices.set(campId, d);
    return (d[dev] ??= { spend: 0, clicks: 0, conversions: 0, bidModifier: null });
  };
  for (const r of devMet) {
    if (!DEVICES.includes(r.segments.device)) continue;
    const d = devOf(String(r.campaign.id), r.segments.device);
    const x = m(r.metrics);
    d.spend += x.spend;
    d.clicks += x.clicks;
    d.conversions += x.conversions;
  }
  // Ad schedule + hourly metrics (30 days, and yesterday to know when the budget ran out).
  type SchedRow = {
    campaign: { id: string };
    campaignCriterion: { criterionId: string; adSchedule?: { dayOfWeek?: string; startHour?: number; startMinute?: string; endHour?: number; endMinute?: string } };
  };
  type HourRow = { campaign: { id: string }; segments: { hour?: number }; metrics?: Metrics };
  const schedRows = await gaql<SchedRow>(
    cid,
    `SELECT campaign.id, campaign_criterion.criterion_id, campaign_criterion.ad_schedule.day_of_week, campaign_criterion.ad_schedule.start_hour,
       campaign_criterion.ad_schedule.start_minute, campaign_criterion.ad_schedule.end_hour, campaign_criterion.ad_schedule.end_minute
     FROM campaign_criterion WHERE campaign_criterion.type = 'AD_SCHEDULE' AND campaign.status = 'ENABLED'`,
  );
  const yesterday = ymd(new Date(Date.now() - 86400_000), account.timeZone);
  const hour30 = await gaql<HourRow>(cid, `SELECT campaign.id, segments.hour, ${METRICS} FROM campaign WHERE ${LAST_30} AND campaign.status = 'ENABLED'`);
  const hour1 = await gaql<HourRow>(cid, `SELECT campaign.id, segments.hour, metrics.cost_micros FROM campaign WHERE segments.date = '${yesterday}' AND campaign.status = 'ENABLED'`);
  const MIN: Record<string, number> = { ZERO: 0, FIFTEEN: 15, THIRTY: 30, FORTY_FIVE: 45 };
  const schedule = new Map<string, { id: string; day: string; startHour: number; startMinute: number; endHour: number; endMinute: number }[]>();
  for (const { campaign, campaignCriterion: k } of schedRows) {
    const a = k.adSchedule;
    if (!a?.dayOfWeek) continue;
    const id = String(campaign.id);
    schedule.set(id, [...(schedule.get(id) ?? []), { id: String(k.criterionId), day: a.dayOfWeek, startHour: a.startHour ?? 0, startMinute: MIN[a.startMinute ?? "ZERO"] ?? 0, endHour: a.endHour ?? 24, endMinute: MIN[a.endMinute ?? "ZERO"] ?? 0 }]);
  }
  const hours = new Map<string, Record<string, { spend: number; clicks: number; conversions: number }>>();
  for (const r of hour30) {
    const id = String(r.campaign.id);
    const h = String(r.segments.hour ?? 0);
    const x = m(r.metrics);
    const cur = hours.get(id) ?? {};
    hours.set(id, cur);
    const v = (cur[h] ??= { spend: 0, clicks: 0, conversions: 0 });
    v.spend += x.spend;
    v.clicks += x.clicks;
    v.conversions += x.conversions;
  }
  const lastDay = new Map<string, Record<string, number>>();
  for (const r of hour1) {
    const id = String(r.campaign.id);
    const cur = lastDay.get(id) ?? {};
    lastDay.set(id, cur);
    cur[String(r.segments.hour ?? 0)] = (cur[String(r.segments.hour ?? 0)] ?? 0) + m(r.metrics).spend;
  }

  const negatives = new Map<string, { text: string; matchType: string }[]>();
  for (const { campaign, campaignCriterion: k } of crits) {
    const id = String(campaign.id);
    if (k.type === "DEVICE" && DEVICES.includes(k.device?.type ?? "") && typeof k.bidModifier === "number" && k.bidModifier !== 1) devOf(id, k.device!.type!).bidModifier = k.bidModifier;
    if (k.type === "KEYWORD" && k.negative && k.keyword?.text) negatives.set(id, [...(negatives.get(id) ?? []), { text: k.keyword.text, matchType: k.keyword.matchType ?? "" }]);
  }

  const campaigns = campAttr.map(({ campaign: c, campaignBudget: b }) => {
    const x = cm.get(String(c.id));
    const tcpa = c.maximizeConversions?.targetCpaMicros ?? c.targetCpa?.targetCpaMicros;
    return {
      id: String(c.id),
      name: c.name,
      status: c.status,
      channelType: c.advertisingChannelType ?? "",
      biddingStrategy: c.biddingStrategyType ?? "",
      dailyBudget: b?.amountMicros ? Number(b.amountMicros) / 1e6 : null,
      ...m(x),
      conversionValue: Number(x?.conversionsValue ?? 0),
      searchImprShare: share(x?.searchImpressionShare),
      lostBudgetShare: share(x?.searchBudgetLostImpressionShare),
      lostRankShare: share(x?.searchRankLostImpressionShare),
      targetCpa: tcpa && Number(tcpa) > 0 ? Number(tcpa) / 1e6 : null,
      budgetId: b?.id ? String(b.id) : null,
      budgetShared: !!b?.explicitlyShared,
      devices: JSON.stringify(devices.get(String(c.id)) ?? {}),
      negatives: JSON.stringify(negatives.get(String(c.id)) ?? []),
      schedule: JSON.stringify(schedule.get(String(c.id)) ?? []),
      hours: JSON.stringify(hours.get(String(c.id)) ?? {}),
      lastDayHours: JSON.stringify(lastDay.get(String(c.id)) ?? {}),
    };
  });

  // --- Daily (90 days, through yesterday)
  const until = ymd(new Date(Date.now() - 86400_000), account.timeZone);
  const since = ymd(new Date(Date.now() - DAYS_DAILY * 86400_000), account.timeZone);
  type DayRow = { campaign: { id: string }; segments: { date: string }; metrics?: Metrics };
  const dayRows = await gaql<DayRow>(cid, `SELECT campaign.id, segments.date, ${METRICS}, metrics.conversions_value FROM campaign WHERE segments.date BETWEEN '${since}' AND '${until}'`);
  const daily = dayRows.map((r) => ({ campaignId: String(r.campaign.id), date: r.segments.date, ...m(r.metrics), conversionValue: Number(r.metrics?.conversionsValue ?? 0) }));

  // --- Ad groups
  type AgAttr = { adGroup: { id: string; name: string; status: string }; campaign: { id: string } };
  type AgMet = { adGroup: { id: string }; metrics?: Metrics };
  const agAttr = await gaql<AgAttr>(cid, "SELECT ad_group.id, ad_group.name, ad_group.status, campaign.id FROM ad_group WHERE ad_group.status != 'REMOVED' AND campaign.status != 'REMOVED'");
  const agMet = await gaql<AgMet>(cid, `SELECT ad_group.id, ${METRICS} FROM ad_group WHERE ${LAST_30} AND ad_group.status != 'REMOVED'`);
  const am = new Map(agMet.map((r) => [String(r.adGroup.id), r.metrics]));
  const adGroups = agAttr.map(({ adGroup: g, campaign: c }) => ({ id: String(g.id), campaignId: String(c.id), name: g.name, status: g.status, ...m(am.get(String(g.id))) }));

  // --- Keywords
  type KwAttr = {
    adGroupCriterion: {
      criterionId: string;
      status: string;
      keyword?: { text?: string; matchType?: string };
      qualityInfo?: { qualityScore?: number; searchPredictedCtr?: string; creativeQualityScore?: string; postClickQualityScore?: string };
    };
    adGroup: { id: string };
    campaign: { id: string };
  };
  type KwMet = { adGroupCriterion: { criterionId: string }; adGroup: { id: string }; metrics?: Metrics };
  const kwAttr = await gaql<KwAttr>(
    cid,
    `SELECT ad_group_criterion.criterion_id, ad_group_criterion.status, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
       ad_group_criterion.quality_info.quality_score, ad_group_criterion.quality_info.search_predicted_ctr,
       ad_group_criterion.quality_info.creative_quality_score, ad_group_criterion.quality_info.post_click_quality_score, ad_group.id, campaign.id
     FROM ad_group_criterion
     WHERE ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.negative = FALSE AND ad_group_criterion.status != 'REMOVED'
       AND ad_group.status != 'REMOVED' AND campaign.status != 'REMOVED'`,
  );
  const kwMet = await gaql<KwMet>(cid, `SELECT ad_group_criterion.criterion_id, ad_group.id, ${METRICS} FROM keyword_view WHERE ${LAST_30}`);
  const km = new Map(kwMet.map((r) => [`${r.adGroup.id}~${r.adGroupCriterion.criterionId}`, r.metrics]));
  const keywords = kwAttr.map(({ adGroupCriterion: k, adGroup: g, campaign: c }) => {
    const id = `${g.id}~${k.criterionId}`;
    return {
      id,
      campaignId: String(c.id),
      adGroupId: String(g.id),
      text: k.keyword?.text ?? "",
      matchType: k.keyword?.matchType ?? "",
      status: k.status,
      qualityScore: k.qualityInfo?.qualityScore ?? null,
      ctrQuality: qPart(k.qualityInfo?.searchPredictedCtr),
      adRelevance: qPart(k.qualityInfo?.creativeQualityScore),
      landingPage: qPart(k.qualityInfo?.postClickQualityScore),
      ...m(km.get(id)),
    };
  });

  // --- Actual user search terms (Search campaigns only; PMax isn't here)
  type StRow = { searchTermView: { searchTerm: string; status?: string }; campaign: { id: string }; adGroup: { id: string }; metrics?: Metrics };
  const stRows = await gaql<StRow>(
    cid,
    `SELECT search_term_view.search_term, search_term_view.status, campaign.id, ad_group.id, ${METRICS}
     FROM search_term_view WHERE ${LAST_30} ORDER BY metrics.cost_micros DESC LIMIT ${SEARCH_TERM_LIMIT}`,
  );
  const searchTerms = stRows.map((r) => ({
    campaignId: String(r.campaign.id),
    adGroupId: String(r.adGroup.id),
    term: r.searchTermView.searchTerm,
    status: r.searchTermView.status ?? "NONE",
    ...m(r.metrics),
  }));

  // --- Responsive search ads (RSA) of active campaigns
  type AdAttr = {
    adGroupAd: {
      status: string;
      adStrength?: string;
      ad: { id: string; type?: string; finalUrls?: string[]; responsiveSearchAd?: { headlines?: { text?: string }[]; descriptions?: { text?: string }[]; path1?: string; path2?: string } };
    };
    adGroup: { id: string };
    campaign: { id: string };
  };
  type AdMet = { adGroupAd: { ad: { id: string } }; adGroup: { id: string }; metrics?: Metrics };
  const adAttr = await gaql<AdAttr>(
    cid,
    `SELECT ad_group_ad.ad.id, ad_group_ad.status, ad_group_ad.ad_strength, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines,
       ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.ad.responsive_search_ad.path1, ad_group_ad.ad.responsive_search_ad.path2, ad_group.id, campaign.id
     FROM ad_group_ad WHERE ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD' AND ad_group_ad.status != 'REMOVED' AND campaign.status = 'ENABLED' AND ad_group.status != 'REMOVED'`,
  );
  const adMet = await gaql<AdMet>(cid, `SELECT ad_group_ad.ad.id, ad_group.id, ${METRICS} FROM ad_group_ad WHERE ${LAST_30} AND ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD' AND campaign.status = 'ENABLED'`);
  const adm = new Map(adMet.map((r) => [`${r.adGroup.id}~${r.adGroupAd.ad.id}`, r.metrics]));
  const ads = adAttr.map(({ adGroupAd: a, adGroup: g, campaign: c }) => {
    const id = `${g.id}~${a.ad.id}`;
    const rsa = a.ad.responsiveSearchAd ?? {};
    return {
      id,
      campaignId: String(c.id),
      adGroupId: String(g.id),
      status: a.status,
      adStrength: a.adStrength ?? "",
      headlines: JSON.stringify((rsa.headlines ?? []).map((h) => h.text ?? "").filter(Boolean)),
      descriptions: JSON.stringify((rsa.descriptions ?? []).map((h) => h.text ?? "").filter(Boolean)),
      finalUrl: a.ad.finalUrls?.[0] ?? "",
      path1: rsa.path1 ?? "",
      path2: rsa.path2 ?? "",
      ...m(adm.get(id)),
    };
  });

  return { account, campaigns, daily, adGroups, keywords, searchTerms, ads };
}

/** Auto-sync schedule (scripts/daily.ts): every 3 hours, within 6h–22h VN time. */
export function isGoogleSyncDue(c: { googleCustomerId: string | null; googleSyncedAt: Date | null }, now = new Date()) {
  if (!c.googleCustomerId) return false;
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Ho_Chi_Minh", hour: "numeric", hourCycle: "h23" }).format(now));
  if (hour < 6 || hour > 22) return false;
  return !c.googleSyncedAt || now.getTime() - c.googleSyncedAt.getTime() >= 3 * 3600_000 - 10 * 60_000;
}
