import { createHash, randomBytes } from "node:crypto";
import type { Client, ClientReport } from "@prisma/client";
import { getT } from "@/i18n/server";
import { translator, type T } from "@/i18n/translate";
import { db, retryBusy } from "./db";
import { encrypt } from "./crypto";
import { buildCampaignReport, type CampaignReport } from "./campaign-report";
import { money, num, resultLabels } from "./format";
import { ownAds } from "./own-ads";
import { publicUrl } from "./zalo";
import { localTime } from "./schedule";
import type { Vars } from "./client-report-vars";

// Daily report sent to the client (an easy-to-read version, not the detailed report for specialists):
// result count + spend + cost per result for yesterday, compared with the day before and the average of the 6 days before that, a 7-day chart,
// rating of yesterday's customers (AI-classified messages, sales ratings of leads / messages), reminders about unanswered customers,
// commentary generated from the metrics (no Claude call) and a "Hôm nay {operator} làm gì" (What we're doing today) line written manually by the specialist.
// Stored in ClientReport (period = "daily"): data = 7-day campaign report + digest (the daily report part).

/** A client's daily report options (Setting table, no extra columns on Client). */
export type DailyOpts = { link: boolean; remind: boolean; quality: boolean };
const DEFAULT_DAILY_OPTS: DailyOpts = { link: true, remind: true, quality: true };
const optsKey = (clientId: string) => `clientReport.daily:${clientId}`;

export async function loadDailyOpts(clientId: string): Promise<DailyOpts> {
  const row = await db.setting.findUnique({ where: { key: optsKey(clientId) } });
  try {
    return { ...DEFAULT_DAILY_OPTS, ...(row ? (JSON.parse(row.value) as Partial<DailyOpts>) : {}) };
  } catch {
    return DEFAULT_DAILY_OPTS;
  }
}
export async function saveDailyOpts(clientId: string, o: DailyOpts) {
  const value = JSON.stringify({ link: !!o.link, remind: !!o.remind, quality: !!o.quality });
  await db.setting.upsert({ where: { key: optsKey(clientId) }, create: { key: optsKey(clientId), value }, update: { value } });
}

/** Rating of customers who messaged yesterday. */
export type MsgQuality = {
  total: number;
  /** "wz": from the platform's ads (ad known); "ads": from ads but Meta doesn't say which ad; "all": source could not be separated. */
  scope: "wz" | "ads" | "all";
  hot: number; // Genuinely interested: considering / ready to buy / bought
  exploring: number; // Researching
  silent: number; // Asked then went silent (stage "mới" (new))
  junk: number; // Not a fit / junk
  unanalyzed: number;
  phones: number;
  closed: number; // sales marked "Đã chốt" (Closed)
  waiting: number; // AI flagged as needing a reply and the last message is still from the customer (page hasn't replied)
  saleRated: number;
};
/** Rating of customers who left their info (form) yesterday: per sales ratings. */
export type LeadQuality = {
  total: number;
  contacted: number;
  noAnswer: number;
  wrongNumber: number;
  notCalled: number;
  good: number;
  avg: number;
  bad: number;
  wrongTarget: number;
  closed: number;
};

export type DailyDigest = {
  date: string; // YYYY-MM-DD (yesterday; the "today so far" version uses today)
  /** "Today so far" version: generation time (HH:mm in the client's timezone), today's numbers still growing. The yesterday version has none. */
  live?: string;
  resultType: string;
  /** "khách nhắn tin" (customers messaging), "khách để lại thông tin" (customers leaving info)... */
  unit: string;
  /** 7 days, every day present. results include extra (messages from other campaign types); cost / result only counts primary-type campaigns. */
  days: { date: string; results: number; spend: number; pSpend: number; extra?: number }[];
  spend: number; // total ad spend yesterday
  results: number;
  /** Portion of results from other campaign types (e.g. post Engagement generating messages). Old versions lack it. */
  extra?: number;
  cpr: number | null;
  prevResults: number | null; // the day before
  avgCpr: number | null; // average of the previous 6 days
  msg: MsgQuality | null;
  lead: LeadQuality | null;
  /** Cost per real prospect yesterday (messages: customer left a phone number; leads: customers sales rated good). Old versions lack it. */
  prospect?: Prospect | null;
  /** Month-to-date cumulative through yesterday, compared with the target cost. Old versions lack it. */
  mtd?: MonthToDate | null;
  /** What the platform did yesterday (gathered from the action log, in plain language). Old versions lack it. */
  actions?: string[];
  /** Running ad sets with results and good cost (7 days; today version: previous 6 days + today). Only good ad sets; weak ones are not shown to the client. Old versions lack it. */
  goodAdSets?: GoodAdSet[];
  /** Period used for the effective ad sets (YYYY-MM-DD). Old versions lack it. */
  goodRange?: { since: string; until: string };
  notes: string[];
  todo: string;
  opts: DailyOpts;
};

