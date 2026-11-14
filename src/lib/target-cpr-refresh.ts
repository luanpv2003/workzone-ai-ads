import { db } from "./db";
import { AUTO_FACTOR, roundNice } from "./target-cpr";

// Database-dependent part of target CPR, split from target-cpr.ts so browser pages (the campaign composer) can import target-cpr.ts.

/** Recompute the auto-suggested level from AdSetHistory (called after syncing history). Returns the new level (null = not enough data). */
export async function refreshAutoTargetCpr(clientId: string) {
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId } });
  const rows = await db.adSetHistory.findMany({ where: { clientId, resultType: client.primaryResult }, select: { spend: true, results: true, recentSpend: true, recentResults: true } });
  const results = rows.reduce((a, r) => a + r.results, 0);
  const wSpend = rows.reduce((a, r) => a + r.spend + r.recentSpend, 0);
  const wResults = rows.reduce((a, r) => a + r.results + r.recentResults, 0);
  const enough = results >= Math.max(1, client.minResults) && wResults > 0;
  const value = enough ? roundNice((wSpend / wResults) * AUTO_FACTOR) : null;
  const spend = rows.reduce((a, r) => a + r.spend, 0);
  const note = enough
    ? JSON.stringify({ days: client.analysisDays, spend: Math.round(spend), results, avgCpr: Math.round(wSpend / wResults), factor: AUTO_FACTOR, at: new Date().toISOString() })
    : null;
  await db.client.update({ where: { id: clientId }, data: { autoTargetCpr: value, autoTargetCprNote: note } });
  return value;
}
