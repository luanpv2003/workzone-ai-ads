import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { db } from "@/lib/db";
import { getMetaClient } from "@/lib/meta";
import { reviewCampaign, thresholdsFor, type Check, type ObjectReview } from "@/lib/optimize";
import { errorMessage } from "@/lib/activity";
import { qualityByAd } from "@/lib/lead-quality";
import { dateTime, money, num, statusLabels } from "@/lib/format";
import { getT } from "@/i18n/server";
import type { T } from "@/i18n/translate";
import { Badge, Card, Empty, statusTone } from "@/components/ui";
import { OptimizeCampaignButton } from "@/components/optimize-actions";
import type { PeriodMetrics } from "@/lib/meta/types";
import { requirePageClient } from "@/lib/access";

// Detailed review of one campaign: explains, against the optimization rule set's exact thresholds, why something should / shouldn't change yet.

const TONE: Record<Check["tone"], { icon: string; cls: string; badge: "green" | "amber" | "red" | "gray" }> = {
  good: { icon: "✓", cls: "text-emerald-600", badge: "green" },
  warn: { icon: "!", cls: "text-amber-600", badge: "amber" },
  bad: { icon: "✕", cls: "text-rose-600", badge: "red" },
  info: { icon: "•", cls: "text-slate-400", badge: "gray" },
};

function Metrics({ m, cur, label, t }: { m: PeriodMetrics; cur: string; label: string; t: T }) {
  const cpr = m.results ? m.spend / m.results : null;
  return (
    <span className="whitespace-nowrap tabular-nums">
      <span className="text-slate-400">{label}:</span> {t("customers.campaignReview.metricsLine", { spend: money(m.spend, cur), results: num(m.results), cpr: cpr != null ? money(cpr, cur) : "—", freq: m.reach ? (m.impressions / m.reach).toFixed(2) : "—", ctr: m.impressions ? ((m.clicks / m.impressions) * 100).toFixed(2) : "0" })}
    </span>
  );
}

