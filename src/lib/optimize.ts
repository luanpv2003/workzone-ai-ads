import type { Client, Recommendation } from "@prisma/client";
import { db } from "./db";
import { getMetaClient } from "./meta";
import { logActivity, errorMessage } from "./activity";
import { budgetStep, money, roundBudget } from "./format";
import { checkBudget, recommendationHistory } from "./recommendations";
import { extractTargetingItems, audiencePromptSection, type FitItem, type RankedTargeting } from "./audience";
import { catalog } from "./targeting";
import { industryPromptSection } from "./industry-stats";
import { generateStructured } from "./ai/claude";
import { OPTIMIZE_SYSTEM } from "./ai/prompts";
import { OptimizeAiSchema, type OptimizeAi } from "./ai/schemas";
import { clientProfile, latestConversationInsights } from "./ai/context";
import { knowledgePromptSection } from "./knowledge";
import type { AdVariant, DuplicateOpts, OptimizeSnapshot, PeriodMetrics } from "./meta/types";
import { pctLabel, probCprAbove, probLowerProportion, probMoreExpensive } from "./stats";
import { qualityByAd, type AdQuality } from "./lead-quality";
import { creativePromptSection } from "./creative-analysis";
import { targetCprOf, targetLabelOf } from "./target-cpr";
import { checkForeignLeak, expatItems, FOREIGN_AGE } from "./foreign-targeting";
import type { TargetingPatch } from "./meta/types";
import { localTime } from "./schedule";
import { getT } from "@/i18n/server";
import { translator, type T } from "@/i18n/translate";

// Phase 3: optimize each running campaign.
// Layer 1 = rules (computed, only conclude with enough data). Layer 2 = Claude writes the rationale + new ad copy + picks test audiences.
// All recommendations go to the "Chờ duyệt" (pending approval) queue; new ad sets / ads are always created PAUSED. Never deletes anything.

const DAY = 86400000;
/**
 * An object just optimized waits at least 3 days before being recommended again (so Meta re-learns and metrics stabilize).
 * Exceptions (coolingFor): further budget increases after optScaleGapHours; pausing doesn't wait.
 */
const COOLDOWN_DAYS = 3;

export type DuplicateParams = Omit<DuplicateOpts, "name" | "dailyBudget" | "detailedTargeting" | "advantageAudience"> & {
  sourceAdSetId: string;
  name: string;
  dailyBudget: number | null;
  detailedTargeting: { id: string; name: string; type: string }[] | null; // null = keep the old audience
  advantageAudience: boolean | null;
  candidates?: { id: string; name: string; type: string; note?: string; untested?: boolean }[]; // for the approver to re-pick
  targetingNote?: string; // describes the audience changes vs the original ad set (language, age...) to show on the approval card
  createdId?: string;
};
export type AddAdParams = { adSetId: string; templateAdId: string; templateName: string; variants: AdVariant[]; createdIds?: string[] };
/** Edit a running ad set's audience (foreign customers): drop languages leaking to Vietnamese users, narrow the age. */
export type UpdateTargetingParams = { adSetId: string; patch: TargetingPatch; before: { locales: string; age: string }; after: { locales: string; age: string }; issues: string[]; keepLocales: number[] };

type Finding = {
  id: string;
  rule: string;
  action: "pause" | "update_budget" | "duplicate_adset" | "add_ad" | "update_targeting" | "manual";
  level: "campaign" | "adset" | "ad";
  targetId: string;
  targetName: string;
  priority: "high" | "medium" | "low";
  facts: string; // metric-based rationale (used when Claude can't run)
  title: string;
  newDailyBudget?: number;
  params?: DuplicateParams | AddAdParams | UpdateTargetingParams;
  /** This action resets the ad set's learning (shows a warning on the approval card). */
  learningReset?: string;
  /** Budget increase: the ad set is exhausting its budget early in the day (condition for the system to auto-increase). */
  limited?: boolean;
  evidence: Record<string, unknown>;
};

/** [Meta] An ad set needs ~50 results/week to exit the learning phase (Meta optimization handbook, section A). */
const LEARNING_EVENTS = 50;
/** If 3-day CPM rises more than this vs 7-day, attribute it to the auction rather than creative fatigue (section D). */
const CPM_STABLE = 1.15;

const cpr = (m: PeriodMetrics) => (m.results ? m.spend / m.results : null);
const ctr = (m: PeriodMetrics) => (m.impressions ? m.clicks / m.impressions : 0);
const freq = (m: PeriodMetrics) => (m.reach ? m.impressions / m.reach : 0);
const cpm = (m: PeriodMetrics) => (m.impressions ? (m.spend / m.impressions) * 1000 : null);
/** High frequency + 3-day CTR down > 20% vs 7-day. */
const ctrDropped = (s: { m7: PeriodMetrics; m3: PeriodMetrics }, th: Thresholds) => freq(s.m7) > th.freqMax && s.m7.impressions > 1000 && ctr(s.m3) < 0.8 * ctr(s.m7);
/** 3-day CPM up sharply vs 7-day: sign of a more expensive auction. */
const cpmRising = (s: { m7: PeriodMetrics; m3: PeriodMetrics }) => {
  const c3 = cpm(s.m3);
  const c7 = cpm(s.m7);
  return c3 != null && c7 != null && c3 > CPM_STABLE * c7;
};
const isFatigued = (s: { m7: PeriodMetrics; m3: PeriodMetrics }, th: Thresholds) => ctrDropped(s, th) && !cpmRising(s);
const ageDays = (iso: string) => (Date.now() - new Date(iso).getTime()) / DAY;
const ev = (m: PeriodMetrics, cur: string) => ({
  spend: money(m.spend, cur),
  results: m.results,
  cpr: cpr(m) != null ? money(cpr(m), cur) : "—",
  freq: +freq(m).toFixed(2),
  ctr: `${(ctr(m) * 100).toFixed(2)}%`,
});

// ------------------------------------------------------------ Thresholds (per-client Settings + self-tuned from past outcomes)

export type Thresholds = {
  warnPct: number;
  pausePct: number;
  mode: "suggest" | "warn";
  minSpendX: number;
  confidence: number; // 0-1
  freqMax: number;
  budgetStepPct: number;
  minAgeDays: number; // new ad sets / ads must run at least X days before regular rules apply
  earlyPct: number; // early cut: costlier than the baseline by ≥ X% ...
  earlySpendX: number; // ... and spent ≥ X times the baseline CPR (including new / learning ad sets)
  scaleMinResults: number;
  scaleConfidence: number; // 0-1, confidence that the ad set is cheaper than the baseline to increase budget (pausing uses confidence)
  scaleSpendPct: number; // "budget exhausted early": today has spent ≥ X% of the daily budget ...
  scaleBeforeHour: number; // ... before hour X
  scaleGapHours: number;
  notes: string[]; // explanations of the system's automatic threshold adjustments
  budgetNote?: string; // the note about a lowered budget step (shown next to budget increase suggestions)
};

export async function thresholdsFor(client: Client): Promise<Thresholds> {
  const t = await getT();
  const th: Thresholds = {
    warnPct: client.optWarnPct,
    pausePct: Math.max(client.optPausePct, client.optWarnPct),
    mode: client.optExpensiveMode === "warn" ? "warn" : "suggest",
    minSpendX: client.optMinSpendX,
    confidence: Math.min(0.99, Math.max(0.5, client.optConfidence / 100)),
    freqMax: client.optFreqMax,
    budgetStepPct: Math.min(client.optBudgetStepPct, client.maxBudgetChangePct),
    minAgeDays: client.optMinAgeDays,
    earlyPct: client.optEarlyPct,
    earlySpendX: client.optEarlySpendX,
    scaleMinResults: client.optScaleMinResults,
    scaleConfidence: Math.min(0.99, Math.max(0.5, client.optScaleConfidence / 100)),
    scaleSpendPct: client.optScaleSpendPct,
    scaleBeforeHour: client.optScaleBeforeHour,
    scaleGapHours: client.optScaleGapHours,
    notes: [],
  };
  // Self-learning: if applied recommendations of the same type mostly turned out worse afterwards → be more cautious.
  const done = await db.recommendation.findMany({
    where: { clientId: client.id, kind: "optimize", status: "executed", evaluation: { not: null } },
    orderBy: { executedAt: { sort: "desc", nulls: "last" } },
    take: 30,
    select: { rule: true, evaluation: true },
  });
  const verdictOf = (e: string | null) => {
    const v = e ? (JSON.parse(e) as Record<string, { campaign?: { verdict?: string } }>) : {};
    return v.d7?.campaign?.verdict ?? v.d3?.campaign?.verdict ?? null;
  };
  const worse = (rule: string) => {
    const list = done
      .filter((d) => d.rule === rule)
      .slice(0, 5)
      .map((d) => verdictOf(d.evaluation))
      .filter((v) => v && v !== "chưa đủ dữ liệu" && v !== "chưa so được");
    return { n: list.length, bad: list.filter((v) => v === "kém hơn").length };
  };
  const w = worse("adset_winner");
  if (w.n >= 2 && w.bad * 2 > w.n) {
    const next = Math.max(10, th.budgetStepPct - 10);
    th.budgetNote = t("workflow.opt.notes.budgetStep", { from: th.budgetStepPct, to: next, bad: w.bad, n: w.n });
    th.notes.push(th.budgetNote);
    th.budgetStepPct = next;
  }
  const p = worse("adset_expensive");
  if (p.n >= 2 && p.bad * 2 > p.n) {
    th.notes.push(t("workflow.opt.notes.pauseThreshold", { from: th.pausePct, to: th.pausePct + 10, bad: p.bad, n: p.n }));
    th.pausePct += 10;
  }
  return th;
}

// ------------------------------------------------------------ Comparison with statistical confidence

type Cmp = { ratio: number | null; conf: number; label: string; baseCpr: number | null };
const sub = (a: PeriodMetrics, b: PeriodMetrics): PeriodMetrics => ({
  spend: Math.max(0, a.spend - b.spend),
  impressions: Math.max(0, a.impressions - b.impressions),
  reach: Math.max(0, a.reach - b.reach),
  clicks: Math.max(0, a.clicks - b.clicks),
  results: Math.max(0, a.results - b.results),
});
const sum = (list: PeriodMetrics[]): PeriodMetrics =>
  list.reduce((x, y) => ({ spend: x.spend + y.spend, impressions: x.impressions + y.impressions, reach: x.reach + y.reach, clicks: x.clicks + y.clicks, results: x.results + y.results }), {
    spend: 0,
    impressions: 0,
    reach: 0,
    clicks: 0,
    results: 0,
  });

