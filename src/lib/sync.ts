import { db, findPaged } from "./db";
import { getMetaClient } from "./meta";
import { logActivity } from "./activity";
import { MetaApiError } from "./meta/graph";
import { markTokenError } from "./token-status";
import type { SyncAdSetHistory, SyncConversation } from "./meta/types";
import { rebuildClientStats } from "./industry-stats";
import { clientPages, type ClientPage } from "./client-pages";
import { extractContacts } from "./pii";
import { attributeConversations } from "./webhook";
import { refreshAutoTargetCpr } from "./target-cpr-refresh";
import { rememberOwnAds } from "./own-ads";
import { pruneMessageImages, saveImagesFor } from "./msg-images";
import { expireStaleRecommendations } from "./recommendations";
import { getT } from "@/i18n/server";
import { viT } from "./format";
import type { T } from "@/i18n/translate";

/** One line of the sync report: which channel, how much was fetched. warn = missing / error, needs user action. */
type SyncChannel = { label: string; value: string; warn?: boolean };
type SyncReport = { channels: SyncChannel[]; errors: string[]; warnings: string[]; posts: number; comments: number };
type Progress = (label: string) => Promise<void>;

const n = (v: number) => v.toLocaleString("vi-VN");

/** Pull the latest data from Meta into the DB, returning a per-channel report. In sample mode, the data is already in the DB. */
export async function syncClient(clientId: string, onProgress?: Progress): Promise<SyncReport> {
  const t = await getT();
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId } });
  const meta = getMetaClient(client);
  const step = async (label: string) => onProgress?.(label);

  // Meta not connected: no data source at all, and no auto-generated sample data.
  if (meta.kind === "mock") {
    return {
      channels: [{ label: "Meta", value: t("core.sync.metaNotConnected"), warn: true }],
      errors: [],
      warnings: [],
      posts: 0,
      comments: 0,
    };
  }

  const pages = clientPages(client);
  let snap, scope;
  const convsByPage: { page: ClientPage; convs: Awaited<ReturnType<typeof meta.fetchConversations>>; error?: string; incremental?: boolean }[] = [];
  try {
    await step(t("core.sync.stepFetching"));
    scope = await meta.accountScope();
    snap = await meta.fetchAccount();
    for (const page of pages) {
      await step(t("core.sync.stepConvs", { page: pages.length > 1 ? ` · ${page.name}` : "", max: n(client.conversationLimit) }));
      try {
        const since = await conversationsSince(clientId, page, client.conversationLimit);
        const convs = await meta.fetchConversations(client.conversationLimit, page.id, since ?? undefined);
        convsByPage.push({ page, convs, incremental: !!since });
      } catch (err) {
        // Main Page error = real error (token, permissions); secondary Page errors are reported separately without stopping the whole sync.
        if (page.primary || (err instanceof MetaApiError && err.code === 190)) throw err;
        convsByPage.push({ page, convs: [], error: friendlyMetaError(err, t) });
      }
    }
  } catch (err) {
    // Authentication error (token expired/revoked) → show a warning on the Meta Token page (System settings).
    if (err instanceof MetaApiError && err.code === 190) await markTokenError(clientId, err.message);
    throw err;
  }

  await step(t("core.sync.stepSavingAds"));
  await storeAccount(clientId, snap, { lastSyncedAt: new Date(), metaTokenError: null });
  // Campaigns / ad sets just paused or re-enabled: pending cards that no longer apply expire immediately.
  await expireStaleRecommendations(clientId).catch(() => 0);

  const convs = convsByPage.flatMap((x) => x.convs.map((c) => ({ ...c, pageId: x.page.id })));
  if (convs.length) await step(t("core.sync.stepSavingConvs", { n: n(convs.length) }));
  const changedBy = await storeConversations(clientId, convs);
  // Advance the "loaded up to" marker only after saving completes (if saving / another Page fails mid-way, reload next time without missing anything).
  for (const x of convsByPage) if (!x.error) await advanceCheckpoint(x.page.id, x.convs);

  // All conversations from a full load are saved → later runs only need to load the new part.
  for (const x of convsByPage) if (!x.error && !x.incremental) await markConversationsFull(x.page.id, client.conversationLimit);

  await refreshContacts(clientId);
  const attributed = await attributeConversations(clientId).catch(() => 0);
  const extra = await syncExtras(clientId, meta, pages, client.analysisDays, step, t);

  const activeCampaigns = snap.campaigns.filter((c) => c.status === "ACTIVE").length;
  const days = client.analysisDays;
  const multi = pages.length > 1;
  const channels: SyncChannel[] = [
    {
      label: t("core.sync.metaAds"),
      value: t("core.sync.metaAdsValue", { campaigns: n(snap.campaigns.length), active: n(activeCampaigns), sets: n(snap.adSets.length), ads: n(snap.ads.length), days: n(snap.daily.length) }),
    },
    // Account also runs for other Pages: state how it was filtered so metrics don't get mixed.
    ...(scope?.filtered
      ? [
          {
            label: t("core.sync.sharedAccount"),
            value:
              t("core.sync.sharedValue", {
                pages: scope.pages.length,
                kept: n(scope.kept),
                skipped: n(scope.skipped),
                others: scope.pages
                  .filter((p) => !p.mine)
                  .map((p) => p.name ?? p.id)
                  .join(", "),
              }) +
              (scope.unknown ? t("core.sync.sharedUnknown", { n: n(scope.unknown) }) : "") +
              (scope.mixed ? t("core.sync.sharedMixed", { n: n(scope.mixed) }) : ""),
            warn: scope.mixed > 0,
          },
        ]
      : []),
    extra.history == null
      ? { label: t("core.sync.history", { days }), value: t("core.sync.errorSeeNotes"), warn: true }
      : { label: t("core.sync.history", { days }), value: t("core.sync.historyValue", { n: n(extra.history) }) },
    extra.breakdowns == null
      ? { label: t("core.sync.breakdowns"), value: t("core.sync.errorSeeNotes"), warn: true }
      : { label: t("core.sync.breakdowns"), value: t("core.sync.breakdownsValue", { n: n(extra.breakdowns), days }) },
  ];
  if (!pages.length) channels.push({ label: t("core.sync.fanpage"), value: t("core.sync.noFanpage"), warn: true });
  for (const { page, convs: list, error, incremental } of convsByPage) {
    const suffix = multi ? ` · ${page.name}` : "";
    const msgs = list.reduce((a, c) => a + c.messages.length, 0);
    const stored = incremental ? await db.conversation.count({ where: { clientId, ...pageWhere(page) } }) : 0;
    channels.push(
      error
        ? { label: t("core.sync.messenger", { suffix }), value: t("core.sync.errorPrefix", { error }), warn: true }
        : incremental
          ? { label: t("core.sync.messenger", { suffix }), value: t("core.sync.onlyNew", { changed: n(changedBy.get(page.id) ?? 0), stored: n(stored) }) }
          : {
              label: t("core.sync.messenger", { suffix }),
              value: t("core.sync.fullLoad", { convs: n(list.length), changed: n(changedBy.get(page.id) ?? 0), msgs: n(msgs) }) + (list.length >= client.conversationLimit ? t("core.sync.hitLimit", { n: n(client.conversationLimit) }) : ""),
            },
    );
    const p = extra.pages.get(page.id);
    if (p) {
      channels.push(
        p.leads == null
          ? { label: t("core.sync.leadForm", { suffix }), value: t("core.sync.errorPrefix", { error: p.leadError ?? t("core.sync.unreadable") }), warn: true }
          : { label: t("core.sync.leadForm", { suffix }), value: t("core.sync.leadFormValue", { leads: n(p.leads), days: Math.min(90, days), fresh: n(p.newLeads ?? 0), forms: n(p.forms ?? 0) }) },
      );
    }
    channels.push(
      !p || p.posts == null
        ? { label: `${t("core.sync.fanpage")}${suffix}`, value: p?.error ? t("core.sync.errorPrefix", { error: p.error }) : t("core.sync.errorSeeNotes"), warn: true }
        : {
            label: `${t("core.sync.fanpage")}${suffix}`,
            value: p.missingPermission ? t("core.sync.postsNoPerm", { n: n(p.posts) }) : t("core.sync.posts", { posts: n(p.posts), comments: n(p.comments ?? 0) }),
            warn: !!p.missingPermission,
          },
    );
  }
  const fromAds = await db.conversation.count({ where: { clientId, sourceAdId: { not: null } } });
  channels.push(
    fromAds
      ? { label: t("core.sync.fromAds"), value: t("core.sync.fromAdsValue", { n: n(fromAds) }) + (attributed ? t("core.sync.justTagged", { n: n(attributed) }) : "") }
      : { label: t("core.sync.fromAds"), value: t("core.sync.fromAdsNone"), warn: true },
  );
  // Instagram Direct messages aren't synced yet: say so, so users don't assume they're there.
  if (pages.some((p) => p.instagramId)) channels.push({ label: t("core.sync.instagram"), value: t("core.sync.instagramValue"), warn: true });

  await logActivity(
    clientId,
    "sync",
    t("core.sync.logSync", { report: channels.map((c) => `${c.label}: ${c.value}`).join("; ") }) +
      (extra.errors.length || extra.warnings.length ? t("core.sync.logNotes", { notes: [...extra.warnings, ...extra.errors].join(" ") }) : ""),
  );
  const sum = (k: "posts" | "comments") => [...extra.pages.values()].reduce((a, p) => a + (p[k] ?? 0), 0);
  return { channels, errors: extra.errors, warnings: extra.warnings, posts: sum("posts"), comments: sum("comments") };
}

