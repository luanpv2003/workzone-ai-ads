import { db } from "./db";
import { feedbackGood } from "./lead-sheet";

// Lead quality per ad: Messenger conversations (lead score from Claude, needs the webhook to know the source ad)
// + Instant Form leads (Meta records the source ad). "Good lead" = conversation score ≥ 50 and not spam,
// or a form lead with a reachable phone / email. If sales has rated the lead (Lead list / Google Sheet), use
// that real-world rating instead of the AI score / phone check.

export type AdQuality = { n: number; good: number; hot: number; spam: number; conv: number; form: number; rated: number };

export async function qualityByAd(clientId: string, days = 30) {
  const since = new Date(Date.now() - days * 86400000);
  const [convs, leads, fbs] = await Promise.all([
    db.conversation.findMany({ where: { clientId, sourceAdId: { not: null }, updatedTime: { gt: since } }, select: { id: true, sourceAdId: true, leadScore: true, stage: true, analyzedAt: true } }),
    db.lead.findMany({ where: { clientId, adId: { not: null }, createdTime: { gt: since } }, select: { id: true, adId: true, phone: true, email: true } }),
    db.salesFeedback.findMany({ where: { clientId }, select: { rowKey: true, contact: true, quality: true, outcome: true } }),
  ]);
  const sale = new Map(fbs.map((f) => [f.rowKey, feedbackGood(f)]));
  const map = new Map<string, AdQuality>();
  const get = (id: string) => map.get(id) ?? map.set(id, { n: 0, good: 0, hot: 0, spam: 0, conv: 0, form: 0, rated: 0 }).get(id)!;
  for (const c of convs) {
    const real = sale.get(`M-${c.id}`) ?? null;
    if (real === null && !c.analyzedAt) continue;
    const q = get(c.sourceAdId!);
    q.n++;
    q.conv++;
    if (real !== null) {
      q.rated++;
      if (real) q.good++;
      else q.spam++;
      continue;
    }
    const spam = c.stage === "spam" || (c.leadScore ?? 0) < 20;
    if (spam) q.spam++;
    if (!spam && (c.leadScore ?? 0) >= 50) q.good++;
    if ((c.leadScore ?? 0) >= 75) q.hot++;
  }
  for (const l of leads) {
    const real = sale.get(`F-${l.id}`) ?? null;
    const q = get(l.adId!);
    q.n++;
    q.form++;
    if (real !== null) {
      q.rated++;
      if (real) q.good++;
      continue;
    }
    if (l.phone || l.email) q.good++;
  }
  return map;
}

/** Score replacing the AI lead score once sales has rated: Closed / Good / Average = real customer, Poor / Wrong audience / Wrong number = junk. */
const SALE_SCORE = { closed: 100, good: 85, bad: 5 } as const;

type AdLeadScore = { adId: string; score: number; sale: boolean };

/**
 * Per-lead score by source ad, for targeting scoring and persona building: conversations use Claude's lead score,
 * but leads rated by sales (web / Google Sheet / Zalo link / HighLevel) use that real rating; form leads count only once sales has rated them.
 */
export async function leadScoresByAd(clientId: string): Promise<AdLeadScore[]> {
  const [convs, leads, fbs] = await Promise.all([
    db.conversation.findMany({ where: { clientId, sourceAdId: { not: null } }, select: { id: true, sourceAdId: true, leadScore: true } }),
    db.lead.findMany({ where: { clientId, adId: { not: null } }, select: { id: true, adId: true } }),
    db.salesFeedback.findMany({ where: { clientId }, select: { rowKey: true, contact: true, quality: true, outcome: true } }),
  ]);
  const scoreOf = (f: (typeof fbs)[number]) => {
    if (f.outcome === "Đã chốt") return SALE_SCORE.closed;
    const good = feedbackGood(f);
    return good === null ? null : good ? SALE_SCORE.good : SALE_SCORE.bad;
  };
  const sale = new Map(fbs.map((f) => [f.rowKey, scoreOf(f)]));
  const out: AdLeadScore[] = [];
  for (const c of convs) {
    const real = sale.get(`M-${c.id}`) ?? null;
    if (real != null) out.push({ adId: c.sourceAdId!, score: real, sale: true });
    else if (c.leadScore != null) out.push({ adId: c.sourceAdId!, score: c.leadScore, sale: false });
  }
  for (const l of leads) {
    const real = sale.get(`F-${l.id}`) ?? null;
    if (real != null) out.push({ adId: l.adId!, score: real, sale: true });
  }
  return out;
}
