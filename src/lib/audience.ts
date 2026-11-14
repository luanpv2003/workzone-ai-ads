import { db } from "./db";
import { getT } from "@/i18n/server";
import { logActivity } from "./activity";
import { maskPii } from "./pii";
import { dateOnly } from "./format";
import { catalog, formatSize, norm, plannerCandidates, searchTargeting, TYPE_LABEL, type TargetingItem } from "./targeting";
import { knowledgePromptSection } from "./knowledge";
import { generateStructured } from "./ai/claude";
import { AUDIENCE_SYSTEM, EXPANSION_SYSTEM } from "./ai/prompts";
import { AudienceAnalysisSchema, AudienceReportSchema, ExpansionSchema, type AudienceAnalysis } from "./ai/schemas";
import { clientProfile, latestConversationInsights, pageAndBreakdownContext } from "./ai/context";
import { BROAD_KEY, industryPromptSection, industryStats } from "./industry-stats";
import { targetCprOf } from "./target-cpr";
import { enqueueRun } from "./targeting-crawl";
import { resolveIdeas } from "./targeting-resolve";
import { hypothesisChecks, hypothesisSection } from "./planner-context";
import { leadScoresByAd } from "./lead-quality";
import { feedbackGood } from "./lead-sheet";

// Customer persona + ranking of top detailed targeting.
// Final score = fit score (Claude scores from the persona) blended with performance score (ad metrics),
// with the performance weight increasing with spend (confidence).

const TOP_N = 20;

/** free: Claude proposed it outside the candidate list (the system found it on Meta). */
export type FitItem = { id: string; name: string; type: string; fit: number; persona: string; reason: string; explore?: boolean; direction?: string | null; free?: boolean };
type ExpansionDirection = { name: string; why: string; keywords: string[]; found: number; missing?: string[] };

export type RankedTargeting = {
  rank: number;
  key: string;
  id: string | null;
  name: string;
  type: string;
  path: string | null;
  size: string;
  score: number;
  fit: number | null;
  perf: number | null;
  confidence: number; // 0-1: confidence of the performance score
  industry?: { index: number; clients: number; results: number; confidence: number } | null; // performance at other clients in the same industry
  verified?: boolean; // enough results (client.minResults) → "Đã kiểm chứng" (Verified)
  persona: string | null;
  reason: string | null;
  spend: number;
  results: number;
  cpr: number | null;
  leadScore: number | null;
  adSets: string[]; // names of ad sets using this item
  sharedWith: number; // number of other items running in the same ad set (performance score is shared)
  prevRank: number | null;
  explore?: boolean; // belongs to an expansion direction (beyond the persona with current evidence)
  slot?: "explore"; // reserved a slot in the top for testing (never run before)
};

// ------------------------------------------------------------ Reading targeting used in ad sets

const DETAIL_TYPES = Object.keys(TYPE_LABEL);
/** Custom / Lookalike audiences: not in the interest catalog, can only be scored by ad metrics. */
export const CUSTOM_TYPE = "custom_audiences";

/** Catalog names with a classification in parentheses: "Beauty salons (cosmetics)" → "beauty salons". */
const bareName = (n: string) => norm(n.replace(/\s*\([^)]*\)\s*$/, ""));

type UsedItem = { key: string; id: string | null; name: string; type: string };

/** Extract detailed targeting items from Meta's targeting spec (flexible_spec) or sample data (array of names). */
export function extractTargetingItems(targetingJson: string | null): UsedItem[] {
  let t: Record<string, unknown>;
  try {
    t = JSON.parse(targetingJson ?? "{}");
  } catch {
    return [];
  }
  const { byId, items } = catalog();
  const out = new Map<string, UsedItem>();
  const add = (type: string, v: unknown) => {
    if (type === CUSTOM_TYPE) {
      const o = typeof v === "object" && v ? (v as { id?: string | number; name?: string }) : { name: String(v) };
      const key = o.id != null ? `ca:${o.id}` : `ca:${norm(o.name ?? "")}`;
      out.set(key, { key, id: null, name: o.name ?? `Tệp ${o.id}`, type: CUSTOM_TYPE });
      return;
    }
    if (typeof v === "object" && v && "id" in v) {
      const o = v as { id: string | number; name?: string };
      const real = byId.get(String(o.id));
      out.set(String(o.id), { key: String(o.id), id: String(o.id), name: real?.name ?? o.name ?? String(o.id), type: real?.type ?? type });
    } else if (typeof v === "string" || typeof v === "number") {
      const real = byId.get(String(v)) ?? items.find((i) => norm(i.name) === norm(String(v))) ?? items.find((i) => bareName(i.name) === norm(String(v)));
      if (real) out.set(real.id, { key: real.id, id: real.id, name: real.name, type: real.type });
      else out.set(`name:${norm(String(v))}`, { key: `name:${norm(String(v))}`, id: null, name: String(v), type });
    }
  };
  const groups = [t, ...((Array.isArray(t.flexible_spec) ? t.flexible_spec : []) as Record<string, unknown>[])];
  for (const g of groups) for (const type of [...DETAIL_TYPES, CUSTOM_TYPE]) if (Array.isArray(g?.[type])) for (const v of g[type] as unknown[]) add(type, v);
  return [...out.values()];
}

