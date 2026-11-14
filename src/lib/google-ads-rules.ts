import { z } from "zod";
import type { GAdsCampaign } from "@prisma/client";
import { db } from "./db";
import { money, num } from "./format";
import type { DeviceStat } from "./google-ads-sync";
import { AD_LIMITS, cleanDescription, cleanHeadline, cleanKeyword, gWidth, proposeChange, type MatchType, type NegItem } from "./google-ads-write";
import { fmtSchedule, hasPhone, hhmm, priceTokens, type Day, type SchedSlot } from "./google-ads-text";
import { generateStructured } from "./ai/claude";
import { clientProfile } from "./ai/context";
import { GOOGLE_NEGATIVES_SYSTEM, GOOGLE_RESTRUCTURE_SYSTEM } from "./ai/prompts";
import { knowledgeContext } from "./knowledge";
import { norm } from "./text";
import { getT } from "@/i18n/server";

// Google Ads optimization proposals (await human approval, never auto-applied). Runs after each Google sync (scripts/daily.ts + Sync button).
// Rules (30-day metrics unless stated otherwise) — when changing thresholds also update the wzone-meta-rules skill (Google section):
// - tcpa_check: target CPA is choking delivery (last 2 days CPC ≥ 2x and clicks ≤ 1/2 compared with the 7 days before) → remove target CPA;
//   or target CPA < 80% of actual CPA (≥ 10 conversions) → raise it to the actual level.
// - device_waste: desktop spends ≥ 200k and ≥ 3% of the campaign with CPA ≥ 3x mobile (or 0 conversions, spend ≥ 2x mobile CPA) → exclude desktop.
// - budget_limited: ≥ 40% impressions lost to budget, ≥ 10 conversions, CPA ≤ account-wide CPA, no choking target CPA → +20% budget.
// - term_waste: search term with ≥ 5 clicks, 0 conversions, spend ≥ 1/2 campaign CPA → exact-match negative (user ticks to select).
// - keyword_waste: enabled keyword with ≥ 10 clicks, 0 conversions, spend ≥ max(3x campaign CPA, 100k) → pause.
// - schedule_budget: yesterday spent ≥ 85% of budget but spend from 18h to end time < 1/2 of that share of the schedule, and over the last 30 days the 17h–end window produced ≥ 25% of conversions
//   or CPA no higher than 1.2x the full day → push the start time later (keeping yesterday's actual running hours) so budget concentrates in the evening.

const per = (a: number, b: number) => (b > 0 ? a / b : null);
const round1k = (v: number) => Math.round(v / 1000) * 1000;
const parse = <T>(s: string, d: T): T => {
  try {
    return JSON.parse(s) as T;
  } catch {
    return d;
  }
};

/** Date YYYY-MM-DD n days from today (VN time). */
const dayAgo = (n: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date(Date.now() - n * 86400_000));