export type GoodAdSet = { name: string; results: number; cpr: number };
export type Prospect = { label: string; count: number; cost: number | null };
export type MonthToDate = {
  since: string;
  days: number;
  results: number;
  /** Portion of results from other campaign types (not counted in cost / result). */
  extra?: number;
  spend: number;
  cpr: number | null;
  /** Target cost / result: internal only, NOT shown to the client. */
  target: number | null;
  prospect: Prospect | null;
};

type DailyData = CampaignReport & { digest: DailyDigest };

const VI = translator("vi");
const UNIT_KEYS = ["messages", "leads", "purchases", "link_clicks"] as const;
const isUnitKey = (k: string): k is (typeof UNIT_KEYS)[number] => (UNIT_KEYS as readonly string[]).includes(k);
/** What results are called for a result type, e.g. "khách nhắn tin" (customers messaging). */
const unitOf = (resultType: string, t: T) => (isUnitKey(resultType) ? t(`notify.dailyReport.unit.${resultType}`) : (resultLabels(t)[resultType] ?? t("notify.dailyReport.resultWord")).toLowerCase());
const dmy = (s: string) => s.split("-").reverse().join("/");
const dm = (s: string) => `${s.slice(8)}/${s.slice(5, 7)}`;

/** Midnight of day YYYY-MM-DD in timezone tz. */
function zonedMidnight(date: string, tz: string) {
  const guess = new Date(`${date}T00:00:00Z`);
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(guess)
      .map((x) => [x.type, x.value]),
  );
  const local = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
  return new Date(guess.getTime() - (local - guess.getTime()));
}
/** "hôm qua" (yesterday) / "hôm nay" (today) depending on the version. */
export const dayWord = (d: Pick<DailyDigest, "live">, t: T = VI) => (d.live ? t("notify.dailyReport.todayWord") : t("notify.dailyReport.yesterdayWord"));
/** Current hour:minute in the client's timezone. */
const hhmm = (tz: string) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

async function msgQuality(client: Client, from: Date, to: Date): Promise<MsgQuality | null> {
  const convs = await db.conversation.findMany({
    where: { clientId: client.id, messages: { some: { fromCustomer: true, createdTime: { gte: from, lt: to } } } },
    select: { id: true, sourceAdId: true, adReply: true, stage: true, analyzedAt: true, needsReply: true, phone: true },
  });
  if (!convs.length) return null;
  const own = new Set((await ownAds(client.id)).keys());
  // Prefer conversations known to come from the platform's ads (webhook attached the ad ID); otherwise conversations Meta marks "đã trả lời một quảng cáo" (replied to an ad)
  // (ad unknown, may belong to another agency running on the same Page); failing that, all conversations except those from other parties' ads.
  const wz = convs.filter((c) => c.sourceAdId && own.has(c.sourceAdId));
  const adReply = convs.filter((c) => !c.sourceAdId && c.adReply);
  const scope: MsgQuality["scope"] = wz.length ? "wz" : adReply.length ? "ads" : "all";
  const list = scope === "wz" ? wz : scope === "ads" ? adReply : convs.filter((c) => !c.sourceAdId || own.has(c.sourceAdId));
  if (!list.length) return null;
  const last = await db.message.findMany({
    where: { conversationId: { in: list.map((c) => c.id) } },
    orderBy: { createdTime: "desc" },
    distinct: ["conversationId"],
    select: { conversationId: true, fromCustomer: true },
  });
  const unanswered = new Set(last.filter((x) => x.fromCustomer).map((x) => x.conversationId));
  const fb = await db.salesFeedback.findMany({ where: { clientId: client.id, rowKey: { in: list.map((c) => `M-${c.id}`) } }, select: { quality: true, outcome: true } });
  const done = list.filter((c) => c.analyzedAt && c.stage);
  const st = (...s: string[]) => done.filter((c) => s.includes(c.stage!)).length;
  return {
    total: list.length,
    scope,
    hot: st("considering", "ready_to_buy", "purchased"),
    exploring: st("interested"),
    silent: st("new"),
    junk: st("lost", "spam"),
    unanalyzed: list.length - done.length,
    phones: list.filter((c) => c.phone).length,
    closed: fb.filter((f) => f.outcome === "Đã chốt").length,
    waiting: list.filter((c) => c.needsReply && unanswered.has(c.id)).length,
    saleRated: fb.filter((f) => f.quality || f.outcome).length,
  };
}

