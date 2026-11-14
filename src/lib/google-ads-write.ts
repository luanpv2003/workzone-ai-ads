import type { GAdsCampaign, GAdsChange } from "@prisma/client";
import { db } from "./db";
import { gmutate, gmutateAll } from "./google-ads";
import { norm } from "./text";
import { AD_LIMITS, cleanDescription, cleanHeadline, DAYS, fmtSchedule, gWidth, hasPhone, type Day, type SchedSlot } from "./google-ads-text";
export { AD_LIMITS, cleanDescription, cleanHeadline, gWidth };
import type { DeviceStat } from "./google-ads-sync";
import { logActivity } from "./activity";
import { money } from "./format";
import { getT } from "@/i18n/server";
import type { T } from "@/i18n/translate";

// Edit Google Ads through the system. Each change is a GAdsChange:
// - Manual edit (Google Ads tab): created + executed immediately (source "manual").
// - Proposal (rules in lib/google-ads-rules.ts or Claude): status "pending", the user reviews / edits / approves before it executes.
// Only reversible operations (enable/pause, budget, target CPA, devices, adding negatives, creating new ad groups in paused state). Nothing is deleted on Google.

export type MatchType = "EXACT" | "PHRASE" | "BROAD";
export type Device = "DESKTOP" | "MOBILE" | "TABLET";
export type NegItem = { text: string; matchType: MatchType; reason?: string; spend?: number; clicks?: number; conversions?: number };

export type GChangeParams =
  | { kind: "negatives"; items: NegItem[] }
  | { kind: "target_cpa"; value: number | null } // null = remove target CPA (Maximize conversions without a cap)
  | { kind: "budget"; amount: number }
  | { kind: "device"; device: Device; bidModifier: number | null } // 0 = excluded (-100%), null = remove adjustment
  | { kind: "keyword_status"; keywords: { id: string; text: string }[]; status: "ENABLED" | "PAUSED" }
  | { kind: "campaign_status"; status: "ENABLED" | "PAUSED" }
  // Create a new ad group (PAUSED) with keywords + 1 responsive search ad. After approval the system proposes an ad_group_switch card.
  | { kind: "ad_group_create"; name: string; finalUrl: string; path1: string; path2: string; headlines: string[]; descriptions: string[]; keywords: { text: string; matchType: MatchType }[]; why?: string }
  // Enable the new ad group and pause duplicate keywords in the old one (so the 2 ad groups don't compete for the same searches).
  | { kind: "ad_group_switch"; adGroupId: string; name: string; pauseKeywords: { id: string; text: string }[] }
  // Ad schedule: one time window for the selected days (replaces the whole old schedule; unselected days don't run).
  | { kind: "ad_schedule"; days: Day[]; startHour: number; startMinute: number; endHour: number; endMinute: number };

/** Device name in the UI language. */
const deviceLabel = (d: Device, t: T) => t(`settings.googleWrite.device.${d}`);
// Google's fixed device criterion IDs (campaignCriteria/{campaignId}~{id}).
const DEVICE_CRITERION: Record<Device, number> = { DESKTOP: 30000, MOBILE: 30001, TABLET: 30002 };
const statusLabel = (st: "ENABLED" | "PAUSED", t: T) => t(`settings.googleWrite.status.${st}`);
const statusDone = (st: "ENABLED" | "PAUSED", t: T) => t(`settings.googleWrite.statusDone.${st}`);