export async function runGoogleRules(clientId: string) {
  const tr = await getT();
  const [camps, daily, keywords, terms] = await Promise.all([
    db.gAdsCampaign.findMany({ where: { clientId, status: "ENABLED" } }),
    db.gAdsDaily.findMany({ where: { clientId, date: { gte: dayAgo(10) } } }),
    db.gAdsKeyword.findMany({ where: { clientId, status: "ENABLED" } }),
    db.gAdsSearchTerm.findMany({ where: { clientId, status: "NONE" } }),
  ]);
  const acc = camps.reduce((a, c) => ({ spend: a.spend + c.spend, conv: a.conv + c.conversions }), { spend: 0, conv: 0 });
  const accCpa = per(acc.spend, acc.conv);
  let n = 0;
  const propose = async (...a: Parameters<typeof proposeChange>) => {
    if ((await proposeChange(...a))?.created) n++;
  };

  for (const c of camps) {
    const cpa = c.conversions >= 3 ? per(c.spend, c.conversions) : null;
    let tcpaChoked = false;

    // --- Target CPA
    if (c.targetCpa) {
      const d = daily.filter((x) => x.campaignId === c.id);
      const sum = (from: number, to: number) =>
        d.filter((x) => x.date >= dayAgo(from) && x.date <= dayAgo(to)).reduce((a, x) => ({ spend: a.spend + x.spend, clicks: a.clicks + x.clicks, days: a.days + 1 }), { spend: 0, clicks: 0, days: 0 });
      const last = sum(2, 1); // last 2 days (through yesterday)
      const prev = sum(9, 3); // the 7 days before that
      const cpcLast = per(last.spend, last.clicks);
      const cpcPrev = per(prev.spend, prev.clicks);
      if (last.days === 2 && prev.days >= 5 && cpcLast && cpcPrev && cpcLast >= 2 * cpcPrev && last.clicks / 2 <= (prev.clicks / prev.days) * 0.5) {
        tcpaChoked = true;
        await propose({
          clientId,
          campaign: c,
          params: { kind: "target_cpa", value: null },
          source: "rule",
          rule: "tcpa_check",
          rationale: tr("settings.googleRules.tcpaChoked", { cpcLast: money(cpcLast, "VND"), ratio: (cpcLast / cpcPrev).toFixed(1).replace(".", ","), cpcPrev: money(cpcPrev, "VND"), clicksLast: num(last.clicks / 2), clicksPrev: num(prev.clicks / prev.days), target: money(c.targetCpa, "VND") }),
        });
      } else if (cpa && c.conversions >= 10 && c.targetCpa < 0.8 * cpa) {
        await propose({
          clientId,
          campaign: c,
          params: { kind: "target_cpa", value: round1k(cpa) },
          source: "rule",
          rule: "tcpa_check",
          rationale: tr("settings.googleRules.tcpaLow", { target: money(c.targetCpa, "VND"), cpa: money(cpa, "VND"), conversions: num(c.conversions) }),
        });
      }
    }

    // --- Device: desktop
    const dev = parse<Record<string, DeviceStat>>(c.devices, {});
    const dt = dev.DESKTOP;
    const mb = dev.MOBILE;
    if (dt && mb && dt.bidModifier !== 0 && c.spend > 0 && dt.spend >= 0.03 * c.spend && dt.spend >= 200_000 && mb.conversions >= 5) {
      const cpaM = mb.spend / mb.conversions;
      const cpaD = per(dt.spend, dt.conversions);
      if ((cpaD && cpaD >= 3 * cpaM) || (!cpaD && dt.spend >= 2 * cpaM)) {
        await propose({
          clientId,
          campaign: c,
          params: { kind: "device", device: "DESKTOP", bidModifier: 0 },
          source: "rule",
          rule: "device_waste",
          rationale: tr("settings.googleRules.deviceWaste", { spend: money(dt.spend, "VND"), conversions: num(dt.conversions), perConv: cpaD ? ` (${tr("settings.googleRules.perConversion", { amount: money(cpaD, "VND") })})` : "", mobile: money(cpaM, "VND") }),
        });
      }
    }

    // --- Budget
    if (!tcpaChoked && !c.budgetShared && c.dailyBudget && (c.lostBudgetShare ?? 0) >= 0.4 && c.conversions >= 10 && cpa && accCpa && cpa <= accCpa) {
      await propose({
        clientId,
        campaign: c,
        params: { kind: "budget", amount: round1k(c.dailyBudget * 1.2) },
        source: "rule",
        rule: "budget_limited",
        rationale: tr("settings.googleRules.budgetLimited", { lost: Math.round((c.lostBudgetShare ?? 0) * 100), cpa: money(cpa, "VND"), accCpa: money(accCpa, "VND") }),
      });
    }

    // --- Budget runs out before evening → shift schedule
    await scheduleRule(clientId, c, propose);

    if (c.channelType !== "SEARCH") continue;
    const kwTexts = keywords.filter((k) => k.campaignId === c.id).map((k) => norm(cleanKeyword(k.text)));

    // --- Costly search terms, 0 conversions
    const minSpend = cpa ? cpa / 2 : 50_000;
    const waste = terms
      .filter((t) => t.campaignId === c.id && t.conversions === 0 && t.clicks >= 5 && t.spend >= minSpend && !kwTexts.includes(norm(cleanKeyword(t.term))))
      .sort((a, b) => b.spend - a.spend);
    const byTerm = new Map<string, NegItem>();
    for (const t of waste) {
      const k = cleanKeyword(t.term);
      const x = byTerm.get(k);
      if (x) {
        x.spend! += t.spend;
        x.clicks! += t.clicks;
      } else byTerm.set(k, { text: k, matchType: "EXACT", spend: t.spend, clicks: t.clicks, conversions: 0 });
    }
    const items = [...byTerm.values()].slice(0, 30);
    if (items.length) {
      await propose({
        clientId,
        campaign: c,
        params: { kind: "negatives", items },
        source: "rule",
        rule: "term_waste",
        rationale: tr("settings.googleRules.termWaste", { count: items.length, total: money(items.reduce((a, x) => a + (x.spend ?? 0), 0), "VND") }),
      });
    }

    // --- Costly keywords, 0 conversions
    const kwBad = keywords.filter((k) => k.campaignId === c.id && k.conversions === 0 && k.clicks >= 10 && k.spend >= Math.max(cpa ? 3 * cpa : 0, 100_000));
    if (kwBad.length) {
      await propose({
        clientId,
        campaign: c,
        params: { kind: "keyword_status", status: "PAUSED", keywords: kwBad.map((k) => ({ id: k.id, text: k.text })) },
        source: "rule",
        rule: "keyword_waste",
        rationale: tr("settings.googleRules.keywordWaste", { list: kwBad.map((k) => tr("settings.googleRules.keywordItem", { text: k.text, spend: money(k.spend, "VND"), clicks: num(k.clicks) })).join(", "), campaign: cpa ? `, ${tr("settings.googleRules.whileCampaign", { amount: money(cpa, "VND") })}` : "" }),
      });
    }
  }
  return n;
}

