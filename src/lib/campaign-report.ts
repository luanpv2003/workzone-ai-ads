import type { Client } from "@prisma/client";
import { getT } from "@/i18n/server";
import { translator, type T } from "@/i18n/translate";
import { db } from "./db";
import { getMetaClient } from "./meta";
import type { CampaignReportData, ReportMetrics, ReportPeriod } from "./meta/types";
import { thresholdsFor, type Thresholds } from "./optimize";
import { probCprAbove } from "./stats";
import { money, num, resultLabels } from "./format";
import { qualityByAd, type AdQuality } from "./lead-quality";
import { targetCprOf, targetLabelOf } from "./target-cpr";

// Report evaluating all of a client's campaigns over a period (today, 7–90 days, lifetime), compared with the preceding period.
// Metrics read directly from Meta; evaluated against the client's own optimization thresholds (Settings → Campaign optimization thresholds).

export type { ReportPeriod };
export const REPORT_PERIODS: readonly ReportPeriod[] = ["today", 7, 14, 30, 60, 90, "lifetime"];
/** Read the period from the URL (?days=today | 7…90 | lifetime); invalid values default to 30 days. */
export const toReportPeriod = (v: string | undefined): ReportPeriod => {
  if (v === "today" || v === "lifetime") return v;
  const d = Number(v);
  return REPORT_PERIODS.includes(d) ? d : 30;
};
export const periodLabel = (p: ReportPeriod, t: T = translator("vi")) => (p === "today" ? t("notify.campaignReport.period.today") : p === "lifetime" ? t("notify.campaignReport.period.lifetime") : t("notify.campaignReport.period.days", { n: p }));
/** Number of days used to filter lead / conversation quality by period. */
const periodDays = (p: ReportPeriod) => (p === "today" ? 1 : p === "lifetime" ? 3650 : p);

export type Tone = "good" | "warn" | "bad" | "info";
/** id: stable code of the verdict (text is translated); only set on freshly built verdicts. */
export type Verdict = { text: string; tone: Tone; why: string; id?: "noSpend" | "noRef" | "noResult" | "notEnough" | "expensive" | "slightlyExpensive" | "good" | "ok" };
export type Row = {
  id: string;
  name: string;
  status: string;
  m: ReportMetrics;
  cpr: number | null;
  ctr: number | null;
  freq: number | null;
  cpm: number | null;
  share: number; // % of spend within the parent
  verdict: Verdict;
  quality: Quality | null;
  diag: Diagnosis;
};
export type Quality = { n: number; good: number; hot: number; spam: number; rate: number };
/** A diagnostic metric: value, comparison level and comment. */
export type Indicator = { key: string; label: string; value: string; bench: string | null; tone: Tone; note: string };
export type Action = { text: string; priority: 1 | 2 | 3 }; // 1 = do now
export type Diagnosis = { indicators: Indicator[]; tags: { text: string; tone: Tone }[]; causes: string[]; actions: Action[] };
export type CampaignRow = Row & {
  objective: string;
  resultType: string;
  budget: string | null;
  prev: ReportMetrics;
  prevCpr: number | null;
  ref: number | null;
  refLabel: string;
  adSets: (Row & { budget: number | null })[];
  ads: (Row & { adSetName: string })[];
};
export type SegmentRow = { dim: "age" | "gender" | "platform"; key: string; label: string; m: ReportMetrics; cpr: number | null; share: number; diff: number | null };
export type TypeTotal = { resultType: string; label: string; m: ReportMetrics; prev: ReportMetrics; cpr: number | null; prevCpr: number | null; campaigns: number };

export type CampaignReport = {
  days: ReportPeriod;
  range: CampaignReportData["range"];
  prevRange: CampaignReportData["prevRange"];
  generatedAt: Date;
  thresholds: Thresholds;
  total: ReportMetrics;
  prevTotal: ReportMetrics;
  types: TypeTotal[];
  campaigns: CampaignRow[];
  /** pSpend: spend of only the primary-result-type campaigns (to compute cost / result per day). */
  /** extra: messages from other campaign types (e.g. Engagement) when the primary result type is messages; not merged into results. */
  daily: { date: string; spend: number; results: number; pSpend?: number; extra?: number }[];
  primaryLabel: string;
  segments: SegmentRow[];
  highlights: { tone: Tone; text: string }[];
  /** Recommended actions, gathered from all campaigns, sorted by priority. */
  plan: (Action & { campaign: string })[];
  hasQuality: boolean;
  optimizations: { title: string; executedAt: Date | null; verdict: string | null; status: string }[];
  pending: number;
};

const zero = (): ReportMetrics => ({ spend: 0, impressions: 0, reach: 0, clicks: 0, results: 0, revenue: 0, plays3s: 0, thruplays: 0 });
const KEYS = ["spend", "impressions", "reach", "clicks", "results", "revenue", "plays3s", "thruplays"] as const;
const add = (a: ReportMetrics, b: ReportMetrics) => {
  for (const k of KEYS) a[k] += b[k] ?? 0;
  return a;
};
const sum = (list: ReportMetrics[]) => list.reduce(add, zero());
export const cprOf = (m: { spend: number; results: number }) => (m.results ? m.spend / m.results : null);
export const change = (now: number | null, prev: number | null) => (now != null && prev ? now / prev - 1 : null);