type StoredConv = SyncConversation & { pageId: string };

/**
 * Write conversations + messages in batches of 25 (could be thousands of conversations; one big transaction would lock the DB too long).
 * Prisma opens transactions with BEGIN IMMEDIATE (holding the write lock from the first statement): all reads happen first, outside the transaction.
 * Returns the number of conversations with new messages per Page.
 */
async function storeConversations(clientId: string, convs: StoredConv[]) {
  const changedBy = new Map<string, number>();
  // Client enabled "Đọc ảnh khách gửi" (read customer images): download images for new messages / messages without images (freshly fetched Meta links are still valid).
  const { readImages } = await db.client.findUniqueOrThrow({ where: { id: clientId }, select: { readImages: true } });
  const imageTodo: { messageId: string; conversationId: string; urls: string[] }[] = [];
  for (let i = 0; i < convs.length; i += 25) {
    const chunk = convs.slice(i, i + 25);
    // Read existing conversations + messages first (outside the transaction): only write new / changed messages, keeping the write lock short.
    const stored = await db.message.findMany({ where: { id: { in: chunk.flatMap((c) => c.messages.map((m) => m.id)) } }, select: { id: true, text: true, images: true } });
    const storedText = new Map(stored.map((m) => [m.id, m.text]));
    const hasImages = new Set(stored.filter((m) => m.images).map((m) => m.id));
    const storedTime = new Map(
      (await db.conversation.findMany({ where: { id: { in: chunk.map((c) => c.id) } }, select: { id: true, updatedTime: true } })).map((c) => [c.id, c.updatedTime.getTime()]),
    );
    await db.$transaction(async (tx) => {
      for (const conv of chunk) {
        // sourceAdId is set by the webhook (attributeConversations); sync doesn't overwrite it.
        const { messages, sourceAdId: _src, ...rest } = conv;
        void _src;
        const changed = storedTime.get(conv.id) !== conv.updatedTime.getTime();
        if (changed) changedBy.set(conv.pageId, (changedBy.get(conv.pageId) ?? 0) + 1);
        // Don't rewrite the id column on update: it would count as a primary key change and re-check foreign keys.
        const { id: _id, ...fields } = rest;
        void _id;
        await tx.conversation.upsert({
          where: { id: conv.id },
          create: { ...rest, clientId },
          // Conversation has new messages → delete the old analysis so Claude re-analyzes it.
          update: changed ? { ...fields, analyzedAt: null } : fields,
        });
        let fresh = [...new Map(messages.filter((m) => !storedText.has(m.id)).map((m) => [m.id, m])).values()];
        // The webhook may have just written that message after the earlier read: re-check inside the transaction (write lock held).
        if (fresh.length) {
          const raced = new Set((await tx.message.findMany({ where: { id: { in: fresh.map((m) => m.id) } }, select: { id: true } })).map((m) => m.id));
          fresh = fresh.filter((m) => !raced.has(m.id));
        }
        if (fresh.length) await tx.message.createMany({ data: fresh.map(({ imageUrls: _u, ...m }) => (void _u, { ...m, conversationId: conv.id })) });
        if (readImages) {
          for (const m of messages) if (m.fromCustomer && m.imageUrls?.length && !hasImages.has(m.id)) imageTodo.push({ messageId: m.id, conversationId: conv.id, urls: m.imageUrls });
        }
        for (const m of messages) {
          if (storedText.has(m.id) && storedText.get(m.id) !== m.text) await tx.message.update({ where: { id: m.id }, data: { text: m.text } });
        }
      }
    }, { timeout: 60_000 });
  }
  if (imageTodo.length) {
    await saveImagesFor(clientId, [...new Map(imageTodo.map((x) => [x.messageId, x])).values()]).catch((err) => console.error("Downloading message images failed:", err));
    await pruneMessageImages(clientId).catch(() => 0);
  }
  return changedBy;
}