/** Negative keywords: strip characters Google rejects, at most 10 words / 80 characters. */
export function cleanKeyword(t: string) {
  const s = t
    .toLowerCase()
    .replace(/[!@%^*()={};~`<>?\\|,"[\]+]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s.split(" ").slice(0, 10).join(" ").slice(0, 80).trim();
}
const negKey = (x: { text: string; matchType: string }) => `${x.matchType}|${cleanKeyword(x.text)}`;

const schedSlots = (p: Extract<GChangeParams, { kind: "ad_schedule" }>): SchedSlot[] =>
  p.days.map((day) => ({ day, startHour: p.startHour, startMinute: p.startMinute, endHour: p.endHour, endMinute: p.endMinute }));
const keywordKey = (x: { text: string; matchType: string }) => `${x.matchType}|${norm(cleanKeyword(x.text))}`;

// A2: the Google write path (amounts, minimums, messages) is still written for VND only.
// Until it is made currency-aware, writes are refused for any other account currency.
const GOOGLE_WRITE_CURRENCY = "VND";
const micros = (v: number) => String(Math.round(v / 1000) * 1000 * 1e6); // VND: round to the nearest 1,000
const parseJson = <T>(s: string, d: T): T => {
  try {
    return JSON.parse(s) as T;
  } catch {
    return d;
  }
};

/** Validate parameters before sending to Google (catches typos like an extra 0). Returns the error text in the UI language. */
function checkParams(p: GChangeParams, camp: GAdsCampaign, t: T): string | null {
  if (p.kind === "budget") {
    if (!camp.budgetId) return t("settings.googleWrite.noOwnBudget");
    if (!(p.amount > 0)) return t("settings.googleWrite.budgetPositive");
    if (camp.dailyBudget && (p.amount > camp.dailyBudget * 3 || p.amount < camp.dailyBudget * 0.2))
      return t("settings.googleWrite.budgetTooFar", { current: money(camp.dailyBudget, "VND") });
  }
  if (p.kind === "target_cpa") {
    if (!["MAXIMIZE_CONVERSIONS", "TARGET_CPA"].includes(camp.biddingStrategy)) return t("settings.googleWrite.cpaOnlyMaxConv");
    if (p.value != null && !(p.value >= 1000)) return t("settings.googleWrite.cpaMin");
    if (p.value == null && camp.biddingStrategy === "TARGET_CPA") return t("settings.googleWrite.cpaCannotRemove");
  }
  if (p.kind === "device" && p.bidModifier != null && (p.bidModifier < 0 || p.bidModifier > 10)) return t("settings.googleWrite.deviceRange");
  if (p.kind === "negatives") {
    if (!p.items.length) return t("settings.googleWrite.noNegatives");
    if (p.items.some((x) => !cleanKeyword(x.text))) return t("settings.googleWrite.emptyNegative");
  }
  if (p.kind === "keyword_status" && !p.keywords.length) return t("settings.googleWrite.noKeywords");
  if (p.kind === "ad_group_create") {
    if (camp.channelType !== "SEARCH") return t("settings.googleWrite.searchOnly");
    if (!p.name.trim() || p.name.length > 255) return t("settings.googleWrite.badGroupName");
    if (!/^https?:\/\/[^\s/]+\.[^\s]+$/.test(p.finalUrl.trim())) return t("settings.googleWrite.badUrl");
    const hs = p.headlines.map(cleanHeadline).filter(Boolean);
    const ds = p.descriptions.map(cleanDescription).filter(Boolean);
    if (hs.length < AD_LIMITS.minHeadlines || hs.length > AD_LIMITS.maxHeadlines) return t("settings.googleWrite.needHeadlines", { min: AD_LIMITS.minHeadlines, max: AD_LIMITS.maxHeadlines, n: hs.length });
    if (ds.length < AD_LIMITS.minDescriptions || ds.length > AD_LIMITS.maxDescriptions) return t("settings.googleWrite.needDescriptions", { min: AD_LIMITS.minDescriptions, max: AD_LIMITS.maxDescriptions, n: ds.length });
    const longH = hs.find((h) => gWidth(h) > AD_LIMITS.headline);
    if (longH) return t("settings.googleWrite.headlineTooLong", { max: AD_LIMITS.headline, text: longH });
    const longD = ds.find((d) => gWidth(d) > AD_LIMITS.description);
    if (longD) return t("settings.googleWrite.descriptionTooLong", { max: AD_LIMITS.description, text: longD });
    if (new Set(hs.map((h) => h.toLowerCase())).size < hs.length) return t("settings.googleWrite.duplicateHeadlines");
    const phone = [...hs, ...ds].find(hasPhone);
    if (phone) return t("settings.googleWrite.noPhones", { text: phone });
    if ([p.path1, p.path2].some((x) => gWidth(x) > AD_LIMITS.path)) return t("settings.googleWrite.pathTooLong", { max: AD_LIMITS.path });
    if (!p.keywords.length || p.keywords.length > 50) return t("settings.googleWrite.keywordCount");
    if (p.keywords.some((k) => !cleanKeyword(k.text))) return t("settings.googleWrite.emptyKeyword");
  }
  if (p.kind === "ad_group_switch" && !/^\d+$/.test(p.adGroupId)) return t("settings.googleWrite.noGroupId");
  if (p.kind === "ad_schedule") {
    if (!p.days.length || p.days.some((d) => !DAYS.includes(d))) return t("settings.googleWrite.pickDay");
    if (![p.startMinute, p.endMinute].every((m) => [0, 15, 30, 45].includes(m))) return t("settings.googleWrite.minutes");
    if (!(p.startHour >= 0 && p.startHour <= 23 && p.endHour >= 0 && p.endHour <= 24) || (p.endHour === 24 && p.endMinute !== 0)) return t("settings.googleWrite.badHour");
    if (p.startHour * 60 + p.startMinute >= p.endHour * 60 + p.endMinute) return t("settings.googleWrite.endAfterStart");
  }
  return null;
}

/** Human-readable title of a change. */
function describeChange(p: GChangeParams, camp: Pick<GAdsCampaign, "name" | "dailyBudget" | "targetCpa" | "schedule">, t: T) {
  switch (p.kind) {
    case "negatives":
      return t("settings.googleWrite.titleNegatives", { n: p.items.length });
    case "target_cpa":
      return p.value == null ? `${t("settings.googleWrite.titleRemoveCpa")}${camp.targetCpa ? ` (${t("settings.googleWrite.currently", { amount: money(camp.targetCpa, "VND") })})` : ""}` : `${t("settings.googleWrite.titleCpa")} ${camp.targetCpa ? `${money(camp.targetCpa, "VND")} → ` : ""}${money(p.value, "VND")}`;
    case "budget":
      return `${t("settings.googleWrite.titleBudget")} ${camp.dailyBudget ? `${money(camp.dailyBudget, "VND")} → ` : ""}${money(p.amount, "VND")}`;
    case "device":
      return p.bidModifier === 0 ? t("settings.googleWrite.titleDeviceOff", { device: deviceLabel(p.device, t).toLowerCase() }) : p.bidModifier == null || p.bidModifier === 1 ? t("settings.googleWrite.titleDeviceReset", { device: deviceLabel(p.device, t).toLowerCase() }) : `${deviceLabel(p.device, t)} ${p.bidModifier > 1 ? "+" : ""}${Math.round((p.bidModifier - 1) * 100)}%`;
    case "keyword_status":
      return t("settings.googleWrite.titleKeywordStatus", { status: statusLabel(p.status, t), what: p.keywords.length === 1 ? t("settings.googleWrite.oneKeyword", { text: p.keywords[0].text }) : t("settings.googleWrite.nKeywords", { n: p.keywords.length }) });
    case "campaign_status":
      return t("settings.googleWrite.titleCampaignStatus", { status: statusLabel(p.status, t) });
    case "ad_group_create":
      return t("settings.googleWrite.titleGroupCreate", { name: p.name, n: p.keywords.length });
    case "ad_schedule":
      return t("settings.googleWrite.titleSchedule", { from: fmtSchedule(parseJson<SchedSlot[]>(camp.schedule, []), t), to: fmtSchedule(schedSlots(p), t) });
    case "ad_group_switch":
      return t("settings.googleWrite.titleSwitch", { name: p.name, extra: p.pauseKeywords.length ? `, ${t("settings.googleWrite.stopDuplicates", { n: p.pauseKeywords.length })}` : "" });
  }
}

function beforeOf(p: GChangeParams, camp: GAdsCampaign) {
  const dev = parseJson<Record<string, DeviceStat>>(camp.devices, {});
  switch (p.kind) {
    case "target_cpa":
      return { targetCpa: camp.targetCpa };
    case "budget":
      return { amount: camp.dailyBudget };
    case "device":
      return { bidModifier: dev[p.device]?.bidModifier ?? null };
    case "campaign_status":
      return { status: camp.status };
    case "ad_schedule":
      return { schedule: parseJson<SchedSlot[]>(camp.schedule, []) };
    default:
      return {};
  }
}

/** Send one change to Google. validateOnly: check only (changes nothing). Returns a result description (+ id of the ad group just created). */
async function pushChange(customerId: string, camp: GAdsCampaign, p: GChangeParams, validateOnly = false): Promise<{ text: string; adGroupId?: string }> {
  const text = await push(customerId, camp, p, validateOnly);
  return typeof text === "string" ? { text } : text;
}

async function push(customerId: string, camp: GAdsCampaign, p: GChangeParams, validateOnly: boolean): Promise<string | { text: string; adGroupId?: string }> {
  const t = await getT();
  const cr = `customers/${customerId}/campaigns/${camp.id}`;
  const o = { validateOnly };
  switch (p.kind) {
    case "negatives": {
      const have = new Set(parseJson<{ text: string; matchType: string }[]>(camp.negatives, []).map(negKey));
      const items = [...new Map(p.items.map((x) => [negKey(x), { text: cleanKeyword(x.text), matchType: x.matchType }])).values()].filter((x) => !have.has(negKey(x)));
      if (!items.length) return t("settings.googleWrite.negativesExist");
      const r = await gmutate(customerId, "campaignCriteria", items.map((x) => ({ create: { campaign: cr, negative: true, keyword: { text: x.text, matchType: x.matchType } } })), { ...o, partialFailure: true });
      const okN = validateOnly ? items.length : (r.results ?? []).filter((x) => "resourceName" in x && x.resourceName).length;
      const skipped = p.items.length - items.length;
      return `${t("settings.googleWrite.doneNegatives", { ok: okN, total: items.length })}${skipped ? ` (${t("settings.googleWrite.skippedDup", { n: skipped })})` : ""}${r.partialFailureError?.message ? `. ${t("settings.googleWrite.errorPrefix", { message: r.partialFailureError.message })}` : ""}`;
    }
    case "target_cpa": {
      const field = camp.biddingStrategy === "TARGET_CPA" ? "targetCpa" : "maximizeConversions";
      // Remove target CPA: leave the field empty in updateMask → Google clears the value.
      const update = { resourceName: cr, [field]: p.value == null ? {} : { targetCpaMicros: micros(p.value) } };
      await gmutate(customerId, "campaigns", [{ update, updateMask: `${field}.targetCpaMicros` }], o);
      return p.value == null ? t("settings.googleWrite.doneRemoveCpa") : t("settings.googleWrite.doneSetCpa", { amount: money(p.value, "VND") });
    }
    case "budget":
      await gmutate(customerId, "campaignBudgets", [{ update: { resourceName: `customers/${customerId}/campaignBudgets/${camp.budgetId}`, amountMicros: micros(p.amount) }, updateMask: "amountMicros" }], o);
      return t("settings.googleWrite.doneBudget", { amount: money(Math.round(p.amount / 1000) * 1000, "VND") });
    case "device": {
      const bid = p.bidModifier ?? 1; // 1 = no adjustment
      const resourceName = `customers/${customerId}/campaignCriteria/${camp.id}~${DEVICE_CRITERION[p.device]}`;
      try {
        await gmutate(customerId, "campaignCriteria", [{ update: { resourceName, bidModifier: bid }, updateMask: "bidModifier" }], o);
      } catch (err) {
        // Campaign has no device criterion yet (never adjusted) → create one.
        if (!/NOT_FOUND|not found|RESOURCE_NOT_FOUND/i.test(String(err))) throw err;
        await gmutate(customerId, "campaignCriteria", [{ create: { campaign: cr, device: { type: p.device }, bidModifier: bid } }], o);
      }
      return describeChange(p, camp, t).replace(/^/, t("settings.googleWrite.donePrefix"));
    }
    case "keyword_status": {
      const ops = p.keywords.map((k) => ({ update: { resourceName: `customers/${customerId}/adGroupCriteria/${k.id}`, status: p.status }, updateMask: "status" }));
      await gmutate(customerId, "adGroupCriteria", ops, o);
      return t("settings.googleWrite.doneKeywordStatus", { status: statusDone(p.status, t), n: p.keywords.length });
    }
    case "campaign_status":
      await gmutate(customerId, "campaigns", [{ update: { resourceName: cr, status: p.status }, updateMask: "status" }], o);
      return t("settings.googleWrite.doneCampaignStatus", { status: statusDone(p.status, t) });
    case "ad_group_create": {
      // One atomic call: ad group (PAUSED) + keywords + ad; temp name -1 to attach to the just-created ad group.
      const ag = `customers/${customerId}/adGroups/-1`;
      const kws = [...new Map(p.keywords.map((k) => [keywordKey(k), { text: cleanKeyword(k.text), matchType: k.matchType }])).values()];
      const ops = [
        { adGroupOperation: { create: { resourceName: ag, campaign: cr, name: p.name.trim(), status: "PAUSED", type: "SEARCH_STANDARD" } } },
        ...kws.map((k) => ({ adGroupCriterionOperation: { create: { adGroup: ag, status: "ENABLED", keyword: k } } })),
        {
          adGroupAdOperation: {
            create: {
              adGroup: ag,
              status: "ENABLED",
              ad: {
                finalUrls: [p.finalUrl.trim()],
                responsiveSearchAd: {
                  headlines: p.headlines.map(cleanHeadline).filter(Boolean).map((text) => ({ text })),
                  descriptions: p.descriptions.map(cleanDescription).filter(Boolean).map((text) => ({ text })),
                  ...(p.path1.trim() && { path1: p.path1.trim() }),
                  ...(p.path1.trim() && p.path2.trim() && { path2: p.path2.trim() }),
                },
              },
            },
          },
        },
      ];
      const r = await gmutateAll(customerId, ops, o);
      const res = r.mutateOperationResponses?.[0]?.adGroupResult?.resourceName ?? "";
      const adGroupId = res.split("/").pop() || undefined;
      return { text: t("settings.googleWrite.doneGroupCreate", { name: p.name.trim(), n: kws.length }), adGroupId };
    }
    case "ad_schedule": {
      // Google ad schedule windows can't be edited: delete the old window and create a new one in the same call (on failure nothing changes).
      const old = parseJson<SchedSlot[]>(camp.schedule, []).filter((x) => x.id);
      const minute = (m: number) => ({ 0: "ZERO", 15: "FIFTEEN", 30: "THIRTY", 45: "FORTY_FIVE" })[m];
      const ops = [
        ...old.map((x) => ({ campaignCriterionOperation: { remove: `customers/${customerId}/campaignCriteria/${camp.id}~${x.id}` } })),
        ...p.days.map((day) => ({
          campaignCriterionOperation: {
            create: { campaign: cr, adSchedule: { dayOfWeek: day, startHour: p.startHour, startMinute: minute(p.startMinute), endHour: p.endHour, endMinute: minute(p.endMinute) } },
          },
        })),
      ];
      const r = await gmutateAll(customerId, ops, o);
      if (!validateOnly) {
        const ids = (r.mutateOperationResponses ?? []).slice(old.length).map((x) => x.campaignCriterionResult?.resourceName?.split("~").pop() ?? "");
        const slots = schedSlots(p).map((x, i) => ({ ...x, id: ids[i] || undefined }));
        await db.gAdsCampaign.update({ where: { id: camp.id }, data: { schedule: JSON.stringify(slots) } });
      }
      return t("settings.googleWrite.doneSchedule", { schedule: fmtSchedule(schedSlots(p), t) });
    }
    case "ad_group_switch": {
      const ops = [
        { adGroupOperation: { update: { resourceName: `customers/${customerId}/adGroups/${p.adGroupId}`, status: "ENABLED" }, updateMask: "status" } },
        ...p.pauseKeywords.map((k) => ({ adGroupCriterionOperation: { update: { resourceName: `customers/${customerId}/adGroupCriteria/${k.id}`, status: "PAUSED" }, updateMask: "status" } })),
      ];
      await gmutateAll(customerId, ops, o);
      return t("settings.googleWrite.doneSwitch", { name: p.name, extra: p.pauseKeywords.length ? ` ${t("settings.googleWrite.andPauseDuplicates", { n: p.pauseKeywords.length })}` : "" });
    }
  }
}

/** Update the DB copy right after editing (without waiting for the next sync). */
async function applyLocal(camp: GAdsCampaign, p: GChangeParams) {
  const where = { id: camp.id };
  switch (p.kind) {
    case "negatives": {
      const cur = parseJson<{ text: string; matchType: string }[]>(camp.negatives, []);
      const add = p.items.map((x) => ({ text: cleanKeyword(x.text), matchType: x.matchType }));
      const merged = [...new Map([...cur, ...add].map((x) => [negKey(x), x])).values()];
      return db.gAdsCampaign.update({ where, data: { negatives: JSON.stringify(merged) } });
    }
    case "target_cpa":
      return db.gAdsCampaign.update({ where, data: { targetCpa: p.value } });
    case "budget":
      return db.gAdsCampaign.update({ where, data: { dailyBudget: Math.round(p.amount / 1000) * 1000 } });
    case "device": {
      const dev = parseJson<Record<string, DeviceStat>>(camp.devices, {});
      dev[p.device] = { ...(dev[p.device] ?? { spend: 0, clicks: 0, conversions: 0 }), bidModifier: p.bidModifier == null || p.bidModifier === 1 ? null : p.bidModifier };
      return db.gAdsCampaign.update({ where, data: { devices: JSON.stringify(dev) } });
    }
    case "keyword_status":
      return db.gAdsKeyword.updateMany({ where: { clientId: camp.clientId, id: { in: p.keywords.map((k) => k.id) } }, data: { status: p.status } });
    case "campaign_status":
      return db.gAdsCampaign.update({ where, data: { status: p.status } });
    case "ad_schedule":
      return; // push already wrote the new schedule (with the schedule IDs Google returned)
    case "ad_group_create":
      return; // the new ad group enters the DB on the next sync (executeChange adds the ad group row itself)
    case "ad_group_switch":
      await db.gAdsAdGroup.updateMany({ where: { clientId: camp.clientId, id: p.adGroupId }, data: { status: "ENABLED" } });
      return db.gAdsKeyword.updateMany({ where: { clientId: camp.clientId, id: { in: p.pauseKeywords.map((k) => k.id) } }, data: { status: "PAUSED" } });
  }
}

/** Landing page URL must be on the same domain as the client's existing ads (blocks URLs Claude made up). */
async function checkFinalUrl(clientId: string, url: string) {
  const t = await getT();
  const hosts = new Set((await db.gAdsAd.findMany({ where: { clientId }, select: { finalUrl: true } })).flatMap((a) => {
    try {
      return [new URL(a.finalUrl).hostname.replace(/^www\./, "")];
    } catch {
      return [];
    }
  }));
  if (!hosts.size) return;
  let host = "";
  try {
    host = new URL(url.trim()).hostname.replace(/^www\./, "");
  } catch {
    throw new Error(t("settings.googleWrite.badUrl"));
  }
  if (!hosts.has(host)) throw new Error(t("settings.googleWrite.urlDomain", { hosts: [...hosts].join(", ") }));
}

/** After creating a new ad group: card "Enable new ad group + pause duplicate keywords in the old one", which the user enables when ready. */
async function proposeSwitch(camp: GAdsCampaign, p: Extract<GChangeParams, { kind: "ad_group_create" }>, adGroupId: string) {
  const t = await getT();
  await db.gAdsAdGroup.upsert({
    where: { id: adGroupId },
    create: { id: adGroupId, clientId: camp.clientId, campaignId: camp.id, name: p.name.trim(), status: "PAUSED" },
    update: { status: "PAUSED", name: p.name.trim() },
  });
  const want = new Set(p.keywords.map(keywordKey));
  const dup = (await db.gAdsKeyword.findMany({ where: { clientId: camp.clientId, campaignId: camp.id, status: "ENABLED", adGroupId: { not: adGroupId } } })).filter((k) => want.has(keywordKey(k)));
  await proposeChange({
    clientId: camp.clientId,
    campaign: camp,
    params: { kind: "ad_group_switch", adGroupId, name: p.name.trim(), pauseKeywords: dup.map((k) => ({ id: k.id, text: `${k.text} [${k.matchType}]` })) },
    source: "rule",
    rule: `switch:${adGroupId}`,
    rationale: t("settings.googleWrite.switchRationale", { extra: dup.length ? ` ${t("settings.googleWrite.switchExtra", { n: dup.length })}` : "" }),
  });
}

async function campaignOf(clientId: string, campaignId: string) {
  const camp = await db.gAdsCampaign.findFirst({ where: { id: campaignId, clientId } });
  if (!camp) throw new Error((await getT())("settings.googleWrite.campaignNotFound"));
  return camp;
}

/** Execute a GAdsChange (approved proposal or manual edit). edited: parameters the user changed before approving. */
export async function executeChange(change: GAdsChange, by: string, edited?: GChangeParams, immediate = false) {
  const t = await getT();
  if (change.status !== "pending") throw new Error(t("settings.googleWrite.alreadyHandled"));
  const client = await db.client.findUniqueOrThrow({ where: { id: change.clientId }, select: { googleCustomerId: true, googleCurrency: true } });
  if (!client.googleCustomerId) throw new Error(t("settings.googleWrite.noAccount"));
  if (client.googleCurrency !== GOOGLE_WRITE_CURRENCY)
    throw new Error(t("settings.googleWrite.currencyOnly", { currency: GOOGLE_WRITE_CURRENCY, actual: client.googleCurrency ? t("settings.googleWrite.inCurrency", { currency: client.googleCurrency }) : t("settings.googleWrite.currencyUnknown") }));
  const camp = await campaignOf(change.clientId, change.campaignId);
  const p = edited ?? (JSON.parse(change.params) as GChangeParams);
  if (p.kind !== change.kind) throw new Error(t("settings.googleWrite.paramMismatch"));
  const bad = checkParams(p, camp, t);
  if (bad) throw new Error(bad);
  // Reservation: only one run gets to execute (double click / 2 people approving at once).
  const lock = await db.gAdsChange.updateMany({ where: { id: change.id, status: "pending" }, data: { status: "running" } });
  if (!lock.count) throw new Error(t("settings.googleWrite.inProgress"));
  try {
    if (p.kind === "ad_group_create") await checkFinalUrl(change.clientId, p.finalUrl);
    const { text: result, adGroupId } = await pushChange(client.googleCustomerId, camp, p);
    await applyLocal(camp, p);
    if (p.kind === "ad_group_create" && adGroupId) await proposeSwitch(camp, p, adGroupId);
    await db.gAdsChange.update({
      where: { id: change.id },
      data: { status: "executed", result, params: JSON.stringify(p), title: describeChange(p, camp, t), before: JSON.stringify(beforeOf(p, camp)), decidedAt: new Date(), decidedBy: by },
    });
    await logActivity(change.clientId, "google", `Google Ads · ${camp.name}: ${result}`);
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // A failed pending card goes back to pending for editing; a failed manual edit (sent immediately) records the error.
    await db.gAdsChange.update({ where: { id: change.id }, data: immediate ? { status: "failed", result: msg, decidedAt: new Date(), decidedBy: by } : { status: "pending", result: t("settings.googleWrite.previousError", { message: msg }) } });
    throw err;
  }
}

/** Manual edit: create the record and execute immediately. */
export async function manualChange(clientId: string, campaignId: string, p: GChangeParams, by: string) {
  const t = await getT();
  const camp = await campaignOf(clientId, campaignId);
  const bad = checkParams(p, camp, t);
  if (bad) throw new Error(bad);
  const change = await db.gAdsChange.create({
    data: { clientId, kind: p.kind, campaignId, campaignName: camp.name, title: describeChange(p, camp, t), params: JSON.stringify(p), source: "manual" },
  });
  return executeChange(change, by, undefined, true);
}

/** Self-drafted new ad group: create a pending card pre-filled from the campaign's best-performing running ad; the user edits then approves. */
export async function draftAdGroup(clientId: string, campaignId: string, by: string) {
  const t = await getT();
  const camp = await campaignOf(clientId, campaignId);
  if (camp.channelType !== "SEARCH") throw new Error(t("settings.googleWrite.searchOnlyShort"));
  const ad = await db.gAdsAd.findFirst({ where: { clientId, campaignId }, orderBy: { spend: "desc" } });
  const p: GChangeParams = {
    kind: "ad_group_create",
    name: t("settings.googleWrite.newGroupName"),
    finalUrl: ad?.finalUrl ?? "",
    path1: ad?.path1 ?? "",
    path2: ad?.path2 ?? "",
    headlines: ad ? parseJson<string[]>(ad.headlines, []) : ["", "", ""],
    descriptions: ad ? parseJson<string[]>(ad.descriptions, []) : ["", ""],
    keywords: [],
  };
  await db.gAdsChange.create({
    data: {
      clientId,
      kind: p.kind,
      campaignId,
      campaignName: camp.name,
      title: t("settings.googleWrite.draftTitle"),
      rationale: t("settings.googleWrite.draftRationale", { by }),
      params: JSON.stringify(p),
      source: "manual",
      rule: `draft:${Date.now()}`,
    },
  });
}

/** Create a pending proposal (no duplicate of a pending proposal for the same rule + campaign; skipped if rejected within the last 7 days). */
export async function proposeChange(x: { clientId: string; campaign: Pick<GAdsCampaign, "id" | "name" | "dailyBudget" | "targetCpa" | "schedule">; params: GChangeParams; rationale: string; source: "rule" | "claude"; rule: string }) {
  const t = await getT();
  const recent = await db.gAdsChange.findFirst({
    where: {
      clientId: x.clientId,
      campaignId: x.campaign.id,
      rule: x.rule,
      // Claude runs when the user clicks the button: don't skip because of a previous rejection.
      OR: [{ status: "pending" }, ...(x.source === "claude" ? [] : [{ status: "rejected", decidedAt: { gte: new Date(Date.now() - 7 * 86400_000) } }])],
    },
  });
  if (recent?.status === "rejected") return null;
  const data = { title: describeChange(x.params, x.campaign, t), rationale: x.rationale, params: JSON.stringify(x.params), campaignName: x.campaign.name, createdAt: new Date(), result: null };
  if (recent) return { change: await db.gAdsChange.update({ where: { id: recent.id }, data }), created: false }; // refresh the metrics of the pending card
  return { change: await db.gAdsChange.create({ data: { ...data, clientId: x.clientId, kind: x.params.kind, campaignId: x.campaign.id, source: x.source, rule: x.rule } }), created: true };
}
