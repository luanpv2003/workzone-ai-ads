import type { Prisma } from "@prisma/client";
import { db } from "./db";
import type { MessageKey } from "@/i18n/translate";
import { convSourceWhere, isAdSource, leadSourceWhere, parseAdIds } from "./own-ads";

// Agency-wide customer contacts: each contact = one Messenger conversation, always tied to the client (business) they messaged.
// One person is not merged across clients (each Page has its own user ID; data belongs to each client).

/** own: source (wz | other | ad | none, see own-ads.ts); ad: pasted list of ad IDs. ownIds is loaded by withOwnAds. */
// scope: clients the viewer may see (visibleClientIds), set on the server, not taken from the URL; null/empty = all clients.
export type ContactFilter = { src?: string; client?: string; ind?: string; seg?: string; phone?: string; q?: string; own?: string; ad?: string; ownIds?: string[]; scope?: string[] | null };

/** Filter by the selected client, within the viewable clients. */
const clientCond = (f: ContactFilter) =>
  f.scope ? { clientId: { in: f.client ? f.scope.filter((id) => id === f.client) : f.scope } } : f.client ? { clientId: f.client } : {};

const srcOf = (f: ContactFilter) => (isAdSource(f.own) ? f.own : undefined);

export const SEGMENTS: { key: string; labelKey: MessageKey; where: Prisma.ConversationWhereInput }[] = [
  { key: "hot", labelKey: "customers.contacts.segments.hot", where: { leadScore: { gte: 75 } } },
  { key: "ready", labelKey: "customers.contacts.segments.ready", where: { stage: "ready_to_buy" } },
  { key: "considering", labelKey: "customers.contacts.segments.considering", where: { stage: { in: ["interested", "considering"] } } },
  { key: "reply", labelKey: "customers.contacts.segments.reply", where: { needsReply: true } },
  { key: "bought", labelKey: "customers.contacts.segments.bought", where: { stage: "purchased" } },
  { key: "spam", labelKey: "customers.contacts.segments.spam", where: { stage: "spam" } },
  { key: "new", labelKey: "customers.contacts.segments.new", where: { analyzedAt: null } },
];

export function contactWhere(f: ContactFilter): Prisma.ConversationWhereInput {
  const q = f.q?.trim();
  const digits = q?.replace(/\D/g, "") ?? "";
  return {
    ...clientCond(f),
    ...(f.ind && { client: { industryKey: f.ind } }),
    ...(SEGMENTS.find((s) => s.key === f.seg)?.where ?? {}),
    ...(f.phone === "1" && { OR: [{ phone: { not: null } }, { email: { not: null } }] }),
    AND: [
      ...(q ? [{ OR: [{ customerName: { contains: q, mode: "insensitive" as const } }, { intent: { contains: q, mode: "insensitive" as const } }, ...(digits.length >= 4 ? [{ phones: { contains: digits } }] : []), { email: { contains: q, mode: "insensitive" as const } }] }] : []),
      ...convSourceWhere(srcOf(f), f.ownIds ?? [], parseAdIds(f.ad)),
    ],
  };
}

const contactSelect = {
  id: true,
  clientId: true,
  pageId: true,
  customerName: true,
  updatedTime: true,
  intent: true,
  stage: true,
  leadScore: true,
  needsReply: true,
  tags: true,
  analyzedAt: true,
  phone: true,
  phones: true,
  email: true,
  link: true,
  sourceAdId: true,
  adReply: true,
  client: { select: { name: true, industryKey: true, metaPageId: true, metaPageName: true, metaInstagramId: true, metaExtraPages: true } },
} satisfies Prisma.ConversationSelect;

export async function contactRows(f: ContactFilter, take: number, skip = 0) {
  return db.conversation.findMany({ where: contactWhere(f), select: contactSelect, orderBy: [{ updatedTime: "desc" }], take, skip });
}

// ------------------------------------------------------------ Leads from Instant forms

export function leadWhere(f: ContactFilter): Prisma.LeadWhereInput {
  const q = f.q?.trim();
  const digits = q?.replace(/\D/g, "") ?? "";
  return {
    ...clientCond(f),
    ...(f.ind && { client: { industryKey: f.ind } }),
    ...(f.phone === "1" && { OR: [{ phone: { not: null } }, { email: { not: null } }] }),
    AND: [
      ...(q ? [{ OR: [{ name: { contains: q, mode: "insensitive" as const } }, { formName: { contains: q, mode: "insensitive" as const } }, { adName: { contains: q, mode: "insensitive" as const } }, { answers: { contains: q, mode: "insensitive" as const } }, ...(digits.length >= 4 ? [{ phones: { contains: digits } }] : []), { email: { contains: q, mode: "insensitive" as const } }] }] : []),
      ...leadSourceWhere(srcOf(f), f.ownIds ?? [], parseAdIds(f.ad)),
    ],
  };
}

const leadSelect = {
  id: true,
  clientId: true,
  pageId: true,
  formName: true,
  adId: true,
  adName: true,
  campaignName: true,
  createdTime: true,
  name: true,
  phone: true,
  phones: true,
  email: true,
  answers: true,
  platform: true,
  client: { select: { name: true, industryKey: true, metaPageId: true, metaPageName: true, metaInstagramId: true, metaExtraPages: true } },
} satisfies Prisma.LeadSelect;

export async function leadRows(f: ContactFilter, take: number, skip = 0) {
  return db.lead.findMany({ where: leadWhere(f), select: leadSelect, orderBy: [{ createdTime: "desc" }], take, skip });
}