// ------------------------------------------------------------ Performance score

/**
 * r = benchmark CPR / actual CPR. r=1 (on target) → 67 points, r=2 (half the cost) → 80, r=0.5 (double the cost) → 50.
 * No results yet: spend below 1 benchmark CPR is not scored yet; the more spent with 0 results, the lower the score.
 */
function perfScore(spend: number, results: number, bench: number, lead: number | null) {
  let base: number | null;
  if (results > 0) {
    const r = bench / (spend / results);
    base = (100 * r) / (r + 0.5);
  } else base = spend < bench ? null : Math.max(0, 20 - 10 * (spend / bench - 1));
  if (base == null) return null;
  // Message quality (average lead score): 50 stays the same, 80 → ×1.24, 20 → ×0.76.
  if (lead != null) base *= 0.6 + (0.8 * lead) / 100;
  return Math.round(Math.max(0, Math.min(100, base)));
}

/** Old rankings (before the verified field existed) use the old confidence threshold. */
export const isVerified = (t: Pick<RankedTargeting, "perf" | "confidence" | "verified">) => t.perf != null && (t.verified ?? t.confidence >= 0.5);

/** Recency weighting: the last 30 days count double compared with older data. */
const RECENT_WEIGHT = 2;

type HistoryRow = { id: string; name: string; campaignName: string; resultType: string; targeting: string; adIds: string[]; spend: number; results: number; wSpend: number; wResults: number };

/** Ad set metrics over analysisDays days (including paused ad sets). If history has not been synced, temporarily use 7-day metrics. */
export async function adSetHistory(clientId: string): Promise<{ rows: HistoryRow[]; days: number | null }> {
  const hist = await db.adSetHistory.findMany({ where: { clientId, spend: { gt: 0 } }, orderBy: { spend: "desc" } });
  if (hist.length) {
    return {
      days: hist[0].days,
      rows: hist.map((h) => ({
        id: h.id,
        name: h.name,
        campaignName: h.campaignName,
        resultType: h.resultType,
        targeting: h.targeting,
        adIds: JSON.parse(h.adIds) as string[],
        spend: h.spend,
        results: h.results,
        wSpend: RECENT_WEIGHT * h.recentSpend + (h.spend - h.recentSpend),
        wResults: RECENT_WEIGHT * h.recentResults + (h.results - h.recentResults),
      })),
    };
  }
  const sets = await db.adSet.findMany({ where: { clientId, spend: { gt: 0 } }, include: { campaign: true, ads: { select: { id: true } } }, orderBy: { spend: "desc" } });
  return {
    days: null,
    rows: sets.map((s) => ({
      id: s.id,
      name: s.name,
      campaignName: s.campaign.name,
      resultType: s.campaign.resultType,
      targeting: s.targeting,
      adIds: s.ads.map((a) => a.id),
      spend: s.spend,
      results: s.results,
      wSpend: s.spend,
      wResults: s.results,
    })),
  };
}

/** Number of top slots reserved for never-run items (so there is always something new to test, not just circling old targeting). */
const EXPLORE_SLOTS = Math.round(TOP_N * 0.3);
const untested = (r: RankedTargeting) => !r.spend && !!r.id && r.type !== CUSTOM_TYPE && (r.fit ?? 0) >= 45;

/**
 * Top N by score, but always with at least EXPLORE_SLOTS never-run items: if short, replace the lowest-scoring run items
 * with the best never-run items (preferring expansion directions). Before any ads run every item is unrun, so nothing changes.
 */