/** Compare an object with the baseline: the remainder's metrics (rest) if available, otherwise a fixed CPR. */
function compare(x: PeriodMetrics, rest: PeriodMetrics | null, fixed: number | null, restLabel: string, fixedLabel: string): Cmp {
  const cx = cpr(x);
  if (rest && rest.results >= 3) {
    const cb = cpr(rest)!;
    return { ratio: cx != null ? cx / cb : null, conf: probMoreExpensive(x, rest), label: restLabel, baseCpr: cb };
  }
  if (fixed) return { ratio: cx != null ? cx / fixed : null, conf: probCprAbove(x, fixed), label: fixedLabel, baseCpr: fixed };
  return { ratio: null, conf: 0.5, label: "", baseCpr: null };
}

const PLATFORM_NAME: Record<string, string> = { facebook: "Facebook", instagram: "Instagram", messenger: "Messenger", audience_network: "Audience Network", threads: "Threads" };
const GENDERS = ["female", "male"];

/**
 * Campaign-level rule: compare the whole campaign with the target CPR (entered manually or auto-suggested). Stricter than ad-set level since it pauses the whole campaign:
 * campaign has run ≥ 7 days, no ad set is learning, spent ≥ (X+1) times the target CPR, costlier than the action threshold + 20% (or 0 results)
 * with enough confidence. Only costlier than the action threshold → warning. Campaigns with a different primary result type are not compared.
 */
function campaignFinding(client: Client, snap: OptimizeSnapshot, th: Thresholds, resultType: string, t: T = translator("vi")): Finding | null {
  const target = targetCprOf(client);
  const sets = snap.adSets.filter((s) => s.status === "ACTIVE");
  if (!target || resultType !== client.primaryResult || !sets.length) return null;
  const age = Math.max(...sets.map((s) => ageDays(s.createdTime)));
  if (age < 7 || sets.some((s) => s.learning === "LEARNING")) return null;
  const c = snap.campaign;
  if (c.m7.spend < (th.minSpendX + 1) * target) return null;
  const m = (x: number | null) => money(x, client.currency);
  const label = targetLabelOf(client, t);
  const ratio = c.m7.results ? c.m7.spend / c.m7.results / target : Infinity;
  const conf = probCprAbove(c.m7, target * (1 + th.pausePct / 100));
  const pauseAt = 1 + (th.pausePct + 20) / 100;
  const base = { level: "campaign" as const, targetId: c.id, targetName: c.name, evidence: { campaign: c.name, m7: ev(c.m7, client.currency), benchmark: m(target), confidence: pctLabel(conf) } };
  const over = Number.isFinite(ratio) ? t("workflow.opt.campaign.over", { label, target: m(target), pct: Math.round((ratio - 1) * 100) }) : t("workflow.opt.campaign.zero", { label, target: m(target) });
  const facts = t("workflow.opt.campaign.facts", { spend: m(c.m7.spend), results: c.m7.results, cpr: c.m7.results ? t("workflow.opt.campaign.cpr", { value: m(cpr(c.m7)) }) : "", over, pause: th.pausePct, conf: pctLabel(conf) });
  if (ratio > pauseAt && conf >= th.confidence) {
    const suggest = th.mode === "suggest";
    return {
      ...base,
      id: `campaign:${c.id}`,
      rule: Number.isFinite(ratio) ? (suggest ? "campaign_expensive" : "campaign_warn") : suggest ? "campaign_zero" : "campaign_warn",
      action: suggest ? "pause" : "manual",
      priority: "high",
      title: suggest
        ? t("workflow.opt.campaign.pauseTitle", { name: c.name, detail: Number.isFinite(ratio) ? t("workflow.opt.campaign.pricier", { pct: Math.round((ratio - 1) * 100) }) : t("workflow.opt.campaign.noResults") })
        : t("workflow.opt.campaign.warnTitle", { name: c.name }),
      facts: t("workflow.opt.campaign.pauseFacts", { facts, pct: Math.round((pauseAt - 1) * 100), conf: pctLabel(th.confidence) }) + (suggest ? "" : t("workflow.opt.campaign.warnOnlyMode")),
    };
  }
  if (ratio > 1 + th.pausePct / 100) {
    return {
      ...base,
      id: `campaign_warn:${c.id}`,
      rule: "campaign_warn",
      action: "manual",
      priority: "medium",
      title: t("workflow.opt.campaign.warnTitle", { name: c.name }),
      facts: t("workflow.opt.campaign.belowThreshold", { facts, pct: Math.round((pauseAt - 1) * 100), conf: pctLabel(th.confidence) }),
    };
  }
  return null;
}

/**
 * Target customers are foreigners: which ad sets are leaking to Vietnamese users (English language, age up to 65+, no filters).
 * This is a setup error, so it doesn't wait for enough data like the performance rules. Adds a Europe–US–Australia expats ad set
 * when the campaign doesn't have one (without English, Europe–US customers can only be reached via the Expats behavior).
 */