const AGE_LABEL = (k: string, t: T) => (k === "Unknown" ? t("notify.campaignReport.age.unknown") : t("notify.campaignReport.age.years", { k }));
const genderLabel = (k: string, t: T) => (k === "female" ? t("notify.campaignReport.gender.female") : k === "male" ? t("notify.campaignReport.gender.male") : k === "unknown" ? t("notify.campaignReport.gender.unknown") : k);
const PLATFORM_LABEL: Record<string, string> = { facebook: "Facebook", instagram: "Instagram", audience_network: "Audience Network", messenger: "Messenger", threads: "Threads" };

/** Evaluate a campaign / ad set / ad against the benchmark CPR, accounting for statistical confidence. */
function judge(m: ReportMetrics, ref: number | null, th: Thresholds, cur: string, refName: string, t: T): Verdict {
  const V = (id: NonNullable<Verdict["id"]>, tone: Tone, text: string, why: string): Verdict => ({ id, text, tone, why });
  if (!m.spend) return V("noSpend", "info", t("notify.campaignReport.verdict.noSpend.text"), t("notify.campaignReport.verdict.noSpend.why"));
  if (!ref) return V("noRef", "info", t("notify.campaignReport.verdict.noRef.text"), t("notify.campaignReport.verdict.noRef.why"));
  const minSpend = th.minSpendX * ref;
  if (!m.results) {
    return m.spend >= minSpend
      ? V("noResult", "bad", t("notify.campaignReport.verdict.noResult.text"), t("notify.campaignReport.verdict.noResult.why", { spend: money(m.spend, cur), x: th.minSpendX, ref: refName }))
      : V("notEnough", "info", t("notify.campaignReport.verdict.notEnough.text"), t("notify.campaignReport.verdict.notEnough.whySpend", { spend: money(m.spend, cur), x: th.minSpendX, ref: refName }));
  }
  const cpr = m.spend / m.results;
  const diff = cpr / ref - 1;
  const pAbove = probCprAbove(m, ref);
  const d = `${diff >= 0 ? "+" : "−"}${Math.round(Math.abs(diff) * 100)}%`;
  if (m.spend < minSpend && m.results < 5) return V("notEnough", "info", t("notify.campaignReport.verdict.notEnough.text"), t("notify.campaignReport.verdict.notEnough.whyResults", { cpr: money(cpr, cur), d, ref: refName, n: m.results }));
  const dear = { cpr: money(cpr, cur), ref: refName, d, conf: Math.round(pAbove * 100) };
  if (diff * 100 >= th.pausePct && pAbove >= th.confidence) return V("expensive", "bad", t("notify.campaignReport.verdict.expensive.text"), t("notify.campaignReport.verdict.expensive.why", dear));
  if (diff * 100 >= th.warnPct && pAbove >= 0.7) return V("slightlyExpensive", "warn", t("notify.campaignReport.verdict.slightlyExpensive.text"), t("notify.campaignReport.verdict.expensive.why", dear));
  if (diff <= -0.15 && 1 - pAbove >= th.confidence)
    return V("good", "good", t("notify.campaignReport.verdict.good.text"), t("notify.campaignReport.verdict.good.why", { cpr: money(cpr, cur), ref: refName, d: d.replace("−", ""), conf: Math.round((1 - pAbove) * 100) }));
  return V("ok", "info", t("notify.campaignReport.verdict.ok.text"), t("notify.campaignReport.verdict.ok.why", { cpr: money(cpr, cur), d, ref: refName }));
}

// ------------------------------------------------------------------ Diagnostics

/** Overall levels to compare against: CPM, CTR, result / click rate, video retention, good-lead rate. */
type Bench = { cpm: number | null; ctr: number | null; cvr: number | null; hook: number | null; hold: number | null; quality: number | null };
const ratio = (a: number, b: number) => (b ? a / b : null);
/** videoAds: metrics of video ads (image ad impressions don't count toward video view rates). */
function benchOf(list: { m: ReportMetrics; quality?: Quality | null }[], videoAds: ReportMetrics[]): Bench {
  const m = sum(list.map((x) => ({ ...x.m })));
  const video = sum(videoAds.map((x) => ({ ...x })));
  const q = list.reduce((a, x) => (x.quality ? { n: a.n + x.quality.n, good: a.good + x.quality.good } : a), { n: 0, good: 0 });
  return {
    cpm: m.impressions ? (m.spend / m.impressions) * 1000 : null,
    ctr: ratio(m.clicks, m.impressions),
    cvr: ratio(m.results, m.clicks),
    hook: ratio(video.plays3s, video.impressions),
    hold: ratio(video.thruplays, video.plays3s),
    quality: q.n >= 10 ? q.good / q.n : null,
  };
}