/**
 * Fast message-only sync (background job every 2 minutes, backing up the webhook): load conversations updated after the latest saved one.
 * Light: usually 1 Meta call per Page. Doesn't touch ads / posts (those still follow the full sync schedule).
 */
/** Save campaigns / ad sets / ads + daily metrics to the DB (objects deleted on Meta are deleted from the DB). */
async function storeAccount(clientId: string, snap: Awaited<ReturnType<ReturnType<typeof getMetaClient>["fetchAccount"]>>, clientData: { lastSyncedAt?: Date; metaTokenError: null }) {
  await db.$transaction(async (tx) => {
    // Don't rewrite the id column when updating campaigns / ad sets: it would count as a primary key change and re-check child ad sets / ads.
    for (const c of snap.campaigns) {
      const { id: _id, ...fields } = c;
      void _id;
      await tx.campaign.upsert({ where: { id: c.id }, create: { ...c, clientId }, update: fields });
    }
    for (const s of snap.adSets) {
      const { id: _id, ...fields } = s;
      void _id;
      await tx.adSet.upsert({ where: { id: s.id }, create: { ...s, clientId }, update: fields });
    }
    for (const a of snap.ads) {
      await tx.ad.upsert({ where: { id: a.id }, create: { ...a, clientId }, update: a });
    }
    // Objects deleted/archived on Meta are removed from the DB.
    // A4: an empty snapshot usually means a failed or permission-limited read, not that the
    // account is empty, so a level that came back empty never wipes what is already stored.
    if (snap.ads.length) await tx.ad.deleteMany({ where: { clientId, id: { notIn: snap.ads.map((a) => a.id) } } });
    if (snap.adSets.length) await tx.adSet.deleteMany({ where: { clientId, id: { notIn: snap.adSets.map((s) => s.id) } } });
    if (snap.campaigns.length) await tx.campaign.deleteMany({ where: { clientId, id: { notIn: snap.campaigns.map((c) => c.id) } } });

    for (const d of snap.daily) {
      await tx.dailyMetric.upsert({
        where: { clientId_date: { clientId, date: d.date } },
        create: { ...d, clientId },
        update: d,
      });
    }

    await tx.client.update({ where: { id: clientId }, data: clientData });
  }, { timeout: 60_000 });
  const campName = new Map(snap.campaigns.map((c) => [c.id, c.name]));
  await rememberOwnAds(clientId, snap.ads.map((a) => ({ id: a.id, name: a.name, campaignId: a.campaignId, campaignName: campName.get(a.campaignId) })));
}