function foreignFindings(client: Client, snap: OptimizeSnapshot, t: T = translator("vi")): Finding[] {
  const out: Finding[] = [];
  const sets = snap.adSets.filter((s) => s.status === "ACTIVE");
  const reset = t("workflow.opt.foreign.reset");
  for (const s of sets) {
    const chk = checkForeignLeak(s.targeting, t);
    if (!chk) continue;
    const base = { level: "adset" as const, targetId: s.id, targetName: s.name, priority: "high" as const, evidence: { m7: ev(s.m7, client.currency), m3: ev(s.m3, client.currency) } };
    if (chk.patch && chk.after) {
      out.push({
        ...base,
        id: `foreign_leak:${s.id}`,
        rule: "foreign_leak",
        action: "update_targeting",
        title: t("workflow.opt.foreign.fixTitle", { name: s.name }),
        facts: chk.issues.join(" "),
        params: { adSetId: s.id, patch: chk.patch, before: chk.before, after: chk.after, issues: chk.issues, keepLocales: chk.keepLocales },
        learningReset: reset,
      });
    } else {
      out.push({
        ...base,
        id: `foreign_leak:${s.id}`,
        rule: "foreign_leak",
        action: "manual",
        title: t("workflow.opt.foreign.leakTitle", { name: s.name }),
        facts: t("workflow.opt.foreign.leakFacts", { issues: chk.issues.join(" ") }),
      });
    }
  }
  const west = expatItems("west");
  const hasExpat = sets.some((s) => checkForeignLeak(s.targeting)?.hasExpat || /Ngoại kiều|Sống ở nước ngoài/.test(s.targeting));
  const source = [...sets].sort((a, b) => b.m7.spend - a.m7.spend)[0];
  if (source && !hasExpat && west.length) {
    out.push({
      id: `foreign_expat:${snap.campaign.id}`,
      rule: "foreign_expat",
      action: "duplicate_adset",
      level: "adset",
      targetId: source.id,
      targetName: source.name,
      priority: "medium",
      title: t("workflow.opt.foreign.expatTitle", { name: snap.campaign.name }),
      facts: t("workflow.opt.foreign.expatFacts", { source: source.name, items: west.map((x) => x.name.replace(/ \(.*$/, "")).join(", "), min: FOREIGN_AGE.min, max: FOREIGN_AGE.max }),
      params: {
        sourceAdSetId: source.id,
        name: `${source.name} - Âu Mỹ Úc (Ngoại kiều)`.slice(0, 120),
        dailyBudget: null,
        detailedTargeting: west,
        advantageAudience: false,
        locales: [],
        ageMin: FOREIGN_AGE.min,
        ageMax: FOREIGN_AGE.max,
        targetingNote: t("workflow.opt.foreign.expatNote", { min: FOREIGN_AGE.min, max: FOREIGN_AGE.max }),
        candidates: [...west, ...expatItems("korea"), ...expatItems("china")],
      },
      evidence: { m7: ev(source.m7, client.currency) },
    });
  }
  return out;
}

/**
 * Try the audience edit in validate-only mode. Meta locks audience edits on old ad sets in some campaigns (e.g. created via Ads Manager's guided flow,
 * using Advantage+ Audience): then recommend recreating an identical ad set with the edited audience (PAUSED), turn on the new one and pause the old one.
 */
async function foreignFallback(meta: ReturnType<typeof getMetaClient>, f: Finding, t: T): Promise<Finding> {
  if (f.action !== "update_targeting") return f;
  const p = f.params as UpdateTargetingParams;
  try {
    await meta.updateAdSetTargeting(p.adSetId, p.patch, true);
    return f;
  } catch (err) {
    const dup: DuplicateParams = {
      sourceAdSetId: p.adSetId,
      name: `${f.targetName} - lọc khách nước ngoài`.slice(0, 120),
      dailyBudget: null,
      detailedTargeting: null,
      advantageAudience: null,
      locales: p.keepLocales,
      ...(p.patch.ageRange && { ageRange: p.patch.ageRange }),
      ...(p.patch.ageMax && { ageMin: p.patch.ageMin, ageMax: p.patch.ageMax }),
      targetingNote: t("workflow.opt.foreign.fallbackNote", { langBefore: p.before.locales, langAfter: p.after.locales, ageBefore: p.before.age, ageAfter: p.after.age }),
    };
    return {
      ...f,
      action: "duplicate_adset",
      title: t("workflow.opt.foreign.recreateTitle", { name: f.targetName }),
      facts: t("workflow.opt.foreign.recreateFacts", { issues: p.issues.join(" "), error: errorMessage(err).replace(/\.$/, "") }),
      params: dup,
      learningReset: undefined,
    };
  }
}

/** Rules layer for one campaign. */
export function ruleFindings(client: Client, snap: OptimizeSnapshot, th: Thresholds, quality?: Map<string, AdQuality>, resultType?: string, t: T = translator("vi")): Finding[] {
  const cur = client.currency;
  const out: Finding[] = [];
  const sets = snap.adSets.filter((s) => s.status === "ACTIVE");
  if (!sets.length) return out;
  const m = (x: number | null) => money(x, cur);
  const pc = (p: number) => pctLabel(p);
  const conf = th.confidence;
  // Broad ad set as the baseline: no detailed targeting, no custom audience, already has results.
  const control = sets.find((s) => !extractTargetingItems(s.targeting).length && s.m7.results >= 3);
  // The target CPR applies to the client's primary result (e.g. messages): campaigns optimizing for another type (e.g. engagement) aren't compared against it.
  const tgtCpr = !resultType || resultType === client.primaryResult ? targetCprOf(client) : null;
  const campaignRef = tgtCpr ?? cpr(snap.campaign.m7);
  const fixedLabel = tgtCpr ? targetLabelOf(client, t) : t("workflow.opt.labels.campaignCpr");
  /** Baseline for an ad set: broad ad set → target CPR → the campaign's other ad sets. */
  const benchFor = (s: (typeof sets)[number]): Cmp => {
    if (control && control.id !== s.id) return compare(s.m7, control.m7, null, t("workflow.opt.labels.broadGroup", { name: control.name }), "");
    if (tgtCpr) return compare(s.m7, null, tgtCpr, "", targetLabelOf(client, t));
    const rest = sum(sets.filter((x) => x.id !== s.id).map((x) => x.m7));
    return compare(s.m7, rest, campaignRef, t("workflow.opt.labels.restOfCampaign"), fixedLabel);
  };

  for (const s of sets) {
    const age = ageDays(s.createdTime);
    const b = benchFor(s);
    const ref = b.baseCpr ?? campaignRef;
    const evidence = { adSet: s.name, ageDays: Math.floor(age), learning: s.learning, m7: ev(s.m7, cur), m3: ev(s.m3, cur), benchmark: ref != null ? m(ref) : null, confidence: pc(b.conf) };
    // 1. No results yet despite heavy spend (even when still new, but requiring more spend).
    const young = age < th.minAgeDays || s.learning === "LEARNING";
    if (ref && s.m7.results === 0 && s.m7.spend >= (young ? Math.max(th.earlySpendX, th.minSpendX) : th.minSpendX) * ref && b.conf >= conf) {
      const suggest = sets.length > 1 && th.mode === "suggest";
      out.push({
        id: `zero:${s.id}`,
        rule: suggest ? "adset_zero" : "adset_zero_warn",
        action: suggest ? "pause" : "manual",
        level: "adset",
        targetId: s.id,
        targetName: s.name,
        priority: "high",
        title: suggest ? t("workflow.opt.adset.zeroPauseTitle", { name: s.name }) : t("workflow.opt.adset.zeroWarnTitle", { name: s.name }),
        facts: t("workflow.opt.adset.zeroFacts", { spend: m(s.m7.spend), label: b.label || fixedLabel, ref: m(ref), conf: pc(b.conf) }) + (sets.length === 1 ? t("workflow.opt.adset.zeroOnlySet") : ""),
        evidence,
      });
      continue;
    }
    if (young) {
      // 1b. Early cut: a new / learning ad set that has spent enough yet is still many times costlier than the baseline rarely recovers.
      // Otherwise leave it alone so Meta can learn (early days are usually pricier, then costs drop).
      if (ref && b.ratio != null && b.ratio >= 1 + th.earlyPct / 100 && s.m7.spend >= th.earlySpendX * ref && b.conf >= conf) {
        const over = Math.round((b.ratio - 1) * 100);
        const suggest = sets.length > 1 && th.mode === "suggest";
        out.push({
          id: `early:${s.id}`,
          rule: suggest ? "adset_early" : "adset_early_warn",
          action: suggest ? "pause" : "manual",
          level: "adset",
          targetId: s.id,
          targetName: s.name,
          priority: "high",
          title: suggest ? t("workflow.opt.adset.earlyPauseTitle", { name: s.name, over }) : t("workflow.opt.adset.earlyWarnTitle", { name: s.name, over }),
          facts: t("workflow.opt.adset.earlyFacts", { hours: Math.floor(age * 24), learning: s.learning === "LEARNING" ? t("workflow.opt.adset.learningSuffix") : "", spend: m(s.m7.spend), x: th.earlySpendX, label: b.label || fixedLabel, ref: m(ref), results: s.m7.results, cpr: m(cpr(s.m7)), over, early: th.earlyPct, conf: pc(b.conf) }) + (sets.length === 1 ? t("workflow.opt.adset.earlyOnlySet") : ""),
          evidence,
        });
      }
      continue; // learning: skip the other rules
    }
    // 2. Costlier than baseline: over the action threshold + enough confidence → recommend pausing (or warn); over the warning threshold → warn.
    if (ref && b.ratio != null && s.m7.spend >= th.minSpendX * ref) {
      const over = Math.round((b.ratio - 1) * 100);
      const sure = b.conf >= conf;
      if (b.ratio > 1 + th.pausePct / 100 && sure && sets.length > 1 && th.mode === "suggest") {
        out.push({
          id: `expensive:${s.id}`,
          rule: "adset_expensive",
          action: "pause",
          level: "adset",
          targetId: s.id,
          targetName: s.name,
          priority: b.ratio > 1 + th.pausePct / 100 + 0.3 ? "high" : "medium",
          title: t("workflow.opt.adset.expensiveTitle", { name: s.name, over }),
          facts: t("workflow.opt.adset.expensiveFacts", { cpr: m(cpr(s.m7)), results: s.m7.results, spend: m(s.m7.spend), label: b.label, ref: m(ref), over, pause: th.pausePct, conf: pc(b.conf) }),
          evidence,
        });
        continue;
      }
      if (b.ratio > 1 + th.warnPct / 100) {
        const reason =
          b.ratio > 1 + th.pausePct / 100
            ? sure
              ? th.mode === "warn"
                ? t("workflow.opt.adset.reasonWarnMode")
                : t("workflow.opt.adset.reasonLastSet")
              : t("workflow.opt.adset.reasonLowConf", { pause: th.pausePct, conf: pc(b.conf), need: pc(conf) })
            : t("workflow.opt.adset.reasonWarnOnly", { warn: th.warnPct, pause: th.pausePct });
        out.push({
          id: `warn:${s.id}`,
          rule: "adset_warn",
          action: "manual",
          level: "adset",
          targetId: s.id,
          targetName: s.name,
          priority: b.ratio > 1 + th.pausePct / 100 ? "high" : "medium",
          title: t("workflow.opt.adset.warnTitle", { name: s.name, over }),
          facts: t("workflow.opt.adset.warnFacts", { cpr: m(cpr(s.m7)), results: s.m7.results, label: b.label, ref: m(ref), over, conf: pc(b.conf) }) + reason,
          evidence,
        });
      }
    }
    // 3. Creative fatigue: high frequency, 3-day CTR down vs 7-day, AND CPM roughly unchanged.
    // A sharp CPM rise = auction-driven (peak season, competitors); new creatives won't fix it. An ad set that never hit the baseline
    // (costlier than the action threshold) isn't fatigued, it's a poor fit: rules 1–2 already handle it.
    if (isFatigued(s, th) && !(ref && b.ratio != null && b.ratio > 1 + th.pausePct / 100)) {
      const tpl = snap.ads.filter((a) => a.adSetId === s.id && a.storySpec && a.status === "ACTIVE").sort((a, b2) => b2.m7.results - a.m7.results || b2.m7.impressions - a.m7.impressions)[0];
      if (tpl) {
        out.push({
          id: `fatigue:${s.id}`,
          rule: "ad_fatigue",
          action: "add_ad",
          level: "adset",
          targetId: s.id,
          targetName: s.name,
          priority: "medium",
          title: t("workflow.opt.adset.fatigueTitle", { name: s.name }),
          facts: t("workflow.opt.adset.fatigueFacts", { freq: freq(s.m7).toFixed(2), max: th.freqMax, ctr3: (ctr(s.m3) * 100).toFixed(2), ctr7: (ctr(s.m7) * 100).toFixed(2), cpm3: m(cpm(s.m3)), cpm7: m(cpm(s.m7)) }),
          params: { adSetId: s.id, templateAdId: tpl.id, templateName: tpl.name, variants: [] },
          learningReset: t("workflow.card.learningReset"),
          evidence,
        });
      }
    }
    // 3b. Learning limited (Meta: ad set struggles to reach ~50 results/week). Not a penalty; fix in Meta's recommended order:
    // consolidate ad sets → broaden audience → increase budget. Only raised when the ad set has no other recommendation.
    if (s.learning === "FAIL" && !out.some((f) => f.targetId === s.id)) {
      const budget = s.dailyBudget ?? (snap.campaign.dailyBudget != null ? snap.campaign.dailyBudget / sets.length : null);
      const unit = ref ?? campaignRef;
      const need = unit ? (LEARNING_EVENTS * unit) / 7 : null;
      const narrow = extractTargetingItems(s.targeting).length > 0;
      const others = sets.filter((x) => x.id !== s.id);
      const steps = [
        others.length ? t("workflow.opt.learning.merge", { count: others.length, names: others.map((x) => `"${x.name}"`).slice(0, 3).join(", ") }) : null,
        narrow ? t("workflow.opt.learning.broaden", { count: extractTargetingItems(s.targeting).length }) : null,
        need && budget != null && budget < need ? t("workflow.opt.learning.raise", { need: m(need), unit: m(unit), budget: m(budget) }) : null,
      ]
        .filter(Boolean)
        .map((x, i) => `${i + 1}) ${x}`);
      out.push({
        id: `learning:${s.id}`,
        rule: "learning_limited",
        action: "manual",
        level: "adset",
        targetId: s.id,
        targetName: s.name,
        priority: "low",
        title: t("workflow.opt.learning.title", { name: s.name }),
        facts:
          t("workflow.opt.learning.facts", { results: s.m7.results }) +
          (steps.length ? t("workflow.opt.learning.fixOrder", { steps: steps.join(" ") }) : t("workflow.opt.learning.budgetOk")),
        evidence,
      });
    }
    // 4. Waste within the ad set (age / gender / platform): costlier than the rest of the ad set, accounting for ≥ 15% of spend.
    const segRef = cpr(s.m7) ?? campaignRef;
    if (segRef) {
      type Cand = { dim: "age" | "gender" | "platform"; key: string; m7: PeriodMetrics; ratio: number | null; conf: number; waste: number; rest: PeriodMetrics };
      const cands: Cand[] = [];
      for (const dim of ["platform", "gender", "age"] as const) {
        const rows = snap.segments.filter((x) => x.adSetId === s.id && x.dim === dim && x.key !== "unknown");
        for (const r of rows) {
          if (r.m7.spend < th.minSpendX * segRef || r.m7.spend < 0.15 * s.m7.spend) continue;
          const rest = sub(s.m7, r.m7);
          const c = compare(r.m7, rest, segRef, "", "");
          const bad = r.m7.results === 0 ? c.conf >= conf : c.ratio != null && c.ratio > 1 + th.pausePct / 100 && c.conf >= conf;
          if (bad) cands.push({ dim, key: r.key, m7: r.m7, ratio: c.ratio, conf: c.conf, rest, waste: r.m7.spend - r.m7.results * (cpr(rest) ?? segRef) });
        }
      }
      const worst = cands.sort((a, b2) => b2.waste - a.waste)[0];
      if (worst) {
        const tj = JSON.parse(s.targeting || "{}") as { age_min?: number; age_max?: number; targeting_automation?: { advantage_audience?: number } };
        const advantage = tj.targeting_automation?.advantage_audience === 1;
        const segLabel = (tr: T) => (worst.dim === "platform" ? tr("workflow.opt.segment.onPlatform", { name: PLATFORM_NAME[worst.key] ?? worst.key }) : worst.dim === "gender" ? tr("workflow.opt.segment.gender", { name: GENDERS.includes(worst.key) ? tr(`workflow.opt.segment.genders.${worst.key}` as "workflow.opt.segment.genders.female") : worst.key }) : tr("workflow.opt.segment.age", { range: worst.key }));
        const label = segLabel(t);
        const how =
          worst.m7.results === 0
            ? t("workflow.opt.segment.zero", { spend: m(worst.m7.spend) })
            : t("workflow.opt.segment.pricier", { cpr: m(cpr(worst.m7)), rest: m(cpr(worst.rest)), pct: Math.round(((worst.ratio ?? 1) - 1) * 100) });
        const facts = t("workflow.opt.segment.facts", { name: s.name, label, how, share: Math.round((worst.m7.spend / s.m7.spend) * 100), conf: pc(worst.conf) });
        let patch: Partial<DuplicateParams> | null = null;
        if (worst.dim === "platform") patch = { excludePlatforms: [worst.key] };
        else if (worst.dim === "gender" && (worst.key === "female" || worst.key === "male")) patch = { genders: [worst.key === "female" ? 1 : 2] };
        else if (worst.dim === "age") {
          const buckets = snap.segments
            .filter((x) => x.adSetId === s.id && x.dim === "age" && x.m7.spend > 0)
            .map((x) => x.key)
            .sort();
          const [lo, hi] = worst.key.split("-").map((x) => parseInt(x));
          if (worst.key === buckets[0] && hi) patch = { ageMin: hi + 1 };
          else if (worst.key === buckets[buckets.length - 1] && lo) patch = { ageMax: Math.max(18, lo - 1) };
        }
        const softNote = advantage && worst.dim !== "platform" ? t("workflow.opt.segment.softNote") : "";
        out.push(
          patch
            ? {
                id: `segment:${s.id}`,
                rule: "segment_waste",
                action: "duplicate_adset",
                level: "adset",
                targetId: s.id,
                targetName: s.name,
                priority: "medium",
                title: t("workflow.opt.segment.wasteTitle", { name: s.name, label }),
                facts: t("workflow.opt.segment.wasteFacts", { facts, note: softNote }),
                params: {
                  sourceAdSetId: s.id,
                  name: `${s.name} - bỏ ${segLabel(translator("vi"))}`,
                  dailyBudget: s.dailyBudget,
                  detailedTargeting: null,
                  advantageAudience: advantage && worst.dim !== "platform" ? false : null,
                  ...patch,
                },
                evidence: { ...evidence, segment: { label, m7: ev(worst.m7, cur), confidence: pc(worst.conf) } },
              }
            : {
                id: `segment:${s.id}`,
                rule: "segment_warn",
                action: "manual",
                level: "adset",
                targetId: s.id,
                targetName: s.name,
                priority: "medium",
                title: t("workflow.opt.segment.warnTitle", { name: s.name, label }),
                facts: t("workflow.opt.segment.warnFacts", { facts }),
                evidence,
              },
        );
      }
    }
  }

  // 4b. Fragmentation: 3+ ad sets splitting the budget, not enough for each to exit learning → consolidate (Meta advises consolidating before increasing budget).
  // Only campaigns running ≥ 7 days: the test phase (2–4 ad sets, 5–7 days) is deliberately split to measure audiences.
  {
    const total = snap.campaign.dailyBudget ?? (sets.every((s) => s.dailyBudget != null) ? sets.reduce((a, s) => a + s.dailyBudget!, 0) : null);
    const age = Math.max(...sets.map((s) => ageDays(s.createdTime)));
    if (campaignRef && total && sets.length >= 3 && age >= 7) {
      const need = (LEARNING_EVENTS * campaignRef) / 7;
      const fit = Math.max(2, Math.floor(total / need));
      if (sets.length > fit) {
        const weakest = [...sets].sort((a, b2) => a.m7.results - b2.m7.results || b2.m7.spend - a.m7.spend).slice(0, sets.length - fit);
        out.push({
          id: `consolidate:${snap.campaign.id}`,
          rule: "consolidate",
          action: "manual",
          level: "campaign",
          targetId: snap.campaign.id,
          targetName: snap.campaign.name,
          priority: "medium",
          title: t("workflow.opt.consolidate.title", { name: snap.campaign.name, count: sets.length, total: m(total) }),
          facts:
            t("workflow.opt.consolidate.facts1", { need: m(need), label: fixedLabel, ref: m(campaignRef), total: m(total), fit }) +
            t("workflow.opt.consolidate.facts2", { weakest: weakest.map((s) => t("workflow.opt.consolidate.weakItem", { name: s.name, results: s.m7.results, spend: m(s.m7.spend) })).join(", ") }),
          learningReset: t("workflow.opt.consolidate.reset"),
          evidence: { campaign: snap.campaign.name, m7: ev(snap.campaign.m7, cur), adSets: sets.length, dailyBudget: m(total), needPerAdSet: m(need), fit },
        });
      }
    }
  }

  // 5. Winning ad set: cheaper than the rest / target CPR with enough confidence → increase budget; enough results → duplicate to test new audiences.
  // The ad set (or CBO campaign) has spent nearly all of today's budget early: it's budget-limited, so increasing actually helps.
  // Spending it all by end of day is normal (Meta always tries to spend the full budget), so only count it before scaleBeforeHour.
  const hour = localTime(client.timezone).hour;
  const limitedOf = (budget: number | null, today?: PeriodMetrics) =>
    budget != null && today != null && hour < th.scaleBeforeHour && today.spend >= (th.scaleSpendPct / 100) * budget ? today.spend / budget : null;
  const budgetOf = (s: (typeof sets)[number]) =>
    s.dailyBudget != null ? limitedOf(s.dailyBudget, s.today) : limitedOf(snap.campaign.dailyBudget, snap.campaign.today);
  const scored = sets
    .filter((s) => ageDays(s.createdTime) >= th.minAgeDays && (s.learning !== "LEARNING" || budgetOf(s) != null) && s.m7.results >= th.scaleMinResults)
    .map((s) => {
      const rest = sum(sets.filter((x) => x.id !== s.id).map((x) => x.m7));
      // Confidence this ad set is CHEAPER: 1 - P(costlier).
      const cheaper = tgtCpr ? 1 - probCprAbove(s.m7, tgtCpr) : rest.results >= 3 ? 1 - probMoreExpensive(s.m7, rest) : 0;
      return { s, cheaper, restCpr: cpr(rest) };
    })
    .filter((x) => x.cheaper >= th.scaleConfidence)
    .sort((a, b2) => cpr(a.s.m7)! - cpr(b2.s.m7)!);
  const win = scored[0];
  if (win) {
    const w = win.s;
    const pct = th.budgetStepPct;
    const evidence = { adSet: w.name, m7: ev(w.m7, cur), m3: ev(w.m3, cur), benchmark: tgtCpr ? m(tgtCpr) : win.restCpr != null ? m(win.restCpr) : null, confidence: pc(win.cheaper) };
    const target =
      w.dailyBudget != null
        ? { level: "adset" as const, id: w.id, name: w.name, budget: w.dailyBudget }
        : snap.campaign.dailyBudget != null
          ? { level: "campaign" as const, id: snap.campaign.id, name: snap.campaign.name, budget: snap.campaign.dailyBudget }
          : null;
    if (target) {
      const next = roundBudget(target.budget * (1 + pct / 100), cur);
      const err = checkBudget(client, target.budget, next, t);
      const used = budgetOf(w);
      const today = target.level === "adset" ? w.today : snap.campaign.today;
      const pace = used != null ? t("workflow.opt.winner.pace", { hour, spend: m(today?.spend ?? 0), pct: Math.round(used * 100) }) : "";
      out.push({
        id: `winner:${target.id}`,
        rule: "adset_winner",
        action: err ? "manual" : "update_budget",
        level: target.level,
        targetId: target.id,
        targetName: target.name,
        priority: used != null ? "high" : "medium",
        newDailyBudget: err ? undefined : next,
        limited: used != null,
        learningReset:
          target.level === "campaign"
            ? t("workflow.opt.winner.resetCbo", { pct })
            : t("workflow.opt.winner.resetAbo", { pct }),
        title: t("workflow.opt.winner.title", { level: target.level === "campaign" ? t("workflow.opt.winner.levelCampaign") : t("workflow.opt.winner.levelAdset"), name: target.name, pct }),
        facts: t("workflow.opt.winner.facts", { name: w.name, cpr: m(cpr(w.m7)), results: w.m7.results, cheaper: tgtCpr ? `${targetLabelOf(client, t)} ${m(tgtCpr)}` : t("workflow.opt.winner.restSets", { value: m(win.restCpr) }), conf: pc(win.cheaper), from: m(target.budget), to: m(next) }) + pace + (th.budgetNote ? ` (${th.budgetNote})` : "") + (err ? t("workflow.opt.winner.manualEdit", { error: err }) : ""),
        evidence: { ...evidence, ...(used != null && { budgetUsedToday: `${Math.round(used * 100)}%` }) },
      });
    }
    if (w.m7.results >= client.minResults && sets.length < 5) {
      out.push({
        id: `dup:${w.id}`,
        rule: "adset_duplicate",
        action: "duplicate_adset",
        level: "adset",
        targetId: w.id,
        targetName: w.name,
        priority: "low",
        title: t("workflow.opt.dup.title", { name: w.name }),
        facts: t("workflow.opt.dup.facts", { name: w.name, results: w.m7.results, cpr: m(cpr(w.m7)) }),
        params: { sourceAdSetId: w.id, name: `${w.name} - Test tệp mới`, dailyBudget: w.dailyBudget, detailedTargeting: null, advantageAudience: null },
        evidence,
      });
    }
  }

  // 6b. Try a new direction: no clear winning ad set while the campaign is costlier than the target CPR or has poor ad sets
  // → duplicate the ad set with the most results (keeping creatives) with NEVER-RUN audiences; add a broad Advantage+ ad set as baseline if missing.
  if (!win && sets.length < 5) {
    const mature = sets.filter((s) => ageDays(s.createdTime) >= th.minAgeDays);
    const camp = snap.campaign.m7;
    const campCpr = cpr(camp);
    const losing = out.filter((f) => ["adset_zero", "adset_zero_warn", "adset_expensive", "adset_warn"].includes(f.rule));
    const expensive = !!tgtCpr && (camp.results ? campCpr! > tgtCpr * (1 + th.warnPct / 100) && probCprAbove(camp, tgtCpr) >= 0.7 : camp.spend >= th.minSpendX * tgtCpr);
    if (mature.length && camp.spend > 0 && (expensive || losing.length)) {
      const src = [...mature].sort((a, b) => b.m7.results - a.m7.results || b.m7.spend - a.m7.spend)[0];
      const testBudget = src.dailyBudget ? Math.max(budgetStep(cur), roundBudget(src.dailyBudget * 0.5, cur)) : null;
      const why = [
        expensive ? t("workflow.opt.explore.expensive", { cpr: m(campCpr), label: targetLabelOf(client, t), target: m(tgtCpr) }) : null,
        losing.length ? t("workflow.opt.explore.losing", { count: losing.length, names: losing.map((f) => `"${f.targetName}"`).join(", ") }) : null,
      ].filter(Boolean);
      const evidence = { campaign: snap.campaign.name, m7: ev(camp, cur), source: src.name, sourceM7: ev(src.m7, cur) };
      out.push({
        id: `explore:${snap.campaign.id}`,
        rule: "explore_new",
        action: "duplicate_adset",
        level: "adset",
        targetId: src.id,
        targetName: src.name,
        priority: "medium",
        title: t("workflow.opt.explore.title", { name: snap.campaign.name }),
        facts: t("workflow.opt.explore.facts", { why: why.join("; "), source: src.name, budget: testBudget ? t("workflow.opt.explore.testBudget", { value: m(testBudget) }) : "" }),
        params: { sourceAdSetId: src.id, name: `${src.name} - Test hướng mới`, dailyBudget: testBudget, detailedTargeting: null, advantageAudience: false },
        evidence,
      });
      if (!sets.some((s) => !extractTargetingItems(s.targeting).length) && sets.length < 4) {
        out.push({
          id: `broad:${snap.campaign.id}`,
          rule: "explore_broad",
          action: "duplicate_adset",
          level: "adset",
          targetId: src.id,
          targetName: src.name,
          priority: "low",
          title: t("workflow.opt.broad.title", { name: snap.campaign.name }),
          facts: t("workflow.opt.broad.facts", { source: src.name }),
          params: { sourceAdSetId: src.id, name: `${src.name} - Test rộng Advantage+`, dailyBudget: testBudget, detailedTargeting: [], advantageAudience: true },
          evidence,
        });
      }
    }
  }

  // 6. Ads that are costly / produce no results compared with the other ads in the ad set.
  for (const s of sets) {
    const ads = snap.ads.filter((a) => a.adSetId === s.id && a.status === "ACTIVE");
    const ref = cpr(s.m7) ?? campaignRef;
    if (ads.length < 2 || !ref) continue;
    for (const a of ads) {
      if (a.m7.spend < th.minSpendX * ref || ageDays(a.createdTime) < th.minAgeDays) continue;
      const rest = sub(s.m7, a.m7);
      const c = compare(a.m7, rest, ref, t("workflow.opt.labels.restAds"), t("workflow.opt.labels.adSetCommon"));
      const bad = a.m7.results === 0 ? c.conf >= conf : c.ratio != null && c.ratio > 1.5 && c.conf >= conf;
      if (!bad) continue;
      const suggest = th.mode === "suggest";
      out.push({
        id: `ad:${a.id}`,
        rule: suggest ? "ad_expensive" : "ad_warn",
        action: suggest ? "pause" : "manual",
        level: "ad",
        targetId: a.id,
        targetName: a.name,
        priority: "medium",
        title: suggest ? t("workflow.opt.ad.pauseTitle", { name: a.name }) : t("workflow.opt.ad.warnTitle", { name: a.name }),
        facts:
          a.m7.results === 0
            ? t("workflow.opt.ad.zeroFacts", { spend: m(a.m7.spend), set: s.name, others: ads.length - 1, conf: pc(c.conf) })
            : t("workflow.opt.ad.pricierFacts", { cpr: m(cpr(a.m7)), label: c.label, set: s.name, base: m(c.baseCpr), pct: Math.round(((c.ratio ?? 1) - 1) * 100), conf: pc(c.conf) }),
        evidence: { ad: a.name, adSet: s.name, m7: ev(a.m7, cur), adSetCpr: m(cpr(s.m7)), confidence: pc(c.conf) },
      });
    }
  }
  // 7. Lead quality per ad (30 days): good-lead rate clearly lower than the campaign's other ads.
  if (quality) {
    const active = snap.ads.filter((a) => a.status === "ACTIVE");
    for (const a of active) {
      const q = quality.get(a.id);
      if (!q || q.n < 10) continue;
      const rest = snap.ads
        .filter((x) => x.id !== a.id)
        .reduce(
          (acc, x) => {
            const r = quality.get(x.id);
            return r ? { good: acc.good + r.good, n: acc.n + r.n } : acc;
          },
          { good: 0, n: 0 },
        );
      if (rest.n < 10) continue;
      const rate = q.good / q.n;
      const restRate = rest.good / rest.n;
      const c = probLowerProportion(q, rest);
      if (!(rate < 0.6 * restRate && c >= conf)) continue;
      const suggest = th.mode === "suggest" && active.filter((x) => x.adSetId === a.adSetId).length > 1;
      out.push({
        id: `quality:${a.id}`,
        rule: suggest ? "ad_low_quality" : "ad_low_quality_warn",
        action: suggest ? "pause" : "manual",
        level: "ad",
        targetId: a.id,
        targetName: a.name,
        priority: "high",
        title: suggest ? t("workflow.opt.quality.pauseTitle", { name: a.name }) : t("workflow.opt.quality.warnTitle", { name: a.name }),
        facts: t("workflow.opt.quality.facts", { good: q.good, n: q.n, rate: Math.round(rate * 100), spam: q.spam ? t("workflow.opt.quality.spam", { count: q.spam }) : "", rest: Math.round(restRate * 100), conf: pc(c) }),
        evidence: { ad: a.name, m7: ev(a.m7, cur), quality: { good: q.good, n: q.n, spam: q.spam, rate: `${Math.round(rate * 100)}%`, rest: `${Math.round(restRate * 100)}%` }, confidence: pc(c) },
      });
    }
  }
  const rank = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b2) => rank[a.priority] - rank[b2.priority]).slice(0, 10);
}

