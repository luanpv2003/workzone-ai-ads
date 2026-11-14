import { db } from "./db";
import { getT } from "@/i18n/server";
import type { T } from "@/i18n/translate";
import { adSetHistory, CUSTOM_TYPE, extractTargetingItems } from "./audience";

// Learn targeting performance per industry from all of the agency's clients.
// Per client: compare each item's CPR with THAT client's average CPR (index > 1 = better), since price levels differ per client.
// Aggregate by industry: geometric mean of the index, weighted by result count. Only aggregated figures, never exposing any client's name / spend.

export const BROAD_KEY = "broad";
// Ad sets with many items (platform approach: ≥ 10 items/ad set) don't reveal which item drove results: split the ad set's spend + results evenly across items.
// The item's CPR is unchanged (both are divided), only the weight drops; items winning across many ad sets / combinations rise to the top when aggregated.

type IndustryStat = {
  key: string;
  itemId: string | null;
  name: string;
  type: string;
  clients: number;
  results: number;
  spend: number;
  index: number; // > 1: better than the client's average
  confidence: number; // 0-1: enough clients + enough results
};

/** Recompute a client's targeting performance (called after each sync). Clients without an industry get their old figures cleared. */
export async function rebuildClientStats(clientId: string) {
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId } });
  await db.targetingClientStat.deleteMany({ where: { clientId } });
  if (!client.industryKey || client.dataSource !== "meta") return 0; // sample data must not be mixed into industry figures
  const tt = await getT();
  const { rows, days } = await adSetHistory(clientId);
  if (!days) return 0; // no 90-day history yet

  type Agg = { key: string; itemId: string | null; name: string; type: string; spend: number; results: number; wSpend: number; wResults: number; adSets: number };
  const out: (Agg & { resultType: string; index: number })[] = [];
  const fullWSpend = new Map<string, number>(); // weighted spend of ad sets containing the item (not split), to evaluate "high spend with 0 results"
  for (const resultType of new Set(rows.map((r) => r.resultType))) {
    const sets = rows.filter((r) => r.resultType === resultType);
    const wSpend = sets.reduce((a, s) => a + s.wSpend, 0);
    const wResults = sets.reduce((a, s) => a + s.wResults, 0);
    if (!wResults) continue;
    const benchCpr = wSpend / wResults;
    const agg = new Map<string, Agg>();
    fullWSpend.clear();
    for (const s of sets) {
      const items = extractTargetingItems(s.targeting).filter((i) => i.type !== CUSTOM_TYPE);
      const list = items.length ? items : [{ key: BROAD_KEY, id: null, name: tt("targeting.industry.broad"), type: BROAD_KEY }];
      const share = 1 / list.length;
      for (const it of list) {
        const a = agg.get(it.key) ?? { key: it.key, itemId: it.id, name: it.name, type: it.type, spend: 0, results: 0, wSpend: 0, wResults: 0, adSets: 0 };
        a.spend += s.spend * share;
        a.results += s.results * share;
        a.wSpend += s.wSpend * share;
        a.wResults += s.wResults * share;
        a.adSets++;
        agg.set(it.key, a);
        fullWSpend.set(it.key, (fullWSpend.get(it.key) ?? 0) + s.wSpend);
      }
    }
    for (const a of agg.values()) {
      // 0 results: only counted when ad sets containing the item spent ≥ 2x the average CPR (clearly poor); otherwise not enough to conclude.
      if (!a.wResults && (fullWSpend.get(a.key) ?? 0) < 2 * benchCpr) continue;
      out.push({ ...a, resultType, index: a.wResults ? benchCpr / (a.wSpend / a.wResults) : 0.1 });
    }
  }
  if (out.length) await db.targetingClientStat.createMany({ data: out.map((o) => ({ ...o, clientId, industryKey: client.industryKey! })) });
  return out.length;
}

/** Aggregated targeting performance of an industry. excludeClientId: exclude the client being viewed (for "suggestions from other clients"). */
export async function industryStats(industryKey: string, resultType: string, excludeClientId?: string): Promise<IndustryStat[]> {
  const rows = await db.targetingClientStat.findMany({
    where: { industryKey, resultType, ...(excludeClientId && { clientId: { not: excludeClientId } }) },
  });
  return aggregate(rows).sort((a, b) => b.confidence * (b.index - 1) - a.confidence * (a.index - 1) || b.results - a.results);
}

type StatRow = { key: string; itemId: string | null; name: string; type: string; clientId: string; results: number; spend: number; wResults: number; index: number };

/** Aggregate per-client figures by item: geometric mean of the index, weighted by √(results). */
function aggregate(rows: StatRow[]): IndustryStat[] {
  const by = new Map<string, StatRow[]>();
  for (const r of rows) (by.get(r.key) ?? by.set(r.key, []).get(r.key)!).push(r);
  return [...by.values()].map((list) => {
    const w = (r: StatRow) => Math.sqrt(r.wResults + 1);
    const sumW = list.reduce((a, r) => a + w(r), 0);
    const logIdx = list.reduce((a, r) => a + w(r) * Math.log(Math.min(10, Math.max(0.1, r.index))), 0) / sumW;
    const clients = new Set(list.map((r) => r.clientId)).size;
    const results = list.reduce((a, r) => a + r.results, 0);
    return {
      key: list[0].key,
      itemId: list[0].itemId,
      name: list[0].name,
      type: list[0].type,
      clients,
      results,
      spend: list.reduce((a, r) => a + r.spend, 0),
      index: Math.round(Math.exp(logIdx) * 100) / 100,
      // Confident at ≥ 3 clients and ≥ 60 results.
      confidence: Math.round(Math.min(1, results / 60) * Math.min(1, clients / 3) * 100) / 100,
    };
  });
}

/**
 * Real performance of each item across all clients (every industry, every result type: the index is relative to each client's own level, so it can be aggregated),
 * with the list of industries it ran in. Used by the Library page: proven items float to the top.
 */
export async function perfByKey() {
  const rows = await db.targetingClientStat.findMany({ where: { key: { not: BROAD_KEY } } });
  const inds = new Map<string, Set<string>>();
  for (const r of rows) (inds.get(r.key) ?? inds.set(r.key, new Set()).get(r.key)!).add(r.industryKey);
  return new Map(aggregate(rows).map((s) => [s.key, { ...s, industries: [...(inds.get(s.key) ?? [])] }]));
}

export const confidenceLabel = (t: T, c: number) => t(c >= 0.99 ? "targeting.industry.confidence.high" : c >= 0.33 ? "targeting.industry.confidence.medium" : "targeting.industry.confidence.low");
export const indexLabel = (i: number) => (i >= 1 ? `+${Math.round((i - 1) * 100)}%` : `−${Math.round((1 - i) * 100)}%`);

/** Prompt snippet: effective targeting in the industry from other clients (for persona analysis and campaign planning). */
export async function industryPromptSection(clientId: string) {
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId } });
  if (!client.industryKey) return { text: "", stats: [] as IndustryStat[] };
  const t = await getT();
  const stats = (await industryStats(client.industryKey, client.primaryResult, clientId)).filter((s) => s.results >= 5);
  if (!stats.length) return { text: "", stats };
  const lines = stats
    .slice(0, 20)
    .map((s) => t("targeting.industry.promptLine", { id: s.itemId ?? "-", type: s.type, name: s.name, index: indexLabel(s.index), clients: s.clients, results: Math.round(s.results), confidence: confidenceLabel(t, s.confidence) }));
  return {
    stats,
    text: t("targeting.industry.promptHeader", { lines: lines.join("\n") }),
  };
}
