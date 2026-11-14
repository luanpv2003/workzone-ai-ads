import type { Client, SalesLift } from "@prisma/client";
import { db } from "./db";
import { getMetaClient } from "./meta";
import type { LiftInsights } from "./meta/types";
import { kiotCreds, kiotGet, vnDay } from "./kiotviet";
import { norm } from "./text";
import { getT } from "@/i18n/server";
import {
  addDays,
  adLabel,
  branchKeysToText,
  computeLift,
  defaultBranchKeys,
  idfOf,
  MIN_DAYS,
  orderMatcher,
  parseBranchKeys,
  suggestControls,
  suggestTestProducts,
  type Period,
  type ProductRef,
  type SameCategory,
} from "./sales-lift-calc";

// Per-SKU performance: campaigns / ads boosting existing posts (Engagement objective) measured by KiotViet sales of the advertised SKUs,
// compared against the baseline before launch and a group of control SKUs. Computation is in sales-lift-calc.ts; this file reads the DB, KiotViet, Meta.

const yesterday = () => addDays(vnDay(new Date()), -1);
const runPeriod = (l: Pick<SalesLift, "runStart" | "runEnd">): Period => ({ start: l.runStart, end: l.runEnd ?? yesterday() });
const basePeriod = (l: Pick<SalesLift, "baseStart" | "baseEnd">): Period => ({ start: l.baseStart, end: l.baseEnd });
export const parseIds = (s: string): string[] => {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
};

/** Days with KiotViet sales (invoices in at least one store). */
async function dataDays(clientId: string, from: string, to: string) {
  const rows = await db.kvDaily.groupBy({ by: ["date"], where: { clientId, date: { gte: from, lte: to } }, _sum: { invoices: true, revenue: true } });
  return rows.filter((r) => (r._sum.invoices ?? 0) > 0).map((r) => ({ date: r.date, revenue: r._sum.revenue ?? 0 }));
}

/** Catalog of products sold around the 2 periods, with baseline sales (to suggest advertised / control SKUs and for user selection). */
async function liftProducts(clientId: string, base: Period, run: Period) {
  const from = base.start < run.start ? base.start : run.start;
  const to = base.end > run.end ? base.end : run.end;
  const rows = await db.kvProductDaily.findMany({ where: { clientId, date: { gte: addDays(from, -30), lte: to } }, select: { productId: true, code: true, name: true, date: true, qty: true, revenue: true } });
  const map = new Map<string, ProductRef & { days: Set<string> }>();
  for (const r of rows) {
    let p = map.get(r.productId);
    if (!p) map.set(r.productId, (p = { id: r.productId, code: r.code, name: r.name, baseQty: 0, baseRevenue: 0, baseDaysSold: 0, recentQty: 0, days: new Set() }));
    if (r.date >= base.start && r.date <= base.end) {
      p.baseQty += r.qty;
      p.baseRevenue += r.revenue;
      if (r.qty > 0) p.days.add(r.date);
    }
    p.recentQty += r.qty;
  }
  const products = [...map.values()].map(({ days, ...p }) => ({ ...p, baseDaysSold: days.size }));
  return { products, rows: rows.filter((r) => r.date >= from) };
}

// ------------------------------------------------------------------ Default suggestions

type AdRef = { id: string; name: string; text: string; campaignId: string };

/** Ads of the measured object (in the synced DB). */
async function adsOf(clientId: string, level: string, objectId: string): Promise<AdRef[]> {
  const ads = await db.ad.findMany({ where: { clientId, ...(level === "ad" ? { id: objectId } : { campaignId: objectId }) }, select: { id: true, name: true, primaryText: true, campaignId: true } });
  return ads.map((a) => ({ id: a.id, name: a.name, text: a.primaryText, campaignId: a.campaignId }));
}

/** KiotViet product groups of the advertised SKUs and SKUs in the same groups (read directly from KiotViet, read-only). On error, skip and use name-based suggestions. */
async function kvCategories(client: Client, testIds: string[]): Promise<SameCategory | undefined> {
  try {
    const creds = kiotCreds(client);
    if (!creds || !testIds.length) return undefined;
    type Prod = { id: number; categoryId?: number; categoryName?: string };
    const info = await Promise.all(testIds.map((id) => kiotGet<Prod>(creds, `/products/${id}`).catch(() => null)));
    const cats = new Map<number, { name: string; ids: Set<string> }>();
    for (const p of info) if (p?.categoryId && !cats.has(p.categoryId)) cats.set(p.categoryId, { name: p.categoryName ?? "", ids: new Set() });
    for (const [catId, c] of cats) {
      for (let at = 0; at < 500; at += 100) {
        const page = await kiotGet<{ data?: Prod[] }>(creds, "/products", { categoryId: catId, pageSize: 100, currentItem: at });
        const rows = page.data ?? [];
        for (const p of rows) if (p.categoryId === catId) c.ids.add(String(p.id));
        if (rows.length < 100) break;
      }
    }
    const out: SameCategory = new Map();
    testIds.forEach((id, i) => {
      const c = info[i]?.categoryId ? cats.get(info[i]!.categoryId!) : undefined;
      if (c?.ids.size) out.set(id, c);
    });
    return out;
  } catch {
    return undefined;
  }
}