// ------------------------------------------------------------ Detailed assessment (explains why / why not optimized yet)

export type Check = { tone: "good" | "warn" | "bad" | "info"; label: string; text: string };
export type ObjectReview = {
  id: string;
  name: string;
  status: string;
  verdict: string;
  verdictTone: "good" | "warn" | "bad" | "info";
  checks: Check[];
  m7: PeriodMetrics;
  m3: PeriodMetrics;
  budget: number | null;
  ageDays: number;
  learning: string | null;
};

/** Tone of the verdict line for each rule; the text is workflow.opt.verdict.<rule>. */
const VERDICT_TONE: Record<string, ObjectReview["verdictTone"]> = {
  adset_zero: "bad",
  adset_zero_warn: "bad",
  adset_expensive: "bad",
  adset_early: "bad",
  adset_early_warn: "bad",
  adset_warn: "warn",
  ad_fatigue: "warn",
  learning_limited: "warn",
  consolidate: "warn",
  segment_waste: "warn",
  segment_warn: "warn",
  adset_winner: "good",
  adset_duplicate: "good",
  explore_new: "warn",
  explore_broad: "info",
  ad_expensive: "bad",
  ad_warn: "bad",
  ad_low_quality: "bad",
  ad_low_quality_warn: "bad",
};

/** Explain each ad set / ad against the rule set's exact thresholds (no Claude call). */
export function reviewCampaign(client: Client, snap: OptimizeSnapshot, th: Thresholds, quality?: Map<string, AdQuality>, resultType?: string, t: T = translator("vi")) {
  const cur = client.currency;
  const m = (x: number | null) => money(x, cur);
  const findings = snap.campaign.status === "ACTIVE" ? ruleFindings(client, snap, th, quality, resultType, t) : [];
  const sets = snap.adSets.filter((s) => s.status === "ACTIVE");
  const tgtCpr = !resultType || resultType === client.primaryResult ? targetCprOf(client) : null;
  const campaignRef = tgtCpr ?? cpr(snap.campaign.m7);
  const refLabel = tgtCpr ? (client.targetCpr != null ? t("workflow.opt.labels.refManual") : t("workflow.opt.labels.refAuto")) : t("workflow.opt.labels.refNone");
  const control = sets.find((s) => !extractTargetingItems(s.targeting).length && s.m7.results >= 3);
  const verdictOf = (id: string, fallback: { text: string; tone: ObjectReview["verdictTone"] }) => {
    const f = findings.filter((x) => x.targetId === id || (x.rule === "adset_winner" && snap.adSets.find((s) => s.id === id)?.name === (x.evidence as { adSet?: string }).adSet));
    return f.length ? { text: f.map((x) => (x.rule in VERDICT_TONE ? t(`workflow.opt.verdict.${x.rule}` as "workflow.opt.verdict.adset_zero") : x.title)).join(" · "), tone: VERDICT_TONE[f[0].rule] ?? "warn" } : fallback;
  };

  const adSets = snap.adSets.map((s) => {
    const age = ageDays(s.createdTime);
    const c7 = cpr(s.m7);
    const c3 = cpr(s.m3);
    const b =
      control && control.id !== s.id
        ? compare(s.m7, control.m7, null, t("workflow.opt.labels.broadGroup", { name: control.name }), "")
        : tgtCpr
          ? compare(s.m7, null, tgtCpr, "", targetLabelOf(client, t))
          : compare(s.m7, sum(sets.filter((x) => x.id !== s.id).map((x) => x.m7)), campaignRef, t("workflow.opt.labels.restOfCampaign"), refLabel);
    const ref = b.baseCpr ?? campaignRef;
    const checks: Check[] = [];
    checks.push(
      age >= th.minAgeDays
        ? { tone: "good", label: t("workflow.opt.review.runtime"), text: t("workflow.opt.review.ranDays", { days: Math.floor(age) }) }
        : {
            tone: "info",
            label: t("workflow.opt.review.runtime"),
            text: t("workflow.opt.review.ranHours", { hours: Math.floor(age * 24), minAge: th.minAgeDays, x: Math.max(th.earlySpendX, th.minSpendX), early: th.earlyPct }),
          },
    );
    if (s.learning)
      checks.push({
        tone: s.learning === "LEARNING" ? "info" : s.learning === "FAIL" ? "warn" : "good",
        label: t("workflow.opt.review.learningStage"),
        text:
          s.learning === "LEARNING"
            ? t("workflow.opt.review.learning")
            : s.learning === "FAIL"
              ? t("workflow.opt.review.learningLimited")
              : t("workflow.opt.review.learningDone"),
      });
    else if (age >= th.minAgeDays) {
      // Meta doesn't return learning_stage_info for many optimization types (e.g. messages): estimate from ~50 results/week.
      const budget = s.dailyBudget ?? (snap.campaign.dailyBudget != null && sets.length ? snap.campaign.dailyBudget / sets.length : null);
      const need = campaignRef ? (LEARNING_EVENTS * campaignRef) / 7 : null;
      const ok = s.m7.results >= LEARNING_EVENTS;
      checks.push({
        tone: ok ? "good" : "info",
        label: t("workflow.opt.review.learningEst"),
        text:
          t("workflow.opt.review.noLearningInfo", { results: s.m7.results, cmp: ok ? "≥" : "<", events: LEARNING_EVENTS }) +
          (ok
            ? t("workflow.opt.review.likelyDone")
            : t("workflow.opt.review.likelyLimited") + (need && budget != null ? t("workflow.opt.review.needBudget", { need: m(need), budget: m(budget) }) : "") + t("workflow.opt.review.smallBudgetNormal")),
      });
    }
    if (ref) {
      checks.push(
        s.m7.spend >= th.minSpendX * ref
          ? { tone: "good", label: t("workflow.opt.review.enoughSpend"), text: t("workflow.opt.review.spendOk", { spend: m(s.m7.spend), x: th.minSpendX, value: m(th.minSpendX * ref) }) }
          : { tone: "info", label: t("workflow.opt.review.enoughSpend"), text: t("workflow.opt.review.spendLow", { spend: m(s.m7.spend), need: m(th.minSpendX * ref), x: th.minSpendX }) },
      );
    }
    if (b.ratio != null && b.baseCpr) {
      const r = b.ratio;
      const sure = b.conf >= th.confidence;
      checks.push({
        tone: r <= 1 ? "good" : r <= 1 + th.warnPct / 100 ? "good" : r <= 1 + th.pausePct / 100 ? "warn" : "bad",
        label: t("workflow.opt.review.costVsBench"),
        text:
          t("workflow.opt.review.cprCompare", { cpr: m(c7), label: b.label, base: m(b.baseCpr), detail: r <= 1 ? t("workflow.opt.review.cheaper", { pct: Math.round((1 - r) * 100) }) : t("workflow.opt.review.pricier", { pct: Math.round((r - 1) * 100) }) }) +
          (r > 1 ? t("workflow.opt.review.thresholds", { warn: th.warnPct, pause: th.pausePct }) : "") +
          t("workflow.opt.review.confidence", { kind: r > 1 ? t("workflow.opt.review.reallyPricier") : t("workflow.opt.review.reallyCheaper"), conf: pctLabel(r > 1 ? b.conf : 1 - b.conf), need: sure || r <= 1 ? "" : t("workflow.opt.review.needConf", { conf: pctLabel(th.confidence) }) }),
      });
    } else if (!s.m7.results) {
      checks.push({
        tone: s.m7.spend > 0 ? "warn" : "info",
        label: t("workflow.opt.review.costVsBench"),
        text: s.m7.spend > 0 ? t("workflow.opt.review.noResults7", { spend: m(s.m7.spend) }) : t("workflow.opt.review.noSpend7"),
      });
    }
    if (c7 != null && c3 != null) {
      const r = c3 / c7;
      checks.push({
        tone: r <= 1.05 ? "good" : r <= 1.3 ? "warn" : "bad",
        label: t("workflow.opt.review.trend"),
        text: t("workflow.opt.review.trendText", { c3: m(c3), word: r <= 0.95 ? t("workflow.opt.review.better") : r <= 1.05 ? t("workflow.opt.review.same") : t("workflow.opt.review.worse"), c7: m(c7) }),
      });
    }
    const f7 = freq(s.m7);
    const tired = isFatigued(s, th);
    const auction = ctrDropped(s, th) && cpmRising(s);
    checks.push({
      tone: tired ? "bad" : f7 > th.freqMax || auction ? "warn" : "good",
      label: t("workflow.opt.review.freqCtrCpm"),
      text:
        t("workflow.opt.review.freqText", { f7: f7.toFixed(2), max: th.freqMax, ctr3: (ctr(s.m3) * 100).toFixed(2), ctr7: (ctr(s.m7) * 100).toFixed(2), cpm3: m(cpm(s.m3)), cpm7: m(cpm(s.m7)) }) +
        (tired
          ? t("workflow.opt.review.tired")
          : auction
            ? t("workflow.opt.review.auction", { pct: Math.round((CPM_STABLE - 1) * 100) })
            : f7 > th.freqMax
              ? t("workflow.opt.review.highFreq")
              : "."),
    });
    // Lead quality of the whole ad set (summed across ads).
    const sq = snap.ads
      .filter((a) => a.adSetId === s.id)
      .reduce(
        (acc, a) => {
          const q = quality?.get(a.id);
          return q ? { good: acc.good + q.good, n: acc.n + q.n, spam: acc.spam + q.spam } : acc;
        },
        { good: 0, n: 0, spam: 0 },
      );
    checks.push(
      sq.n
        ? {
            tone: sq.n < 10 ? "info" : sq.good / sq.n >= 0.5 ? "good" : "warn",
            label: t("workflow.opt.review.leadQuality"),
            text: t("workflow.opt.review.leadText", { good: sq.good, n: sq.n, rate: Math.round((sq.good / sq.n) * 100), spam: sq.spam ? t("workflow.opt.review.spamWrong", { count: sq.spam }) : "" }),
          }
        : { tone: "info", label: t("workflow.opt.review.leadQuality"), text: t("workflow.opt.review.leadUnknown") },
    );
    const segF = findings.find((x) => x.targetId === s.id && (x.rule === "segment_waste" || x.rule === "segment_warn"));
    checks.push(
      segF
        ? { tone: "warn", label: t("workflow.opt.review.waste"), text: segF.facts }
        : { tone: "good", label: t("workflow.opt.review.waste"), text: t("workflow.opt.review.noWaste") },
    );
    checks.push(
      s.m7.results >= client.minResults
        ? { tone: "good", label: t("workflow.opt.review.resultCount"), text: t("workflow.opt.review.resultsEnough", { results: s.m7.results, min: client.minResults }) }
        : { tone: "info", label: t("workflow.opt.review.resultCount"), text: t("workflow.opt.review.resultsFew", { results: s.m7.results, min: client.minResults, scale: th.scaleMinResults }) },
    );
    const young = age < th.minAgeDays || s.learning === "LEARNING";
    const worst = checks.some((c) => c.tone === "bad") ? "bad" : checks.some((c) => c.tone === "warn") ? "warn" : null;
    const fallback =
      s.status !== "ACTIVE"
        ? { text: t("workflow.opt.review.notRunning"), tone: "info" as const }
        : young
          ? { text: t("workflow.opt.review.learningNoEval"), tone: "info" as const }
          : worst
            ? { text: t("workflow.opt.review.watch"), tone: "warn" as const }
            : { text: t("workflow.opt.review.fine"), tone: "good" as const };
    const setRef = c7 ?? campaignRef;
    const ads = snap.ads
      .filter((a) => a.adSetId === s.id)
      .map((a) => {
        const aChecks: Check[] = [];
        const q = quality?.get(a.id);
        if (q && q.n) {
          const rate = q.good / q.n;
          aChecks.push({
            tone: q.n < 10 ? "info" : rate >= 0.5 ? "good" : rate >= 0.3 ? "warn" : "bad",
            label: t("workflow.opt.review.leadQuality"),
            text: t("workflow.opt.review.adLeadText", { good: q.good, n: q.n, rate: Math.round(rate * 100), hot: q.hot ? t("workflow.opt.review.hotLeads", { count: q.hot }) : "", spam: q.spam ? t("workflow.opt.review.spamOnly", { count: q.spam }) : "", few: q.n < 10 ? t("workflow.opt.review.needTen") : "" }),
          });
        }
        if (a.status === "ACTIVE" && setRef) {
          const c = compare(a.m7, sub(s.m7, a.m7), setRef, t("workflow.opt.labels.restAds"), t("workflow.opt.labels.adSetCommon"));
          if (a.m7.results === 0)
            aChecks.push({
              tone: a.m7.spend >= th.minSpendX * setRef ? "bad" : "info",
              label: t("workflow.opt.review.adResult"),
              text: t("workflow.opt.review.adZero", { spend: m(a.m7.spend), more: a.m7.spend >= th.minSpendX * setRef ? t("workflow.opt.review.adZeroMore", { need: m(th.minSpendX * setRef), conf: pctLabel(c.conf) }) : "" }),
            });
          else if (c.ratio != null && c.baseCpr) {
            const r = c.ratio;
            aChecks.push({
              tone: r <= 1 ? "good" : r <= 1.5 ? "warn" : "bad",
              label: t("workflow.opt.review.adVsSet"),
              text: t("workflow.opt.review.adCompare", { cpr: m(cpr(a.m7)), label: c.label, base: m(c.baseCpr), detail: r <= 1 ? t("workflow.opt.review.cheaper", { pct: Math.round((1 - r) * 100) }) : t("workflow.opt.review.pricierConf", { pct: Math.round((r - 1) * 100), conf: pctLabel(c.conf) }) }),
            });
          }
        }
        const v = verdictOf(
          a.id,
          a.status !== "ACTIVE"
            ? { text: t("workflow.opt.review.notRunning"), tone: "info" }
            : !a.m7.spend
              ? { text: t("workflow.opt.review.noSpend7Short"), tone: "info" }
              : aChecks.some((c) => c.tone === "info")
                ? { text: t("workflow.opt.review.notEnoughData"), tone: "info" }
                : aChecks.some((c) => c.tone !== "good")
                  ? { text: t("workflow.opt.review.watchMore"), tone: "warn" }
                  : { text: t("workflow.opt.review.keep"), tone: "good" },
        );
        const review: ObjectReview = {
          id: a.id,
          name: a.name,
          status: a.status,
          verdict: v.text,
          verdictTone: v.tone,
          checks: aChecks,
          m7: a.m7,
          m3: a.m3,
          budget: null,
          ageDays: Math.floor(ageDays(a.createdTime)),
          learning: null,
        };
        return review;
      });
    const base0 = verdictOf(s.id, fallback);
    const badAds = ads.filter((a) => a.verdictTone === "bad").length;
    const v = badAds ? { text: `${base0.text} · ${t("workflow.opt.review.badAds", { count: badAds })}`, tone: base0.tone === "good" ? ("warn" as const) : base0.tone } : base0;
    const review: ObjectReview = {
      id: s.id,
      name: s.name,
      status: s.status,
      verdict: v.text,
      verdictTone: v.tone,
      checks,
      m7: s.m7,
      m3: s.m3,
      budget: s.dailyBudget,
      ageDays: Math.floor(age),
      learning: s.learning,
    };
    return { ...review, ads };
  });
  return { ref: campaignRef, refLabel, control: control?.name ?? null, campaign: snap.campaign, findings, adSets, thresholds: th };
}