function Checks({ checks }: { checks: Check[] }) {
  return (
    <ul className="space-y-1">
      {checks.map((c, i) => (
        <li key={i} className="flex gap-2 text-sm">
          <span className={`w-3 shrink-0 font-bold ${TONE[c.tone].cls}`}>{TONE[c.tone].icon}</span>
          <span>
            <span className="font-medium text-slate-700">{c.label}:</span> <span className="text-slate-600">{c.text}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export default async function CampaignReviewPage({ params }: { params: Promise<{ id: string; campaignId: string }> }) {
  await connection();
  const t = await getT();
  const statusLabel = statusLabels(t);
  const { id, campaignId } = await params;
  await requirePageClient(id); // check access right on the page: the layout may not re-run on client-side navigation
  const [client, campaign, recs] = await Promise.all([
    db.client.findUniqueOrThrow({ where: { id } }),
    db.campaign.findFirst({ where: { id: campaignId, clientId: id } }),
    db.recommendation.findMany({ where: { clientId: id, kind: "optimize", campaignId }, orderBy: { createdAt: "desc" }, take: 20 }),
  ]);
  if (!campaign) notFound();
  const cur = client.currency;
  let review: ReturnType<typeof reviewCampaign> | null = null;
  let error: string | null = null;
  try {
    const snap = await getMetaClient(client).fetchOptimizeSnapshot(campaignId);
    if (snap) review = reviewCampaign(client, snap, await thresholdsFor(client), await qualityByAd(id), campaign.resultType, t);
    else error = t("customers.campaignReview.notConnected");
  } catch (err) {
    error = errorMessage(err);
  }
  const pending = recs.filter((r) => r.status === "pending");
  const done = recs.filter((r) => r.status === "executed" || r.status === "done").slice(0, 5);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href={`/clients/${id}`} className="text-sm text-slate-500 hover:text-slate-800">{t("customers.campaignReview.back")}</Link>
          <h2 className="mt-1 text-lg font-semibold text-slate-900">{t("customers.campaignReview.heading", { name: campaign.name })}</h2>
          <p className="text-xs text-slate-500">{t("customers.campaignReview.sub")}</p>
        </div>
        {review?.campaign.status === "ACTIVE" && <OptimizeCampaignButton clientId={id} campaignId={campaignId} />}
      </div>

      {error && <Empty>{t("customers.campaignReview.error", { error })}</Empty>}

      {review && (
        <>
          <Card title={t("customers.campaignReview.baseline")}>
            <div className="space-y-2 text-sm text-slate-700">
              <p className="flex flex-wrap items-center gap-2">
                <Badge tone={statusTone(review.campaign.status)}>{statusLabel[review.campaign.status] ?? review.campaign.status}</Badge>
                <Metrics m={review.campaign.m7} cur={cur} label={t("customers.campaignReview.wholeCampaign")} t={t} />
              </p>
              <p>
                <b>{t("customers.campaignReview.refCpr", { value: review.ref != null ? money(review.ref, cur) : t("customers.campaignReview.noRef") })}</b> ({review.refLabel})
                {review.control && <>{t("customers.campaignReview.control")}<b>{review.control}</b></>}
              </p>
              {!client.targetCpr &&
                (client.autoTargetCpr ? (
                  <p className="text-xs text-amber-700">{t("customers.campaignReview.autoTarget", { value: money(client.autoTargetCpr, client.currency), days: client.analysisDays })}</p>
                ) : (
                  <p className="text-xs text-amber-700">{t("customers.campaignReview.noTarget")}</p>
                ))}
              {review.thresholds.notes.map((n) => (
                <p key={n} className="text-xs text-violet-700">{t("customers.campaignReview.autoAdjust", { note: n })}</p>
              ))}
              <details className="text-xs text-slate-500">
                <summary className="cursor-pointer font-medium text-indigo-600">{t("customers.campaignReview.howTitle")}</summary>
                <ul className="mt-1 list-disc space-y-0.5 pl-5">
                  <li>{t("customers.campaignReview.r1a")}<b>{t("customers.campaignReview.r1b")}</b>{t("customers.campaignReview.r1c", { pct: Math.round(review.thresholds.confidence * 100) })}</li>
                  <li>{t("customers.campaignReview.r2", { n: review.thresholds.minSpendX + 1 })}</li>
                  <li>{t("customers.campaignReview.r3", { n: review.thresholds.minSpendX })}</li>
                  <li>
                    {t("customers.campaignReview.r4a", { warn: review.thresholds.warnPct })}<b>{t("customers.campaignReview.r4b")}</b>{t("customers.campaignReview.r4c", { pause: review.thresholds.pausePct })}{" "}
                    {review.thresholds.mode === "suggest" ? t("customers.campaignReview.r4suggest") : t("customers.campaignReview.r4warnOnly")}.
                  </li>
                  <li>{t("customers.campaignReview.r5", { step: review.thresholds.budgetStepPct, min: client.minResults })}</li>
                  <li>{t("customers.campaignReview.r6")}</li>
                  <li>{t("customers.campaignReview.r7", { freq: review.thresholds.freqMax })}</li>
                  <li>{t("customers.campaignReview.r8", { n: review.thresholds.minSpendX })}</li>
                  <li>{t("customers.campaignReview.r9")}</li>
                </ul>
              </details>
            </div>
          </Card>

          {(pending.length > 0 || done.length > 0) && (
            <Card title={t("customers.campaignReview.recs")}>
              <ul className="space-y-1.5 text-sm">
                {pending.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-2">
                    <Badge tone="amber">{t("customers.campaignReview.pending")}</Badge>
                    <span className="text-slate-800">{r.title}</span>
                  </li>
                ))}
                {done.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-2 text-slate-500">
                    <Badge tone="green">{t("customers.campaignReview.done", { at: r.executedAt ? dateTime(r.executedAt) : "" })}</Badge>
                    <span>{r.title}</span>
                  </li>
                ))}
              </ul>
              {pending.length > 0 && (
                <Link href={`/clients/${id}/recommendations`} className="mt-3 inline-block text-sm font-medium text-indigo-600 hover:underline">
                  {t("customers.campaignReview.openPending")}
                </Link>
              )}
            </Card>
          )}

          {review.adSets.map((s) => (
            <Card key={s.id}>
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-semibold text-slate-900">{s.name}</p>
                    <p className="text-xs text-slate-500">
                      {t("customers.campaignReview.adSetLine", { status: statusLabel[s.status] ?? s.status, days: s.ageDays, budget: s.budget != null ? t("customers.campaignReview.adSetBudget", { value: money(s.budget, cur) }) : "" })}
                    </p>
                  </div>
                  <Badge tone={TONE[s.verdictTone].badge}>{s.verdict}</Badge>
                </div>
                <div className="flex flex-col gap-0.5 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
                  <Metrics m={s.m7} cur={cur} label={t("customers.campaignReview.d7")} t={t} />
                  <Metrics m={s.m3} cur={cur} label={t("customers.campaignReview.d3")} t={t} />
                </div>
                <Checks checks={s.checks} />
                {s.ads.length > 0 && <AdsTable ads={s.ads} cur={cur} t={t} />}
              </div>
            </Card>
          ))}
        </>
      )}
    </div>
  );
}

function AdsTable({ ads, cur, t }: { ads: ObjectReview[]; cur: string; t: T }) {
  const statusLabel = statusLabels(t);
  return (
    <div className="-mx-5 overflow-x-auto border-t border-slate-100">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-slate-500">
          <tr>
            <th className="min-w-56 px-5 py-2 font-medium">{t("customers.campaignReview.ads.ad")}</th>
            <th className="px-3 py-2 text-right font-medium whitespace-nowrap">{t("customers.campaignReview.ads.spend7")}</th>
            <th className="px-3 py-2 text-right font-medium">{t("customers.campaignReview.ads.results")}</th>
            <th className="px-3 py-2 text-right font-medium">{t("customers.campaignReview.ads.cpr")}</th>
            <th className="min-w-64 px-5 py-2 font-medium">{t("customers.campaignReview.ads.review")}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {ads.map((a) => (
            <tr key={a.id} className="align-top">
              <td className="px-5 py-2 text-slate-800">
                {a.name}
                <div className="text-[11px] text-slate-400">{statusLabel[a.status] ?? a.status}</div>
              </td>
              <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums">{money(a.m7.spend, cur)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{num(a.m7.results)}</td>
              <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums">{a.m7.results ? money(a.m7.spend / a.m7.results, cur) : "—"}</td>
              <td className="px-5 py-2">
                <Badge tone={TONE[a.verdictTone].badge}>{a.verdict}</Badge>
                {a.checks.map((c, i) => (
                  <p key={i} className="mt-1 text-xs text-slate-600">
                    <span className={`font-bold ${TONE[c.tone].cls}`}>{TONE[c.tone].icon}</span> {c.text}
                  </p>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
