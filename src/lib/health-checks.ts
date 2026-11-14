import type { Client } from "@prisma/client";
import { db } from "./db";
import { money } from "./format";
import { CUSTOM_TYPE, extractTargetingItems } from "./audience";
import { MIN_TARGETING_ITEMS } from "./plan-rules";
import { qualityByAd } from "./lead-quality";
import { pctLabel, probCprAbove, probMoreExpensive } from "./stats";
import { targetCprOf, targetLabelOf } from "./target-cpr";
import { getT } from "@/i18n/server";

// Account health scoring in code — the Meta optimization handbook, section G.
// Each item: Pass / Fail / Unknown (missing data) / Not applicable. Score only counts known items; with data coverage < 60% no score is given.
// Claude only reads the results to explain and propose, never scoring itself. If you change rules here, update the skill file too.

export type CheckStatus = "pass" | "fail" | "unknown" | "na";
type CheckSeverity = "critical" | "high" | "medium";
const SEVERITY_WEIGHT: Record<CheckSeverity, number> = { critical: 5, high: 3, medium: 1 };

export type HealthCheck = { key: string; label: string; severity: CheckSeverity; status: CheckStatus; detail: string };
export type HealthReport = {
  score: number | null; // null when coverage < 60%
  coverage: number; // 0-100
  grade: "graded" | "provisional" | "insufficient";
  checks: HealthCheck[];
  window: string;
};

const LEARNING_EVENTS = 50; // [Meta] ~50 results/week per ad set to exit learning
const MIN_QUALITY_SAMPLE = 10;
const GOOD_LEAD_RATE = 0.3;
const MIN_UTILIZATION = 0.7;
const MAX_ADS_PER_SET = 6;
const DAY = 86400000;

const cprOf = (m: { spend: number; results: number }) => (m.results ? m.spend / m.results : null);

/** An ad set's targeted locations, for comparing audience overlap between campaigns. */
function geoKey(targetingJson: string) {
  try {
    const g = (JSON.parse(targetingJson || "{}") as { geo_locations?: Record<string, unknown> }).geo_locations ?? {};
    const keys = Object.entries(g)
      .filter(([k, v]) => Array.isArray(v) && v.length && k !== "location_types")
      .flatMap(([k, v]) => (v as unknown[]).map((x) => `${k}:${typeof x === "object" && x ? ((x as { key?: string }).key ?? JSON.stringify(x)) : String(x)}`))
      .sort();
    return keys.length ? keys.join("|") : null;
  } catch {
    return null;
  }
}