const pctTxt = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;
const diffTxt = (d: number, t: T) => (Math.abs(d) < 0.03 ? t("notify.campaignReport.diff.same") : t(d >= 0 ? "notify.campaignReport.diff.higher" : "notify.campaignReport.diff.lower", { p: Math.round(Math.abs(d) * 100) }));
/** Result-per-click rate only makes sense when results happen after a click (messages, leads, orders). */
const CVR_TYPES = new Set(["messages", "leads", "purchases"]);

type DiagInput = {
  level: "campaign" | "adset" | "ad";
  m: ReportMetrics;
  resultType: string;
  verdict: Verdict;
  ref: number | null;
  bench: Bench;
  benchName: string;
  quality: Quality | null;
  th: Thresholds;
  cur: string;
  prev?: ReportMetrics;
  halves?: [ReportMetrics, ReportMetrics];
  pacing?: { budget: number; perDay: number } | null;
  video: ReportMetrics; // total metrics of the video ads inside
  t: T;
};

function diagnose(x: DiagInput): Diagnosis {
  const { m, th, cur, bench, t } = x;
  const ind: Indicator[] = [];
  const causes: string[] = [];
  const actions: Action[] = [];
  const tags: Diagnosis["tags"] = [];
  const tag = (text: string, tone: Tone) => tags.push({ text, tone });
  const vs = (d: number, key: string) => t(key as "notify.campaignReport.ind.cpm.note", { diff: diffTxt(d, t), bench: x.benchName });
  const cpr = cprOf(m);
  const expensive = x.verdict.tone === "bad" || x.verdict.tone === "warn";
  const cheap = x.verdict.tone === "good";
  const enough = m.impressions >= 1000;

  ind.push({ key: "cpr", label: t("notify.campaignReport.ind.cpr"), value: cpr != null ? money(cpr, cur) : "—", bench: x.ref != null ? money(x.ref, cur) : null, tone: x.verdict.tone, note: x.verdict.why });

  // Impression cost: high → narrow / competitive audience / expensive placement.
  const cpm = m.impressions ? (m.spend / m.impressions) * 1000 : null;
  let cpmHigh = false;
  if (cpm != null && bench.cpm && enough) {
    const d = cpm / bench.cpm - 1;
    cpmHigh = d >= 0.3;
    const tone: Tone = cpmHigh ? "warn" : d <= -0.2 ? "good" : "info";
    ind.push({ key: "cpm", label: t("notify.campaignReport.ind.cpm.label"), value: money(cpm, cur), bench: money(bench.cpm, cur), tone, note: vs(d, "notify.campaignReport.ind.cpm.note") });
    if (cpmHigh) tag(t("notify.campaignReport.tag.cpmHigh"), "warn");
  }

  // Content appeal: link CTR.
  const ctr = ratio(m.clicks, m.impressions);
  let ctrLow = false;
  if (ctr != null && bench.ctr && enough) {
    const d = ctr / bench.ctr - 1;
    ctrLow = d <= -0.25;
    const tone: Tone = ctrLow ? "warn" : d >= 0.25 ? "good" : "info";
    ind.push({
      key: "ctr",
      label: t("notify.campaignReport.ind.ctr.label"),
      value: pctTxt(ctr, 2),
      bench: pctTxt(bench.ctr, 2),
      tone,
      note: vs(d, ctrLow ? "notify.campaignReport.ind.ctr.low" : d >= 0.25 ? "notify.campaignReport.ind.ctr.high" : "notify.campaignReport.ind.ctr.normal"),
    });
    tag(ctrLow ? t("notify.campaignReport.tag.ctrLow") : d >= 0.25 ? t("notify.campaignReport.tag.ctrGood") : "", ctrLow ? "warn" : "good");
  }

  // Post-click conversion: many clicks but few messages / leads → greeting, offer, form.
  const cvr = ratio(m.results, m.clicks);
  let cvrLow = false;
  if (CVR_TYPES.has(x.resultType) && cvr != null && bench.cvr && m.clicks >= 30) {
    const d = cvr / bench.cvr - 1;
    cvrLow = d <= -0.25;
    const tone: Tone = cvrLow ? "warn" : d >= 0.25 ? "good" : "info";
    ind.push({
      key: "cvr",
      label: t("notify.campaignReport.ind.cvr.label"),
      value: pctTxt(cvr),
      bench: pctTxt(bench.cvr),
      tone,
      note: vs(d, cvrLow ? "notify.campaignReport.ind.cvr.low" : "notify.campaignReport.ind.cvr.normal"),
    });
    if (cvrLow) tag(t("notify.campaignReport.tag.cvrLow"), "warn");
  }

  // Saturation.
  const freq = m.reach ? m.impressions / m.reach : null;
  let saturated = false;
  if (freq != null && m.reach > 0) {
    saturated = freq > th.freqMax;
    const tone: Tone = saturated ? "warn" : freq > th.freqMax * 0.8 ? "info" : "good";
    ind.push({
      key: "freq",
      label: t("notify.campaignReport.ind.freq.label"),
      value: freq.toFixed(2),
      bench: `≤ ${th.freqMax}`,
      tone,
      note: saturated ? t("notify.campaignReport.ind.freq.saturated") : tone === "info" ? t("notify.campaignReport.ind.freq.near") : t("notify.campaignReport.ind.freq.fine"),
    });
    if (saturated) tag(t("notify.campaignReport.tag.freqHigh"), "warn");
  }

  // Video: 3-second hold and completion.
  let hookLow = false;
  const v = x.video;
  if (v.plays3s > 0 && v.impressions >= 1000) {
    const hook = v.plays3s / v.impressions;
    const hold = v.thruplays / v.plays3s;
    const dh = bench.hook ? hook / bench.hook - 1 : null;
    hookLow = dh != null && dh <= -0.25;
    ind.push({
      key: "hook",
      label: t("notify.campaignReport.ind.hook.label"),
      value: pctTxt(hook),
      bench: bench.hook ? pctTxt(bench.hook) : null,
      tone: hookLow ? "warn" : dh != null && dh >= 0.25 ? "good" : "info",
      note: dh != null ? vs(dh, hookLow ? "notify.campaignReport.ind.hook.low" : "notify.campaignReport.ind.hook.normal") : t("notify.campaignReport.ind.hook.none"),
    });
    ind.push({
      key: "hold",
      label: t("notify.campaignReport.ind.hold.label"),
      value: pctTxt(hold),
      bench: bench.hold ? pctTxt(bench.hold) : null,
      tone: bench.hold && hold / bench.hold - 1 <= -0.25 ? "warn" : "info",
      note: t("notify.campaignReport.ind.hold.note"),
    });
    if (hookLow) tag(t("notify.campaignReport.tag.hookWeak"), "warn");
  }

  // Lead quality (conversations with a source ad + forms).
  let qualityLow = false;
  if (x.quality && x.quality.n >= 5) {
    const q = x.quality;
    const d = bench.quality != null ? q.rate - bench.quality : null;
    qualityLow = (d != null && d <= -0.15) || q.rate < 0.3;
    const tone: Tone = qualityLow ? "warn" : d != null && d >= 0.1 ? "good" : "info";
    ind.push({
      key: "quality",
      label: t("notify.campaignReport.ind.quality.label"),
      value: `${pctTxt(q.rate, 0)} (${q.good}/${q.n})`,
      bench: bench.quality != null ? pctTxt(bench.quality, 0) : null,
      tone,
      note: t("notify.campaignReport.ind.quality.note", { hot: q.hot, spam: q.spam, low: qualityLow ? t("notify.campaignReport.ind.quality.lowNote") : "" }),
    });
    tag(qualityLow ? t("notify.campaignReport.tag.leadBad") : tone === "good" ? t("notify.campaignReport.tag.leadGood") : "", qualityLow ? "warn" : "good");
  }

  // Trend within the period: second half vs first half.
  let worsening = false;
  if (x.halves) {
    const [a, b] = x.halves;
    const ca = cprOf(a);
    const cb = cprOf(b);
    if (ca && cb && a.results >= 5 && b.results >= 5) {
      const d = cb / ca - 1;
      worsening = d >= 0.25;
      ind.push({
        key: "trend",
        label: t("notify.campaignReport.ind.trend.label"),
        value: `${money(ca, cur)} → ${money(cb, cur)}`,
        bench: null,
        tone: worsening ? "warn" : d <= -0.2 ? "good" : "info",
        note: t("notify.campaignReport.ind.trend.note", { dir: d >= 0 ? t("notify.campaignReport.ind.trend.pricier") : t("notify.campaignReport.ind.trend.cheaper"), p: Math.round(Math.abs(d) * 100) }),
      });
      if (worsening) tag(t("notify.campaignReport.tag.worsening"), "warn");
    }
  }
  if (x.prev) {
    const cp = cprOf(x.prev);
    const c = change(cpr, cp);
    if (c != null && x.prev.results >= 5) {
      ind.push({
        key: "prev",
        label: t("notify.campaignReport.ind.prev.label"),
        value: t("notify.campaignReport.ind.prev.value", { sign: c >= 0 ? "+" : "−", p: Math.round(Math.abs(c) * 100) }),
        bench: cp != null ? money(cp, cur) : null,
        tone: c >= 0.2 ? "warn" : c <= -0.1 ? "good" : "info",
        note: t("notify.campaignReport.ind.prev.note", { n: num(x.prev.results), spend: money(x.prev.spend, cur) }),
      });
    }
  }

  // Budget spending.
  let underspend = false;
  if (x.pacing && x.pacing.budget > 0) {
    const r = x.pacing.perDay / x.pacing.budget;
    underspend = r < 0.7;
    ind.push({
      key: "pacing",
      label: t("notify.campaignReport.ind.pacing.label"),
      value: `${money(x.pacing.perDay, cur)} (${Math.round(r * 100)}%)`,
      bench: money(x.pacing.budget, cur),
      tone: underspend ? "warn" : "info",
      note: underspend ? t("notify.campaignReport.ind.pacing.under") : t("notify.campaignReport.ind.pacing.fine"),
    });
    if (underspend) tag(t("notify.campaignReport.tag.underspend"), "warn");
  }

  // Causes + recommended actions.
  const lv = t(`notify.campaignReport.level.${x.level}`);
  if (x.verdict.id === "noResult") {
    causes.push(t("notify.campaignReport.cause.noResult"));
    actions.push({
      text: x.level === "ad" ? t("notify.campaignReport.action.noResultAd") : t("notify.campaignReport.action.noResultOther", { lv }),
      priority: 1,
    });
  }
  if (expensive) {
    if (cpmHigh && !ctrLow) {
      causes.push(t("notify.campaignReport.cause.cpmHigh"));
      actions.push({ text: t("notify.campaignReport.action.widen"), priority: 2 });
    }
    if (ctrLow) {
      causes.push(t("notify.campaignReport.cause.ctrLow"));
      actions.push({ text: t("notify.campaignReport.action.newCreatives"), priority: 1 });
    }
    if (cvrLow) {
      causes.push(t("notify.campaignReport.cause.cvrLow"));
      actions.push({
        text: x.resultType === "leads" ? t("notify.campaignReport.action.cvrLeads") : t("notify.campaignReport.action.cvrMessages"),
        priority: 2,
      });
    }
    // Slightly off metrics (15–25%) also contribute to higher cost.
    const mild: { k: "cpm" | "ctr" | "cvr"; text: string }[] = [];
    if (cpm != null && bench.cpm && !cpmHigh && cpm / bench.cpm - 1 >= 0.15) mild.push({ k: "cpm", text: t("notify.campaignReport.mild.cpm", { diff: diffTxt(cpm / bench.cpm - 1, t) }) });
    if (ctr != null && bench.ctr && !ctrLow && ctr / bench.ctr - 1 <= -0.15) mild.push({ k: "ctr", text: t("notify.campaignReport.mild.ctr", { diff: diffTxt(ctr / bench.ctr - 1, t) }) });
    if (CVR_TYPES.has(x.resultType) && cvr != null && bench.cvr && !cvrLow && m.clicks >= 30 && cvr / bench.cvr - 1 <= -0.15) mild.push({ k: "cvr", text: t("notify.campaignReport.mild.cvr", { diff: diffTxt(cvr / bench.cvr - 1, t) }) });
    if (mild.length) {
      causes.push(t("notify.campaignReport.cause.contrib", { list: mild.map((y) => y.text).join(", "), bench: x.benchName }));
      if (!ctrLow && !cvrLow && mild.some((y) => y.k !== "cpm")) actions.push({ text: t("notify.campaignReport.action.tryNew"), priority: 2 });
    }
    if (!cpmHigh && !ctrLow && !cvrLow && !saturated && !mild.length && x.verdict.id !== "noResult") causes.push(t("notify.campaignReport.cause.funnelOk"));
    if (x.level !== "campaign" && x.verdict.tone === "bad") actions.push({ text: t("notify.campaignReport.action.cutOrPause", { lv }), priority: 2 });
  }
  if (saturated) {
    causes.push(t("notify.campaignReport.cause.freq", { f: freq!.toFixed(1) }));
    actions.push({ text: t("notify.campaignReport.action.refresh"), priority: worsening ? 1 : 2 });
  }
  if (hookLow) actions.push({ text: t("notify.campaignReport.action.hook"), priority: 2 });
  if (worsening && !saturated) {
    causes.push(t("notify.campaignReport.cause.rising"));
    actions.push({ text: t("notify.campaignReport.action.watch"), priority: 2 });
  }
  if (qualityLow) {
    causes.push(t("notify.campaignReport.cause.leadBad"));
    actions.push({ text: t("notify.campaignReport.action.narrow"), priority: cheap ? 1 : 2 });
  }
  if (underspend) actions.push({ text: t("notify.campaignReport.action.underspend"), priority: 3 });
  if (cheap && !qualityLow && !saturated) {
    causes.push(t("notify.campaignReport.cause.cheap"));
    if (!underspend) actions.push({ text: t("notify.campaignReport.action.scale", { pct: th.budgetStepPct }), priority: 1 });
  }
  if (!actions.length && x.verdict.id === "notEnough") actions.push({ text: t("notify.campaignReport.action.moreData"), priority: 3 });
  if (!actions.length && x.verdict.id === "ok") actions.push({ text: t("notify.campaignReport.action.keep"), priority: 3 });

  return { indicators: ind, tags: tags.filter((t) => t.text), causes, actions: actions.sort((a, b) => a.priority - b.priority) };
}