/** Targeting candidates to test in a duplicated ad set: from the client's Top ranking, excluding items the campaign already uses. */
/** Audience candidates for a duplicated ad set: top ranking + items Claude scored in the latest persona analysis (including expansion directions). */
export async function duplicateCandidates(clientId: string, snap: OptimizeSnapshot) {
  const t = await getT();
  const used = new Set(snap.adSets.flatMap((s) => extractTargetingItems(s.targeting).map((i) => i.id)).filter(Boolean));
  const [ranking, analysis] = await Promise.all([
    db.targetingRanking.findFirst({ where: { clientId }, orderBy: { createdAt: "desc" } }),
    db.audienceAnalysis.findFirst({ where: { clientId }, orderBy: { createdAt: "desc" }, select: { candidates: true } }),
  ]);
  // Only items still in the catalog (alive and found via copy-paste in Ads Manager).
  const { byId } = catalog();
  const items: RankedTargeting[] = (ranking ? (JSON.parse(ranking.items) as RankedTargeting[]) : []).filter((i) => i.id && byId.has(i.id));
  const fits: FitItem[] = (analysis ? (JSON.parse(analysis.candidates) as FitItem[]) : []).filter((f) => byId.has(f.id));
  const seen = new Set<string>();
  const out: NonNullable<DuplicateParams["candidates"]> = [];
  for (const i of items) {
    if (!i.id || used.has(i.id) || i.type === "custom_audiences" || seen.has(i.id)) continue;
    seen.add(i.id);
    const untested = !i.spend;
    out.push({
      id: i.id,
      name: i.name,
      type: i.type,
      untested,
      note: t("workflow.opt.cand.score", { score: i.score }) + (i.persona ? `, ${i.persona}` : "") + (untested ? t("workflow.opt.cand.untested") : "") + (i.explore ? t("workflow.opt.cand.explore") : "") + (i.industry ? t("workflow.opt.cand.industry", { pct: `${i.industry.index >= 1 ? "+" : "−"}${Math.round(Math.abs(i.industry.index - 1) * 100)}` }) : ""),
    });
  }
  // Items outside the top (no ad metrics yet): all untried.
  for (const f of [...fits].sort((a, b) => Number(!!b.explore) - Number(!!a.explore) || b.fit - a.fit)) {
    if (used.has(f.id) || seen.has(f.id)) continue;
    seen.add(f.id);
    out.push({ id: f.id, name: f.name, type: f.type, untested: true, note: t("workflow.opt.cand.fit", { fit: f.fit, persona: f.persona }) + (f.explore ? t("workflow.opt.cand.explore") : "") });
  }
  return out.slice(0, 35);
}