export async function healthChecks(client: Client): Promise<HealthReport> {
  const t = await getT();
  const names = <T extends { name: string }>(list: T[], max = 3, fmt: (x: T) => string = (x) => `"${x.name}"`) =>
    list.slice(0, max).map(fmt).join(", ") + (list.length > max ? t("workflow.health.andMore", { count: list.length - max }) : "");
  const cur = client.currency;
  const m = (v: number | null) => money(v, cur);
  const [campaigns, convs, quality] = await Promise.all([
    db.campaign.findMany({ where: { clientId: client.id }, include: { adSets: { include: { ads: true } } } }),
    db.conversation.findMany({ where: { clientId: client.id, analyzedAt: { not: null } }, select: { leadScore: true, needsReply: true } }),
    qualityByAd(client.id),
  ]);

  const active = campaigns
    .filter((c) => c.status === "ACTIVE")
    .map((c) => {
      const sets = c.adSets.filter((s) => s.status === "ACTIVE").map((s) => ({ ...s, activeAds: s.ads.filter((a) => a.status === "ACTIVE") }));
      return { ...c, sets };
    });
  const activeSets = active.flatMap((c) => c.sets.map((s) => ({ ...s, campaign: c })));
  const primary = campaigns.filter((c) => c.resultType === client.primaryResult && c.spend > 0);
  const acc = primary.reduce((a, c) => ({ spend: a.spend + c.spend, results: a.results + c.results }), { spend: 0, results: 0 });
  const target = targetCprOf(client);
  const ref = target ?? cprOf(acc); // CPR benchmark: the target, otherwise the account-wide CPR
  const refLabel = target ? targetLabelOf(client, t) : t("workflow.health.accountCpr");
  const conf = Math.min(0.99, Math.max(0.5, client.optConfidence / 100));
  const need = ref ? (LEARNING_EVENTS * ref) / 7 : null; // minimum daily budget for an ad set to have a chance of exiting learning
  const checks: HealthCheck[] = [];
  const add = (key: string, label: string, severity: CheckSeverity, status: CheckStatus, detail: string) => checks.push({ key, label, severity, status, detail });

  // 1. Has a target CPR
  add(
    "target_cpr",
    t("workflow.health.targetCpr.label"),
    "high",
    client.targetCpr != null || client.autoTargetCpr != null ? "pass" : "fail",
    client.targetCpr != null
      ? t("workflow.health.targetCpr.manual", { value: m(client.targetCpr) })
      : client.autoTargetCpr != null
        ? t("workflow.health.targetCpr.auto", { value: m(client.autoTargetCpr) })
        : t("workflow.health.targetCpr.none"),
  );

  // 2. CPR vs target (7 days, campaigns with the same primary result type)
  {
    const warnAt = 1 + client.optWarnPct / 100;
    const cprLabel = t("workflow.health.cprVsTarget.label");
    if (!primary.length) add("cpr_vs_target", cprLabel, "critical", "na", t("workflow.health.cprVsTarget.noCampaign"));
    else if (!target) add("cpr_vs_target", cprLabel, "critical", "unknown", t("workflow.health.cprVsTarget.noTarget"));
    else if (acc.spend < client.optMinSpendX * target)
      add("cpr_vs_target", cprLabel, "critical", "unknown", t("workflow.health.cprVsTarget.notEnoughSpend", { spent: m(acc.spend), need: m(client.optMinSpendX * target), x: client.optMinSpendX }));
    else {
      const c = cprOf(acc);
      const ratio = c != null ? c / target : Infinity;
      const p = probCprAbove(acc, target * warnAt);
      const facts = t("workflow.health.cprVsTarget.facts", { spend: m(acc.spend), results: acc.results, cpr: c != null ? t("workflow.health.cprVsTarget.factsCpr", { value: m(c) }) : "", label: targetLabelOf(client, t), target: m(target) });
      if (ratio <= warnAt) add("cpr_vs_target", cprLabel, "critical", "pass", t("workflow.health.cprVsTarget.within", { facts, pct: client.optWarnPct }));
      else if (p >= conf) add("cpr_vs_target", cprLabel, "critical", "fail", t("workflow.health.cprVsTarget.over", { facts, detail: Number.isFinite(ratio) ? t("workflow.health.cprVsTarget.pricier", { pct: Math.round((ratio - 1) * 100) }) : t("workflow.health.cprVsTarget.noResults"), conf: pctLabel(p) }));
      else add("cpr_vs_target", cprLabel, "critical", "unknown", t("workflow.health.cprVsTarget.lowConf", { facts, conf: pctLabel(p), need: pctLabel(conf) }));
    }
  }

  // 3. Lead quality (30 days, customers with a known ad source)
  {
    const q = [...quality.values()].reduce((a, x) => ({ n: a.n + x.n, good: a.good + x.good, spam: a.spam + x.spam, rated: a.rated + x.rated }), { n: 0, good: 0, spam: 0, rated: 0 });
    const lqLabel = t("workflow.health.leadQuality.label");
    if (client.primaryResult !== "messages" && client.primaryResult !== "leads") add("lead_quality", lqLabel, "critical", "na", t("workflow.health.leadQuality.na"));
    else if (q.n < MIN_QUALITY_SAMPLE)
      add("lead_quality", lqLabel, "critical", "unknown", t("workflow.health.leadQuality.fewSamples", { n: q.n, min: MIN_QUALITY_SAMPLE }));
    else {
      const rate = q.good / q.n;
      add(
        "lead_quality",
        lqLabel,
        "critical",
        rate >= GOOD_LEAD_RATE ? "pass" : "fail",
        t("workflow.health.leadQuality.summary", { good: q.good, n: q.n, rate: Math.round(rate * 100), need: GOOD_LEAD_RATE * 100 }) + (q.spam ? t("workflow.health.leadQuality.spam", { count: q.spam }) : "") + (q.rated ? t("workflow.health.leadQuality.rated", { count: q.rated }) : t("workflow.health.leadQuality.notRated")),
      );
    }
  }

  // 4. Responding to hot leads
  {
    const hot = convs.filter((c) => (c.leadScore ?? 0) >= 75 && c.needsReply).length;
    const replyLabel = t("workflow.health.reply.label");
    if (!convs.length) add("reply", replyLabel, "high", "unknown", t("workflow.health.reply.unknown"));
    else add("reply", replyLabel, "high", hot ? "fail" : "pass", hot ? t("workflow.health.reply.hot", { count: hot }) : t("workflow.health.reply.none", { count: convs.length }));
  }

  // 5. Money spent on 0-result ad sets
  const zeroLabel = t("workflow.health.zeroResult.label");
  if (!activeSets.length) add("zero_result", zeroLabel, "critical", "na", t("workflow.health.noActiveSets"));
  else if (!ref) add("zero_result", zeroLabel, "critical", "unknown", t("workflow.health.zeroResult.noRef"));
  else {
    const bad = activeSets.filter((s) => s.results === 0 && s.spend >= client.optMinSpendX * ref);
    const waste = bad.reduce((a, s) => a + s.spend, 0);
    add(
      "zero_result",
      zeroLabel,
      "critical",
      bad.length ? "fail" : "pass",
      bad.length
        ? t("workflow.health.zeroResult.fail", { count: bad.length, waste: m(waste), x: client.optMinSpendX, label: refLabel, ref: m(ref), names: names(bad) })
        : t("workflow.health.zeroResult.pass", { x: client.optMinSpendX, label: refLabel, value: m(client.optMinSpendX * ref) }),
    );
  }

  // 6–7. Budget sufficient to exit learning, and fragmentation (many ad sets splitting the budget)
  {
    const budgeted = active.flatMap((c) =>
      c.sets.map((s) => ({ name: s.name, campaign: c, budget: s.dailyBudget ?? (c.dailyBudget != null && c.sets.length ? c.dailyBudget / c.sets.length : null) })).filter((x) => x.budget != null),
    ) as { name: string; campaign: (typeof active)[number]; budget: number }[];
    const lbLabel = t("workflow.health.learningBudget.label");
    const fragLabel = t("workflow.health.fragmentation.label");
    if (!activeSets.length) {
      add("learning_budget", lbLabel, "medium", "na", t("workflow.health.noActiveSets"));
      add("fragmentation", fragLabel, "high", "na", t("workflow.health.noActiveSets"));
    } else if (!need) {
      add("learning_budget", lbLabel, "medium", "unknown", t("workflow.health.learningBudget.noRef"));
      add("fragmentation", fragLabel, "high", "unknown", t("workflow.health.learningBudget.noRef"));
    } else if (!budgeted.length) {
      add("learning_budget", lbLabel, "medium", "unknown", t("workflow.health.learningBudget.lifetime"));
      add("fragmentation", fragLabel, "high", "unknown", t("workflow.health.learningBudget.lifetime"));
    } else {
      const low = budgeted.filter((x) => x.budget < need);
      add(
        "learning_budget",
        lbLabel,
        "medium",
        low.length ? "fail" : "pass",
        t("workflow.health.learningBudget.need", { need: m(need), label: refLabel, ref: m(ref) }) +
          (low.length ? t("workflow.health.learningBudget.low", { low: low.length, total: budgeted.length, names: names(low) }) : t("workflow.health.learningBudget.allOk")),
      );
      const spread = active
        .filter((c) => c.sets.length >= 2)
        .map((c) => {
          const total = c.dailyBudget ?? c.sets.reduce((a, s) => a + (s.dailyBudget ?? 0), 0);
          // Always allow 2 ad sets (2 directions: right need + adjacent industry); more require enough budget for each ad set.
          return { name: c.name, n: c.sets.length, total, fit: Math.max(2, Math.floor(total / need)) };
        })
        .filter((c) => c.total > 0);
      const bad = spread.filter((c) => c.n > c.fit);
      if (!spread.length) add("fragmentation", fragLabel, "high", "na", t("workflow.health.fragmentation.na"));
      else
        add(
          "fragmentation",
          fragLabel,
          "high",
          bad.length ? "fail" : "pass",
          bad.length
            ? bad.map((c) => t("workflow.health.fragmentation.item", { name: c.name, n: c.n, total: m(c.total), fit: c.fit })).join("; ") + t("workflow.health.fragmentation.merge")
            : t("workflow.health.fragmentation.ok"),
        );
    }
  }

  // 8. Frequency
  {
    const seen = activeSets.filter((s) => s.impressions > 1000 && s.reach > 0);
    const high = seen.filter((s) => s.impressions / s.reach > client.optFreqMax);
    const freqLabel = t("workflow.health.frequency.label");
    if (!seen.length) add("frequency", freqLabel, "medium", activeSets.length ? "unknown" : "na", activeSets.length ? t("workflow.health.frequency.notEnough") : t("workflow.health.frequency.noSets"));
    else
      add(
        "frequency",
        freqLabel,
        "medium",
        high.length ? "fail" : "pass",
        high.length
          ? t("workflow.health.frequency.fail", { count: high.length, max: client.optFreqMax, names: names(high, 3, (s) => `"${s.name}" ${(s.impressions / s.reach).toFixed(1)}`) })
          : t("workflow.health.frequency.pass", { max: client.optFreqMax }),
      );
  }

  // 9. Content diversity, 10. Ads per ad set
  if (!active.length) {
    add("creative_diversity", t("workflow.health.diversity.label"), "medium", "na", t("workflow.health.noActiveCampaigns"));
    add("ads_per_set", t("workflow.health.adsPerSet.label"), "medium", "na", t("workflow.health.noActiveCampaigns"));
  } else {
    const withAds = active.filter((c) => c.sets.some((s) => s.activeAds.length));
    const mono = withAds.filter((c) => new Set(c.sets.flatMap((s) => s.activeAds.map((a) => a.primaryText.trim() || a.name))).size < 2);
    add(
      "creative_diversity",
      t("workflow.health.diversity.label"),
      "medium",
      !withAds.length ? "unknown" : mono.length ? "fail" : "pass",
      !withAds.length ? t("workflow.health.diversity.noAds") : mono.length ? t("workflow.health.diversity.fail", { count: mono.length, names: names(mono) }) : t("workflow.health.diversity.pass"),
    );
    const off = activeSets.filter((s) => s.activeAds.length < 2 || s.activeAds.length > MAX_ADS_PER_SET);
    add(
      "ads_per_set",
      t("workflow.health.adsPerSet.label"),
      "medium",
      !activeSets.length ? "na" : off.length ? "fail" : "pass",
      !activeSets.length
        ? t("workflow.health.frequency.noSets")
        : off.length
          ? t("workflow.health.adsPerSet.fail", { count: off.length, max: MAX_ADS_PER_SET, names: names(off, 3, (s) => `"${s.name}" (${s.activeAds.length})`) })
          : t("workflow.health.adsPerSet.pass", { max: MAX_ADS_PER_SET }),
    );
  }

  // 11. Detailed-targeting ad sets have enough items (platform approach: one direction per ad set, ≥ 10 items, Advantage+ on). Custom-audience / broad ad sets excluded.
  {
    const sets = active.flatMap((c) => c.sets);
    const withItems = sets.map((s) => ({ name: s.name, items: extractTargetingItems(s.targeting) })).filter((x) => x.items.length && !x.items.some((i) => i.type === CUSTOM_TYPE));
    const thin = withItems.filter((x) => x.items.length < MIN_TARGETING_ITEMS);
    add(
      "targeting_depth",
      t("workflow.health.depth.label", { min: MIN_TARGETING_ITEMS }),
      "medium",
      !withItems.length ? "na" : thin.length ? "fail" : "pass",
      !withItems.length
        ? t("workflow.health.depth.na")
        : thin.length
          ? t("workflow.health.depth.fail", { count: thin.length, min: MIN_TARGETING_ITEMS, names: names(thin, 3, (x) => `"${x.name}" (${x.items.length})`) })
          : t("workflow.health.depth.pass", { min: MIN_TARGETING_ITEMS }),
    );
  }

  // 12. Audience overlap between campaigns: 2 campaigns with the same result type have identical targeting (same locations + same detailed targeting items, or both broad).
  {
    const keyed = active
      .filter((c) => c.sets.length)
      .map((c) => ({
        name: c.name,
        keys: c.sets.map((s) => {
          const geo = geoKey(s.targeting);
          return geo ? `${c.resultType}#${geo}#${extractTargetingItems(s.targeting).map((i) => i.key).sort().join(",")}` : null;
        }),
      }))
      .filter((c) => c.keys.every(Boolean));
    const groups = new Map<string, string[]>();
    for (const c of keyed) for (const k of new Set(c.keys)) groups.set(k!, [...(groups.get(k!) ?? []), c.name]);
    const dup = [...new Set([...groups.values()].filter((g) => g.length > 1).map((g) => g.join("\u0000")))].map((g) => g.split("\u0000"));
    add(
      "overlap",
      t("workflow.health.overlap.label"),
      "medium",
      active.length < 2 ? "na" : keyed.length < 2 ? "unknown" : dup.length ? "fail" : "pass",
      active.length < 2
        ? t("workflow.health.overlap.single")
        : keyed.length < 2
          ? t("workflow.health.overlap.noGeo")
          : dup.length
            ? t("workflow.health.overlap.fail", { groups: dup.map((g) => g.map((n) => `"${n}"`).join(" + ")).join("; ") })
            : t("workflow.health.overlap.pass"),
    );
  }

  // 13. Budget fully spent (excluding campaigns running under 7 days)
  {
    const old = active
      .filter((c) => !c.createdTime || Date.now() - c.createdTime.getTime() >= 7 * DAY)
      .map((c) => ({ name: c.name, spend: c.spend, budget: c.dailyBudget ?? (c.sets.some((s) => s.dailyBudget != null) ? c.sets.reduce((a, s) => a + (s.dailyBudget ?? 0), 0) : null) }))
      .filter((c) => c.budget != null && c.budget > 0) as { name: string; spend: number; budget: number }[];
    const spend = old.reduce((a, c) => a + c.spend, 0);
    const cap = old.reduce((a, c) => a + c.budget * 7, 0);
    const util = cap ? spend / cap : null;
    const under = old.filter((c) => c.spend < MIN_UTILIZATION * c.budget * 7);
    add(
      "budget_utilization",
      t("workflow.health.utilization.label"),
      "medium",
      !active.length ? "na" : util == null ? "unknown" : util >= MIN_UTILIZATION ? "pass" : "fail",
      !active.length
        ? t("workflow.health.noActiveCampaigns")
        : util == null
          ? t("workflow.health.utilization.none")
          : t("workflow.health.utilization.summary", { spend: m(spend), cap: m(cap), pct: Math.round(util * 100), need: MIN_UTILIZATION * 100 }) + (util < MIN_UTILIZATION && under.length ? t("workflow.health.utilization.slow", { names: names(under) }) : ""),
    );
  }

  // 14. Budget allocation: a clearly cheaper ad set has a lower budget than an expensive one (ABO campaigns)
  {
    const abo = active.filter((c) => c.dailyBudget == null && c.sets.filter((s) => s.dailyBudget != null).length >= 2);
    const bad: string[] = [];
    let compared = 0;
    for (const c of abo) {
      const sets = c.sets.filter((s) => s.dailyBudget != null && s.results >= 5).sort((a, b) => cprOf(a)! - cprOf(b)!);
      if (sets.length < 2) continue;
      compared++;
      const cheap = sets[0];
      const exp = sets[sets.length - 1];
      const p = probMoreExpensive(exp, cheap);
      if (p >= conf && cheap.dailyBudget! < exp.dailyBudget!)
        bad.push(t("workflow.health.allocation.item", { campaign: c.name, cheap: cheap.name, cheapCpr: m(cprOf(cheap)), cheapBudget: m(cheap.dailyBudget), exp: exp.name, expCpr: m(cprOf(exp)), expBudget: m(exp.dailyBudget), conf: pctLabel(p) }));
    }
    add(
      "budget_allocation",
      t("workflow.health.allocation.label"),
      "high",
      !abo.length ? "na" : !compared ? "unknown" : bad.length ? "fail" : "pass",
      !abo.length ? t("workflow.health.allocation.na") : !compared ? t("workflow.health.allocation.unknown") : bad.length ? `${bad.join("; ")}.` : t("workflow.health.allocation.pass"),
    );
  }

  // 15. Fresh data
  {
    const age = client.lastSyncedAt ? (Date.now() - client.lastSyncedAt.getTime()) / 3600000 : null;
    add(
      "freshness",
      t("workflow.health.fresh.label"),
      "high",
      client.dataSource !== "meta" ? "na" : age == null || age > 26 ? "fail" : "pass",
      client.dataSource !== "meta" ? t("workflow.health.fresh.sample") : age == null ? t("workflow.health.fresh.never") : age > 26 ? t("workflow.health.fresh.old", { hours: Math.round(age) }) : t("workflow.health.fresh.ok", { hours: Math.round(age) }),
    );
  }

  // Score = weight of Passed items / weight of known items; coverage = known weight / weight of all applicable items.
  const w = (list: HealthCheck[]) => list.reduce((a, c) => a + SEVERITY_WEIGHT[c.severity], 0);
  const applicable = checks.filter((c) => c.status !== "na");
  const known = applicable.filter((c) => c.status !== "unknown");
  const coverage = w(applicable) ? Math.round((w(known) / w(applicable)) * 100) : 0;
  const grade = coverage >= 80 ? "graded" : coverage >= 60 ? "provisional" : "insufficient";
  const score = grade === "insufficient" || !w(known) ? null : Math.round((w(known.filter((c) => c.status === "pass")) / w(known)) * 100);
  const order = { fail: 0, unknown: 1, pass: 2, na: 3 };
  checks.sort((a, b) => order[a.status] - order[b.status] || SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity]);
  return { score, coverage, grade, checks, window: t("workflow.health.window") };
}

const GRADE_LABEL: Record<HealthReport["grade"], string> = {
  graded: "Enough data",
  provisional: "Provisional",
  insufficient: "Not enough data to score",
};

/** Compact version for Claude to read. */
export function healthPromptSection(h: HealthReport) {
  const st = { pass: "PASSED", fail: "FAILED", unknown: "UNKNOWN", na: "NOT APPLICABLE" };
  return [
    `# System health score (${h.window})`,
    `Score: ${h.score ?? "not scored"} · Data coverage: ${h.coverage}% (${GRADE_LABEL[h.grade]})`,
    ...h.checks.filter((c) => c.status !== "na").map((c) => `- [${st[c.status]}] ${c.label} (severity ${c.severity}): ${c.detail}`),
  ].join("\n");
}
