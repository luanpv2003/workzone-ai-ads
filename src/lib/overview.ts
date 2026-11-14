import { db } from "./db";
import { derive, sumMetrics } from "./format";
import { targetCprOf } from "./target-cpr";

/** Aggregate metrics for 1 client for the overview table. ids: only these clients (null/empty = all clients). */
export async function clientSummaries(ids?: string[] | null) {
  const clients = await db.client.findMany({
    where: ids ? { id: { in: ids } } : {},
    orderBy: { name: "asc" },
    include: {
      campaigns: true,
      audits: { where: { kind: "account" }, orderBy: { createdAt: "desc" }, take: 1 },
      _count: {
        select: {
          recommendations: { where: { status: "pending" } },
          conversations: { where: { needsReply: true } },
        },
      },
    },
  });
  const hot = await db.conversation.groupBy({ by: ["clientId"], where: { leadScore: { gte: 75 }, needsReply: true, ...(ids ? { clientId: { in: ids } } : {}) }, _count: true });
  const hotBy = new Map(hot.map((h) => [h.clientId, h._count]));

  return clients.map((c) => {
    const primary = c.campaigns.filter((x) => x.resultType === c.primaryResult);
    const all = sumMetrics(c.campaigns);
    const main = sumMetrics(primary);
    const d = derive(main);
    const tgt = targetCprOf(c);
    const cprVsTarget = d.cpr != null && tgt ? (d.cpr - tgt) / tgt : null;
    return {
      id: c.id,
      name: c.name,
      industry: c.industry,
      currency: c.currency,
      dataSource: c.dataSource,
      primaryResult: c.primaryResult,
      activeCampaigns: c.campaigns.filter((x) => x.status === "ACTIVE").length,
      spend: all.spend,
      results: main.results,
      cpr: d.cpr,
      roas: derive(all).roas,
      targetCpr: tgt,
      targetAuto: c.targetCpr == null && tgt != null,
      targetRoas: c.targetRoas,
      cprVsTarget,
      score: c.audits[0]?.score ?? null,
      lastAudit: c.audits[0]?.createdAt ?? null,
      pending: c._count.recommendations,
      needsReply: c._count.conversations,
      hotLeads: hotBy.get(c.id) ?? 0,
      lastSyncedAt: c.lastSyncedAt,
    };
  });
}