type Recent = { targetId: string | null; actionType: string; executedAt: Date | null; params: string; undoneAt: Date | null };

/** Optimizations applied within COOLDOWN_DAYS days (to compute cooldowns). */
export async function recentExecuted(clientId: string): Promise<Recent[]> {
  return db.recommendation.findMany({
    where: { clientId, kind: "optimize", status: "executed", executedAt: { gt: new Date(Date.now() - COOLDOWN_DAYS * DAY) } },
    select: { targetId: true, actionType: true, executedAt: true, params: true, undoneAt: true },
  });
}

/**
 * Whether an object is still in cooldown after the previous optimization:
 * - budget increase: the previous increase was less than scaleGapHours ago, or the audience was just changed / an ad added / duplicated (3 days, re-learning);
 * - pause: only wait if the system / a person paused it within 3 days and it's running again (a person turned it back on: respect that);
 * - other actions: 3 days after any change. Undone actions count too (the person didn't want it: don't redo for 3 days).
 */
export function coolingFor(recent: Recent[], f: Pick<Finding, "targetId" | "action">, th: Pick<Thresholds, "scaleGapHours">) {
  const touched = recent.filter((r) => {
    const p = JSON.parse(r.params || "{}") as { sourceAdSetId?: string; adSetId?: string };
    return r.targetId === f.targetId || p.sourceAdSetId === f.targetId || p.adSetId === f.targetId;
  });
  if (f.action === "pause") return touched.some((r) => r.actionType === "pause" || r.actionType === "resume");
  if (f.action === "update_budget")
    return touched.some((r) =>
      r.actionType === "update_budget" ? !!r.undoneAt || r.executedAt!.getTime() > Date.now() - th.scaleGapHours * 3600_000 : r.actionType !== "pause",
    );
  return touched.length > 0;
}