/** schedule_budget rule (see top of file). */
async function scheduleRule(clientId: string, c: GAdsCampaign, propose: (...a: Parameters<typeof proposeChange>) => Promise<void>) {
  const tr = await getT();
  const slots = parse<SchedSlot[]>(c.schedule, []);
  if (!slots.length || !c.dailyBudget) return;
  // Most common time window (most clients set one window for every day).
  const count = new Map<string, number>();
  for (const x of slots) count.set(`${x.startHour}:${x.startMinute}-${x.endHour}:${x.endMinute}`, (count.get(`${x.startHour}:${x.startMinute}-${x.endHour}:${x.endMinute}`) ?? 0) + 1);
  const [win] = [...count].sort((a, b) => b[1] - a[1])[0];
  const [sh, sm, eh, em] = win.split(/[-:]/).map(Number);
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  if (end < 20 * 60) return; // schedule ends before 20h: not an evening issue

  const day = parse<Record<string, number>>(c.lastDayHours, {});
  const total = Object.values(day).reduce((a, v) => a + v, 0);
  if (total < 0.85 * c.dailyBudget) return; // yesterday didn't spend the whole budget
  const evening = Object.entries(day).filter(([h]) => Number(h) >= 18).reduce((a, [, v]) => a + v, 0);
  // Share of the schedule from 18h to end time; evening spend below half of that share = ran out of money early.
  const eveShareOfHours = (end - Math.max(start, 18 * 60)) / (end - start);
  if (evening >= 0.5 * eveShareOfHours * total) return;
  // Money-out hour: the first hour where cumulative spend ≥ 90%.
  let acc = 0;
  let out = 24;
  for (let h = 0; h < 24; h++) {
    acc += day[String(h)] ?? 0;
    if (acc >= 0.9 * total) {
      out = h + 1;
      break;
    }
  }
  const served = out * 60 - start;
  const newStart = Math.floor((end - served) / 30) * 30;
  if (newStart < start + 60 || newStart > end - 120) return;

  const hrs = parse<Record<string, { spend: number; clicks: number; conversions: number }>>(c.hours, {});
  const sum = (from: number) => Object.entries(hrs).filter(([h]) => Number(h) >= from).reduce((a, [, v]) => ({ spend: a.spend + v.spend, conv: a.conv + v.conversions }), { spend: 0, conv: 0 });
  const all = sum(0);
  const eve = sum(17);
  const cpaAll = per(all.spend, all.conv);
  const cpaEve = per(eve.spend, eve.conv);
  const share = all.conv ? eve.conv / all.conv : 0;
  if (!(share >= 0.25 || (cpaAll && cpaEve && cpaEve <= 1.2 * cpaAll))) return;

  const days = [...new Set(slots.map((x) => x.day))] as Day[];
  const params = { kind: "ad_schedule" as const, days, startHour: Math.floor(newStart / 60), startMinute: newStart % 60, endHour: eh, endMinute: em };
  await propose({
    clientId,
    campaign: c,
    params,
    source: "rule",
    rule: "schedule_budget",
    rationale: [
      tr("settings.googleRules.scheduleYesterday", { total: money(total, "VND"), budget: money(c.dailyBudget, "VND"), out, end: hhmm(eh, em), evening: money(evening, "VND") }),
      tr("settings.googleRules.scheduleEvening", { end: hhmm(eh, em), share: Math.round(share * 100), perConv: cpaEve ? `, ${tr("settings.googleRules.perConversion", { amount: money(cpaEve, "VND") })}` : "", allDay: cpaAll ? ` (${tr("settings.googleRules.allDay", { amount: money(cpaAll, "VND") })})` : "" }),
      tr("settings.googleRules.scheduleShift", { from: hhmm(sh, sm), to: hhmm(params.startHour, params.startMinute), current: fmtSchedule(slots, tr) }),
    ].join("\n"),
  });
}

