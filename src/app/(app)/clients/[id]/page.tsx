import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { connection } from "next/server";
import { BreakdownTables } from "@/components/breakdown-tables";
import { db } from "@/lib/db";
import { derive, money, num, pct, resultLabels, statusLabels, sumMetrics, type Metrics } from "@/lib/format";
import { getT } from "@/i18n/server";
import type { MessageKey, T } from "@/i18n/translate";
import { DailyChart } from "@/components/daily-chart";
import { BudgetCell, StatusSwitch } from "@/components/inline-controls";
import { Badge, btnClass, Card, Empty, priorityLabels, Stat, statusTone } from "@/components/ui";
import { AdSetManualActions, OptimizeCampaignButton } from "@/components/optimize-actions";
import { targetCprOf } from "@/lib/target-cpr";
import { todayOverview } from "@/lib/today";
import { BarChart3, ChevronRight, Zap } from "lucide-react";
import { RowToggle } from "@/components/row-toggle";
import { AdsRefreshCountdown } from "@/components/ads-refresh-countdown";
import { requirePageClient } from "@/lib/access";

const META_ACTIONS = new Set(["pause", "resume", "update_budget", "duplicate_adset", "add_ad", "update_targeting"]);
const ACTION_KEYS: Record<string, MessageKey> = {
  pause: "customers.clientHome.action.pause",
  resume: "customers.clientHome.action.resume",
  update_budget: "customers.clientHome.action.update_budget",
  duplicate_adset: "customers.clientHome.action.duplicate_adset",
  add_ad: "customers.clientHome.action.add_ad",
  update_targeting: "customers.clientHome.action.update_targeting",
  new_draft: "customers.clientHome.action.new_draft",
  manual: "customers.clientHome.action.manual",
};

function cprClass(cpr: number | null, target: number | null) {
  if (cpr == null || !target) return "";
  if (cpr > target * 1.3) return "text-rose-600 font-medium";
  if (cpr <= target) return "text-emerald-600";
  return "text-amber-600";
}