/** The approver dismissed a recommendation of the same type for the same object within 7 days (the "later" reason: 3 days) → don't recommend again. Key `rule:targetId`. */
export async function rejectedSkips(clientId: string) {
  const rejected = await db.recommendation.findMany({
    where: { clientId, kind: "optimize", status: "rejected", decidedAt: { gt: new Date(Date.now() - 7 * DAY) } },
    select: { rule: true, targetId: true, result: true, decidedAt: true },
  });
  // The reason text is stored in the language of whoever dismissed the card: match it in every language.
  const later = (["vi", "en"] as const).map((l) => translator(l)("workflow.card.skipReasons.later"));
  return new Set(rejected.filter((r) => !later.some((w) => (r.result ?? "").includes(w)) || r.decidedAt!.getTime() > Date.now() - 3 * DAY).map((r) => `${r.rule}:${r.targetId}`));
}

/** Try new audiences from the shared catalog (interests): skipped for clients targeting foreigners; foreign audiences are handled by foreignFindings. */
const EXPAND_RULES = new Set(["adset_duplicate", "explore_new", "explore_broad"]);

/** Check the client's running campaigns (or one campaign) and create optimization recommendations pending approval. */
export async function runOptimize(clientId: string, opts: { campaignId?: string; onProgress?: (label: string) => Promise<void> } = {}) {
  const t = await getT();
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId } });
  if (client.dataSource !== "meta") throw new Error(t("workflow.opt.run.notConnected"));
  const meta = getMetaClient(client);
  const evaluated = await evaluateOptimizations(clientId).catch(() => 0);
  const campaigns = opts.campaignId ? await db.campaign.findMany({ where: { clientId, id: opts.campaignId } }) : await db.campaign.findMany({ where: { clientId, status: "ACTIVE" } });

  const snaps: OptimizeSnapshot[] = [];
  const findings: (Finding & { campaignId: string; campaignName: string })[] = [];
  const candidates = new Map<string, Awaited<ReturnType<typeof duplicateCandidates>>>();
  const recent = await recentExecuted(clientId);
  const th = await thresholdsFor(client);
  const skip = await rejectedSkips(clientId);
  // Automation "Chạy thử" (dry run) cards (auto-rules.ts) are kept for preview; don't create duplicate cards.
  const dryrun = new Set(
    (await db.recommendation.findMany({ where: { clientId, kind: "optimize", status: "pending", auto: "dryrun" }, select: { rule: true, targetId: true } })).map((r) => `${r.rule}:${r.targetId}`),
  );

  const quality = await qualityByAd(clientId);
  await opts.onProgress?.(t("workflow.opt.run.reading", { count: campaigns.length }));
  const all = await meta.fetchOptimizeSnapshots(campaigns.map((c) => c.id));
  for (const snap of all) {
    const c = campaigns.find((x) => x.id === snap.campaign.id)!;
    if (snap.campaign.status !== "ACTIVE") continue;
    snaps.push(snap);
    // Whole campaign costly / no results vs target CPR → recommend pausing the campaign, dropping that campaign's individual recommendations.
    const camp = campaignFinding(client, snap, th, c.resultType, t);
    const usable = (f: Finding) => !coolingFor(recent, f, th) && !skip.has(`${f.rule}:${f.targetId}`) && !dryrun.has(`${f.rule}:${f.targetId}`);
    const list = camp && usable(camp) && camp.action === "pause" ? [camp] : [...(camp && usable(camp) ? [camp] : []), ...ruleFindings(client, snap, th, quality, c.resultType, t).filter(usable).filter((f) => !(client.audienceOrigin === "foreign" && EXPAND_RULES.has(f.rule)))];
    if (client.audienceOrigin === "foreign") for (const f of foreignFindings(client, snap, t).filter(usable)) list.push(await foreignFallback(meta, f, t));
    const ownTargets = (f: Finding) => f.rule === "explore_broad" || f.rule === "foreign_expat" || f.rule === "foreign_leak"; // brings its own audience, no shared candidates needed
    if (list.some((f) => f.action === "duplicate_adset" && !ownTargets(f))) candidates.set(c.id, await duplicateCandidates(clientId, snap));
    for (const f of list) {
      if (f.action === "duplicate_adset" && !ownTargets(f)) {
        const cands = candidates.get(c.id) ?? [];
        // Trying a new direction only uses never-run audiences; if none remain, drop this recommendation.
        (f.params as DuplicateParams).candidates = f.rule === "explore_new" ? cands.filter((x) => x.untested) : cands;
        if (f.rule === "explore_new" && !(f.params as DuplicateParams).candidates!.length) continue;
      }
      findings.push({ ...f, campaignId: c.id, campaignName: c.name });
    }
  }

  // AI layer: only called when there are findings; on error, still save recommendations with metric-based rationale.
  let ai: OptimizeAi | null = null;
  if (findings.length) {
    await opts.onProgress?.(t("workflow.opt.run.writing", { count: findings.length }));
    try {
      const [audience, industry, insights, knowledge, creative, history] = await Promise.all([
        audiencePromptSection(clientId),
        industryPromptSection(clientId),
        latestConversationInsights(clientId),
        knowledgePromptSection(clientId),
        creativePromptSection(clientId),
        recommendationHistory(clientId, "optimize"),
      ]);
      const prompt = `# Client profile
${clientProfile(client)}

${knowledge}

${audience.text}

${industry.text}

${creative}

# Insights from messages
${insights ? JSON.stringify({ top_questions: insights.top_questions, objections: insights.objections, personas: insights.personas.map((p) => p.name) }) : "None yet."}

# Running campaigns (7-day / 3-day metrics)
${JSON.stringify(
  snaps.map((s) => ({
    campaign: s.campaign.name,
    m7: ev(s.campaign.m7, client.currency),
    ad_sets: s.adSets
      .filter((x) => x.status === "ACTIVE")
      .map((x) => ({ name: x.name, targeting: extractTargetingItems(x.targeting).map((it) => it.name), m7: ev(x.m7, client.currency), m3: ev(x.m3, client.currency) })),
  })),
)}

# Findings of the rule engine
${JSON.stringify(findings.map((f) => ({ id: f.id, action: f.action, campaign: f.campaignName, target: f.targetName, facts: f.facts, ...(f.learningReset && { learning_reset: f.learningReset }), ...(f.action === "add_ad" && { template_ad: (f.params as AddAdParams).templateName }) })))}

# Targeting candidates for duplicated ad sets (id | type | name | note)
${
  [...candidates.values()]
    .flat()
    .map((c) => `${c.id} | ${c.type} | ${c.name} | ${c.note ?? ""}`)
    .join("\n") || "None."
}

${history.text}

Rewrite the findings.`;
      ai = (await generateStructured({ clientId: clientId, system: OPTIMIZE_SYSTEM, prompt, schema: OptimizeAiSchema, effort: "medium" })).data;
    } catch (err) {
      await logActivity(clientId, "error", t("workflow.opt.run.aiFailed", { error: errorMessage(err) }));
    }
  }

  // A new check replaces the pending optimization recommendations of the same campaign (a whole-client check also replaces Claude's extra recommendations).
  await db.recommendation.updateMany({
    where: {
      clientId,
      kind: "optimize",
      status: "pending",
      rule: { not: "manual" }, // user-created cards (Duplicate / + Ad) are kept
      // Automation dry-run cards are kept; failed automatic cards (auto "on" still pending) are replaced,
      // otherwise they'd sit forever next to the new card for the same action (approving both = changing the budget twice).
      AND: [
        { OR: [{ auto: null }, { auto: "on" }] },
        { OR: [{ campaignId: { in: campaigns.map((c) => c.id) } }, ...(opts.campaignId ? [] : [{ rule: "ai_extra" }])] },
      ],
    },
    data: { status: "expired", result: t("workflow.opt.run.replacedByCheck"), decidedAt: new Date() },
  });
  let created = 0;
  for (const f of findings) {
    const a = ai?.findings.find((x) => x.id === f.id);
    const params = f.params ? structuredClone(f.params) : undefined;
    if (f.action === "add_ad" && params) (params as AddAdParams).variants = a?.ad_variants?.slice(0, 3) ?? [{ primary_text: "", headline: "", description: "" }];
    if (f.action === "duplicate_adset" && params) {
      const p = params as DuplicateParams;
      const picked = (f.rule === "explore_broad" || f.rule.startsWith("foreign_") ? [] : (a?.targeting_ids ?? []).map((id) => p.candidates?.find((c) => c.id === id)).filter(Boolean)) as NonNullable<DuplicateParams["candidates"]>;
      if (picked.length) p.detailedTargeting = picked.slice(0, 3).map(({ id, name, type }) => ({ id, name, type }));
      // Claude couldn't pick: take the 3 highest-scoring untried audiences (expansion directions already sorted first).
      else if (f.rule === "explore_new") p.detailedTargeting = (p.candidates ?? []).slice(0, 3).map(({ id, name, type }) => ({ id, name, type }));
      // Duplicating a winning ad set without a suitable audience: keep the old audience, turn on Advantage+ so Meta expands.
      // Duplicating to drop waste: keep the rule's settings as is (Advantage+ off so the dropped segments don't come back).
      else if (f.rule === "adset_duplicate") p.advantageAudience = true;
      if (a?.new_adset_name?.trim()) p.name = a.new_adset_name.trim().slice(0, 120);
    }
    await db.recommendation.create({
      data: {
        clientId,
        kind: "optimize",
        campaignId: f.campaignId,
        campaignName: f.campaignName,
        rule: f.rule,
        title: a?.title?.trim() || f.title,
        rationale: `${a?.rationale?.trim() || f.facts}${a ? `\n\n${t("workflow.opt.run.dataLabel")}: ${f.facts}` : ""}`,
        priority: f.priority,
        expectedImpact: a?.expected_impact ?? "",
        actionType: f.action,
        targetLevel: f.level,
        targetId: f.targetId,
        targetName: f.targetName,
        newDailyBudget: f.newDailyBudget ?? null,
        params: JSON.stringify(params ?? {}),
        evidence: JSON.stringify({ ...f.evidence, ...(f.learningReset && { learningReset: f.learningReset }) }),
      },
    });
    created++;
  }
  for (const x of (ai?.extra ?? []).slice(0, 2)) {
    await db.recommendation.create({
      data: {
        clientId,
        kind: "optimize",
        campaignId: opts.campaignId ?? null,
        campaignName: opts.campaignId ? campaigns[0]?.name : null,
        rule: "ai_extra",
        title: x.title,
        rationale: x.rationale,
        priority: x.priority,
        actionType: x.kind === "new_draft" && x.brief.trim() ? "new_draft" : "manual",
        params: JSON.stringify(x.kind === "new_draft" ? { brief: x.brief } : {}),
      },
    });
    created++;
  }
  await db.client.update({ where: { id: clientId }, data: { lastOptimizeAt: new Date() } });
  await logActivity(
    clientId,
    "analyze",
    t("workflow.opt.run.summary", { campaigns: snaps.length, created }) + (evaluated ? t("workflow.opt.run.summaryEvaluated", { count: evaluated }) : ""),
  );
  return { campaigns: snaps.length, findings: findings.length, created, evaluated, summary: ai?.summary ?? null };
}