async function leadQuality(client: Client, from: Date, to: Date): Promise<LeadQuality | null> {
  const leads = await db.lead.findMany({ where: { clientId: client.id, isOrganic: false, createdTime: { gte: from, lt: to } }, select: { id: true, adId: true } });
  if (!leads.length) return null;
  const own = new Set((await ownAds(client.id)).keys());
  // Leads with an ad ID not belonging to our ad accounts = another agency running on the same Page.
  const list = own.size ? leads.filter((l) => !l.adId || own.has(l.adId)) : leads;
  if (!list.length) return null;
  const fb = await db.salesFeedback.findMany({ where: { clientId: client.id, rowKey: { in: list.map((l) => `F-${l.id}`) } }, select: { contact: true, quality: true, outcome: true } });
  const n = (f: (x: (typeof fb)[number]) => boolean) => fb.filter(f).length;
  const called = n((x) => !!x.contact || !!x.quality || !!x.outcome);
  return {
    total: list.length,
    contacted: n((x) => x.contact === "Được" || (!x.contact && !!x.quality)),
    noAnswer: n((x) => x.contact === "Không nghe máy"),
    wrongNumber: n((x) => x.contact === "Sai số"),
    notCalled: list.length - called,
    good: n((x) => x.quality === "Tốt"),
    avg: n((x) => x.quality === "Trung bình"),
    bad: n((x) => x.quality === "Kém"),
    wrongTarget: n((x) => x.quality === "Sai tệp"),
    closed: n((x) => x.outcome === "Đã chốt"),
  };
}

const pct = (x: number) => `${Math.round(Math.abs(x) * 100)}%`;
export const cmpPrev = (d: DailyDigest, t: T = VI) =>
  d.prevResults == null
    ? null
    : d.results === d.prevResults
      ? t("notify.dailyReport.cmp.same")
      : t(d.results > d.prevResults ? "notify.dailyReport.cmp.more" : "notify.dailyReport.cmp.less", { n: num(Math.abs(d.results - d.prevResults)) });
/** Compare cost / result with the previous 6-day average: null when not comparable. c < 0 means cheaper. */
export const cprChange = (d: DailyDigest) => (d.cpr != null && d.avgCpr ? d.cpr / d.avgCpr - 1 : null);
export const cmpAvg = (d: DailyDigest, t: T = VI) => {
  const c = cprChange(d);
  return c == null ? null : Math.abs(c) < 0.03 ? t("notify.dailyReport.cmp.avgSame") : t(c < 0 ? "notify.dailyReport.cmp.cheaper" : "notify.dailyReport.cmp.pricier", { p: pct(c) });
};

/** Real prospects within a range: messages → customer left a phone number; lead forms → customers sales rated good. */
function prospectOf(resultType: string, msg: MsgQuality | null, lead: LeadQuality | null, spend: number, t: T): Prospect | null {
  if (resultType === "leads" ? lead : !msg && lead) {
    const n = lead!.good;
    return lead!.total - lead!.notCalled > 0 ? { label: t("notify.dailyReport.prospect.saleGood"), count: n, cost: n ? spend / n : null } : null;
  }
  if (msg && msg.total - msg.unanalyzed > 0) return { label: t("notify.dailyReport.prospect.phone"), count: msg.phones, cost: msg.phones ? spend / msg.phones : null };
  return null;
}

/** Ad set name shown to the client: strip the internal code prefix ("N7 | Đúng ngành: …" → "Đúng ngành: …"). */
const cleanName = (name: string) => name.replace(/^\s*[A-Za-z]{0,3}\d{0,3}\s*\|\s*/, "").trim() || name;

/**
 * Ad sets worth showing off to the client: campaign + ad set active, primary result type, ≥ 2 results,
 * cost / result rated good or not above the average for that result type. Cheapest first, at most 5.
 * Multiple periods (today version: previous 6 days + today): sum by ad set id; per-period ratings can't be summed, so only compare against the merged average.
 */
