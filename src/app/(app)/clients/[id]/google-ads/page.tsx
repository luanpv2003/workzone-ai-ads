import Link from "next/link";
import { connection } from "next/server";
import { db } from "@/lib/db";
import { dateTime, money, num, pct } from "@/lib/format";
import { formatCustomerId } from "@/lib/google-ads";
import { googleClaudeNegativesAction, googleClaudeRestructureAction, googleManualChangeAction, syncGoogleAdsAction } from "@/app/google-ads-actions";
import { DraftGroupButton, GoogleCampaignEditor, GoogleChangeCard, type CampaignEdit, type ChangeView } from "@/components/google-ads-edit";
import type { GChangeParams } from "@/lib/google-ads-write";
import { ActionButton } from "@/components/action-button";
import { DailyChart } from "@/components/daily-chart";
import { Badge, Card, Empty, Stat, type Tone } from "@/components/ui";
import { requirePageClient, roleAllows } from "@/lib/access";
import { getT } from "@/i18n/server";
import type { T } from "@/i18n/translate";

// Client's Google Ads: overview per period, suggestions awaiting approval (rules / Claude), campaigns + manual edits, keywords, real search terms, edit history.
// Every change is sent to Google via lib/google-ads-write.ts only after the user clicks (no automatic edits).
// 7/14/30-day periods are computed from GAdsDaily; ad groups/keywords/search terms and impression share are 30 days (fetched during sync).

const RANGES = [7, 14, 30, 90] as const;
const CHANNELS = ["SEARCH", "PERFORMANCE_MAX", "DISPLAY", "VIDEO", "SHOPPING", "DEMAND_GEN", "LOCAL", "SMART", "MULTI_CHANNEL"] as const;
const MATCHES = ["EXACT", "PHRASE", "BROAD"] as const;
const STATUS_TONE: Record<string, Tone> = { ENABLED: "green", PAUSED: "gray" };
const TERMS = ["ADDED", "EXCLUDED", "ADDED_EXCLUDED"] as const;
const QLEVELS = ["BELOW_AVERAGE", "AVERAGE", "ABOVE_AVERAGE"] as const;

const ctr = (clicks: number, impr: number) => (impr ? (clicks / impr) * 100 : null);
// The 3 Quality Score components: color by level.
const QPART_CLS: Record<(typeof QLEVELS)[number], string> = { BELOW_AVERAGE: "bg-rose-50 text-rose-700", AVERAGE: "bg-amber-50 text-amber-700", ABOVE_AVERAGE: "bg-emerald-50 text-emerald-700" };
function QParts({ k, tr }: { k: { ctrQuality: string | null; adRelevance: string | null; landingPage: string | null }; tr: T }) {
  const parts = [
    [tr("settings.googlePage.qClicks"), tr("settings.googlePage.qCtrFull"), k.ctrQuality],
    [tr("settings.googlePage.qAd"), tr("settings.googlePage.qAdFull"), k.adRelevance],
    [tr("settings.googlePage.qPage"), tr("settings.googlePage.qPageFull"), k.landingPage],
  ] as const;
  if (!parts.some((x) => x[2])) return null;
  const level = (v: string | null) => ((QLEVELS as readonly string[]).includes(v ?? "") ? (v as (typeof QLEVELS)[number]) : null);
  return (
    <span className="ml-1 inline-flex gap-0.5 align-middle">
      {parts.map(([short, full, v]) => {
        const lv = level(v);
        return (
          <span key={short} title={`${full}: ${lv ? tr(`settings.googlePage.qLevel.${lv}`) : tr("settings.googlePage.qNone")}`} className={`rounded px-1 text-[10px] leading-4 ${lv ? QPART_CLS[lv] : "bg-slate-100 text-slate-400"}`}>
            {short}
          </span>
        );
      })}
    </span>
  );
}
/** One metric in a card (phone layout): small label + number. */
function Metric({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs leading-4 text-mut">{label}</dt>
      <dd className={`mt-0.5 tabular-nums ${warn ? "font-medium text-amber-700" : "text-ink"}`}>{value}</dd>
    </div>
  );
}
const per = (a: number, b: number) => (b ? a / b : null);
const sharePct = (v: number | null) => (v == null ? "—" : pct(v * 100, 0));