function composeTop(rows: RankedTargeting[]) {
  const top = rows.slice(0, TOP_N);
  const have = top.filter(untested).length;
  if (have >= EXPLORE_SLOTS) return top;
  const pool = rows
    .slice(TOP_N)
    .filter(untested)
    .sort((a, b) => Number(!!b.explore) - Number(!!a.explore) || b.score - a.score)
    .slice(0, EXPLORE_SLOTS - have)
    .map((r) => ({ ...r, slot: "explore" as const }));
  if (!pool.length) return top;
  const keep = top.filter((r) => untested(r));
  const tested = top.filter((r) => !untested(r)).slice(0, TOP_N - keep.length - pool.length);
  return [...tested, ...keep, ...pool].sort((a, b) => b.score - a.score || (b.fit ?? 0) - (a.fit ?? 0));
}

/** Build a new ranking from the latest analysis's fit scores + current ad metrics. Does not call Claude. */
export async function buildRanking(clientId: string, analysisId?: string) {
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId } });
  const analysis = analysisId
    ? await db.audienceAnalysis.findUniqueOrThrow({ where: { id: analysisId } })
    : await db.audienceAnalysis.findFirst({ where: { clientId }, orderBy: { createdAt: "desc" } });
  const fits: FitItem[] = analysis ? JSON.parse(analysis.candidates) : [];

  // Only compare ad sets with the same primary result type (messaging CPR is not comparable with reach CPR).
  const history = await adSetHistory(clientId);
  const adSets = history.rows.filter((s) => s.resultType === client.primaryResult);
  // AI lead score; for customers a salesperson has rated, use the actual rating (lib/lead-quality.ts).
  const quality = await leadScoresByAd(clientId);
  const adToSet = new Map(adSets.flatMap((s) => s.adIds.map((a) => [a, s.id] as const)));
  const leadBySet = new Map<string, { sum: number; n: number }>();
  for (const q of quality) {
    const s = adToSet.get(q.adId);
    if (!s) continue;
    const m = leadBySet.get(s) ?? { sum: 0, n: 0 };
    m.sum += q.score;
    m.n++;
    leadBySet.set(s, m);
  }

  const spendAll = adSets.reduce((a, s) => a + s.spend, 0);
  const wSpendAll = adSets.reduce((a, s) => a + s.wSpend, 0);
  const wResultsAll = adSets.reduce((a, s) => a + s.wResults, 0);
  const bench = targetCprOf(client) ?? (wResultsAll ? wSpendAll / wResultsAll : null);

  type Agg = UsedItem & { spend: number; results: number; wSpend: number; wResults: number; leadSum: number; leadN: number; adSets: string[]; sharedWith: number };
  const used = new Map<string, Agg>();
  for (const s of adSets) {
    if (!s.spend) continue;
    const items = extractTargetingItems(s.targeting);
    const lead = leadBySet.get(s.id);
    for (const it of items) {
      const a = used.get(it.key) ?? { ...it, spend: 0, results: 0, wSpend: 0, wResults: 0, leadSum: 0, leadN: 0, adSets: [], sharedWith: 0 };
      a.spend += s.spend;
      a.results += s.results;
      a.wSpend += s.wSpend;
      a.wResults += s.wResults;
      if (lead) {
        a.leadSum += lead.sum;
        a.leadN += lead.n;
      }
      a.adSets.push(s.name);
      a.sharedWith = Math.max(a.sharedWith, items.length - 1);
      used.set(it.key, a);
    }
  }

  // Performance at other clients in the same industry: nudges the score up/down, and adds industry winners to the candidate list.
  const priors = new Map((client.industryKey ? await industryStats(client.industryKey, client.primaryResult, clientId) : []).filter((p) => p.type !== BROAD_KEY).map((p) => [p.key, p]));
  const { byId } = catalog();
  const keys = new Set([
    ...fits.map((f) => f.id),
    ...used.keys(),
    ...[...priors.values()]
      .filter((p) => p.index > 1 && p.confidence >= 0.2 && byId.has(p.key))
      .slice(0, 15)
      .map((p) => p.key),
  ]);
  const rows: RankedTargeting[] = [];
  for (const key of keys) {
    const f = fits.find((x) => x.id === key) ?? null;
    const u = used.get(key) ?? null;
    const real: TargetingItem | undefined = byId.get(key);
    // Items no longer in the catalog (deprecated / not found in Ads Manager): kept only if currently running in an ad, so metrics can be scored.
    if (!real && !u) continue;
    const lead = u && u.leadN >= 3 ? u.leadSum / u.leadN : null;
    // Performance score computed on weighted metrics (recent data weighs more).
    const perf = u && bench ? perfScore(u.wSpend, u.wResults, bench, lead) : null;
    // Confidence grows with real result count, full once minResults is reached; sharing an ad set with many items splits the score, so confidence drops.
    const confidence = perf == null || !u || !bench ? 0 : Math.min(1, u.results / Math.max(1, client.minResults)) / Math.sqrt(1 + u.sharedWith);
    const verified = perf != null && !!u && u.results >= client.minResults && confidence >= 0.5;
    const w = 0.75 * confidence;
    const fit = f?.fit ?? null;
    const prior = priors.get(key) ?? null;
    // Industry reference score: index 1 (equal to average) ≈ 60, 25% better ≈ 80; max weight 40% at full confidence.
    const priorScore = prior ? Math.max(0, Math.min(100, 60 + 80 * (prior.index - 1))) : null;
    const wI = prior ? 0.4 * prior.confidence : 0;
    const base = fit == null ? priorScore : priorScore == null ? fit : fit * (1 - wI) + priorScore * wI;
    const score = Math.round(perf == null ? (base ?? 0) : (base ?? 50) * (1 - w) + perf * w);
    if (fit == null && perf == null && prior == null) continue;
    rows.push({
      rank: 0,
      key,
      id: real?.id ?? u?.id ?? f?.id ?? null,
      name: real?.name ?? f?.name ?? u?.name ?? key,
      type: real?.type ?? f?.type ?? u?.type ?? "interests",
      path: real?.path ?? null,
      size: real ? formatSize(real.vnLo, real.vnHi) : "",
      score,
      fit,
      perf,
      confidence: Math.round(confidence * 100) / 100,
      verified,
      industry: prior && { index: prior.index, clients: prior.clients, results: Math.round(prior.results), confidence: prior.confidence },
      persona: f?.persona ?? null,
      reason: f?.reason ?? null,
      spend: u?.spend ?? 0,
      results: u?.results ?? 0,
      cpr: u && u.results ? Math.round(u.spend / u.results) : null,
      leadScore: lead == null ? null : Math.round(lead),
      adSets: u?.adSets ?? [],
      sharedWith: u?.sharedWith ?? 0,
      prevRank: null,
      explore: f?.explore || undefined,
    });
  }
  rows.sort((a, b) => b.score - a.score || (b.fit ?? 0) - (a.fit ?? 0));
  const top = composeTop(rows).map((r, i) => ({ ...r, rank: i + 1 }));

  // Compare with the previous ranking to show rank changes.
  const prev = await db.targetingRanking.findFirst({ where: { clientId }, orderBy: { createdAt: "desc" } });
  if (prev) {
    const prevRank = new Map((JSON.parse(prev.items) as RankedTargeting[]).map((r) => [r.key, r.rank]));
    for (const r of top) r.prevRank = prevRank.get(r.key) ?? null;
  }

  const withAds = top.some((r) => r.spend > 0);
  const t = await getT();
  const label = withAds
    ? t("targeting.audience.rankLabelAds", { days: history.days ?? 7, date: dateOnly(client.lastSyncedAt ?? new Date()), double: history.days ? t("targeting.audience.rankLabelDouble") : "" })
    : t("targeting.audience.rankLabelBefore", { date: dateOnly(new Date()) });
  return db.targetingRanking.create({
    data: {
      clientId,
      analysisId: analysis?.id ?? null,
      label,
      stage: withAds ? "with_ads" : "before_ads",
      items: JSON.stringify(top),
      benchmarkCpr: bench,
      spend: spendAll,
    },
  });
}