function goodAdSets(rs: CampaignReport[], resultType: string): GoodAdSet[] {
  const sets = new Map<string, { name: string; active: boolean; spend: number; results: number; good: boolean }>();
  for (const r of rs)
    for (const c of r.campaigns.filter((x) => x.resultType === resultType))
      for (const s of c.adSets) {
        const x = sets.get(s.id);
        sets.set(s.id, {
          name: s.name,
          active: c.status === "ACTIVE" && s.status === "ACTIVE",
          spend: (x?.spend ?? 0) + s.m.spend,
          results: (x?.results ?? 0) + s.m.results,
          good: rs.length === 1 && s.verdict.tone === "good",
        });
      }
  const t = rs.map((r) => r.types.find((x) => x.resultType === resultType)?.m).filter((m) => !!m);
  const tRes = t.reduce((a, m) => a + m.results, 0);
  const avg = tRes ? t.reduce((a, m) => a + m.spend, 0) / tRes : null;
  return [...sets.values()]
    .map((s) => ({ ...s, cpr: s.results ? s.spend / s.results : null }))
    .filter((s) => s.active && s.results >= 2 && s.cpr != null && (s.good || (avg != null && s.cpr <= avg)))
    .sort((a, b) => a.cpr! - b.cpr!)
    .slice(0, 5)
    .map((s) => ({ name: cleanName(s.name), results: s.results, cpr: s.cpr! }));
}

