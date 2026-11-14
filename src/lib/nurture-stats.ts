import { db } from "./db";

/** Which re-engagement messages the customer replied to afterwards (based on messages synced to the DB). */
export async function repliedSet(sends: { id: string; conversationId: string | null; sentAt: Date; status: string }[]) {
  const ok = sends.filter((s) => s.conversationId && s.status !== "failed");
  if (!ok.length) return new Set<string>();
  const min = new Date(Math.min(...ok.map((s) => s.sentAt.getTime())));
  const msgs = await db.message.findMany({
    where: { conversationId: { in: [...new Set(ok.map((s) => s.conversationId!))] }, fromCustomer: true, createdTime: { gt: min } },
    select: { conversationId: true, createdTime: true },
  });
  return new Set(ok.filter((s) => msgs.some((m) => m.conversationId === s.conversationId && m.createdTime > s.sentAt)).map((s) => s.id));
}

/** Re-engagement page metrics for a client. */
export async function nurtureOverview(clientId: string) {
  const week = new Date(Date.now() - 7 * 86400_000);
  const [flows, sends, weekSends, optOuts, in24] = await Promise.all([
    db.nurtureFlow.findMany({ where: { clientId }, orderBy: { updatedAt: "desc" }, include: { _count: { select: { sends: true } } } }),
    db.nurtureSend.findMany({ where: { clientId }, orderBy: { sentAt: "desc" }, take: 30, include: { flow: { select: { id: true, name: true } } } }),
    db.nurtureSend.findMany({ where: { clientId, sentAt: { gt: week }, status: { not: "failed" } }, select: { id: true, conversationId: true, sentAt: true, status: true } }),
    db.nurtureOptOut.findMany({ where: { clientId }, orderBy: { createdAt: "desc" }, take: 50 }),
    db.message.findMany({ where: { conversation: { clientId }, fromCustomer: true, createdTime: { gt: new Date(Date.now() - 86400_000) } }, distinct: ["conversationId"], select: { conversationId: true } }),
  ]);
  const [replied, weekReplied] = await Promise.all([repliedSet(sends), repliedSet(weekSends)]);
  return { flows, sends, optOuts, in24: in24.length, weekSent: weekSends.length, weekReplied: weekReplied.size, replied };
}