// ------------------------------------------------------------ Persona analysis with Claude

async function adSetEvidence(clientId: string) {
  const { rows } = await adSetHistory(clientId);
  const scores = await leadScoresByAd(clientId);
  return rows.slice(0, 60).map((s) => {
    const ids = new Set(s.adIds);
    const q = scores.filter((c) => ids.has(c.adId));
    const rated = q.filter((c) => c.sale);
    let t: Record<string, unknown> = {};
    try {
      t = JSON.parse(s.targeting);
    } catch {}
    return {
      ad_set: s.name,
      campaign: s.campaignName,
      result_type: s.resultType,
      age: `${t.age_min ?? "?"}-${t.age_max ?? "?"}`,
      genders: t.genders ?? "all",
      detailed_targeting: extractTargetingItems(s.targeting).map((i) => (i.id ? `${i.id} ${i.name}` : i.name)),
      spend: Math.round(s.spend),
      results: s.results,
      cpr: s.results ? Math.round(s.spend / s.results) : null,
      // Weighted CPR: the last 30 days count double, better reflecting the present.
      weighted_cpr: s.wResults ? Math.round(s.wSpend / s.wResults) : null,
      customers_scored: q.length,
      avg_lead_score: q.length ? Math.round(q.reduce((a, c) => a + c.score, 0) / q.length) : null,
      // Sales ratings: number of customers, real customers (Đã chốt / Tốt / Trung bình = Closed / Good / Average), number closed.
      sale_rated: rated.length,
      sale_good: rated.filter((c) => c.score >= 50).length,
      sale_closed: rated.filter((c) => c.score >= 100).length,
    };
  });
}