/**
 * Fast refresh of ad metrics (campaigns / ad sets / ads over 7 days including today + daily chart), run by the worker every 15 minutes.
 * Doesn't count as a full sync (lastSyncedAt unchanged). The timestamp is stored in Setting sync.ads.<clientId>.
 */
export async function quickSyncAds(clientId: string) {
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId } });
  const meta = getMetaClient(client);
  if (meta.kind === "mock") return null;
  let snap;
  try {
    snap = await meta.fetchAccount();
  } catch (err) {
    if (err instanceof MetaApiError && err.code === 190) await markTokenError(clientId, err.message);
    throw err;
  }
  await storeAccount(clientId, snap, { metaTokenError: null });
  return snap.campaigns.length;
}

const QUICK_CONV_LIMIT = 100;

export async function quickSyncConversations(clientId: string) {
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId } });
  const meta = getMetaClient(client);
  if (meta.kind === "mock") return 0;
  let total = 0;
  for (const page of clientPages(client)) {
    const since = await convCheckpoint(clientId, page);
    // If this Page has never been synced, leave it to the full sync to load (loading everything here would be too heavy).
    if (!since) continue;
    const fetched = await meta.fetchConversations(QUICK_CONV_LIMIT, page.id, since);
    const convs = fetched.filter((c) => c.updatedTime > since);
    if (!convs.length) continue;
    const changed = await storeConversations(clientId, convs.map((c) => ({ ...c, pageId: page.id })));
    total += changed.get(page.id) ?? 0;
    // Hit the limit before reaching back to the old marker (e.g. the worker was down a long time): there are conversations in between not yet loaded.
    // Clear the "fully loaded" flag so the next full sync reloads everything instead of only the new part.
    if (fetched.length >= QUICK_CONV_LIMIT && !fetched.some((c) => c.updatedTime <= since)) await db.setting.deleteMany({ where: { key: `sync.convFull.${page.id}` } });
    await advanceCheckpoint(page.id, convs);
  }
  if (total) {
    await refreshContacts(clientId);
    await attributeConversations(clientId).catch(() => 0);
  }
  return total;
}