// ------------------------------------------------------------------ Claude filters off-target search terms

const NegativesSchema = z.object({
  campaigns: z.array(
    z.object({
      campaignId: z.string(),
      items: z.array(z.object({ text: z.string(), matchType: z.enum(["EXACT", "PHRASE"]), reason: z.string() })),
    }),
  ),
  summary: z.string(),
});

/**
 * Whether a negative would block a running keyword. Compared without diacritics (Google treats "bep me in" and "bếp mẹ ỉn" as nearly the same).
 * EXACT: identical to a keyword. PHRASE/BROAD: every word of the negative is contained in a keyword.
 */
function blocksKeyword(neg: { text: string; matchType: MatchType }, kw: string[]) {
  const t = norm(cleanKeyword(neg.text));
  const kwn = kw.map((k) => norm(cleanKeyword(k)));
  if (neg.matchType === "EXACT") return kwn.includes(t);
  const words = t.split(" ");
  return kwn.some((k) => {
    const kws = k.split(" ");
    return words.every((w) => kws.includes(w));
  });
}

/** Claude reads search terms of active Search campaigns → "Add negative keywords" cards awaiting approval (one card per campaign). */
export async function claudeGoogleNegatives(clientId: string) {
  const tr = await getT();
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId } });
  const camps = (await db.gAdsCampaign.findMany({ where: { clientId, status: "ENABLED", channelType: "SEARCH" } })) as GAdsCampaign[];
  if (!camps.length) return tr("settings.googleRules.noSearchCampaigns");
  const [keywords, terms] = await Promise.all([
    db.gAdsKeyword.findMany({ where: { clientId, campaignId: { in: camps.map((c) => c.id) }, status: { not: "REMOVED" } } }),
    // Terms with ≥ 2 clicks, at most 150 terms/campaign (sporadic 1-click terms aren't worth negating; a compact prompt makes Claude answer quickly).
    db.gAdsSearchTerm.findMany({ where: { clientId, campaignId: { in: camps.map((c) => c.id) }, status: "NONE", clicks: { gte: 2 } }, orderBy: { spend: "desc" } }),
  ]);
  if (!terms.length) return tr("settings.googleRules.noTerms");
  const r0 = (v: number) => Math.round(v);
  const data = camps.map((c) => ({
    campaignId: c.id,
    name: c.name,
    keywords_dang_chay: [...new Set(keywords.filter((k) => k.campaignId === c.id && k.status === "ENABLED").map((k) => k.text.toLowerCase()))],
    phu_dinh_da_co: parse<{ text: string; matchType: string }[]>(c.negatives, []).map((x) => `${x.text} [${x.matchType}]`),
    cum_tim_kiem_30_ngay: terms
      .filter((t) => t.campaignId === c.id)
      .slice(0, 150)
      .map((t) => [t.term, r0(t.spend), t.clicks, r0(t.conversions)]),
  }));
  // Menu / products in the Knowledge base so Claude knows what is actually sold (capped at 12,000 characters to keep the prompt compact).
  const kb = (await knowledgeContext(clientId, 12_000)).text;
  const { data: out } = await generateStructured({
    system: GOOGLE_NEGATIVES_SYSTEM,
    prompt: `${clientProfile(client)}\n\n${kb ? `${tr("settings.googleRules.kbHeadMenu")}\n${kb}\n\n` : ""}${tr("settings.googleRules.negPromptIntro")}\n${JSON.stringify(data)}`,
    schema: NegativesSchema,
    effort: "low",
    clientId,
  });
  let cards = 0;
  let total = 0;
  for (const g of out.campaigns) {
    const c = camps.find((x) => x.id === g.campaignId);
    if (!c) continue;
    const kw = keywords.filter((k) => k.campaignId === c.id).map((k) => k.text.toLowerCase());
    const have = new Set(parse<{ text: string; matchType: string }[]>(c.negatives, []).map((x) => `${x.matchType}|${cleanKeyword(x.text)}`));
    const items: NegItem[] = [];
    for (const it of g.items) {
      const text = cleanKeyword(it.text);
      if (!text || have.has(`${it.matchType}|${text}`) || blocksKeyword({ text, matchType: it.matchType }, kw) || items.some((x) => x.text === text && x.matchType === it.matchType)) continue;
      // Metrics: terms matching exactly (EXACT) or every term containing all the words (PHRASE).
      const words = text.split(" ");
      const hit = terms.filter((t) => t.campaignId === c.id && (it.matchType === "EXACT" ? cleanKeyword(t.term) === text : words.every((w) => cleanKeyword(t.term).split(" ").includes(w))));
      items.push({ text, matchType: it.matchType, reason: it.reason, spend: hit.reduce((a, t) => a + t.spend, 0), clicks: hit.reduce((a, t) => a + t.clicks, 0), conversions: hit.reduce((a, t) => a + t.conversions, 0) });
    }
    if (!items.length) continue;
    items.sort((a, b) => (b.spend ?? 0) - (a.spend ?? 0));
    const spend = items.reduce((a, x) => a + (x.spend ?? 0), 0);
    if (
      await proposeChange({
        clientId,
        campaign: c,
        params: { kind: "negatives", items: items.slice(0, 40) },
        source: "claude",
        rule: "claude_negatives",
        rationale: `${tr("settings.googleRules.negRationale", { count: items.length, spend: money(spend, "VND") })} ${out.summary}`.slice(0, 1200),
      })
    ) {
      cards++;
      total += items.length;
    }
  }
  return cards ? tr("settings.googleRules.negDone", { total, cards }) : `${tr("settings.googleRules.negNone")} ${out.summary}`.slice(0, 300);
}