function MetricCells({ m, currency, target }: { m: Metrics; currency: string; target: number | null }) {
  const d = derive(m);
  return (
    <>
      <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{money(m.spend, currency)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{num(m.results)}</td>
      <td className={`px-3 py-2 text-right tabular-nums whitespace-nowrap ${cprClass(d.cpr, target)}`}>{money(d.cpr, currency)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{pct(d.ctr)}</td>
      <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{money(d.cpm, currency)}</td>
      <td className={`px-3 py-2 text-right tabular-nums ${d.frequency && d.frequency > 3 ? "text-rose-600" : ""}`}>{num(d.frequency, 2)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{d.roas ? num(d.roas, 2) : "—"}</td>
    </>
  );
}

export default async function ClientPerformancePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ all?: string }> }) {
  await connection();
  const t = await getT();
  const resultLabelMap = resultLabels(t);
  const priorityLabel = priorityLabels(t);
  const { id } = await params;
  await requirePageClient(id); // check access right on the page: the layout may not re-run on client-side navigation
  const showAll = (await searchParams).all === "1";
  const [client, campaigns, daily, breakdowns, recs, today, adsSync] = await Promise.all([
    db.client.findUniqueOrThrow({ where: { id } }),
    db.campaign.findMany({
      where: { clientId: id },
      // Don't fetch targeting (some clients stuff in hundreds of interests, several MB) since this table doesn't display it.
      include: { adSets: { omit: { targeting: true }, include: { ads: { orderBy: { spend: "desc" } } }, orderBy: { spend: "desc" } } },
      orderBy: [{ status: "asc" }, { spend: "desc" }],
    }),
    db.dailyMetric.findMany({ where: { clientId: id }, orderBy: { date: "desc" }, take: 30 }).then((rows) => rows.reverse()),
    db.adBreakdown.findMany({ where: { clientId: id } }),
    db.recommendation.findMany({ where: { clientId: id, status: "pending" }, orderBy: { createdAt: "desc" }, take: 4, select: { id: true, title: true, actionType: true, priority: true } }),
    todayOverview(),
    db.setting.findUnique({ where: { key: `sync.ads.${id}` } }),
  ]);
  // Ads data timestamp: the latest quick refresh (worker, every 15 minutes) or full sync, whichever is newer.
  const quick = (() => {
    try {
      return adsSync ? (JSON.parse(adsSync.value) as { at: string; every?: number; error?: string }) : null;
    } catch {
      return null;
    }
  })();
  const quickAt = quick ? new Date(quick.at) : null;
  const adsAt = [quickAt, client.lastSyncedAt].filter((x): x is Date => !!x).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const tasks = today.list.find((c) => c.id === id)?.tasks.filter((task) => task.category !== t("core.today.catOptimise")) ?? [];

  const cur = client.currency;
  const main = sumMetrics(campaigns.filter((c) => c.resultType === client.primaryResult));
  const all = sumMetrics(campaigns);
  const d = derive(main);
  const dAll = derive(all);
  const resultLabel = resultLabelMap[client.primaryResult];
  // By default only show campaigns that are running or have spend in the last 7 days; old disabled campaigns are hidden behind the "Xem tất cả" (Show all) button.
  const busy = campaigns.filter((c) => c.status === "ACTIVE" || c.spend > 0);
  const shown = showAll || !busy.length ? campaigns : busy;
  const hidden = campaigns.length - shown.length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-ink">{t("customers.clientHome.title")}</h2>
          <p className="text-sm text-mut">{t("customers.clientHome.subPre")}<AdsRefreshCountdown dataAt={adsAt?.toISOString() ?? null} lastAt={quick?.at ?? null} every={quick?.every ?? 900} />{t("customers.clientHome.subPost")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={`/clients/${id}/campaigns?days=today`} className={btnClass("secondary")} title={t("customers.clientHome.todayTitle")}>
            {t("customers.clientHome.today")}
          </Link>
          <Link href={`/clients/${id}/campaigns?days=lifetime`} className={btnClass("secondary")} title={t("customers.clientHome.lifetimeTitle")}>
            {t("customers.clientHome.lifetime")}
          </Link>
          <Link href={`/clients/${id}/campaigns`} className={btnClass("secondary")}>
            <BarChart3 /> {t("customers.clientHome.reports")}
          </Link>
        </div>
      </div>
      <div className="grid gap-3 @xl:grid-cols-3 @5xl:grid-cols-5">
        <Stat label={t("customers.clientHome.stat.spend")} value={money(all.spend, cur)} />
        <Stat label={resultLabel} value={num(main.results)} />
        <Stat
          label={t("customers.clientHome.stat.cpr")}
          value={money(d.cpr, cur)}
          hint={client.targetCpr ? t("customers.clientHome.stat.target", { value: money(client.targetCpr, cur) }) : client.autoTargetCpr ? t("customers.clientHome.stat.autoTarget", { value: money(client.autoTargetCpr, cur) }) : t("customers.clientHome.stat.noTarget")}
          tone={d.cpr && targetCprOf(client) ? (d.cpr <= targetCprOf(client)! ? "good" : "bad") : undefined}
        />
        <Stat label={t("customers.clientHome.stat.ctr")} value={pct(dAll.ctr)} hint={t("customers.clientHome.stat.cpm", { value: money(dAll.cpm, cur) })} />
        <Stat
          label="ROAS"
          value={dAll.roas ? num(dAll.roas, 2) : "—"}
          hint={client.targetRoas ? t("customers.clientHome.stat.roasTarget", { value: client.targetRoas }) : undefined}
          tone={dAll.roas && client.targetRoas ? (dAll.roas >= client.targetRoas ? "good" : "bad") : undefined}
        />
      </div>

      <div className="grid items-start gap-4 [&>*]:min-w-0 @5xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card title={t("customers.clientHome.daily.title")}>
          {daily.length ? (
            <DailyChart
              currency={cur}
              resultLabel={resultLabel}
              data={daily.map((x) => ({ date: x.date, spend: x.spend, results: x.results, cpr: x.results ? x.spend / x.results : null }))}
            />
          ) : (
            <Empty>{t("customers.clientHome.daily.empty")}</Empty>
          )}
        </Card>
        <div className="space-y-4">
          <Card title={t("customers.clientHome.tasks.title")}>
            {tasks.length ? (
              <ul className="-my-2 divide-y divide-line">
                {tasks.map((task, i) => (
                  <li key={i} className="flex items-center gap-2.5 py-2.5">
                    <span className={`size-2 shrink-0 rounded-full ${task.tone === "red" ? "bg-rose-600" : task.tone === "amber" ? "bg-amber-400" : "bg-emerald-500"}`} />
                    <span className="min-w-0 flex-1 text-sm text-ink">{task.text}</span>
                    <Link href={task.href} className={btnClass(task.category === t("core.today.catProcess") ? "ai" : "secondary")}>
                      {task.cta}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-emerald-700">{t("customers.clientHome.tasks.none")}</p>
            )}
          </Card>
          <Card
            title={t("customers.clientHome.recs.title")}
            action={
              recs.length ? (
                <Link href={`/clients/${id}/recommendations`} className="inline-flex items-center gap-1 text-sm font-medium text-indigo-600 hover:underline">
                  {t("customers.clientHome.recs.review")} <ChevronRight className="size-4" />
                </Link>
              ) : null
            }
          >
            {recs.length ? (
              <ul className="-my-2 divide-y divide-line">
                {recs.map((r) => (
                  <li key={r.id} className="flex items-center gap-2.5 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-ink">{r.title}</p>
                      <p className="text-xs text-mut">
                        {t("customers.clientHome.recs.line", { action: ACTION_KEYS[r.actionType] ? t(ACTION_KEYS[r.actionType]) : r.actionType, priority: priorityLabel[r.priority]?.toLowerCase() ?? r.priority })}
                      </p>
                    </div>
                    <Link href={`/clients/${id}/recommendations`} className={btnClass(META_ACTIONS.has(r.actionType) ? "meta" : "secondary")}>
                      {META_ACTIONS.has(r.actionType) && <Zap />} {t("customers.clientHome.recs.view")}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-mut">{t("customers.clientHome.recs.none")}</p>
            )}
          </Card>
        </div>
      </div>

      <BreakdownTables rows={breakdowns} currency={cur} resultLabel={resultLabel} />
      <Card
        title={
          <>
            {t("customers.clientHome.camp.title")} <span className="text-xs font-normal text-mut">· <AdsRefreshCountdown dataAt={adsAt?.toISOString() ?? null} lastAt={quick?.at ?? null} every={quick?.every ?? 900} /></span>
          </>
        }
        action={
          <span className="flex flex-wrap items-center gap-3">
            {campaigns.some((c) => c.status === "ACTIVE") && <OptimizeCampaignButton clientId={id} />}
            {hidden > 0 ? (
            <Link href="?all=1" scroll={false} className="text-xs font-medium text-indigo-600 hover:underline">{t("customers.clientHome.camp.showHidden", { n: hidden })}</Link>
          ) : showAll && busy.length < campaigns.length ? (
            <Link href="?" scroll={false} className="text-xs font-medium text-indigo-600 hover:underline">{t("customers.clientHome.camp.onlyActive")}</Link>
          ) : null}
          </span>
        }
      >
        {!campaigns.length ? (
          <Empty>{t("customers.clientHome.camp.empty")}</Empty>
        ) : (
          <div className="-mx-5 -my-5 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  <th className="w-12 py-2 pl-5 font-medium">{t("customers.clientHome.th.on")}</th>
                  <th className="min-w-72 px-3 py-2 font-medium">{t("customers.clientHome.th.name")}</th>
                  <th className="px-3 py-2 font-medium">{t("customers.clientHome.th.status")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("customers.clientHome.th.budget")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("customers.clientHome.th.spend")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("customers.clientHome.th.results")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("customers.clientHome.th.cpr")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("customers.clientHome.th.ctr")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("customers.clientHome.th.cpm")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("customers.clientHome.th.freq")}</th>
                  <th className="px-3 py-2 text-right font-medium">ROAS</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((c) => (
                  <CampaignRows key={c.id} c={c} clientId={id} currency={cur} t={t} target={c.resultType === client.primaryResult ? targetCprOf(client) : null} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

type CampaignWithTree = Prisma.CampaignGetPayload<{ include: { adSets: { omit: { targeting: true }; include: { ads: true } } } }>;

function CampaignRows({ c, clientId, currency, target, t }: { c: CampaignWithTree; clientId: string; currency: string; target: number | null; t: T }) {
  const statusLabel = statusLabels(t);
  const resultLabelMap = resultLabels(t);
  return (
    <>
      <tr data-row={c.id} className="border-t border-slate-200 bg-panel font-medium">
        <td className="py-2 pl-5"><StatusSwitch clientId={clientId} level="campaign" id={c.id} status={c.status} name={c.name} /></td>
        <td className="px-3 py-2">
          <div className="text-slate-900">
            {c.adSets.length > 0 && <RowToggle id={c.id} label={c.name} />}
            {c.name}
          </div>
          <div className="text-xs font-normal text-slate-500">
            {c.objective} · {resultLabelMap[c.resultType] ?? c.resultType}
            <span className="ml-2 inline-flex flex-wrap items-center gap-2">
              {(c.status === "ACTIVE" || c.spend > 0) && (
                <Link href={`/clients/${clientId}/campaigns/${c.id}`} className="text-[11px] font-medium text-indigo-600 hover:underline">
                  {t("customers.clientHome.detail")}
                </Link>
              )}
              {c.status === "ACTIVE" && <OptimizeCampaignButton clientId={clientId} campaignId={c.id} />}
            </span>
          </div>
        </td>
        <td className="px-3 py-2"><Badge tone={statusTone(c.status)}>{statusLabel[c.status] ?? c.status}</Badge></td>
        <td className="px-3 py-2 text-right whitespace-nowrap">
          {c.dailyBudget ? <BudgetCell clientId={clientId} level="campaign" id={c.id} value={c.dailyBudget} currency={currency} /> : <span className="text-xs text-slate-400">ABO</span>}
        </td>
        <MetricCells m={c} currency={currency} target={target} />
      </tr>
      {c.adSets.map((s) => (
        <FragmentRows key={s.id} s={s} campaignId={c.id} clientId={clientId} currency={currency} target={target} statusLabel={statusLabel} />
      ))}
    </>
  );
}

function FragmentRows({ s, campaignId, clientId, currency, target, statusLabel }: { s: CampaignWithTree["adSets"][number]; campaignId: string; clientId: string; currency: string; target: number | null; statusLabel: Record<string, string> }) {
  return (
    <>
      <tr data-row={s.id} data-parent={campaignId} className="border-t border-slate-100 bg-slate-50/50">
        <td className="py-2 pl-5"><StatusSwitch clientId={clientId} level="adset" id={s.id} status={s.status} name={s.name} /></td>
        <td className="py-2 pr-3 pl-7 text-slate-800">
          {s.ads.length > 0 ? <RowToggle id={s.id} label={s.name} /> : <span className="text-slate-400">└ </span>}
          {s.name}
          <AdSetManualActions clientId={clientId} adSetId={s.id} />
        </td>
        <td className="px-3 py-2"><Badge tone={statusTone(s.status)}>{statusLabel[s.status] ?? s.status}</Badge></td>
        <td className="px-3 py-2 text-right whitespace-nowrap">
          {s.dailyBudget ? <BudgetCell clientId={clientId} level="adset" id={s.id} value={s.dailyBudget} currency={currency} /> : "—"}
        </td>
        <MetricCells m={s} currency={currency} target={target} />
      </tr>
      {s.ads.map((a) => (
        <tr key={a.id} data-parent={`${campaignId} ${s.id}`} className="border-t border-slate-100 text-slate-600">
          <td className="py-1.5 pl-5"><StatusSwitch clientId={clientId} level="ad" id={a.id} status={a.status} name={a.name} /></td>
          <td className="py-1.5 pr-3 pl-12 text-xs">
            <span className="text-slate-300">└ </span>
            {a.name}
          </td>
          <td className="px-3 py-1.5"><Badge tone={statusTone(a.status)}>{statusLabel[a.status] ?? a.status}</Badge></td>
          <td />
          <MetricCells m={a} currency={currency} target={target} />
        </tr>
      ))}
    </>
  );
}
