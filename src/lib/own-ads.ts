import type { Prisma } from "@prisma/client";
import { db } from "./db";
import type { T } from "@/i18n/translate";

// Separate results brought by the platform's ads from those of other agencies running ads on the same Page (separate ad accounts).
// "Ours" = ads in the client's connected ad account: the OwnAd table (remembered on every sync, never deleted)
// ∪ Ad (currently on Meta) ∪ AdSetHistory.adIds (with spend in the analysis window) — so no backfill of old data is needed.

export type AdSource = "wz" | "other" | "ad" | "none";

const SOURCE_KEYS: AdSource[] = ["wz", "other", "ad", "none"];

/** Source options with labels in the given language: `sourceOptions(t)` with the translator of the request. */
export const sourceOptions = (t: T): { key: AdSource; label: string; hint: string }[] =>
  SOURCE_KEYS.map((key) => ({ key, label: t(`customers.ownAds.${key}.label`), hint: t(`customers.ownAds.${key}.hint`) }));

export const isAdSource = (v: string | undefined): v is AdSource => v === "wz" || v === "other" || v === "ad" || v === "none";

/** Source group of a conversation / lead. */
export const sourceKind = (adId: string | null, own: { has: (id: string) => boolean }, adReply = false): AdSource => (adId ? (own.has(adId) ? "wz" : "other") : adReply ? "ad" : "none");

/** System message Meta inserts into the conversation when a customer messages from an ad (the API doesn't include the ad ID). */
const AD_REPLY_TEXT = ["đã trả lời một quảng cáo", "replied to an ad", "responded to an ad"];

/** Flag conversations containing a "… replied to an ad" message (called after each message sync). */
export async function markAdReplies(clientId: string) {
  // Find first (read, no write lock held) then update by id: an updateMany filtered by message
  // would scan the Message table while holding the write lock (Prisma opens BEGIN IMMEDIATE), making the web wait past socket_timeout.
  const ids = (
    await db.conversation.findMany({
      where: { clientId, adReply: false, messages: { some: { fromCustomer: false, OR: AD_REPLY_TEXT.map((t) => ({ text: { contains: t, mode: "insensitive" as const } })) } } },
      select: { id: true },
    })
  ).map((c) => c.id);
  let count = 0;
  for (let i = 0; i < ids.length; i += 500) {
    count += (await db.conversation.updateMany({ where: { id: { in: ids.slice(i, i + 500) }, adReply: false }, data: { adReply: true } })).count;
  }
  return count;
}

/** Remember ads of the client's ad account (called during sync). */
export async function rememberOwnAds(clientId: string, ads: { id: string; name?: string; campaignId?: string | null; campaignName?: string | null }[]) {
  if (!ads.length) return;
  const known = new Map((await db.ownAd.findMany({ where: { id: { in: ads.map((a) => a.id) } }, select: { id: true, name: true, campaignName: true } })).map((a) => [a.id, a]));
  const now = new Date();
  for (let i = 0; i < ads.length; i += 100) {
    await db.$transaction(
      ads.slice(i, i + 100).map((a) => {
        const k = known.get(a.id);
        const data = { clientId, name: a.name || k?.name || "", campaignId: a.campaignId ?? undefined, campaignName: a.campaignName || k?.campaignName || null, lastSeenAt: now };
        return db.ownAd.upsert({ where: { id: a.id }, create: { id: a.id, ...data }, update: data });
      }),
    );
  }
}

export type OwnAdInfo = { id: string; clientId: string; name: string; campaignName: string | null };

/** All our ads (one client or all), with names for display. */
export async function ownAds(clientId?: string): Promise<Map<string, OwnAdInfo>> {
  const where = clientId ? { clientId } : {};
  const [saved, current, history] = await Promise.all([
    db.ownAd.findMany({ where, select: { id: true, clientId: true, name: true, campaignName: true } }),
    db.ad.findMany({ where, select: { id: true, clientId: true, name: true, campaign: { select: { name: true } } } }),
    db.adSetHistory.findMany({ where, select: { clientId: true, adIds: true, campaignName: true } }),
  ]);
  const out = new Map<string, OwnAdInfo>();
  for (const h of history) for (const id of JSON.parse(h.adIds) as string[]) out.set(id, { id, clientId: h.clientId, name: "", campaignName: h.campaignName || null });
  for (const a of saved) out.set(a.id, { ...a, name: a.name || out.get(a.id)?.name || "", campaignName: a.campaignName ?? out.get(a.id)?.campaignName ?? null });
  for (const a of current) out.set(a.id, { id: a.id, clientId: a.clientId, name: a.name, campaignName: a.campaign.name });
  return out;
}

/** Split a user-pasted list of ad IDs (commas, whitespace, newlines). */
export function parseAdIds(v: string | undefined): string[] {
  return [...new Set((v ?? "").split(/[\s,;]+/).map((x) => x.trim()).filter((x) => /^[\w-]{3,}$/.test(x)))];
}

/** Conversation filter condition by source (joined into AND). */
export function convSourceWhere(src: AdSource | undefined, ownIds: string[], adIds: string[] = []): Prisma.ConversationWhereInput[] {
  const out: Prisma.ConversationWhereInput[] = [];
  if (src === "wz") out.push({ sourceAdId: { in: ownIds } });
  if (src === "other") out.push({ sourceAdId: { not: null, notIn: ownIds } });
  if (src === "ad") out.push({ sourceAdId: null, adReply: true });
  if (src === "none") out.push({ sourceAdId: null, adReply: false });
  if (adIds.length) out.push({ sourceAdId: { in: adIds } });
  return out;
}

/** Form lead filter condition by source (leads always have an ad ID except organic forms, so there's no "unknown ad" group). */
export function leadSourceWhere(src: AdSource | undefined, ownIds: string[], adIds: string[] = []): Prisma.LeadWhereInput[] {
  const out: Prisma.LeadWhereInput[] = [];
  if (src === "wz") out.push({ adId: { in: ownIds } });
  if (src === "other") out.push({ adId: { not: null, notIn: ownIds } });
  if (src === "ad") out.push({ id: { in: [] } });
  if (src === "none") out.push({ adId: null });
  if (adIds.length) out.push({ adId: { in: adIds } });
  return out;
}