/**
 * Extract customer quotes (phone/email masked) as evidence for the persona: first conversations sales rated as real customers (Closed first),
 * then conversations with the highest lead score; skip conversations sales rated as junk / wrong audience.
 */
async function customerVoices(clientId: string) {
  const fbs = await db.salesFeedback.findMany({ where: { clientId, rowKey: { startsWith: "M-" } }, select: { rowKey: true, contact: true, quality: true, outcome: true } });
  const verdict = new Map(fbs.map((f) => [f.rowKey.slice(2), { good: feedbackGood(f), closed: f.outcome === "Đã chốt" }]));
  const goodIds = [...verdict].filter(([, v]) => v.good).sort((a, b) => Number(b[1].closed) - Number(a[1].closed)).map(([id]) => id);
  const badIds = [...verdict].filter(([, v]) => v.good === false).map(([id]) => id);
  const include = { messages: { where: { fromCustomer: true }, orderBy: { createdTime: "asc" as const }, take: 4 } };
  const rated = goodIds.length ? await db.conversation.findMany({ where: { clientId, id: { in: goodIds.slice(0, 15) } }, include }) : [];
  rated.sort((a, b) => goodIds.indexOf(a.id) - goodIds.indexOf(b.id));
  const top = await db.conversation.findMany({
    where: { clientId, id: { notIn: [...rated.map((c) => c.id), ...badIds] } },
    orderBy: [{ leadScore: { sort: "desc", nulls: "last" } }, { updatedTime: "desc" }],
    take: Math.max(10, 25 - rated.length),
    include,
  });
  return [...rated, ...top]
    .filter((c) => c.messages.length)
    .map((c) => {
      const v = verdict.get(c.id);
      const tag = v ? `sales: ${v.closed ? "closed" : "real customer"}` : `lead ${c.leadScore ?? "?"}`;
      return `- [${tag}${c.stage ? `, ${c.stage}` : ""}${c.intent ? `, ${c.intent}` : ""}] ${c.messages.map((m) => maskPii(m.text).slice(0, 160)).join(" / ")}`;
    })
    .join("\n");
}

const escRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Library items whose name contains the keyword at the start of a word (mid-word matches excluded; e.g. "loan" in "Đài Loan" still matches, so Claude filters further). */
function keywordHits(k: string) {
  const q = norm(k.trim());
  if (q.length < 3) return [];
  const re = new RegExp(`(^|[^a-z0-9])${escRe(q)}`);
  return searchTargeting(k, 12).filter((it) => re.test(norm(it.name)) || (!!it.en && re.test(norm(it.en))));
}

/**
 * Step 1: Claude ideates expansion directions beyond the persona / running targeting, then looks up the Targeting library by keyword
 * (only real items). Avoids the loop "persona built from customers of old targeting → picks old targeting again".
 */