/** SKUs present in any of the client's ads (not used as controls). */
async function advertisedIds(clientId: string, products: ProductRef[], idf: (w: string) => number) {
  const ads = await db.ad.findMany({ where: { clientId }, select: { name: true, primaryText: true } });
  return new Set(suggestTestProducts(ads.map((a) => ({ label: adLabel(a.name), text: a.primaryText })), products, idf).map((p) => p.id));
}

type LiftDefaults = {
  runStart: string;
  baseStart: string;
  baseEnd: string;
  testIds: string[];
  controlIds: string[];
  branchWords: string;
  note: string;
};

/**
 * Prefill for a measurement:
 * - Run period: from the first day with spend (Meta, last 90 days); with no spend yet, from today.
 * - Baseline: the 14 days right before the run period; if another of our campaigns advertised the same post (same template name) in the prior 28 days, move the baseline before that campaign started.
 *   Clipped to the first day with KiotViet sales.
 * - Advertised SKUs: match ad names / post content to product names. Control SKUs: same product group, steady sales, not advertised.
 */
export async function liftDefaults(client: Client, level: "campaign" | "ad", objectId: string, keepRunStart?: string): Promise<LiftDefaults> {
  const t = await getT();
  const notes: string[] = [];
  const today = vnDay(new Date());
  let runStart = keepRunStart;
  if (!runStart) {
    const ins = await getMetaClient(client)
      .fetchLiftInsights(level, objectId, addDays(today, -89), today)
      .catch(() => null);
    runStart = ins?.daily.find((d) => d.spend > 0)?.date;
    if (runStart) notes.push(t("settings.salesLift.runStartFirstSpend", { day: runStart }));
    else if (ins) {
      runStart = today;
      notes.push(t("settings.salesLift.noSpendYet"));
    } else {
      // Meta unreadable: use the synced campaign creation date.
      const camp = await db.campaign.findFirst({
        where: { clientId: client.id, ...(level === "ad" ? { ads: { some: { id: objectId } } } : { id: objectId }) },
        select: { createdTime: true },
      });
      runStart = camp?.createdTime ? vnDay(camp.createdTime) : today;
      notes.push(t("settings.salesLift.spendUnreadable", { from: camp?.createdTime ? t("settings.salesLift.campaignCreated") : t("settings.salesLift.today"), day: runStart }));
    }
  }

  // Baseline: move back before another campaign that ran the same ad template.
  const ads = await adsOf(client.id, level, objectId);
  const labels = new Set(ads.map((a) => norm(adLabel(a.name))));
  const mine = new Set(ads.map((a) => a.id));
  const others = await db.ad.findMany({
    where: { clientId: client.id, id: { notIn: [...mine] }, campaign: { createdTime: { lt: new Date(`${runStart}T00:00:00+07:00`), gte: new Date(`${addDays(runStart, -28)}T00:00:00+07:00`) } } },
    select: { name: true, campaign: { select: { name: true, createdTime: true } } },
  });
  const overlap = others.filter((o) => labels.has(norm(adLabel(o.name))) && o.campaign.createdTime);
  let baseEnd = addDays(runStart, -1);
  if (overlap.length) {
    const first = overlap.reduce((a, b) => (a.campaign.createdTime! < b.campaign.createdTime! ? a : b));
    baseEnd = addDays(vnDay(first.campaign.createdTime!), -1);
    notes.push(t("settings.salesLift.baseEnd", { end: baseEnd, name: first.campaign.name, since: vnDay(first.campaign.createdTime!) }));
  }
  let baseStart = addDays(baseEnd, -13);
  const firstKv = await db.kvDaily.findFirst({ where: { clientId: client.id }, orderBy: { date: "asc" }, select: { date: true } });
  if (firstKv && firstKv.date > baseStart) {
    baseStart = firstKv.date;
    notes.push(t("settings.salesLift.baseStart", { start: baseStart }));
  }

  const { products } = await liftProducts(client.id, { start: baseStart, end: baseEnd }, { start: runStart, end: today });
  const idf = idfOf(products);
  const test = suggestTestProducts(ads.map((a) => ({ label: adLabel(a.name), text: a.text })), products, idf, t);
  const testIds = test.map((x) => x.id);
  const nb = (await dataDays(client.id, baseStart, baseEnd)).length;
  const controls = suggestControls(testIds, products, await advertisedIds(client.id, products, idf), nb, { idf, categories: await kvCategories(client, testIds), tr: t });
  if (!testIds.length) notes.push(t("settings.salesLift.noSkuMatch"));
  const branches = await db.kvBranch.findMany({ where: { clientId: client.id }, select: { name: true } });
  return {
    runStart,
    baseStart,
    baseEnd,
    testIds,
    controlIds: controls.map((c) => c.id),
    branchWords: branchKeysToText(defaultBranchKeys(branches.map((b) => b.name))),
    note: [
      ...notes,
      ...test.map((x) => t("settings.salesLift.adLine", { name: products.find((p) => p.id === x.id)?.name ?? "", reason: x.reason })),
      ...controls.map((c) => t("settings.salesLift.controlLine", { name: products.find((p) => p.id === c.id)?.name ?? "", reason: c.reason })),
    ].join("\n"),
  };
}