function row(id: string, name: string, status: string, m: ReportMetrics, parentSpend: number, verdict: Verdict, quality: Quality | null, diag: Diagnosis): Row {
  return {
    id,
    name,
    status,
    m,
    cpr: cprOf(m),
    ctr: m.impressions ? (m.clicks / m.impressions) * 100 : null,
    freq: m.reach ? m.impressions / m.reach : null,
    cpm: m.impressions ? (m.spend / m.impressions) * 1000 : null,
    share: parentSpend ? (m.spend / parentSpend) * 100 : 0,
    verdict,
    quality,
    diag,
  };
}

const toQuality = (q: Omit<AdQuality, "conv" | "form" | "rated"> | undefined): Quality | null => (q && q.n ? { n: q.n, good: q.good, hot: q.hot, spam: q.spam, rate: q.good / q.n } : null);
function mergeQuality(list: (AdQuality | undefined)[]) {
  const acc = { n: 0, good: 0, hot: 0, spam: 0 };
  for (const q of list) if (q) for (const k of ["n", "good", "hot", "spam"] as const) acc[k] += q[k];
  return toQuality(acc);
}

const cache = new Map<string, { at: number; data: CampaignReportData }>();
const TTL = 10 * 60_000;

/** Meta metrics for the report period; cached 10 minutes so opening the page then exporting a PDF doesn't call Meta again. */
async function reportData(client: Client, days: ReportPeriod, fresh = false) {
  const key = `${client.id}:${days}`;
  const hit = cache.get(key);
  if (hit && !fresh && Date.now() - hit.at < TTL) return { data: hit.data, at: new Date(hit.at) };
  const data = await getMetaClient(client).fetchCampaignReport(days);
  cache.set(key, { at: Date.now(), data });
  return { data, at: new Date() };
}