async function expansionCandidates(
  client: Awaited<ReturnType<typeof db.client.findUniqueOrThrow>>,
  insights: Awaited<ReturnType<typeof latestConversationInsights>>,
  knowledge: string,
  ads: Awaited<ReturnType<typeof adSetEvidence>>,
) {
  const running = [...new Set(ads.flatMap((s) => s.detailed_targeting))];
  const runningIds = new Set(running.map((d) => d.split(" ")[0]));
  const prompt = `# Client profile
${clientProfile(client)}

${knowledge}

# Current personas (from messages)
${insights ? JSON.stringify(insights.personas) : "Messages not analysed yet."}

# Targeting running / run before
${running.slice(0, 80).join("\n") || "No ads run yet."}

Propose expansion directions.`;
  const res = await generateStructured({ clientId: client.id, system: EXPANSION_SYSTEM, prompt, schema: ExpansionSchema, effort: "low" });
  const items = new Map<string, { item: TargetingItem; direction: string }>();
  const directions: ExpansionDirection[] = res.data.directions.slice(0, 6).map((d) => {
    let found = 0;
    const missing: string[] = [];
    for (const k of d.keywords.slice(0, 8)) {
      // Whole phrase first; if few results, look up each long word (≥ 5 chars) in the phrase, e.g. "auto repair" → "repair".
      let list = keywordHits(k);
      if (list.length < 2)
        for (const w of norm(k)
          .split(/[^a-z0-9]+/)
          .filter((x) => x.length >= 5))
          list = list.concat(keywordHits(w));
      if (!list.length) missing.push(k);
      for (const it of list.slice(0, 8)) {
        if (found >= 15) break;
        if ((it.vnHi ?? 0) < 20000 || runningIds.has(it.id) || items.has(it.id)) continue;
        items.set(it.id, { item: it, direction: d.name });
        found++;
      }
    }
    return { name: d.name, why: d.why, keywords: d.keywords, found, missing };
  });
  return { items, directions };
}

/**
 * Expansion keywords not yet in the Targeting library → saved as the client's own keyword set and a small
 * "Mở rộng theo ngành" (Expand by industry) run is queued (the worker queries Meta, adding only real items). The next analysis will have more candidates.
 */
async function queueLibraryScan(client: { id: string; name: string }, directions: ExpansionDirection[]) {
  const kws = [
    ...new Set(
      directions
        .flatMap((d) => d.missing ?? [])
        .map((k) => k.trim())
        .filter((k) => k.length >= 3),
    ),
  ].slice(0, 40);
  if (!kws.length) return 0;
  const name = `Hướng mở rộng · ${client.name}`.slice(0, 120);
  // active: false so full industry scans don't pick up this set; it only runs when selected.
  const set = await db.targetingSeedSet.upsert({ where: { name }, create: { name, keywords: JSON.stringify(kws), active: false }, update: { keywords: JSON.stringify(kws) } });
  const queued = await db.targetingRun.findFirst({ where: { kind: "expand", status: "queued" } });
  if (queued) {
    const p = JSON.parse(queued.params || "{}") as { seedSetIds?: string[] };
    if (p.seedSetIds?.length && !p.seedSetIds.includes(set.id))
      await db.targetingRun.update({ where: { id: queued.id }, data: { params: JSON.stringify({ ...p, seedSetIds: [...p.seedSetIds, set.id] }) } });
  } else if (!(await db.targetingRun.findFirst({ where: { kind: "expand", status: "running" } }))) {
    await enqueueRun("expand", { seedSetIds: [set.id], rounds: 1, maxCalls: 300 }, (await getT())("targeting.audience.triggerExpand", { name: client.name }));
  }
  return kws.length;
}