// ------------------------------------------------------------------ Meta metrics (cached on the measurement)

type CachedComment = { id: string; postId: string; message: string; createdTime: string; fromPage: boolean };
type LiftMetaCache = {
  at?: string;
  key?: string;
  error?: string;
  insights?: LiftInsights | null;
  firstSpend?: string | null;
  comments?: CachedComment[];
};
const STALE_MS = 2 * 3600_000;
const cacheKey = (l: SalesLift) => [l.level, l.objectId, l.baseStart, runPeriod(l).end].join("|");
const parseCache = (s: string): LiftMetaCache => {
  try {
    return JSON.parse(s) as LiftMetaCache;
  } catch {
    return {};
  }
};

/**
 * Re-read from Meta when missing, older than 2 hours, or the period changed: spend + comments per ad in the run period,
 * first day with spend, and comments on the source posts since the start of the baseline (to compare comments before / during the run).
 */
export async function ensureLiftMeta(lift: SalesLift, client: Client, force = false): Promise<LiftMetaCache> {
  const t = await getT();
  const cur = parseCache(lift.metaCache);
  if (!force && cur.key === cacheKey(lift) && cur.at && Date.now() - Date.parse(cur.at) < STALE_MS) return cur;
  if (client.dataSource !== "meta") return { error: t("settings.salesLift.metaNotConnected") };
  const next: LiftMetaCache = { at: new Date().toISOString(), key: cacheKey(lift) };
  try {
    const meta = getMetaClient(client);
    const run = runPeriod(lift);
    const today = vnDay(new Date());
    const [ins, life] = await Promise.all([
      run.start <= run.end ? meta.fetchLiftInsights(lift.level as "campaign" | "ad", lift.objectId, run.start, run.end) : Promise.resolve(null),
      meta.fetchLiftInsights(lift.level as "campaign" | "ad", lift.objectId, addDays(today, -89), today),
    ]);
    next.insights = ins ?? (life ? { spend: 0, comments: 0, daily: [], ads: life.ads.map((a) => ({ ...a, spend: 0, comments: 0 })) } : null);
    next.firstSpend = life?.daily.find((d) => d.spend > 0)?.date ?? null;
    const posts = [...new Set((next.insights?.ads ?? life?.ads ?? []).map((a) => a.postId).filter((x): x is string => !!x))];
    const since = new Date(`${lift.baseStart}T00:00:00+07:00`);
    const lists = await Promise.all(posts.map((p) => meta.fetchPostComments(p, since).catch(() => [])));
    next.comments = lists.flat().map((c) => ({ id: c.id, postId: c.postId, message: c.message, createdTime: c.createdTime.toISOString(), fromPage: c.fromPage }));
  } catch (err) {
    next.error = err instanceof Error ? err.message : String(err);
    // Keep old numbers (if any) so the screen still shows figures, along with the error.
    if (cur.insights) Object.assign(next, { insights: cur.insights, comments: cur.comments, firstSpend: cur.firstSpend, at: cur.at });
  }
  await db.salesLift.update({ where: { id: lift.id }, data: { metaCache: JSON.stringify(next) } });
  return next;
}

// ------------------------------------------------------------------ Results

export type LiftView = Awaited<ReturnType<typeof liftView>>;