// ------------------------------------------------------------------ Claude splits ad groups & writes ads (raising quality score)

const RestructureSchema = z.object({
  landingNotes: z.string(),
  groups: z.array(
    z.object({
      name: z.string(),
      theme: z.string(),
      why: z.string(),
      keywords: z.array(z.object({ text: z.string(), matchType: z.enum(["EXACT", "PHRASE", "BROAD"]) })),
      finalUrl: z.string(),
      path1: z.string(),
      path2: z.string(),
      headlines: z.array(z.string()),
      descriptions: z.array(z.string()),
    }),
  ),
});

/** Truncate a string by Google-style length (without cutting mid-word if possible). */
function fitWidth(s: string, max: number) {
  if (gWidth(s) <= max) return s;
  let out = "";
  for (const w of s.split(" ")) {
    const next = out ? `${out} ${w}` : w;
    if (gWidth(next) > max) break;
    out = next;
  }
  return out;
}

/**
 * Claude proposes new ad groups (keywords + RSA) for each active Search campaign → "Create group" cards awaiting approval,
 * created on Google in paused state. One call per campaign (bundling several campaigns makes Claude run over 15 minutes).
 */
export async function claudeGoogleRestructure(clientId: string) {
  const tr = await getT();
  const QP: Record<string, string> = { BELOW_AVERAGE: tr("settings.googleRules.qBelow"), AVERAGE: tr("settings.googleRules.qAverage"), ABOVE_AVERAGE: tr("settings.googleRules.qAbove") };
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId } });
  const camps = await db.gAdsCampaign.findMany({ where: { clientId, status: "ENABLED", channelType: "SEARCH" }, orderBy: { spend: "desc" } });
  if (!camps.length) return tr("settings.googleRules.noSearchCampaigns");
  const ids = camps.map((c) => c.id);
  const [groups, keywords, ads, terms] = await Promise.all([
    db.gAdsAdGroup.findMany({ where: { clientId, campaignId: { in: ids } } }),
    db.gAdsKeyword.findMany({ where: { clientId, campaignId: { in: ids }, status: "ENABLED" }, orderBy: { spend: "desc" } }),
    db.gAdsAd.findMany({ where: { clientId, campaignId: { in: ids }, status: "ENABLED" }, orderBy: { spend: "desc" } }),
    db.gAdsSearchTerm.findMany({ where: { clientId, campaignId: { in: ids }, status: "NONE", conversions: { gte: 2 } }, orderBy: { conversions: "desc" } }),
  ]);
  if (!keywords.length) return tr("settings.googleRules.noKeywords");
  const gName = new Map(groups.map((g) => [g.id, g.name]));
  const r0 = (v: number) => Math.round(v);
  const kb = (await knowledgeContext(clientId, 8_000)).text;
  const head = `${clientProfile(client)}\n\n${kb ? `${tr("settings.googleRules.kbHead")}\n${kb}\n\n` : ""}`;
  // Prices in new ads must appear in the client description / Knowledge base / running ads (blocks prices Claude made up).
  const knownPrices = new Set(priceTokens([client.brief, kb, ...ads.flatMap((a) => [...parse<string[]>(a.headlines, []), ...parse<string[]>(a.descriptions, [])])].join("\n")));
  const okLine = (t: string) => t && !hasPhone(t) && priceTokens(t).every((p) => knownPrices.has(p));

  let cards = 0;
  const skipped: string[] = [];
  for (const c of camps) {
    const kwHere = keywords.filter((k) => k.campaignId === c.id);
    if (!kwHere.length) continue;
    const adsHere = ads.filter((a) => a.campaignId === c.id);
    const termsHere = terms.filter((t) => t.campaignId === c.id);
    const urls = [...new Set(adsHere.map((a) => a.finalUrl).filter(Boolean))];
    const data = {
      name: c.name,
      urls_dang_dung: urls,
      // [keyword, match type, ad group, score, CTR, Ad, Page, spend, clicks, conversions]
      tu_khoa: kwHere
        .slice(0, 80)
        .map((k) => [k.text, k.matchType, gName.get(k.adGroupId) ?? "", k.qualityScore, QP[k.ctrQuality ?? ""] ?? null, QP[k.adRelevance ?? ""] ?? null, QP[k.landingPage ?? ""] ?? null, r0(k.spend), k.clicks, r0(k.conversions)]),
      quang_cao_dang_chay: adsHere
        .slice(0, 3)
        .map((a) => ({ nhom: gName.get(a.adGroupId) ?? "", do_manh: a.adStrength, tieu_de: parse<string[]>(a.headlines, []), mo_ta: parse<string[]>(a.descriptions, []), url: a.finalUrl })),
      cum_tim_kiem_co_chuyen_doi: termsHere.slice(0, 25).map((t) => [t.term, r0(t.spend), t.clicks, r0(t.conversions)]),
    };
    let out: z.infer<typeof RestructureSchema>;
    try {
      ({ data: out } = await generateStructured({
        system: GOOGLE_RESTRUCTURE_SYSTEM,
        prompt: `${head}${tr("settings.googleRules.restructureHead")}\n${JSON.stringify(data)}`,
        schema: RestructureSchema,
        effort: "low",
        clientId,
      }));
    } catch (err) {
      skipped.push(`${c.name}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const allowed = new Map<string, { text: string; matchType: MatchType }>();
    for (const k of kwHere) allowed.set(norm(cleanKeyword(k.text)), { text: k.text, matchType: k.matchType as MatchType });
    for (const t of termsHere) if (!allowed.has(norm(cleanKeyword(t.term)))) allowed.set(norm(cleanKeyword(t.term)), { text: cleanKeyword(t.term), matchType: "PHRASE" });
    // Replace this campaign's old Claude cards (not yet approved) with the new run.
    await db.gAdsChange.deleteMany({ where: { clientId, campaignId: c.id, status: "pending", rule: { startsWith: "claude_group:" } } });
    let i = 0;
    for (const g of out.groups.slice(0, 5)) {
      // Keywords: keep only running keywords / terms that already converted (keeping the original match type of running keywords).
      const kws = [
        ...new Map(
          g.keywords.flatMap((k) => {
            const a = allowed.get(norm(cleanKeyword(k.text)));
            return a ? [[`${a.matchType}|${norm(a.text)}`, a] as const] : [];
          }),
        ).values(),
      ];
      const headlines = [...new Map(g.headlines.map(cleanHeadline).filter((h) => okLine(h) && gWidth(h) <= AD_LIMITS.headline).map((h) => [h.toLowerCase(), h])).values()].slice(0, AD_LIMITS.maxHeadlines);
      const descriptions = g.descriptions.map(cleanDescription).filter((d) => okLine(d) && gWidth(d) <= AD_LIMITS.description).slice(0, AD_LIMITS.maxDescriptions);
      if (kws.length < 1 || headlines.length < AD_LIMITS.minHeadlines || descriptions.length < AD_LIMITS.minDescriptions) continue;
      const finalUrl = urls.includes(g.finalUrl.trim()) ? g.finalUrl.trim() : (urls[0] ?? "");
      if (!finalUrl) continue;
      const stats = kws.map((k) => kwHere.find((x) => norm(x.text) === norm(k.text) && x.matchType === k.matchType)).filter((x) => !!x);
      const spend = stats.reduce((a, x) => a + x.spend, 0);
      const lowQs = stats.filter((x) => x.qualityScore != null && x.qualityScore <= 4).length;
      i++;
      const r = await proposeChange({
        clientId,
        campaign: c,
        params: {
          kind: "ad_group_create",
          name: g.name.slice(0, 120),
          finalUrl,
          path1: fitWidth(g.path1.replace(/\s+/g, "-"), AD_LIMITS.path),
          path2: fitWidth(g.path2.replace(/\s+/g, "-"), AD_LIMITS.path),
          headlines,
          descriptions,
          keywords: kws,
          why: g.why,
        },
        source: "claude",
        rule: `claude_group:${c.id}:${i}`,
        rationale: [
          `${g.theme}. ${g.why}`,
          tr("settings.googleRules.groupStats", { keywords: kws.length, running: stats.length, spend: money(spend, "VND"), lowQs: lowQs ? `, ${tr("settings.googleRules.lowQs", { n: lowQs })}` : "" }),
          i === 1 && out.landingNotes ? `${tr("settings.googleRules.landing")} ${out.landingNotes}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      });
      if (r) cards++;
    }
  }
  if (!cards && skipped.length) throw new Error(skipped.join("; ").slice(0, 400));
  return `${cards ? tr("settings.googleRules.groupsDone", { cards }) : tr("settings.googleRules.groupsNone")}${skipped.length ? `. ${tr("settings.googleRules.skipped", { list: skipped.join("; ") })}` : ""}`.slice(0, 500);
}