export async function buildCampaignReport(client: Client, days: ReportPeriod, opts: { fresh?: boolean } = {}): Promise<CampaignReport> {
  const cur = client.currency;
  const tr = await getT();
  const [{ data, at }, th, qMap] = await Promise.all([reportData(client, days, opts.fresh), thresholdsFor(client), qualityByAd(client.id, periodDays(days))]);
  const qAds = (ids: string[]) => mergeQuality(ids.map((i) => qMap.get(i)));

  // Totals by result type (messaging CPR is not added to link-click CPR).
  const typeKeys = [...new Set(data.campaigns.map((c) => c.resultType))];
  const types: TypeTotal[] = typeKeys
    .map((t) => {
      const list = data.campaigns.filter((c) => c.resultType === t);
      const m = sum(list.map((c) => ({ ...c.m })));
      const prev = sum([...list.map((c) => ({ ...c.prev })), ...data.prevOther.filter((o) => o.resultType === t).map((o) => ({ ...o.m }))]);
      return { resultType: t, label: resultLabels(tr)[t] ?? t, m, prev, cpr: cprOf(m), prevCpr: cprOf(prev), campaigns: list.filter((c) => c.m.spend > 0).length };
    })
    .sort((a, b) => b.m.spend - a.m.spend);
  const total = sum(data.campaigns.map((c) => ({ ...c.m })));
  const prevTotal = sum([...data.campaigns.map((c) => ({ ...c.prev })), ...data.prevOther.map((o) => ({ ...o.m }))]);
  const typeCpr = new Map(types.map((t) => [t.resultType, t.cpr]));

  // Overall levels by result type to compare each campaign's CPM / CTR / conversion / video / lead.
  const campQuality = new Map(data.campaigns.map((c) => [c.id, qAds(data.ads.filter((a) => a.campaignId === c.id).map((a) => a.id))]));
  const videoOf = (ads: CampaignReportData["ads"]) => sum(ads.filter((a) => a.m.plays3s > 0).map((a) => ({ ...a.m })));
  const typeBench = new Map(
    typeKeys.map((t) => {
      const list = data.campaigns.filter((c) => c.resultType === t);
      const ids = new Set(list.map((c) => c.id));
      return [
        t,
        benchOf(
          list.map((c) => ({ m: c.m, quality: campQuality.get(c.id) })),
          data.ads.filter((a) => ids.has(a.campaignId) && a.m.plays3s > 0).map((a) => a.m),
        ),
      ];
    }),
  );
  // Mid-period (to compare first / second half). Lifetime: from the first day with spend instead of the 36-month mark.
  const first = data.daily.reduce((a, d) => (d.date < a ? d.date : a), data.range.until);
  const start = Date.parse(days === "lifetime" ? first : data.range.since);
  const mid = new Date(start + (Date.parse(data.range.until) - start + 864e5) / 2).toISOString().slice(0, 10);

  const campaigns: CampaignRow[] = data.campaigns
    .map((c) => {
      const tgt = c.resultType === client.primaryResult ? targetCprOf(client) : null;
      const ref = tgt ?? (typeCpr.get(c.resultType) ?? null);
      const refLabel = tgt ? targetLabelOf(client, tr) : tr("notify.campaignReport.bench.sharedCpr", { type: resultLabels(tr)[c.resultType] ?? c.resultType });
      const sets = data.adSets.filter((s) => s.campaignId === c.id);
      const ads = data.ads.filter((a) => a.campaignId === c.id);
      const setName = new Map(sets.map((s) => [s.id, s.name]));
      const quality = campQuality.get(c.id) ?? null;
      // Ad sets / ads compared with the rest of the campaign (or the target CPR if set).
      const inner = (m: ReportMetrics) => {
        const rest = { spend: c.m.spend - m.spend, results: c.m.results - m.results };
        return tgt ?? cprOf(rest) ?? cprOf(c.m);
      };
      const innerName = tgt ? targetLabelOf(client, tr) : tr("notify.campaignReport.bench.restOfCampaign");
      const campBench = benchOf(
        [{ m: c.m, quality }],
        ads.filter((a) => a.m.plays3s > 0).map((a) => a.m),
      );

      const cDaily = data.daily.filter((d) => d.campaignId === c.id);
      const halves: [ReportMetrics, ReportMetrics] = [sum(cDaily.filter((d) => d.date < mid).map((d) => ({ ...d.m }))), sum(cDaily.filter((d) => d.date >= mid).map((d) => ({ ...d.m })))];
      const activeDays = cDaily.filter((d) => d.m.spend > 0).length;
      // Lifetime: metrics are aggregated by month, so daily spend rate cannot be computed.
      const pacing = days !== "lifetime" && c.status === "ACTIVE" && c.dailyBudget && activeDays >= 3 ? { budget: c.dailyBudget, perDay: c.m.spend / activeDays } : null;
      const verdict = judge(c.m, ref, th, cur, refLabel, tr);
      const diag = diagnose({
        level: "campaign",
        m: c.m,
        resultType: c.resultType,
        verdict,
        ref,
        bench: typeBench.get(c.resultType)!,
        benchName: tr("notify.campaignReport.bench.campaigns"),
        quality,
        th,
        cur,
        prev: c.prev,
        halves,
        pacing,
        video: videoOf(ads),
        t: tr,
      });

      const adSetRows = sets
        .map((s) => {
          const q = qAds(ads.filter((a) => a.adSetId === s.id).map((a) => a.id));
          const r = inner(s.m);
          const v = judge(s.m, r, th, cur, innerName, tr);
          const d = diagnose({
            level: "adset",
            m: s.m,
            resultType: c.resultType,
            verdict: v,
            ref: r,
            bench: campBench,
            benchName: tr("notify.campaignReport.bench.wholeCampaign"),
            quality: q,
            th,
            cur,
            video: videoOf(ads.filter((a) => a.adSetId === s.id)),
            t: tr,
          });
          return { ...row(s.id, s.name, s.status, s.m, c.m.spend, v, q, d), budget: s.dailyBudget };
        })
        .sort((a, b) => b.m.spend - a.m.spend);
      const adRows = ads
        .map((a) => {
          const q = toQuality(qMap.get(a.id));
          const r = inner(a.m);
          const v = judge(a.m, r, th, cur, innerName, tr);
          const d = diagnose({
            level: "ad",
            m: a.m,
            resultType: c.resultType,
            verdict: v,
            ref: r,
            bench: campBench,
            benchName: tr("notify.campaignReport.bench.wholeCampaign"),
            quality: q,
            th,
            cur,
            video: a.m.plays3s > 0 ? a.m : zero(),
            t: tr,
          });
          return { ...row(a.id, a.name, a.status, a.m, c.m.spend, v, q, d), adSetName: setName.get(a.adSetId) ?? "" };
        })
        .sort((a, b) => b.m.spend - a.m.spend);
      return {
        ...row(c.id, c.name, c.status, c.m, total.spend, verdict, quality, diag),
        objective: c.objective,
        resultType: c.resultType,
        budget: c.dailyBudget ? tr("notify.campaignReport.budget.perDay", { v: money(c.dailyBudget, cur) }) : c.lifetimeBudget ? tr("notify.campaignReport.budget.lifetime", { v: money(c.lifetimeBudget, cur) }) : null,
        prev: c.prev,
        prevCpr: cprOf(c.prev),
        ref,
        refLabel,
        adSets: adSetRows,
        ads: adRows,
      };
    })
    .sort((a, b) => b.m.spend - a.m.spend || a.name.localeCompare(b.name));

  // Action plan: each campaign's priorities, then notable ad sets / ads.
  const plan: CampaignReport["plan"] = [];
  for (const c of campaigns.filter((x) => x.m.spend > 0)) {
    for (const a of c.diag.actions.filter((x) => x.priority <= 2)) plan.push({ ...a, campaign: c.name });
    for (const s of c.adSets.filter((x) => x.verdict.tone === "bad" || x.verdict.tone === "good").slice(0, 3))
      for (const a of s.diag.actions.filter((x) => x.priority === 1)) plan.push({ ...a, campaign: `${c.name} › ${s.name}` });
  }
  plan.sort((a, b) => a.priority - b.priority);

  // Daily trend of the primary result type.
  const primary = types.find((t) => t.resultType === client.primaryResult) ?? types[0];
  const primaryIds = new Set(data.campaigns.filter((c) => c.resultType === primary?.resultType).map((c) => c.id));
  const byDay = new Map<string, { spend: number; results: number; pSpend: number; extra: number }>();
  for (const d of data.daily) {
    const x = byDay.get(d.date) ?? { spend: 0, results: 0, pSpend: 0, extra: 0 };
    x.spend += d.m.spend;
    if (primaryIds.has(d.campaignId)) {
      x.results += d.m.results;
      x.pSpend += d.m.spend;
    } else if (primary?.resultType === "messages") x.extra += d.msgs ?? 0;
    byDay.set(d.date, x);
  }
  const daily = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, ...v }));

  // Age / gender / platform of the primary result type: which segments cost more than the overall level.
  const segMap = new Map<string, SegmentRow>();
  for (const s of data.segments.filter((x) => primaryIds.has(x.campaignId))) {
    const k = `${s.dim}:${s.key}`;
    const label = s.dim === "age" ? AGE_LABEL(s.key, tr) : s.dim === "gender" ? genderLabel(s.key, tr) : (PLATFORM_LABEL[s.key] ?? s.key);
    const x = segMap.get(k) ?? { dim: s.dim, key: s.key, label, m: zero(), cpr: null, share: 0, diff: null };
    add(x.m, s.m);
    segMap.set(k, x);
  }
  const pSpend = primary?.m.spend ?? 0;
  const segments = [...segMap.values()]
    .map((s) => ({ ...s, cpr: cprOf(s.m), share: pSpend ? (s.m.spend / pSpend) * 100 : 0, diff: primary?.cpr && s.m.results ? s.m.spend / s.m.results / primary.cpr - 1 : null }))
    .filter((s) => s.m.spend > 0)
    .sort((a, b) => a.dim.localeCompare(b.dim) || (a.dim === "age" ? a.key.localeCompare(b.key) : b.m.spend - a.m.spend));

  // Automatic commentary (no AI): changes vs the previous period, best / most expensive campaigns, where money is being wasted.
  const highlights: CampaignReport["highlights"] = [];
  if (primary) {
    const ch = change(primary.cpr, primary.prevCpr);
    highlights.push({
      tone: ch == null ? "info" : ch <= -0.05 ? "good" : ch >= 0.1 ? "bad" : "info",
      text: tr("notify.campaignReport.highlight.primary", {
        label: primary.label,
        n: num(primary.m.results),
        cpr: primary.cpr != null ? money(primary.cpr, cur) : "—",
        change: ch != null ? tr("notify.campaignReport.highlight.primaryChange", { dir: ch <= 0 ? tr("notify.campaignReport.highlight.down") : tr("notify.campaignReport.highlight.up"), p: Math.round(Math.abs(ch) * 100) }) : "",
      }),
    });
  }
  const sc = change(total.spend, prevTotal.spend);
  if (sc != null) highlights.push({ tone: "info", text: tr("notify.campaignReport.highlight.spend", { spend: money(total.spend, cur), dir: sc >= 0 ? tr("notify.campaignReport.highlight.up") : tr("notify.campaignReport.highlight.down"), p: Math.round(Math.abs(sc) * 100) }) });
  const good = campaigns.filter((c) => c.verdict.tone === "good");
  const bad = campaigns.filter((c) => c.verdict.tone === "bad" || c.verdict.tone === "warn");
  if (good.length) highlights.push({ tone: "good", text: tr("notify.campaignReport.highlight.good", { list: good.map((c) => `${c.name} (${c.verdict.why.split(",")[0]})`).join("; ") }) });
  if (bad.length) highlights.push({ tone: "bad", text: tr("notify.campaignReport.highlight.bad", { list: bad.map((c) => `${c.name} — ${c.verdict.text.toLowerCase()}`).join("; ") }) });
  const waste = segments.filter((s) => s.share >= 15 && s.diff != null && s.diff * 100 >= th.warnPct);
  for (const s of waste.slice(0, 3)) highlights.push({ tone: "warn", text: tr("notify.campaignReport.highlight.waste", { label: s.label, share: Math.round(s.share), diff: Math.round(s.diff! * 100) }) });
  const zeroSpend = campaigns.filter((c) => c.status === "ACTIVE" && !c.m.spend);
  if (zeroSpend.length) highlights.push({ tone: "warn", text: tr("notify.campaignReport.highlight.zero", { n: zeroSpend.length, list: zeroSpend.map((c) => c.name).join(", ") }) });

  const since = new Date(`${data.range.since}T00:00:00+07:00`);
  const [recs, pending] = await Promise.all([
    db.recommendation.findMany({ where: { clientId: client.id, kind: "optimize", executedAt: { gte: since } }, orderBy: { executedAt: { sort: "desc", nulls: "last" } }, take: 30 }),
    db.recommendation.count({ where: { clientId: client.id, status: "pending" } }),
  ]);
  const optimizations = recs.map((r) => {
    const ev = r.evaluation ? (JSON.parse(r.evaluation) as Record<string, { campaign?: { verdict?: string } }>) : {};
    return { title: r.title, executedAt: r.executedAt, status: r.status, verdict: ev.d7?.campaign?.verdict ?? ev.d3?.campaign?.verdict ?? null };
  });

  return {
    days,
    range: data.range,
    prevRange: data.prevRange,
    generatedAt: at,
    thresholds: th,
    total,
    prevTotal,
    types,
    campaigns,
    daily,
    primaryLabel: primary?.label ?? tr("notify.campaignReport.resultWord"),
    segments,
    highlights,
    plan: plan.slice(0, 15),
    hasQuality: qMap.size > 0,
    optimizations,
    pending,
  };
}