/** What the platform did yesterday: turn the action log (manual + automatic) into a few plain lines, without exposing internal names. Audience creation is not shown to the client. */
async function workActions(clientId: string, from: Date, to: Date, t: T): Promise<string[]> {
  const [rows, active] = await Promise.all([
    db.activity.findMany({ where: { clientId, kind: { in: ["execute", "publish"] }, createdAt: { gte: from, lt: to } }, select: { message: true } }),
    db.campaign.findMany({ where: { clientId, status: "ACTIVE" }, select: { name: true } }),
  ]);
  const sets: Record<string, Set<string>> = { offAdset: new Set(), offAd: new Set(), offOther: new Set(), on: new Set(), up: new Set(), down: new Set(), campaign: new Set(), draft: new Set(), form: new Set() };
  const amount = (s: string) => Number(s.replace(/[^\d]/g, ""));
  for (const { message: m } of rows) {
    if (/^Lỗi|\(chạy thử\)|^\[chạy thử\]/i.test(m)) continue;
    let x: RegExpMatchArray | null;
    if ((x = m.match(/Tắt nhóm "([^"]+)"/))) sets.offAdset.add(x[1]);
    else if ((x = m.match(/Tắt quảng cáo "([^"]+)"/))) sets.offAd.add(x[1]);
    else if ((x = m.match(/Thủ công: "([^"]+)" → Tắt/))) sets.offOther.add(x[1]);
    else if ((x = m.match(/"([^"]+)" → Bật/))) sets.on.add(x[1]);
    else if ((x = m.match(/(?:Tăng ngân sách|budget) "([^"]+)" ([\d.,]+)\s*₫?[^→]*→ ([\d.,]+)/))) (amount(x[3]) >= amount(x[2]) ? sets.up : sets.down).add(x[1]);
    else if ((x = m.match(/Đã tạo chiến dịch "([^"]+)"/))) sets.campaign.add(x[1]);
    else if ((x = m.match(/Tạo bản nháp "([^"]+)"/))) sets.draft.add(x[1]);
    else if ((x = m.match(/Tạo Biểu mẫu tức thì "([^"]+)"/))) sets.form.add(x[1]);
  }
  // A manual pause with the same name as an automatic pause is not counted twice.
  for (const n of [...sets.offAdset, ...sets.offAd]) sets.offOther.delete(n);
  const off = sets.offAdset.size + sets.offAd.size + sets.offOther.size;
  const offWhat = off === sets.offAdset.size ? t("notify.dailyReport.work.adsets") : off === sets.offAd.size ? t("notify.dailyReport.work.ads") : t("notify.dailyReport.work.both");
  // Campaigns are built in paused state; once turned on (on the web or in Ads Manager), report them as running.
  const on = new Set(active.map((c) => c.name));
  const live = [...sets.campaign].filter((n) => on.has(n)).length;
  const camp = sets.campaign.size;
  const offParts = [sets.offAdset.size && t("notify.dailyReport.work.partAdsets", { n: sets.offAdset.size }), sets.offAd.size && t("notify.dailyReport.work.partAds", { n: sets.offAd.size })].filter(Boolean);
  return [
    off && (sets.offOther.size || offParts.length < 2 ? t("notify.dailyReport.work.offLine", { n: off, what: offWhat }) : t("notify.dailyReport.work.offParts", { parts: offParts.join(t("notify.dailyReport.work.and")) })),
    sets.up.size && t("notify.dailyReport.work.up", { n: sets.up.size }),
    sets.down.size && t("notify.dailyReport.work.down", { n: sets.down.size }),
    sets.on.size && t("notify.dailyReport.work.on", { n: sets.on.size }),
    camp && (live === camp ? t("notify.dailyReport.work.campLive", { n: camp }) : live ? t("notify.dailyReport.work.campPartial", { n: camp, live, left: camp - live }) : t("notify.dailyReport.work.campWait", { n: camp })),
    sets.draft.size && t("notify.dailyReport.work.draft", { n: sets.draft.size }),
    sets.form.size && t("notify.dailyReport.work.form", { n: sets.form.size }),
  ].filter((x): x is string => !!x);
}

/** Short plain-language commentary generated from the metrics (no Claude call). */
function makeNotes(d: Omit<DailyDigest, "notes" | "todo" | "opts">, t: T): string[] {
  const out: string[] = [];
  // Today version: numbers keep growing until end of day, so don't flag "lowest of the week".
  const day = d.live ? t("notify.dailyReport.notes.dayToday", { live: d.live }) : t("notify.dailyReport.notes.dayYesterday");
  if (!d.spend) return [d.live ? t("notify.dailyReport.notes.noSpendLive", { day }) : t("notify.dailyReport.notes.noSpend")];
  const prior = d.days.slice(0, -1);
  const active = prior.filter((x) => x.spend > 0);
  if (active.length >= 3 && d.results > Math.max(...prior.map((x) => x.results))) out.push(d.live ? t("notify.dailyReport.notes.mostLive", { day, unit: d.unit }) : t("notify.dailyReport.notes.most", { unit: d.unit }));
  else if (!d.live && active.length >= 3 && d.results < Math.min(...active.map((x) => x.results))) out.push(t("notify.dailyReport.notes.least", { unit: d.unit }));
  if (!d.results) out.push(t("notify.dailyReport.notes.none", { day, unit: d.unit }));
  const m = d.msg;
  if (m && m.total - m.unanalyzed > 0) {
    const read = m.total - m.unanalyzed;
    if (m.hot) out.push(t("notify.dailyReport.notes.hot", { hot: m.hot, read }));
    else out.push(t("notify.dailyReport.notes.noHot", { read }));
  }
  const l = d.lead;
  if (l && l.total - l.notCalled > 0 && l.good + l.avg + l.bad + l.wrongTarget > 0) out.push(t("notify.dailyReport.notes.leadGood", { good: l.good, n: l.good + l.avg + l.bad + l.wrongTarget }));
  // Cheaper cost is already shown in the cost line; if more expensive, say clearly it's being handled.
  const c = d.cpr != null && d.avgCpr ? d.cpr / d.avgCpr - 1 : null;
  if (c != null && c >= 0.15) out.push(t("notify.dailyReport.notes.costHigh", { unit: d.unit, perUnit: perUnitOf(d.unit, t), pct: pct(c) }));
  return out.slice(0, 3);
}

/**
 * Build the daily report in the client's timezone: yesterday's metrics, or (live) today up to generation time —
 * in that case the previous 6 days come from the report through yesterday, and today's column reads Meta's "today" period separately.
 */
async function buildDailyData(client: Client, todo = "", live = false): Promise<DailyData> {
  const t = await getT();
  // A single Meta read covers both the 7-day chart and month-to-date: period = max(7, days from the start of the month through yesterday).
  const today = localTime(client.timezone).date;
  const yesterday = addDays(today, -1);
  const period = Math.max(7, Number(yesterday.slice(8)));
  // Good ad sets evaluated over 7 days (read separately when the cumulative period is longer than 7 days); today version: 6 days through yesterday + today.
  const [report, week, now] = await Promise.all([
    buildCampaignReport(client, period, { fresh: true }),
    live ? buildCampaignReport(client, 6, { fresh: true }) : period > 7 ? buildCampaignReport(client, 7, { fresh: true }) : null,
    live ? buildCampaignReport(client, "today", { fresh: true }) : null,
  ]);
  const date = (now ?? report).range.until;
  const daily = now ? [...report.daily.filter((x) => x.date < date), ...now.daily.filter((x) => x.date === date)] : report.daily;
  const monthStart = `${date.slice(0, 8)}01`;
  const primary = report.types.find((t) => t.resultType === client.primaryResult) ?? report.types[0];
  const resultType = primary?.resultType ?? client.primaryResult ?? "messages";
  const byDate = new Map(daily.map((x) => [x.date, x]));
  // Messaging customer count includes messages from other campaign types (matching the account total on Meta); cost / result only counts primary-type campaigns.
  const extraOf = (x: { extra?: number } | undefined) => (resultType === "messages" ? (x?.extra ?? 0) : 0);
  const days = Array.from({ length: 7 }, (_, i) => {
    const day = addDays(date, i - 6);
    const x = byDate.get(day);
    const extra = extraOf(x);
    return { date: day, results: (x?.results ?? 0) + extra, spend: x?.spend ?? 0, pSpend: x?.pSpend ?? x?.spend ?? 0, ...(extra ? { extra } : {}) };
  });
  const own = (x: { results: number; extra?: number }) => x.results - (x.extra ?? 0);
  const y = days[6];
  const prior = days.slice(0, 6);
  const pRes = prior.reduce((a, x) => a + own(x), 0);
  const pSp = prior.reduce((a, x) => a + x.pSpend, 0);
  const from = zonedMidnight(date, client.timezone);
  const to = live ? new Date() : zonedMidnight(addDays(date, 1), client.timezone);
  const mFrom = zonedMidnight(monthStart, client.timezone);
  const [msg, lead, mMsg, mLead, actions] = await Promise.all([
    msgQuality(client, from, to),
    leadQuality(client, from, to),
    msgQuality(client, mFrom, to),
    leadQuality(client, mFrom, to),
    workActions(client.id, from, to, t),
  ]);
  const month = daily.filter((x) => x.date >= monthStart && x.date <= date);
  const mRes = month.reduce((a, x) => a + x.results, 0);
  const mExtra = month.reduce((a, x) => a + extraOf(x), 0);
  const mSp = month.reduce((a, x) => a + (x.pSpend ?? x.spend), 0);
  const mtd: MonthToDate = {
    since: monthStart,
    days: Number(date.slice(8)),
    results: mRes + mExtra,
    ...(mExtra ? { extra: mExtra } : {}),
    spend: month.reduce((a, x) => a + x.spend, 0),
    cpr: mRes ? mSp / mRes : null,
    target: client.targetCpr ?? client.autoTargetCpr ?? null,
    prospect: prospectOf(resultType, mMsg, mLead, mSp, t),
  };
  const good = live && week && now ? [week, now] : [week ?? report];
  const base = {
    date,
    ...(live ? { live: hhmm(client.timezone) } : {}),
    resultType,
    unit: unitOf(resultType, t),
    days,
    spend: y.spend,
    results: y.results,
    ...(y.extra ? { extra: y.extra } : {}),
    cpr: own(y) ? y.pSpend / own(y) : null,
    // Today isn't over yet: don't compare counts with the whole of yesterday.
    prevResults: !live && (days[5].spend || days[5].results) ? days[5].results : null,
    avgCpr: pRes ? pSp / pRes : null,
    msg,
    lead,
    prospect: prospectOf(resultType, msg, lead, y.pSpend, t),
    mtd: mtd.spend || mtd.results ? mtd : null,
    actions,
    goodAdSets: goodAdSets(good, resultType),
    goodRange: { since: good[0].range.since, until: good[good.length - 1].range.until },
  };
  const digest: DailyDigest = { ...base, notes: makeNotes(base, t), todo: todo.trim(), opts: await loadDailyOpts(client.id) };
  return { ...report, digest };
}

/** Zalo OA template variables for the daily report (same variable names as the weekly / monthly reports). */
function dailyVars(client: Pick<Client, "name" | "currency">, d: DailyDigest, key: string, t: T = VI): Vars {
  const label = resultLabels(t)[d.resultType] ?? t("notify.dailyReport.resultWordCap");
  return {
    ten_khach: client.name,
    ky_bao_cao: t("notify.dailyReport.dayWord"),
    khoang_ngay: d.live ? `${dmy(d.date)} ${t("notify.dailyReport.until", { live: d.live })}` : dmy(d.date),
    tu_ngay: dmy(d.date),
    den_ngay: dmy(d.date),
    chi_tieu: money(d.spend, client.currency),
    so_ket_qua: num(d.results),
    loai_ket_qua: label,
    ket_qua: `${num(d.results)} ${d.unit}`,
    gia_ket_qua: d.cpr != null ? money(d.cpr, client.currency) : "—",
    so_ky_truoc: cmpAvg(d, t) ?? cmpPrev(d, t) ?? t("notify.dailyReport.noCompare"),
    nhan_xet: d.notes[0] ?? "",
    link_bao_cao: `${publicUrl()}/r/${key}`,
    ma_bao_cao: key,
    ngay_lap: dmy(new Date().toISOString().slice(0, 10)),
  };
}

/** Summary line of customer ratings (messages / leads) for the outgoing message. */
function qualityLine(d: DailyDigest, t: T) {
  const parts: string[] = [];
  const m = d.msg;
  if (m && m.total - m.unanalyzed > 0) {
    const read = m.total - m.unanalyzed;
    const items = [m.hot ? t("notify.dailyReport.quality.hot", { n: m.hot }) : t("notify.dailyReport.quality.noHot"), m.phones && t("notify.dailyReport.quality.phones", { n: m.phones }), m.closed && t("notify.dailyReport.quality.closed", { n: m.closed })];
    parts.push(t("notify.dailyReport.quality.msgPart", { n: num(read), day: dayWord(d, t), items: items.filter(Boolean).join(", ") }));
  }
  const l = d.lead;
  if (l) {
    const rated = l.total - l.notCalled;
    parts.push(
      rated
        ? t("notify.dailyReport.quality.leadRated", {
            total: l.total,
            items: [t("notify.dailyReport.quality.reached", { n: l.contacted }), l.good && t("notify.dailyReport.quality.good", { n: l.good }), l.avg && t("notify.dailyReport.quality.avg", { n: l.avg }), l.bad && t("notify.dailyReport.quality.bad", { n: l.bad }), l.wrongTarget && t("notify.dailyReport.quality.wrongTarget", { n: l.wrongTarget }), l.closed && t("notify.dailyReport.quality.closed", { n: l.closed })].filter(Boolean).join(", "),
          })
        : t("notify.dailyReport.quality.leadUnrated", { total: l.total }),
    );
  }
  return parts.length ? t("notify.dailyReport.quality.line", { parts: parts.join("; ") }) : null;
}

/** Reminder line for the client side (customers not yet answered / not yet called). */
export function remindLine(d: DailyDigest, t: T = VI) {
  if (!d.opts.remind) return null;
  const out: string[] = [];
  if (d.msg?.waiting) out.push(t("notify.dailyReport.remind.waiting", { n: d.msg.waiting }));
  if (d.lead?.notCalled) out.push(t("notify.dailyReport.remind.notCalled", { n: d.lead.notCalled }));
  return out.length ? t("notify.dailyReport.remind.line", { list: out.join(", ") }) : null;
}

const QUALITY_NOTE = /nhu cầu|sale đánh giá|\bneed\b|rated good by sales/;

/** "khách nhắn tin" → "khách"; "đơn hàng" stays unchanged (used after the word "mỗi"). */
export const perUnitOf = (unit: string, t: T = VI) => {
  for (const k of UNIT_KEYS) if (unit === VI(`notify.dailyReport.unit.${k}`) || unit === t(`notify.dailyReport.unit.${k}`)) return t(`notify.dailyReport.perUnit.${k}`);
  return unit.startsWith("khách") ? t("notify.dailyReport.perUnit.messages") : unit;
};

/** "gồm 9 từ quảng cáo đẩy bài" (incl. 9 from post-boost ads): messages from other campaign types (not counted in the per-customer average). */
export const extraNote = (n: number | undefined, t: T = VI) => (n ? t("notify.dailyReport.extraNote", { n: num(n) }) : null);
/** Title of the effective ad sets table: today version includes today's numbers. */
export const goodTitle = (d: Pick<DailyDigest, "live" | "goodRange">, t: T = VI) =>
  d.goodRange ? t("notify.dailyReport.goodTitle.range", { from: dm(d.goodRange.since), to: dm(d.goodRange.until) }) : t("notify.dailyReport.goodTitle.week", { today: d.live ? t("notify.dailyReport.goodTitle.todayPart") : "" });

/** Month-to-date line for the outgoing message. */
function mtdLine(d: DailyDigest, currency: string, t: T) {
  const m = d.mtd;
  if (!m) return null;
  // Target cost is an internal number: never include it in messages to the client.
  const pr = m.prospect?.count ? t("notify.dailyReport.mtdProspect", { n: num(m.prospect.count), label: m.prospect.label }) : "";
  return t("notify.dailyReport.mtd", { days: m.days, results: num(m.results), unit: d.unit, pr, cpr: m.cpr != null ? money(m.cpr, currency) : "—", perUnit: perUnitOf(d.unit, t) });
}

/** Auto-composed daily report message (email, Telegram, copy-paste to Zalo). The approver can edit it before sending. */
export function dailyMessage(clientName: string, currency: string, d: DailyDigest, link: string | null, t: T = VI) {
  const prev = cmpPrev(d, t);
  const avg = cmpAvg(d, t);
  const remind = remindLine(d, t);
  const pu = perUnitOf(d.unit, t);
  const head = [extraNote(d.extra, t), prev].filter(Boolean).join(", ");
  // Customer quality commentary is already in the Rating line: pick a different comment.
  const note = d.opts.quality ? d.notes.find((n) => !QUALITY_NOTE.test(n)) : d.notes[0];
  return [
    d.live ? t("notify.dailyReport.msg.titleLive", { d: dm(d.date), live: d.live, name: clientName }) : t("notify.dailyReport.msg.title", { d: dm(d.date), name: clientName }),
    t("notify.dailyReport.msg.results", { unit: `${d.unit[0].toUpperCase()}${d.unit.slice(1)}`, n: num(d.results), head: head ? ` (${head})` : "" }),
    t("notify.dailyReport.msg.spend", { v: money(d.spend, currency) }),
    d.cpr != null ? t("notify.dailyReport.msg.avg", { perUnit: pu, v: money(d.cpr, currency), avg: avg ? ` (${avg})` : "" }) : null,
    d.opts.quality ? qualityLine(d, t) : null,
    mtdLine(d, currency, t),
    d.goodAdSets?.length
      ? t("notify.dailyReport.msg.good", {
          title: goodTitle(d, t),
          list: d.goodAdSets
            .slice(0, 3)
            .map((g) => t("notify.dailyReport.msg.goodItem", { name: g.name, n: num(g.results), perUnit: pu, cpr: money(g.cpr, currency) }))
            .join("; "),
        })
      : null,
    d.actions?.length ? t("notify.dailyReport.msg.work", { day: dayWord(d, t), list: d.actions.map((a) => a[0].toLowerCase() + a.slice(1)).join("; ") }) : null,
    note ?? null,
    remind ? `⚠️ ${remind}` : null,
    d.todo ? t("notify.dailyReport.msg.todo", { label: d.live ? t("notify.dailyReport.msg.nextLive") : t("notify.dailyReport.msg.nextToday"), todo: d.todo }) : null,
    d.opts.link && link ? t("notify.dailyReport.msg.more", { link }) : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export const isDaily = (r: Pick<ClientReport, "period">) => r.period === "daily";
export const digestOf = (r: Pick<ClientReport, "data">): DailyDigest | null => (JSON.parse(r.data) as Partial<DailyData>).digest ?? null;

/** Build the daily report (yesterday, or today so far when live) as a ClientReport, with public link /r/<code>. */
export async function createDailyReport(clientId: string, trigger: "manual" | "schedule", by: string, live = false) {
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId } });
  const t = await getT();
  const data = await buildDailyData(client, "", live);
  const key = randomBytes(9).toString("base64url");
  return db.clientReport.create({
    data: {
      clientId,
      period: "daily",
      since: data.digest.date,
      until: data.digest.date,
      data: JSON.stringify(data),
      vars: JSON.stringify(dailyVars(client, data.digest, key, t)),
      keyHash: createHash("sha256").update(key).digest("hex"), // same as client-report.ts
      key: encrypt(key),
      trigger,
      createdBy: by,
    },
  });
}

/** Edit the "Hôm nay {operator} làm gì" (What we're doing today) line of a daily report. */
export async function saveDailyTodo(reportId: string, todo: string) {
  const r = await db.clientReport.findUniqueOrThrow({ where: { id: reportId } });
  if (!isDaily(r)) throw new Error((await getT())("notify.dailyReport.onlyDaily"));
  const data = JSON.parse(r.data) as DailyData;
  data.digest.todo = todo.trim().slice(0, 500);
  await retryBusy(() => db.clientReport.update({ where: { id: reportId }, data: { data: JSON.stringify(data) } }));
}