/**
 * Each Page's "loaded from Meta up to" marker. Based only on what was read from Meta (not the DB),
 * because the webhook writes new messages to the DB first: a DB-based marker would miss conversations the webhook didn't report.
 */
async function convCheckpoint(clientId: string, page: ClientPage): Promise<Date | null> {
  const row = await db.setting.findUnique({ where: { key: `sync.convCheckpoint.${page.id}` } });
  if (row) return new Date(row.value);
  const last = await db.conversation.findFirst({ where: { clientId, ...pageWhere(page) }, orderBy: { updatedTime: "desc" }, select: { updatedTime: true } });
  return last?.updatedTime ?? null;
}

async function advanceCheckpoint(pageId: string, convs: { updatedTime: Date }[]) {
  if (!convs.length) return;
  const key = `sync.convCheckpoint.${pageId}`;
  const max = new Date(Math.max(...convs.map((c) => c.updatedTime.getTime())));
  const row = await db.setting.findUnique({ where: { key } });
  if (row && new Date(row.value) >= max) return;
  await db.setting.upsert({ where: { key }, create: { key, value: max.toISOString() }, update: { value: max.toISOString() } });
}

const pageWhere = (page: ClientPage) => (page.primary ? { OR: [{ pageId: page.id }, { pageId: null }] } : { pageId: page.id });

/**
 * Marker for loading new conversations: the latest saved update. Reload everything (null) when never fully loaded,
 * when the conversation limit was raised, or the latest full load is more than 7 days old (to be sure nothing is missed).
 */
async function conversationsSince(clientId: string, page: ClientPage, limit: number) {
  const row = await db.setting.findUnique({ where: { key: `sync.convFull.${page.id}` } });
  const full = row ? (JSON.parse(row.value) as { limit: number; at: number }) : null;
  if (!full || full.limit < limit || Date.now() - full.at > 7 * 86400_000) return null;
  return convCheckpoint(clientId, page);
}

async function markConversationsFull(pageId: string, limit: number) {
  const key = `sync.convFull.${pageId}`;
  const value = JSON.stringify({ limit, at: Date.now() });
  await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
}