export default async function GoogleAdsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ d?: string }> }) {
  await connection();
  const tr = await getT();
  const channel = (v: string) => ((CHANNELS as readonly string[]).includes(v) ? tr(`settings.googlePage.channel.${v as (typeof CHANNELS)[number]}`) : v);
  const matchL = (v: string) => ((MATCHES as readonly string[]).includes(v) ? tr(`settings.googlePage.match.${v as (typeof MATCHES)[number]}`) : v);
  const statusL = (v: string) => (v in STATUS_TONE ? tr(`settings.googlePage.status.${v as "ENABLED" | "PAUSED"}`) : v);
  const termL = (v: string) => ((TERMS as readonly string[]).includes(v) ? tr(`settings.googlePage.term.${v as (typeof TERMS)[number]}`) : null);
  const { id } = await params;
  const { role } = await requirePageClient(id); // check access right on the page: the layout may not re-run on client-side navigation
  const canEdit = roleAllows(role, "edit");
  const { d } = await searchParams;
  const days = RANGES.find((r) => String(r) === d) ?? 30;
  const client = await db.client.findUniqueOrThrow({ where: { id } });
  const sync = (
    <>
      {canEdit && client.googleSyncedAt && (
        <ActionButton action={googleClaudeNegativesAction.bind(null, id)} pending={tr("settings.googlePage.queueing")} variant="ai">
          {tr("settings.googlePage.claudeNegatives")}
        </ActionButton>
      )}
      <ActionButton action={syncGoogleAdsAction.bind(null, id)} pending={tr("settings.googlePage.syncing")}>
        {tr("settings.googlePage.syncGoogle")}
      </ActionButton>
    </>
  );

  if (!client.googleCustomerId) {
    return (
      <Empty>
        {tr("settings.googlePage.noAccount")}{" "}
        <Link href={`/clients/${id}/settings/integrations`} className="text-indigo-600 hover:underline">
          {tr("settings.googlePage.settingsLink")}
        </Link>{" "}
        {tr("settings.googlePage.toPick")}
      </Empty>
    );
  }
  const cur = client.googleCurrency || "VND";
  const head = (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div className="text-sm">
        <span className="font-medium text-ink">{client.googleAccountName ?? tr("settings.googlePage.account")}</span> <span className="text-mut">({formatCustomerId(client.googleCustomerId)})</span>
        <span className="block text-xs text-mut @2xl:ml-2 @2xl:inline">{tr("settings.googlePage.synced", { when: client.googleSyncedAt ? dateTime(client.googleSyncedAt) : tr("settings.googlePage.never") })}</span>
        {client.googleSyncError && <p className="mt-1 text-xs text-rose-700">{tr("settings.googlePage.lastError", { error: client.googleSyncError })}</p>}
      </div>
      <div className="flex w-full flex-wrap items-center gap-2 @2xl:w-auto">
        <nav className="flex w-full gap-1 @2xl:w-auto">
          {RANGES.map((r) => (
            <Link
              key={r}
              href={`?d=${r}`}
              className={`flex-1 rounded-lg px-2.5 py-2 text-center text-xs @2xl:flex-none @2xl:py-1 ${r === days ? "bg-ink text-panel" : "border border-line text-ink2 hover:bg-hover"}`}
            >
              {tr("settings.googlePage.rangeDays", { count: r })}
            </Link>
          ))}
        </nav>
        {sync}
      </div>
    </div>
  );
  if (!client.googleSyncedAt) return (<>{head}<Empty>{tr("settings.googlePage.noData")}</Empty></>);

  const since = new Date(new Date().getTime() - days * 86400_000).toISOString().slice(0, 10);
  const [campaigns, daily, keywords, terms, pendingChanges, history, liveKeywords, liveAds] = await Promise.all([
    db.gAdsCampaign.findMany({ where: { clientId: id } }),
    db.gAdsDaily.findMany({ where: { clientId: id, date: { gte: since } } }),
    db.gAdsKeyword.findMany({ where: { clientId: id }, orderBy: { spend: "desc" }, take: 60 }),
    db.gAdsSearchTerm.findMany({ where: { clientId: id }, orderBy: { spend: "desc" }, take: 100 }),
    db.gAdsChange.findMany({ where: { clientId: id, status: "pending" }, orderBy: { createdAt: "desc" } }),
    db.gAdsChange.findMany({ where: { clientId: id, status: { in: ["executed", "failed", "rejected"] } }, orderBy: { decidedAt: "desc" }, take: 20 }),
    db.gAdsKeyword.findMany({ where: { clientId: id, status: "ENABLED", qualityScore: { not: null } } }),
    db.gAdsAd.findMany({ where: { clientId: id }, orderBy: { spend: "desc" } }),
  ]);
  // Quality Score: share of spend (30 days) on low-score keywords / each below-average component; landing page by the ad group's URL.
  const qsSpend = liveKeywords.reduce((a, k) => a + k.spend, 0);
  const shareOf = (f: (k: (typeof liveKeywords)[number]) => boolean) => (qsSpend ? liveKeywords.filter(f).reduce((a, k) => a + k.spend, 0) / qsSpend : 0);
  const qs = {
    low: shareOf((k) => (k.qualityScore ?? 10) <= 4),
    ctr: shareOf((k) => k.ctrQuality === "BELOW_AVERAGE"),
    rel: shareOf((k) => k.adRelevance === "BELOW_AVERAGE"),
    lp: shareOf((k) => k.landingPage === "BELOW_AVERAGE"),
    avg: qsSpend ? liveKeywords.reduce((a, k) => a + (k.qualityScore ?? 0) * k.spend, 0) / qsSpend : null,
  };
  const urlOfGroup = new Map<string, string>();
  for (const a of liveAds) if (!urlOfGroup.has(a.adGroupId) && a.finalUrl) urlOfGroup.set(a.adGroupId, a.finalUrl);
  const lpByUrl = new Map<string, { spend: number; bad: number }>();
  for (const k of liveKeywords) {
    const u = urlOfGroup.get(k.adGroupId);
    if (!u) continue;
    const x = lpByUrl.get(u) ?? { spend: 0, bad: 0 };
    x.spend += k.spend;
    if (k.landingPage === "BELOW_AVERAGE") x.bad += k.spend;
    lpByUrl.set(u, x);
  }
  const searchCamps = campaigns.filter((c) => c.status === "ENABLED" && c.channelType === "SEARCH").map((c) => ({ id: c.id, name: c.name }));
  const parse = <T,>(s: string, d: T): T => {
    try {
      return JSON.parse(s) as T;
    } catch {
      return d;
    }
  };
  const changeViews: ChangeView[] = pendingChanges.map((c) => ({
    id: c.id,
    kind: c.kind,
    campaignName: c.campaignName,
    title: c.title,
    rationale: c.rationale,
    params: JSON.parse(c.params) as GChangeParams,
    source: c.source,
    result: c.result,
    createdAt: c.createdAt.toISOString(),
  }));
  const editable: CampaignEdit[] = [...campaigns]
    .sort((a, b) => (a.status === "ENABLED" ? 0 : 1) - (b.status === "ENABLED" ? 0 : 1) || b.spend - a.spend)
    .map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      channelType: c.channelType,
      biddingStrategy: c.biddingStrategy,
      dailyBudget: c.dailyBudget,
      targetCpa: c.targetCpa,
      budgetShared: c.budgetShared,
      hasBudget: !!c.budgetId,
      spend: c.spend,
      conversions: c.conversions,
      devices: parse(c.devices, {}),
      negatives: c.status === "ENABLED" ? parse(c.negatives, []) : [], // only sync negatives of enabled campaigns
      schedule: parse(c.schedule, []),
      hours: c.status === "ENABLED" ? parse(c.hours, {}) : {},
      lastDayHours: c.status === "ENABLED" ? parse(c.lastDayHours, {}) : {},
    }));
  const campName = new Map(campaigns.map((c) => [c.id, c.name]));

  // Per period: sum GAdsDaily by campaign and by day.
  const zero = () => ({ spend: 0, impressions: 0, clicks: 0, conversions: 0 });
  const byCamp = new Map<string, ReturnType<typeof zero>>();
  const byDay = new Map<string, ReturnType<typeof zero>>();
  const total = zero();
  const slot = (m: Map<string, ReturnType<typeof zero>>, k: string) => {
    if (!m.has(k)) m.set(k, zero());
    return m.get(k)!;
  };
  for (const d of daily) {
    for (const acc of [slot(byCamp, d.campaignId), slot(byDay, d.date), total]) {
      acc.spend += d.spend;
      acc.impressions += d.impressions;
      acc.clicks += d.clicks;
      acc.conversions += d.conversions;
    }
  }
  const chart = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, spend: v.spend, results: v.conversions, cpr: per(v.spend, v.conversions) }));
  const rows = campaigns
    .map((c) => ({ c, p: byCamp.get(c.id) ?? zero() }))
    .sort((a, b) => b.p.spend - a.p.spend || (a.c.status === "ENABLED" ? -1 : 1));
  const cpa = per(total.spend, total.conversions);
  const noConv = total.spend > 0 && total.conversions === 0;
  const wasted = terms.filter((t) => t.conversions === 0 && t.clicks >= 5);
  // Per-row buttons: shared by the table (desktop) and the list (phone).
  const kwButton = (k: (typeof keywords)[number]) =>
    canEdit && (k.status === "ENABLED" || k.status === "PAUSED") ? (
      <ActionButton
        variant="ghost"
        confirm={tr("settings.googlePage.confirmKeyword", { action: k.status === "ENABLED" ? tr("settings.googlePage.pauseVerb") : tr("settings.googlePage.enableVerb"), text: k.text })}
        action={googleManualChangeAction.bind(null, id, k.campaignId, { kind: "keyword_status", status: k.status === "ENABLED" ? "PAUSED" : "ENABLED", keywords: [{ id: k.id, text: k.text }] })}
      >
        {k.status === "ENABLED" ? tr("settings.googlePage.stop") : tr("settings.googlePage.enable")}
      </ActionButton>
    ) : null;
  const termButton = (t: (typeof terms)[number]) =>
    canEdit && t.status === "NONE" ? (
      <ActionButton
        variant="ghost"
        confirm={tr("settings.googlePage.confirmNegative", { term: t.term, campaign: campName.get(t.campaignId) ?? "" })}
        action={googleManualChangeAction.bind(null, id, t.campaignId, { kind: "negatives", items: [{ text: t.term, matchType: "EXACT" }] })}
      >
        {tr("settings.googlePage.negate")}
      </ActionButton>
    ) : null;

  // Quick-jump bar (phone): only the sections currently shown.
  const jumps: [string, string][] = [
    ...(changeViews.length ? [["g-pending", tr("settings.googlePage.jumpPending", { n: changeViews.length })] as [string, string]] : []),
    ["g-campaigns", tr("settings.googlePage.campaigns")],
    ...(liveKeywords.length ? [["g-quality", tr("settings.googlePage.qualityScore")] as [string, string]] : []),
    ...(canEdit && campaigns.length ? [["g-edit", tr("settings.googlePage.manualEdit")] as [string, string]] : []),
    ["g-keywords", tr("settings.googlePage.keywords")],
    ["g-terms", tr("settings.googlePage.searchTerms")],
    ...(history.length ? [["g-history", tr("settings.googlePage.history")] as [string, string]] : []),
  ];

  return (
    <>
      {head}
      <nav className="sticky top-0 z-20 -mx-4 mb-4 flex gap-1.5 overflow-x-auto border-b border-line bg-bg/95 px-4 py-2 backdrop-blur [scrollbar-width:none] md:top-12 @3xl:hidden">
        {jumps.map(([id, label], i) => (
          <a
            key={id}
            href={`#${id}`}
            className={`shrink-0 rounded-full border px-3 py-1.5 text-xs whitespace-nowrap ${i === 0 && id === "g-pending" ? "border-indigo-300 bg-indigo-50 font-medium text-indigo-700" : "border-line bg-panel text-ink2"}`}
          >
            {label}
          </a>
        ))}
      </nav>
      <div className="flex flex-col">
      {noConv && (
        <p className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {tr("settings.googlePage.noConvBefore")}<b>{tr("settings.googlePage.noConvBold")}</b>{tr("settings.googlePage.noConvAfter", { days })}
        </p>
      )}
      <div className="mb-6 grid grid-cols-2 gap-3 @xl:grid-cols-3 @4xl:grid-cols-6">
        <Stat label={tr("settings.googlePage.spendDays", { days })} value={money(total.spend, cur)} />
        <Stat label={tr("settings.googlePage.clicks")} value={num(total.clicks)} hint={tr("settings.googlePage.impressionsN", { n: num(total.impressions) })} />
        <Stat label="CTR" value={pct(ctr(total.clicks, total.impressions))} />
        <Stat label={tr("settings.googlePage.avgCpc")} value={money(per(total.spend, total.clicks), cur)} />
        <Stat label={tr("settings.googlePage.conversions")} value={num(total.conversions, 1)} tone={noConv ? "bad" : undefined} />
        <Stat label={tr("settings.googlePage.costPerConv")} value={money(cpa, cur)} />
      </div>

      {chart.length > 1 && (
        <Card title={tr("settings.googlePage.byDay")} className="mb-6">
          <DailyChart data={chart} resultLabel={tr("settings.googlePage.conversions")} currency={cur} />
        </Card>
      )}

      {changeViews.length > 0 && (
        <Card id="g-pending" title={<>{tr("settings.googlePage.pendingTitle")} <span className="font-normal text-slate-400">· {changeViews.length} · {tr("settings.googlePage.pendingSub")}</span></>} className="order-first mb-6 @3xl:order-none">
          <div className="space-y-3">
            {changeViews.map((c) => (
              <GoogleChangeCard key={c.id} change={c} canEdit={canEdit} />
            ))}
          </div>
        </Card>
      )}

      <Card id="g-campaigns" title={<>{tr("settings.googlePage.campaigns")} <span className="font-normal text-slate-400">· {campaigns.length}</span></>} className="mb-6">
        {campaigns.length ? (
          <>
          <ul className="divide-y divide-slate-100 @3xl:hidden">
            {rows.map(({ c, p }) => (
              <li key={c.id} className="py-3 first:pt-0 last:pb-0">
                <div className="font-medium break-words text-ink">{c.name}</div>
                <div className="mt-1 flex flex-wrap gap-1">
                  <Badge tone={STATUS_TONE[c.status] ?? "amber"}>{statusL(c.status)}</Badge>
                  <Badge tone="mut">{channel(c.channelType)}</Badge>
                </div>
                <dl className="mt-2 grid grid-cols-3 gap-x-3 gap-y-2 text-sm">
                  <Metric label={tr("settings.googlePage.spend")} value={money(p.spend, cur)} />
                  <Metric label={tr("settings.googlePage.conversions")} value={num(p.conversions, 1)} />
                  <Metric label={tr("settings.googlePage.costConvShort")} value={money(per(p.spend, p.conversions), cur)} />
                </dl>
                <details className="mt-1 text-sm">
                  <summary className="cursor-pointer py-1.5 text-xs text-indigo-600">{tr("settings.googlePage.moreMetrics")}</summary>
                  <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-2">
                    <Metric label={tr("settings.googlePage.dailyBudget")} value={money(c.dailyBudget, cur)} />
                    <Metric label={tr("settings.googlePage.targetCpa")} value={c.targetCpa ? money(c.targetCpa, cur) : "—"} />
                    <Metric label={tr("settings.googlePage.clicks")} value={num(p.clicks)} />
                    <Metric label="CTR" value={pct(ctr(p.clicks, p.impressions))} />
                    <Metric label="CPC" value={money(per(p.spend, p.clicks), cur)} />
                    <Metric label={tr("settings.googlePage.imprShare30")} value={sharePct(c.searchImprShare)} />
                    <Metric label={tr("settings.googlePage.lostBudget")} value={sharePct(c.lostBudgetShare)} warn={(c.lostBudgetShare ?? 0) >= 0.2} />
                    <Metric label={tr("settings.googlePage.lostRank")} value={sharePct(c.lostRankShare)} warn={(c.lostRankShare ?? 0) >= 0.5} />
                  </dl>
                </details>
              </li>
            ))}
          </ul>
          <div className="-mx-5 hidden overflow-x-auto px-5 @3xl:block">
            <table className="w-full text-sm">
              <thead className="text-left text-xs whitespace-nowrap text-slate-400">
                <tr>
                  <th className="py-1 pr-3 font-medium">{tr("settings.googlePage.campaigns")}</th>
                  <th className="py-1 pr-3 font-medium">{tr("settings.googlePage.dailyBudget")}</th>
                  <th className="py-1 pr-3 font-medium" title={tr("settings.googlePage.targetCpaTitle")}>{tr("settings.googlePage.targetCpa")}</th>
                  <th className="py-1 pr-3 text-right font-medium">{tr("settings.googlePage.spend")}</th>
                  <th className="py-1 pr-3 text-right font-medium">{tr("settings.googlePage.colClicks")}</th>
                  <th className="py-1 pr-3 text-right font-medium">CTR</th>
                  <th className="py-1 pr-3 text-right font-medium">CPC</th>
                  <th className="py-1 pr-3 text-right font-medium">{tr("settings.googlePage.conversions")}</th>
                  <th className="py-1 pr-3 text-right font-medium">{tr("settings.googlePage.costConvShort")}</th>
                  <th className="py-1 pr-3 text-right font-medium" title={tr("settings.googlePage.imprTitle")}>{tr("settings.googlePage.impressions")}</th>
                  <th className="py-1 pr-3 text-right font-medium" title={tr("settings.googlePage.lostBudgetTitle")}>{tr("settings.googlePage.lostBudgetShort")}</th>
                  <th className="py-1 text-right font-medium" title={tr("settings.googlePage.lostRankTitle")}>{tr("settings.googlePage.lostRankShort")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map(({ c, p }) => (
                  <tr key={c.id} className="whitespace-nowrap">
                    <td className="py-2 pr-3">
                      <div className="max-w-xs truncate font-medium text-ink" title={c.name}>
                        {c.name}
                      </div>
                      <div className="mt-0.5 flex gap-1">
                        <Badge tone={STATUS_TONE[c.status] ?? "amber"}>{statusL(c.status)}</Badge>
                        <Badge tone="mut">{channel(c.channelType)}</Badge>
                      </div>
                    </td>
                    <td className="py-2 pr-3">{money(c.dailyBudget, cur)}</td>
                    <td className="py-2 pr-3">{c.targetCpa ? money(c.targetCpa, cur) : "—"}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{money(p.spend, cur)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{num(p.clicks)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{pct(ctr(p.clicks, p.impressions))}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{money(per(p.spend, p.clicks), cur)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{num(p.conversions, 1)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{money(per(p.spend, p.conversions), cur)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{sharePct(c.searchImprShare)}</td>
                    <td className={`py-2 pr-3 text-right tabular-nums ${(c.lostBudgetShare ?? 0) >= 0.2 ? "font-medium text-amber-700" : ""}`}>{sharePct(c.lostBudgetShare)}</td>
                    <td className={`py-2 text-right tabular-nums ${(c.lostRankShare ?? 0) >= 0.5 ? "font-medium text-amber-700" : ""}`}>{sharePct(c.lostRankShare)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>
        ) : (
          <p className="text-sm text-mut">{tr("settings.googlePage.noCampaigns")}</p>
        )}
      </Card>

      {liveKeywords.length > 0 && (
        <Card
          id="g-quality"
          title={<>{tr("settings.googlePage.qualityScore")} <span className="font-normal text-slate-400">· {tr("settings.googlePage.qualitySub")}</span></>}
          className="mb-6"
          action={
            canEdit && searchCamps.length > 0 ? (
              <ActionButton action={googleClaudeRestructureAction.bind(null, id)} pending={tr("settings.googlePage.queueing")} variant="ai">
                {tr("settings.googlePage.claudeRestructure")}
              </ActionButton>
            ) : undefined
          }
        >
          <div className="mb-3 grid grid-cols-2 gap-3 @xl:grid-cols-3 @4xl:grid-cols-5">
            <Stat label={tr("settings.googlePage.avgScore")} value={qs.avg == null ? "—" : num(qs.avg, 1)} tone={qs.avg != null && qs.avg < 5 ? "bad" : undefined} />
            <Stat label={tr("settings.googlePage.spendLowScore")} value={pct(qs.low * 100, 0)} tone={qs.low >= 0.3 ? "bad" : undefined} />
            <Stat label={tr("settings.googlePage.ctrBelow")} value={pct(qs.ctr * 100, 0)} tone={qs.ctr >= 0.3 ? "bad" : undefined} />
            <Stat label={tr("settings.googlePage.relBelow")} value={pct(qs.rel * 100, 0)} tone={qs.rel >= 0.3 ? "bad" : undefined} />
            <Stat label={tr("settings.googlePage.lpBelow")} value={pct(qs.lp * 100, 0)} tone={qs.lp >= 0.3 ? "bad" : undefined} />
          </div>
          <p className="text-sm text-ink2">
            {tr("settings.googlePage.qualityHelp")}
          </p>
          {[...lpByUrl].some(([, x]) => x.bad > 0) && (
            <div className="mt-3 text-sm">
              <p className="mb-1 text-xs text-slate-600">{tr("settings.googlePage.landingPages")}</p>
              <ul className="space-y-0.5">
                {[...lpByUrl]
                  .filter(([, x]) => x.bad > 0)
                  .sort((a, b) => b[1].bad - a[1].bad)
                  .map(([u, x]) => (
                    <li key={u}>
                      <a href={u} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">
                        {u}
                      </a>{" "}
                      <span className="text-xs text-rose-700">· {tr("settings.googlePage.landingBad", { pct: pct((x.bad / x.spend) * 100, 0) })}</span>
                    </li>
                  ))}
              </ul>
            </div>
          )}
          {canEdit && searchCamps.length > 0 && (
            <div className="mt-3">
              <DraftGroupButton clientId={id} campaigns={searchCamps} />
            </div>
          )}
        </Card>
      )}

      {canEdit && campaigns.length > 0 && (
        <Card id="g-edit" title={<>{tr("settings.googlePage.manualTitle")} <span className="font-normal text-slate-400">· {tr("settings.googlePage.manualSub")}</span></>} className="mb-6">
          <GoogleCampaignEditor clientId={id} campaigns={editable} />
        </Card>
      )}

      <div className="grid gap-6 @5xl:grid-cols-2">
        <Card id="g-keywords" title={<>{tr("settings.googlePage.keywords")} <span className="font-normal text-slate-400">· {tr("settings.googlePage.keywordsSub")}</span></>}>
          {keywords.length ? (
            <>
            <div className="-mx-5 hidden overflow-x-auto px-5 @3xl:block">
              <table className="w-full text-sm">
                <thead className="text-left text-xs whitespace-nowrap text-slate-400">
                  <tr>
                    <th className="py-1 pr-3 font-medium">{tr("settings.googlePage.keyword")}</th>
                    <th className="py-1 pr-3 text-right font-medium" title={tr("settings.googlePage.qsTitle")}>{tr("settings.googlePage.qsShort")}</th>
                    <th className="py-1 pr-3 text-right font-medium">{tr("settings.googlePage.spend")}</th>
                    <th className="py-1 pr-3 text-right font-medium">{tr("settings.googlePage.colClicks")}</th>
                    <th className="py-1 pr-3 text-right font-medium">CPC</th>
                    <th className="py-1 text-right font-medium">{tr("settings.googlePage.convShort")}</th>
                    {canEdit && <th />}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {keywords.map((k) => (
                    <tr key={k.id} className={k.status !== "ENABLED" ? "text-mut" : ""}>
                      <td className="py-1.5 pr-3">
                        <span className="font-medium">{k.text}</span> <span className="text-xs text-mut">{matchL(k.matchType)}</span>
                        <QParts k={k} tr={tr} />
                        {k.status !== "ENABLED" && <span className="ml-1 text-xs">· {statusL(k.status)}</span>}
                      </td>
                      <td className={`py-1.5 pr-3 text-right tabular-nums ${k.qualityScore != null && k.qualityScore <= 4 ? "font-medium text-rose-700" : ""}`}>{k.qualityScore ?? "—"}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums whitespace-nowrap">{money(k.spend, cur)}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{num(k.clicks)}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums whitespace-nowrap">{money(per(k.spend, k.clicks), cur)}</td>
                      <td className="py-1.5 text-right tabular-nums">{num(k.conversions, 1)}</td>
                      {canEdit && <td className="py-1.5 pl-2 text-right">{kwButton(k)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="divide-y divide-slate-100 @3xl:hidden">
              {keywords.map((k) => (
                <li key={k.id} className={`flex items-start justify-between gap-2 py-2.5 first:pt-0 ${k.status !== "ENABLED" ? "text-mut" : ""}`}>
                  <div className="min-w-0 text-sm">
                    <span className="font-medium break-words">{k.text}</span> <span className="text-xs text-mut">{matchL(k.matchType)}</span>
                    {k.status !== "ENABLED" && <span className="ml-1 text-xs">· {statusL(k.status)}</span>}
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-mut tabular-nums">
                      <span>
                        {tr("settings.googlePage.qsShort")} <b className={k.qualityScore != null && k.qualityScore <= 4 ? "text-rose-700" : "text-ink"}>{k.qualityScore ?? "—"}</b>
                        <QParts k={k} tr={tr} />
                      </span>
                      <span>{tr("settings.googlePage.spendShort", { amount: money(k.spend, cur) })}</span>
                      <span>{tr("settings.googlePage.clicksN", { n: num(k.clicks) })}</span>
                      <span>CPC {money(per(k.spend, k.clicks), cur)}</span>
                      <span>{num(k.conversions, 1)} {tr("settings.googlePage.convShort")}</span>
                    </div>
                  </div>
                  {kwButton(k)}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-mut">
              {tr("settings.googlePage.qsLegend1")}<b>{tr("settings.googlePage.qClicks")}</b>{tr("settings.googlePage.qsLegend2")}<b>{tr("settings.googlePage.qAd")}</b>{tr("settings.googlePage.qsLegend3")}<b>{tr("settings.googlePage.qPage")}</b>{tr("settings.googlePage.qsLegend4")}
            </p>
            </>
          ) : (
            <p className="text-sm text-mut">{tr("settings.googlePage.noKeywords")}</p>
          )}
        </Card>

        <Card id="g-terms" title={<>{tr("settings.googlePage.realTerms")} <span className="font-normal text-slate-400">· {tr("settings.googlePage.days30")}</span></>}>
          {wasted.length > 0 && (
            <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {tr("settings.googlePage.wasted1", { n: wasted.length })}<b>{tr("settings.googlePage.negate")}</b>{tr("settings.googlePage.wasted2")}
            </p>
          )}
          {terms.length ? (
            <>
            <div className="-mx-5 hidden overflow-x-auto px-5 @3xl:block">
              <table className="w-full text-sm">
                <thead className="text-left text-xs whitespace-nowrap text-slate-400">
                  <tr>
                    <th className="py-1 pr-3 font-medium">{tr("settings.googlePage.searchTerm")}</th>
                    <th className="py-1 pr-3 text-right font-medium">{tr("settings.googlePage.spend")}</th>
                    <th className="py-1 pr-3 text-right font-medium">{tr("settings.googlePage.colClicks")}</th>
                    <th className="py-1 text-right font-medium">{tr("settings.googlePage.convShort")}</th>
                    {canEdit && <th />}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {terms.map((t) => (
                    <tr key={t.id} className={t.conversions === 0 && t.clicks >= 5 ? "bg-amber-50/60" : ""}>
                      <td className="py-1.5 pr-3">
                        {t.term}
                        {termL(t.status) && <span className="ml-1 text-xs text-mut">· {termL(t.status)}</span>}
                      </td>
                      <td className="py-1.5 pr-3 text-right tabular-nums whitespace-nowrap">{money(t.spend, cur)}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{num(t.clicks)}</td>
                      <td className="py-1.5 text-right tabular-nums">{num(t.conversions, 1)}</td>
                      {canEdit && <td className="py-1.5 pl-2 text-right">{termButton(t)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="-mx-5 divide-y divide-slate-100 @3xl:hidden">
              {terms.map((t) => (
                <li key={t.id} className={`flex items-start justify-between gap-2 px-5 py-2.5 ${t.conversions === 0 && t.clicks >= 5 ? "bg-amber-50/60" : ""}`}>
                  <div className="min-w-0 text-sm">
                    <span className="break-words">{t.term}</span>
                    {termL(t.status) && <span className="ml-1 text-xs text-mut">· {termL(t.status)}</span>}
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-mut tabular-nums">
                      <span>{tr("settings.googlePage.spendShort", { amount: money(t.spend, cur) })}</span>
                      <span>{tr("settings.googlePage.clicksN", { n: num(t.clicks) })}</span>
                      <span>{num(t.conversions, 1)} {tr("settings.googlePage.convShort")}</span>
                    </div>
                  </div>
                  {termButton(t)}
                </li>
              ))}
            </ul>
            </>
          ) : (
            <p className="text-sm text-mut">{tr("settings.googlePage.noTerms")}</p>
          )}
        </Card>
      </div>

      {history.length > 0 && (
        <Card id="g-history" title={<>{tr("settings.googlePage.historyTitle")} <span className="font-normal text-slate-400">· {tr("settings.googlePage.last20")}</span></>} className="mt-6">
          <ul className="divide-y divide-slate-100 text-sm">
            {history.map((h) => (
              <li key={h.id} className="flex flex-wrap items-baseline gap-x-2 py-1.5">
                <Badge tone={h.status === "executed" ? "green" : h.status === "failed" ? "red" : "mut"}>{h.status === "executed" ? tr("settings.googlePage.hEdited") : h.status === "failed" ? tr("settings.googlePage.hFailed") : tr("settings.googlePage.hDismissed")}</Badge>
                <span className="font-medium text-ink">{h.title}</span>
                <span className="text-xs text-mut">
                  {h.campaignName} · {h.source === "manual" ? tr("settings.googlePage.srcManual") : h.source === "claude" ? tr("settings.googlePage.srcClaude") : tr("settings.googlePage.srcRule")} · {h.decidedBy ?? ""} {dateTime(h.decidedAt)}
                </span>
                {h.status !== "rejected" && h.result && <span className={`w-full text-xs ${h.status === "failed" ? "text-rose-700" : "text-mut"}`}>{h.result}</span>}
              </li>
            ))}
          </ul>
        </Card>
      )}
      </div>
    </>
  );
}