// ------------------------------------------------------------ Measuring results after applying (3 and 7 days)

type Side = { spendPerDay: number; results: number; resultsPerDay: number; cpr: number | null };
const side = (m: PeriodMetrics, days: number): Side => ({ spendPerDay: m.spend / days, results: m.results, resultsPerDay: m.results / days, cpr: cpr(m) });
const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** 7-day metrics before execution (stored as the comparison baseline). */
export async function captureBaseline(client: Client, rec: Recommendation) {
  if (!rec.campaignId) return null;
  const snap = await getMetaClient(client)
    .fetchOptimizeSnapshot(rec.campaignId)
    .catch(() => null);
  if (!snap) return null;
  const target = rec.targetLevel === "adset" ? snap.adSets.find((s) => s.id === rec.targetId)?.m7 : rec.targetLevel === "ad" ? snap.ads.find((a) => a.id === rec.targetId)?.m7 : snap.campaign.m7;
  return { campaign: side(snap.campaign.m7, 7), target: target ? side(target, 7) : null, at: new Date().toISOString() };
}

const verdict = (before: Side | null, after: Side) => {
  if (after.results < 3) return "chưa đủ dữ liệu";
  if (!before?.cpr || after.cpr == null) return "chưa so được";
  const r = after.cpr / before.cpr;
  return r <= 0.95 ? "tốt hơn" : r >= 1.05 ? "kém hơn" : "như cũ";
};

/** Re-measure optimization recommendations applied 3 / 7 days ago. Returns the number just measured. */
async function evaluateOptimizations(clientId: string) {
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId } });
  const recs = await db.recommendation.findMany({ where: { clientId, kind: "optimize", status: "executed", executedAt: { lt: new Date(Date.now() - 3 * DAY) }, baseline: { not: null } } });
  const campaigns = new Map((await db.campaign.findMany({ where: { clientId }, select: { id: true, resultType: true } })).map((c) => [c.id, c.resultType]));
  const meta = getMetaClient(client);
  let n = 0;
  for (const r of recs) {
    const evals = r.evaluation ? (JSON.parse(r.evaluation) as Record<string, unknown>) : {};
    const days = (Date.now() - r.executedAt!.getTime()) / DAY;
    const key = days >= 7 ? "d7" : "d3";
    if (evals[key] || !r.campaignId) continue;
    // Pausing the whole campaign: nothing to measure before/after (and not used to self-tune the ad set pause threshold).
    if (r.actionType === "pause" && r.targetLevel === "campaign") continue;
    const rt = campaigns.get(r.campaignId) ?? client.primaryResult;
    const since = ymd(new Date(r.executedAt!.getTime() + DAY));
    const period = Math.max(1, Math.floor(days) - 1);
    const base = JSON.parse(r.baseline!) as { campaign: Side; target: Side | null };
    const p = JSON.parse(r.params) as { createdId?: string };
    const campaignAfter = side(await meta.metricsSince("campaign", r.campaignId, since, rt), period);
    // Newly duplicated ad set: measure the new ad set; pause: measure the whole campaign only; otherwise measure the object itself.
    const targetId = r.actionType === "duplicate_adset" ? p.createdId : r.actionType === "pause" ? null : r.targetId;
    const targetLevel = r.actionType === "duplicate_adset" ? "adset" : (r.targetLevel as "campaign" | "adset" | "ad");
    const targetAfter = targetId ? side(await meta.metricsSince(targetLevel, targetId, since, rt), period) : null;
    evals[key] = {
      days: period,
      campaign: { before: base.campaign, after: campaignAfter, verdict: verdict(base.campaign, campaignAfter) },
      target: targetAfter ? { before: base.target, after: targetAfter } : null,
    };
    await db.recommendation.update({ where: { id: r.id }, data: { evaluation: JSON.stringify(evals) } });
    n++;
  }
  return n;
}