/** Readable Meta error: strip documentation links, state clearly when a permission is missing. */
export function friendlyMetaError(err: unknown, t: T = viT) {
  const msg = err instanceof Error ? err.message : String(err);
  const perm = msg.match(/'([a-z_]+)' permission/)?.[1];
  if (perm) return t("core.sync.tokenPerm", { perm });
  return msg.replace(/\s*Refer to[\s\S]*$/i, "").replace(/https?:\/\/\S+/g, "").replace(/\(#\d+\)\s*/g, "").trim().slice(0, 200);
}

/**
 * Supplementary sources: Page posts + comments, ad metrics by age/gender/region/platform.
 * Errors here (missing permission, Page hasn't granted read access) don't break the main sync.
 */
async function syncExtras(clientId: string, meta: ReturnType<typeof getMetaClient>, pages: ClientPage[], days: number, step: Progress, t: T) {
  // null = that part failed (unlike 0 = fetched but no data).
  type PageResult = { posts: number | null; comments: number | null; missingPermission: string | null; error?: string; leads?: number | null; newLeads?: number; forms?: number; leadError?: string };
  const out = {
    pages: new Map<string, PageResult>(),
    breakdowns: null as number | null,
    history: null as number | null,
    errors: [] as string[],
    warnings: [] as string[],
  };
  for (const page of pages) {
    const label = pages.length > 1 ? ` (${page.name})` : "";
    const r: PageResult = { posts: null, comments: null, missingPermission: null };
    out.pages.set(page.id, r);
    try {
      await step(t("core.sync.stepPosts", { label }));
      const { posts, comments, missingPermission } = await meta.fetchPageActivity({ posts: 60, commentPosts: 15, commentsPerPost: 40 }, page.id);
      if (missingPermission) {
        r.missingPermission = missingPermission;
        out.warnings.push(t("core.sync.warnPerm", { perm: missingPermission, label }));
      }
      await db.$transaction(async (tx) => {
        for (const p of posts) {
          await tx.pagePost.upsert({ where: { id: p.id }, create: { ...p, clientId, pageId: page.id }, update: { ...p, pageId: page.id, syncedAt: new Date() } });
        }
        const withComments = [...new Set(comments.map((c) => c.postId))];
        await tx.postComment.deleteMany({ where: { postId: { in: withComments } } });
        for (const c of comments) await tx.postComment.create({ data: { ...c, clientId } });
      }, { timeout: 60_000 });
      r.posts = posts.length;
      r.comments = comments.length;
    } catch (err) {
      r.error = friendlyMetaError(err, t);
      out.errors.push(t("core.sync.errPosts", { label, error: r.error }));
    }
    // Instant Form leads (customer directory). Meta only allows reading the last 90 days; older saved leads are kept.
    try {
      await step(t("core.sync.stepLeads", { label }));
      const { leads, forms } = await meta.fetchLeads(days, page.id);
      const existing = new Set((await db.lead.findMany({ where: { id: { in: leads.map((l) => l.id) } }, select: { id: true } })).map((x) => x.id));
      for (let i = 0; i < leads.length; i += 100) {
        await db.$transaction(leads.slice(i, i + 100).map((l) => db.lead.upsert({ where: { id: l.id }, create: { ...l, clientId, pageId: page.id }, update: { ...l, pageId: page.id, syncedAt: new Date() } })));
      }
      r.leads = leads.length;
      r.newLeads = leads.filter((l) => !existing.has(l.id)).length;
      r.forms = forms;
    } catch (err) {
      r.leads = null;
      r.leadError = friendlyMetaError(err, t);
      out.errors.push(t("core.sync.errLeads", { label, error: r.leadError }));
    }
  }
  try {
    await step(t("core.sync.stepBreakdowns", { days }));
    const rows = await meta.fetchBreakdowns(days);
    // A4: keep the previous breakdowns when the read comes back empty.
    if (rows.length) await db.$transaction([db.adBreakdown.deleteMany({ where: { clientId } }), db.adBreakdown.createMany({ data: rows.map((r) => ({ ...r, clientId, days })) })]);
    out.breakdowns = rows.length;
  } catch (err) {
    out.errors.push(t("core.sync.errBreakdowns", { error: friendlyMetaError(err, t) }));
  }
  try {
    await step(t("core.sync.stepHistory", { days }));
    const rows = await meta.fetchAdSetHistory(days);
    await saveAdSetHistory(clientId, rows);
    await rememberOwnAds(clientId, rows.flatMap((r) => (JSON.parse(r.adIds) as string[]).map((id) => ({ id, campaignId: r.campaignId, campaignName: r.campaignName }))));
    out.history = rows.length;
    await rebuildClientStats(clientId); // update targeting performance by industry
    await refreshAutoTargetCpr(clientId); // auto-suggested target CPR (when the user hasn't entered one)
  } catch (err) {
    out.errors.push(t("core.sync.errHistory", { days, error: friendlyMetaError(err, t) }));
  }
  return out;
}

/** Directory: extract phones / emails from customer messages (newest first) for all of the client's conversations. */
async function refreshContacts(clientId: string) {
  const convs = await findPaged((skip, take) =>
    db.conversation.findMany({
      where: { clientId },
      orderBy: { id: "asc" },
      skip,
      take,
      select: { id: true, phone: true, email: true, phones: true, messages: { where: { fromCustomer: true }, orderBy: { createdTime: "desc" }, select: { text: true } } },
    }),
  );
  let found = 0;
  for (const c of convs) {
    const { phones, emails } = extractContacts(c.messages.map((m) => m.text));
    const phone = phones[0] ?? null;
    const email = emails[0] ?? null;
    if (phone || email) found++;
    const all = JSON.stringify(phones);
    if (phone !== c.phone || email !== c.email || all !== c.phones) await db.conversation.update({ where: { id: c.id }, data: { phone, email, phones: all } });
  }
  return found;
}

/** Replace the client's entire ad set history with a fresh read (the date range may have changed). */
async function saveAdSetHistory(clientId: string, rows: SyncAdSetHistory[]) {
  if (!rows.length) return; // A4: an empty read never wipes the stored history
  await db.$transaction([
    db.adSetHistory.deleteMany({ where: { clientId } }),
    db.adSetHistory.createMany({ data: rows.map((r) => ({ ...r, clientId })) }),
  ]);
}