export async function runAudienceAnalysis(clientId: string) {
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId } });
  const [insights, ads, voices, knowledge, convCount, docCount, pageData, industry] = await Promise.all([
    latestConversationInsights(clientId),
    adSetEvidence(clientId),
    customerVoices(clientId),
    knowledgePromptSection(clientId),
    db.conversation.count({ where: { clientId } }),
    db.knowledgeDoc.count({ where: { clientId, useForAi: true } }),
    pageAndBreakdownContext(clientId),
    industryPromptSection(clientId),
  ]);
  if (!convCount && !ads.length && !docCount && !pageData && client.brief.trim().length < 30) {
    throw new Error((await getT())("targeting.audience.notEnoughData"));
  }

  // Targeting candidates: by industry, description, message insights + currently running items (so items in use are scored too).
  const seed = [client.industry, client.brief, JSON.stringify(insights?.personas ?? ""), (insights?.top_questions ?? []).join(" ")].join(" ");
  // 220 candidates is diverse enough; more makes Claude run much longer without choosing better.
  const candidates = new Map(plannerCandidates(seed, 220).map((i) => [i.id, i]));
  const { byId } = catalog();
  for (const s of ads)
    for (const d of s.detailed_targeting) {
      const it = byId.get(d.split(" ")[0]);
      if (it) candidates.set(it.id, it);
    }
  for (const s of industry.stats) {
    const it = s.itemId ? byId.get(s.itemId) : undefined;
    if (it) candidates.set(it.id, it);
  }
  // Expansion directions: on error, still analyze as before.
  const expansion = await expansionCandidates(client, insights, knowledge, ads).catch(async (err) => {
    await logActivity(clientId, "error", (await getT())("targeting.audience.expansionFailed", { detail: err instanceof Error ? err.message : String(err) }));
    return { items: new Map<string, { item: TargetingItem; direction: string }>(), directions: [] as ExpansionDirection[] };
  });
  for (const { item } of expansion.items.values()) candidates.set(item.id, item);
  const scanned = await queueLibraryScan(client, expansion.directions).catch(() => 0);
  const lines = [...candidates.values()].map((t) => {
    const dir = expansion.items.get(t.id)?.direction;
    return `${t.id} | ${t.type} | ${t.name} | ${formatSize(t.vnLo, t.vnHi) || "?"}${dir ? ` | expansion direction: ${dir}` : ""}`;
  });

  const prompt = `# Client profile
${clientProfile(client)}

${knowledge}

# Insights from the latest message analysis
${insights ? JSON.stringify(insights) : "Messages not analysed yet."}

# What customers say (${convCount} conversations; first the customers sales rated as real customers / closed, then the conversations with the highest lead scores)
${voices || "No conversations yet."}

# Performance per ad set (${client.analysisDays} days, including ad sets that are off, with spend; weighted_cpr: the last 30 days count double; avg_lead_score uses the sales rating when there is one; sale_good / sale_closed are real customers / closed deals confirmed by sales, more reliable than the AI score. Ad sets under ${client.minResults} results are small samples: do not draw firm conclusions)
${ads.length ? JSON.stringify(ads) : "No ads have run yet."}

${pageData}

${industry.text}

${await hypothesisSection(client)}

# Expansion directions beyond the current persona (never targeted before)
${expansion.directions.length ? expansion.directions.map((d) => `- ${d.name}: ${d.why}`).join("\n") : "None."}

# Candidate list of targeting (id | type | name | size in Vietnam | expansion direction if any)
${lines.join("\n")}

Build the target customer persona and score the targeting.`;

  const res = await generateStructured({ clientId: clientId, system: AUDIENCE_SYSTEM, prompt, schema: AudienceAnalysisSchema });
  const report: AudienceAnalysis = res.data;

  // Keep items that really exist in the catalog, normalize scores.
  const fits: FitItem[] = [];
  const seen = new Set<string>();
  // Items Claude proposed outside the candidate list: search Meta by name (if found, add to the Library).
  const free = report.targeting.filter((t) => !candidates.has(t.id) && !byId.get(t.id));
  const resolved = free.length ? await resolveIdeas(free.map((t) => ({ name: t.name, type: t.type }))) : [];
  const freeIds = new Map(free.flatMap((t, i) => (resolved[i] ? [[t, resolved[i]!.item] as const] : [])));
  for (const t of report.targeting) {
    const fr = freeIds.get(t);
    const real = fr ?? catalog().byId.get(t.id);
    if (!real || seen.has(real.id)) continue;
    seen.add(real.id);
    const dir = expansion.items.get(real.id)?.direction ?? null;
    fits.push({
      id: real.id,
      name: real.name,
      type: real.type,
      fit: Math.max(0, Math.min(100, Math.round(t.fit_score))),
      persona: t.persona,
      reason: t.reason,
      explore: !!t.explore || (!!dir && t.persona === dir),
      direction: dir,
      ...(fr && { free: true }),
    });
  }

  const analysis = await db.audienceAnalysis.create({
    data: {
      clientId,
      report: JSON.stringify(report),
      candidates: JSON.stringify(fits),
      stats: JSON.stringify({
        conversations: convCount,
        adSets: ads.length,
        spend: ads.reduce((a, s) => a + s.spend, 0),
        documents: docCount,
        dropped: report.targeting.length - fits.length,
        free: fits.filter((f) => f.free).length,
        directions: expansion.directions,
        libraryScan: scanned,
        // Number of hypotheses with conclusions at build time (lib/freshness.ts: more conclusions trigger a rebuild).
        hypotheses: (await hypothesisChecks(client)).filter((c) => c.verdict === "right" || c.verdict === "wrong").length,
      }),
      model: res.model,
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
    },
  });
  await buildRanking(clientId, analysis.id);
  const tl = await getT();
  await logActivity(clientId, "analyze", tl("targeting.audience.logAnalyzed", { personas: report.personas.length, fits: fits.length, free: fits.some((f) => f.free) ? tl("targeting.audience.logFree", { n: fits.filter((f) => f.free).length }) : "" }));
  return analysis.id;
}