/** All figures for the measurement screen: recomputed each time from KvProductDaily + the Meta numbers read. */
export async function liftView(lift: SalesLift, client: Client, meta: LiftMetaCache) {
  const t = await getT();
  const base = basePeriod(lift);
  const run = runPeriod(lift);
  const testIds = parseIds(lift.testIds);
  const controlIds = parseIds(lift.controlIds);
  const from = base.start < run.start ? base.start : run.start;
  const [{ products, rows }, days] = await Promise.all([liftProducts(client.id, base, run), dataDays(client.id, from, base.end > run.end ? base.end : run.end)]);
  const result = computeLift({ base, run, dataDays: new Set(days.map((d) => d.date)), testIds, controlIds, rows, store: days, tr: t });

  // Comments: Meta counts comments driven by ads; order comments are read on the source post (including organic visitors, not just from ads).
  const ads = meta.insights?.ads ?? [];
  let postIds = [...new Set(ads.map((a) => a.postId).filter((x): x is string => !!x))];
  if (!postIds.length) {
    // Meta not read yet: find the source post by ad content in the synced Fanpage.
    const texts = (await adsOf(client.id, lift.level, lift.objectId)).map((a) => norm(a.text).slice(0, 60)).filter((t) => t.length >= 20);
    const posts = texts.length ? await db.pagePost.findMany({ where: { clientId: client.id }, select: { id: true, message: true } }) : [];
    postIds = posts.filter((p) => texts.some((t) => norm(p.message).startsWith(t))).map((p) => p.id);
  }
  const stored = postIds.length ? await db.postComment.findMany({ where: { postId: { in: postIds } }, select: { id: true, postId: true, message: true, createdTime: true, fromPage: true } }) : [];
  const all = new Map<string, CachedComment>();
  for (const c of stored) all.set(c.id, { ...c, createdTime: c.createdTime.toISOString() });
  for (const c of meta.comments ?? []) all.set(c.id, c);
  const branches = parseBranchKeys(lift.branchWords);
  const match = orderMatcher(branches);
  const dayOf = (iso: string) => vnDay(new Date(iso));
  const inRun = (d: string) => d >= run.start && d <= run.end;
  const inBase = (d: string) => d >= base.start && d <= base.end;
  const comments = [...all.values()]
    .filter((c) => !c.fromPage)
    .map((c) => ({ ...c, day: dayOf(c.createdTime), ...match(c.message) }))
    .sort((a, b) => b.createdTime.localeCompare(a.createdTime));
  const runComments = comments.filter((c) => inRun(c.day));
  const autoOrders = runComments.filter((c) => c.order).length;
  const orders = lift.manualOrders ?? autoOrders;
  const byBranch = new Map<string, number>();
  for (const c of runComments) if (c.order && c.branch) byBranch.set(c.branch, (byBranch.get(c.branch) ?? 0) + 1);
  const baseOrders = comments.filter((c) => inBase(c.day) && c.order).length;

  const spend = lift.manualSpend ?? meta.insights?.spend ?? null;
  const name = new Map(products.map((p) => [p.id, p]));
  return {
    base,
    run,
    result,
    enough: result.enough,
    minDays: MIN_DAYS,
    products: products.sort((a, b) => b.baseRevenue - a.baseRevenue || b.recentQty - a.recentQty).map((p) => ({ id: p.id, code: p.code, name: p.name, baseQty: p.baseQty, baseDaysSold: p.baseDaysSold })),
    productName: (id: string) => name.get(id)?.name ?? t("settings.salesLift.code", { id }),
    productCode: (id: string) => name.get(id)?.code ?? "",
    spend,
    spendSource: lift.manualSpend != null ? ("manual" as const) : meta.insights ? ("meta" as const) : null,
    metaComments: meta.insights?.comments ?? null,
    ads,
    postIds,
    comments: runComments,
    autoOrders,
    orders,
    baseOrders,
    baseOrderDays: result.baseDays,
    byBranch: [...byBranch.entries()].sort((a, b) => b[1] - a[1]),
    roas: spend && result.incRevenue != null ? result.incRevenue / spend : null,
    costPerOrder: spend && orders ? spend / orders : null,
    costPerComment: spend && meta.insights?.comments ? spend / meta.insights.comments : null,
    costPerUnit: spend && result.incQty && result.incQty > 0 ? spend / result.incQty : null,
    firstSpend: meta.firstSpend ?? null,
  };
}

/** Another of our campaigns also advertising the same template (same name) and active: it confounds the result. */
export async function overlappingCampaigns(lift: SalesLift) {
  const ads = await adsOf(lift.clientId, lift.level, lift.objectId);
  const labels = new Set(ads.map((a) => norm(adLabel(a.name))));
  const own = new Set(ads.map((a) => a.campaignId));
  const others = await db.ad.findMany({
    where: { clientId: lift.clientId, campaignId: { notIn: [...own] }, status: "ACTIVE", campaign: { status: "ACTIVE" } },
    select: { name: true, campaign: { select: { id: true, name: true } } },
  });
  const hit = new Map<string, { name: string; ads: Set<string> }>();
  for (const o of others) {
    const l = adLabel(o.name);
    if (!labels.has(norm(l))) continue;
    const c = hit.get(o.campaign.id) ?? { name: o.campaign.name, ads: new Set() };
    c.ads.add(l);
    hit.set(o.campaign.id, c);
  }
  return [...hit.values()].map((c) => ({ name: c.name, ads: [...c.ads] }));
}