/** Persona summary + top targeting to include in the campaign planning prompt. */
export async function audiencePromptSection(clientId: string) {
  const [analysis, ranking] = await Promise.all([
    db.audienceAnalysis.findFirst({ where: { clientId }, orderBy: { createdAt: "desc" } }),
    db.targetingRanking.findFirst({ where: { clientId }, orderBy: { createdAt: "desc" } }),
  ]);
  if (!analysis) return { text: "", ids: [] as string[] };
  const report = AudienceReportSchema.safeParse(JSON.parse(analysis.report));
  const items: RankedTargeting[] = ranking ? JSON.parse(ranking.items) : [];
  const personas = report.success
    ? report.data.personas.map((p) => `- ${p.name} (${p.share}; ${p.age_range}, ${p.gender}, ${p.locations}): ${p.description} | Messages: ${p.message_angles.join("; ")}`).join("\n")
    : "";
  // Claude leads: Claude's proposals from the persona step come first, with the system's metrics attached as evidence.
  const fits: FitItem[] = JSON.parse(analysis.candidates || "[]");
  const byKey = new Map(items.map((i) => [i.id ?? i.key, i]));
  const evidence = (r: RankedTargeting | undefined) => {
    if (!r) return "no data yet (never run)";
    const parts = [
      r.perf != null ? `performance ${r.perf}/100${r.verified ? " (verified)" : " (small sample)"}, spent ${Math.round(r.spend).toLocaleString("vi-VN")}` : "never run for this client",
      r.industry ? `industry ${r.industry.index >= 1 ? "+" : "−"}${Math.round(Math.abs(r.industry.index - 1) * 100)}% (${r.industry.clients} clients)` : null,
      r.size ? `size ${r.size}` : null,
      `system score ${r.score}`,
    ];
    return parts.filter(Boolean).join(" · ");
  };
  const claude = [...fits]
    .sort((a, b) => b.fit - a.fit)
    .map((f) => `- ${f.id} | ${f.type} | ${f.name} | Claude scored ${f.fit}${f.explore ? " · expansion direction" : ""}${f.free ? " · proposed by Claude itself" : ""} | ${f.persona}: ${f.reason} | evidence: ${evidence(byKey.get(f.id))}`);
  const inFits = new Set(fits.map((f) => f.id));
  const systemOnly = items
    .filter((i) => i.id && !inFits.has(i.id))
    .slice(0, 15)
    .map((i) => `- ${i.id} | ${i.type} | ${i.name} | ${evidence(i)}${i.persona ? ` | ${i.persona}` : ""}`);
  const industry = await industryPromptSection(clientId);
  return {
    ids: [...fits.map((f) => f.id), ...items.flatMap((i) => (i.id ? [i.id] : []))],
    text: `# Target customer persona (analysed ${dateOnly(analysis.createdAt)}, reviewed by the user)
${personas}
${report.success ? `Suggested demographics: ${report.data.demographics.age_min}-${report.data.demographics.age_max}, ${report.data.demographics.genders}. ${report.data.demographics.note}` : ""}

# Targeting Claude proposed at the persona step (id | type | name | fit score | persona: reason | evidence from the data)
This is the starting point; you may keep, drop, or propose better items. If the evidence is bad, weigh it carefully and give the reason if you still choose it.
${claude.join("\n") || "None yet."}

# System assessment: items outside the proposals above (for reference; ${ranking?.label ?? ""})
${systemOnly.join("\n") || "None."}

${industry.text}`,
  };
}
