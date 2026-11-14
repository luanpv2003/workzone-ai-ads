import Link from "next/link";
import { connection } from "next/server";
import { db } from "@/lib/db";
import { audienceAction, refreshRankingAction } from "@/app/actions";
import { ActionButton } from "@/components/action-button";
import { Hint } from "@/components/hint";
import { Badge, btnClass, Card, Empty } from "@/components/ui";
import { AudienceReportSchema } from "@/lib/ai/schemas";
import { CUSTOM_TYPE, isVerified, type FitItem, type RankedTargeting } from "@/lib/audience";
import { TargetingBoard } from "@/components/targeting-board";
import { buildBoardSections } from "@/lib/targeting-board";
import { copyTextOf, typeLabel } from "@/lib/targeting";
import { getT } from "@/i18n/server";
import type { MessageKey, T } from "@/i18n/translate";
import { CopyText } from "@/components/targeting/controls";
import { dateTime, money, num } from "@/lib/format";
import { requirePageClient } from "@/lib/access";

const GENDER: Record<string, MessageKey> = {
  all: "targeting.board.gender.all",
  female: "targeting.board.gender.female",
  male: "targeting.board.gender.male",
};

/** Catalogue strings mark **bold** parts; this turns them into <b> elements. */
const rich = (str: string) => str.split("**").map((part, i) => (i % 2 ? <b key={i}>{part}</b> : part));

function ScoreBar({ v, tone = "bg-indigo-500" }: { v: number | null; tone?: string }) {
  if (v == null) return <span className="text-slate-300">—</span>;
  return (
    <span className="flex items-center gap-1.5">
      <span className="h-1.5 w-12 overflow-hidden rounded-full bg-slate-100">
        <span className={`block h-full rounded-full ${tone}`} style={{ width: `${v}%` }} />
      </span>
      <span className="tabular-nums">{v}</span>
    </span>
  );
}

/** Predicted = fit score only; verified = has ads data, and once it reaches the minimum result count it is "Đã kiểm chứng" (Verified). */
function Verified({ t, tr }: { t: RankedTargeting; tr: T }) {
  if (t.perf == null)
    return (
      <span className="flex flex-col items-start gap-1">
        <Badge>{tr("targeting.audiencePage.predicted")}</Badge>
        {t.slot === "explore" && <Badge tone="violet">{tr("targeting.audiencePage.reserved")}</Badge>}
        {t.explore && <Badge tone="amber">{tr("targeting.audiencePage.exploreDir")}</Badge>}
      </span>
    );
  if (isVerified(t)) return <Badge tone="green">{tr("targeting.audiencePage.verified")}</Badge>;
  return <Badge tone="amber">{tr("targeting.audiencePage.verifying")}</Badge>;
}

/** Explains a row's Score: how much the fit, industry reference and performance parts each contribute. */
function scoreTip(t: RankedTargeting, tr: T) {
  const wI = t.industry ? 0.4 * (t.industry.confidence ?? 0) : 0;
  const priorScore = t.industry ? Math.round(Math.max(0, Math.min(100, 60 + 80 * (t.industry.index - 1)))) : null;
  const w = t.perf != null ? 0.75 * t.confidence : 0;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const parts: string[] = [];
  const baseShare = 1 - w;
  if (t.fit != null) parts.push(tr("targeting.audiencePage.tipFit", { v: t.fit, pct: pct(baseShare * (priorScore != null ? 1 - wI : 1)) }));
  if (priorScore != null) parts.push(tr("targeting.audiencePage.tipIndustry", { v: priorScore, pct: pct(baseShare * (t.fit != null ? wI : 1)) }));
  if (t.fit == null && priorScore == null && t.perf != null) parts.push(tr("targeting.audiencePage.tipMid", { pct: pct(baseShare) }));
  if (t.perf != null) parts.push(tr("targeting.audiencePage.tipPerf", { v: t.perf, pct: pct(w) }));
  return (
    <>
      {rich(tr("targeting.audiencePage.tipScore", { score: t.score, parts: parts.join(" + ") }))}
      <br />
      {t.perf == null
        ? tr("targeting.audiencePage.tipNoAds")
        : t.confidence >= 1
          ? tr("targeting.audiencePage.tipFull")
          : tr("targeting.audiencePage.tipPartial", { pct: pct(w), shared: t.sharedWith ? tr("targeting.audiencePage.tipShared") : "" })}
    </>
  );
}

function RankChange({ r, tr }: { r: RankedTargeting; tr: T }) {
  if (r.prevRank == null) return <span className="text-[11px] font-medium text-sky-600">{tr("targeting.audiencePage.rankNew")}</span>;
  const d = r.prevRank - r.rank;
  if (!d) return <span className="text-slate-300">=</span>;
  return <span className={`text-xs font-medium ${d > 0 ? "text-emerald-600" : "text-rose-600"}`}>{d > 0 ? `▲${d}` : `▼${-d}`}</span>;
}

export default async function AudiencePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ r?: string }> }) {
  await connection();
  const { id } = await params;
  const tr = await getT();
  await requirePageClient(id); // check access right on the page: the layout may not re-run on client-side navigation
  const { r } = await searchParams;
  const [client, analysis, rankings] = await Promise.all([
    db.client.findUniqueOrThrow({ where: { id } }),
    db.audienceAnalysis.findFirst({
      where: { clientId: id },
      orderBy: { createdAt: "desc" },
    }),
    db.targetingRanking.findMany({
      where: { clientId: id },
      orderBy: { createdAt: "desc" },
      take: 24,
      select: { id: true, label: true, stage: true, createdAt: true },
    }),
  ]);
  const rankingId = r && rankings.some((x) => x.id === r) ? r : rankings[0]?.id;
  const ranking = rankingId ? await db.targetingRanking.findUnique({ where: { id: rankingId } }) : null;
  const items: RankedTargeting[] = ranking ? JSON.parse(ranking.items) : [];
  // Vietnamese Ads Manager name + text to copy (verified to be found in Ads Manager).
  const libRows = new Map(
    (await db.targetingItem.findMany({ where: { key: { in: items.map((i) => i.key) } }, select: { key: true, name: true, nameVi: true, copyText: true, findable: true, status: true } })).map((t) => [t.key, t]),
  );
  const parsed = analysis ? AudienceReportSchema.safeParse(JSON.parse(analysis.report)) : null;
  const report = parsed?.success ? parsed.data : null;
  const stats = analysis ? JSON.parse(analysis.stats) : null;
  const cur = client.currency;

  const fits: FitItem[] = analysis ? JSON.parse(analysis.candidates) : [];
  const sections = report ? await buildBoardSections(report, fits, items) : [];

  const actions = (
    <div className="flex flex-wrap items-start gap-2">
      {analysis && (
        <ActionButton action={refreshRankingAction.bind(null, id)} pending={tr("targeting.audiencePage.rescoring")}>
          {tr("targeting.audiencePage.refresh")}
        </ActionButton>
      )}
      {analysis && (
        <a href={`/report/audience/${id}${rankingId ? `?r=${rankingId}` : ""}`} target="_blank" rel="noreferrer" className={btnClass("secondary")}>
          {tr("targeting.audiencePage.exportPdf")}
        </a>
      )}
      <ActionButton action={audienceAction.bind(null, id)} variant="primary" pending={tr("targeting.audiencePage.analyzing")}>
        ✦ {analysis ? tr("targeting.audiencePage.reanalyze") : tr("targeting.audiencePage.analyze")}
      </ActionButton>
    </div>
  );

  if (!analysis) {
    return (
      <Card title={tr("targeting.audiencePage.cardTitleEmpty")} action={actions}>
        <Empty>
          {tr("targeting.audiencePage.empty")}
          <br />
          {rich(tr("targeting.audiencePage.emptyHint"))}
        </Empty>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card
        title={
          <>
            {tr("targeting.audiencePage.cardTitle")} <span className="font-normal text-slate-400">· {dateTime(analysis.createdAt)}</span>
          </>
        }
        action={actions}
      >
        {report ? (
          <div className="space-y-4">
            <p className="text-sm whitespace-pre-line text-slate-700">{report.summary}</p>
            {report.bias_note && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                <b>{tr("targeting.audiencePage.bias")}</b> {report.bias_note}
              </p>
            )}
            {stats?.directions?.length > 0 && (
              <div className="rounded-lg border border-violet-200 bg-violet-50/60 px-3 py-2 text-xs text-slate-700">
                <p className="font-medium text-violet-800">{tr("targeting.audiencePage.directions")}</p>
                <ul className="mt-1 space-y-0.5">
                  {(stats.directions as { name: string; why: string; found: number }[]).map((d) => (
                    <li key={d.name}>
                      <b>{d.name}</b> <span className="text-slate-400">{tr("targeting.audiencePage.foundItems", { n: d.found })}</span> — {d.why}
                    </li>
                  ))}
                </ul>
                {stats.libraryScan > 0 && (
                  <p className="mt-1 text-slate-500">
                    {tr("targeting.audiencePage.libraryScan", { n: stats.libraryScan })}
                  </p>
                )}
              </div>
            )}
            {stats && (
              <p className="text-xs text-slate-500">
                {tr("targeting.audiencePage.basedOn", { conv: num(stats.conversations), adSets: num(stats.adSets), spend: money(stats.spend, cur), docs: num(stats.documents), model: analysis.model })}
              </p>
            )}
            <div className="grid gap-3 @3xl:grid-cols-2">
              {report.personas.map((p, i) => (
                <div key={i} className="space-y-2 rounded-xl border border-slate-200 p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="font-semibold text-slate-900">
                      {i + 1}. {p.name}
                    </p>
                    <span className="text-xs text-slate-500">{p.share}</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Badge tone="violet">{tr("targeting.audiencePage.ageYears", { range: p.age_range })}</Badge>
                    <Badge tone="violet">{GENDER[p.gender] ? tr(GENDER[p.gender]) : p.gender}</Badge>
                    {/* Locations are often long phrases: allow wrapping, don't overflow the card */}
                    <span className="inline-block max-w-full rounded-2xl bg-sky-50 px-2 py-0.5 text-xs font-medium break-words text-sky-700 ring-1 ring-sky-200">{p.locations}</span>
                  </div>
                  <p className="text-sm text-slate-700">{p.description}</p>
                  <dl className="grid gap-2 text-sm @xl:grid-cols-2">
                    <div>
                      <dt className="text-xs font-medium text-emerald-700">{tr("targeting.audiencePage.whyBuy")}</dt>
                      <dd>
                        <ul className="list-disc pl-4 text-slate-600">
                          {p.motivations.map((m, j) => (
                            <li key={j}>{m}</li>
                          ))}
                        </ul>
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs font-medium text-rose-700">{tr("targeting.audiencePage.hesitate")}</dt>
                      <dd>
                        <ul className="list-disc pl-4 text-slate-600">
                          {p.objections.map((m, j) => (
                            <li key={j}>{m}</li>
                          ))}
                        </ul>
                      </dd>
                    </div>
                  </dl>
                  <div className="rounded-lg bg-indigo-50/60 p-2.5 text-sm">
                    <p className="text-xs font-medium text-indigo-700">{tr("targeting.audiencePage.angles")}</p>
                    <ul className="list-disc pl-4 text-slate-700">
                      {p.message_angles.map((m, j) => (
                        <li key={j}>{m}</li>
                      ))}
                    </ul>
                  </div>
                  <p className="text-xs text-slate-500">
                    <b>{tr("targeting.audiencePage.evidence")}</b> {p.evidence}
                  </p>
                </div>
              ))}
            </div>
            <p className="text-sm text-slate-700">
              <b>{tr("targeting.audiencePage.demo")}</b> {tr("targeting.audiencePage.demoLine", { min: report.demographics.age_min, max: report.demographics.age_max, gender: GENDER[report.demographics.genders] ? tr(GENDER[report.demographics.genders]) : report.demographics.genders, note: report.demographics.note })}
            </p>
            {report.data_gaps.length > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                <p className="font-medium">{tr("targeting.audiencePage.dataGaps")}</p>
                <ul className="list-disc pl-5">
                  {report.data_gaps.map((g, i) => (
                    <li key={i}>{g}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-slate-500">{tr("targeting.audiencePage.unreadable")}</p>
        )}
      </Card>

      {sections.length > 0 && (
        <Card
          title={
            <>
              {tr("targeting.audiencePage.boardTitle")} <span className="font-normal text-slate-400">{tr("targeting.audiencePage.boardSub")}</span>
            </>
          }
        >
          <TargetingBoard sections={sections} />
        </Card>
      )}

      <Card
        title={
          <>
            {ranking?.stage === "with_ads" ? tr("targeting.audiencePage.topWithAds", { n: items.length }) : tr("targeting.audiencePage.topPredicted", { n: items.length })}
            {ranking && <span className="font-normal text-slate-400"> · {ranking.label}</span>}
          </>
        }
        action={
          rankings.length > 1 && (
            <div className="flex flex-wrap items-center gap-1 text-xs">
              <span className="text-slate-500">{tr("targeting.audiencePage.stage")}</span>
              {rankings.slice(0, 8).map((x) => (
                <Link
                  key={x.id}
                  href={`?r=${x.id}`}
                  scroll={false}
                  className={`rounded-full px-2 py-0.5 ${x.id === rankingId ? "bg-ink text-panel" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
                  title={x.label}
                >
                  {dateTime(x.createdAt)}
                  {x.stage === "with_ads" ? tr("targeting.audiencePage.stageAds") : ""}
                </Link>
              ))}
            </div>
          )
        }
      >
        {ranking?.stage !== "with_ads" && (
          <p className="mb-3 rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
            {rich(tr("targeting.audiencePage.noAdsNote"))}
          </p>
        )}
        <div className="mb-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-500">
          <span>
            {rich(tr("targeting.audiencePage.legend1"))}
          </span>
          <span>
            {tr("targeting.audiencePage.legend2", { bench: ranking?.benchmarkCpr ? money(ranking.benchmarkCpr, cur) : tr("targeting.audiencePage.benchStandard") })}
          </span>
          <span>{tr("targeting.audiencePage.legend3")}</span>
        </div>
        {!items.length ? (
          <Empty>{tr("targeting.audiencePage.noItems")}</Empty>
        ) : (
          <div className="-mx-5 -mb-5 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-3 py-2 text-right font-medium">
                    <Hint tip={tr("targeting.audiencePage.hRank")}>#</Hint>
                  </th>
                  <th className="px-2 py-2 font-medium">
                    <Hint tip={tr("targeting.audiencePage.hChange")}>±</Hint>
                  </th>
                  <th className="min-w-64 px-3 py-2 font-medium">
                    <Hint tip={rich(tr("targeting.audiencePage.hTarget"))}>{tr("targeting.audiencePage.colTarget")}</Hint>
                  </th>
                  <th className="px-3 py-2 font-medium">
                    <Hint tip={rich(tr("targeting.audiencePage.hScore"))}>{tr("targeting.audiencePage.colScore")}</Hint>
                  </th>
                  <th className="px-3 py-2 font-medium">
                    <Hint tip={rich(tr("targeting.audiencePage.hStatus", { min: client.minResults }))}>{tr("targeting.audiencePage.colStatus")}</Hint>
                  </th>
                  <th className="px-3 py-2 font-medium">
                    <Hint tip={rich(tr("targeting.audiencePage.hFit"))}>{tr("targeting.audiencePage.colFit")}</Hint>
                  </th>
                  <th className="px-3 py-2 font-medium">
                    <Hint tip={rich(tr("targeting.audiencePage.hPerf", { days: client.analysisDays, bench: ranking?.benchmarkCpr ? money(ranking.benchmarkCpr, cur) : tr("targeting.audiencePage.benchStandard"), cprKind: client.targetCpr ? tr("targeting.audiencePage.cprTarget") : client.autoTargetCpr ? tr("targeting.audiencePage.cprAuto") : tr("targeting.audiencePage.cprAvg") }))}>{tr("targeting.audiencePage.colPerf")}</Hint>
                  </th>
                  <th className="px-3 py-2 text-right font-medium whitespace-nowrap">
                    <Hint tip={tr("targeting.audiencePage.hAds")}>
                      {tr("targeting.audiencePage.colAds")}
                    </Hint>
                  </th>
                  <th className="min-w-72 px-3 py-2 font-medium">
                    <Hint tip={tr("targeting.audiencePage.hPersona")}>{tr("targeting.audiencePage.colPersona")}</Hint>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((t) => (
                  <tr key={t.key} className="align-top hover:bg-slate-50">
                    <td className="px-3 py-3 text-right font-semibold text-slate-900 tabular-nums">{t.rank}</td>
                    <td className="px-2 py-3">
                      <RankChange r={t} tr={tr} />
                    </td>
                    <td className="px-3 py-3">
                      <p className="font-medium text-slate-900">{libRows.get(t.key)?.nameVi || t.name}</p>
                      {(() => {
                        const l = libRows.get(t.key);
                        if (t.type === CUSTOM_TYPE) return null;
                        if (l?.findable === false || l?.status === "dead")
                          return <p className="text-[11px] font-medium text-rose-600">{tr("targeting.audiencePage.doNotUse", { why: l.status === "dead" ? tr("targeting.audiencePage.retired") : tr("targeting.audiencePage.notFound") })}</p>;
                        const c = copyTextOf({ name: l?.nameVi || t.name, copyText: l?.copyText });
                        return (
                          <p className="flex items-center gap-1.5 text-[11px] text-slate-500">
                            <span className={l?.findable ? "text-emerald-700" : ""}>{tr("targeting.audiencePage.copyLabel", { mark: l?.findable ? "✓" : "?" })}</span>
                            <code className="rounded bg-slate-100 px-1 text-slate-700">{c}</code>
                            <CopyText text={c} />
                          </p>
                        );
                      })()}
                      <p className="text-xs text-slate-500">
                        {t.type === CUSTOM_TYPE ? tr("targeting.type.custom") : typeLabel(tr, t.type)}
                        {t.size && tr("targeting.audiencePage.peopleVn", { size: t.size })}
                        {!t.id && t.type !== CUSTOM_TYPE && tr("targeting.audiencePage.notInCatalogue")}
                      </p>
                      {t.path && (
                        <p className="truncate text-[11px] text-slate-400" title={t.path}>
                          {t.path}
                        </p>
                      )}
                      {t.industry && (
                        <p
                          className={`mt-0.5 text-[11px] ${t.industry.index >= 1 ? "text-emerald-700" : "text-rose-600"}`}
                          title={tr("targeting.audiencePage.industryTip")}
                        >
                          {tr("targeting.audiencePage.industryLine", { sign: t.industry.index >= 1 ? "+" : "−", pct: Math.round(Math.abs(t.industry.index - 1) * 100), clients: t.industry.clients, results: num(t.industry.results) })}
                        </p>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      <Hint tip={scoreTip(t, tr)} className="no-underline">
                        <span
                          className={`inline-flex h-8 w-10 items-center justify-center rounded-lg text-sm font-bold tabular-nums ${t.score >= 75 ? "bg-emerald-50 text-emerald-700" : t.score >= 55 ? "bg-indigo-50 text-indigo-700" : "bg-slate-100 text-slate-600"}`}
                        >
                          {t.score}
                        </span>
                      </Hint>
                    </td>
                    <td className="px-3 py-3">
                      <Verified t={t} tr={tr} />
                    </td>
                    <td className="px-3 py-3">
                      <ScoreBar v={t.fit} />
                    </td>
                    <td className="px-3 py-3">
                      <ScoreBar v={t.perf} tone="bg-emerald-500" />
                      {t.perf != null && <p className="mt-0.5 text-[11px] text-slate-400">{tr("targeting.audiencePage.confidence", { pct: Math.round(t.confidence * 100) })}</p>}
                    </td>
                    <td className="px-3 py-3 text-right text-xs whitespace-nowrap text-slate-600 tabular-nums">
                      {t.spend ? (
                        <>
                          <div>{money(t.spend, cur)}</div>
                          <div>
                            {tr("targeting.audiencePage.results", { n: num(t.results) })}
                            {t.cpr != null && ` · ${money(t.cpr, cur)}`}
                          </div>
                          {t.leadScore != null && <div>{tr("targeting.audiencePage.leadScore", { n: t.leadScore })}</div>}
                          <div className="text-slate-400" title={t.adSets.join("\n")}>
                            {tr("targeting.audiencePage.adSetsCount", { n: t.adSets.length })}
                            {t.sharedWith ? tr("targeting.audiencePage.sharedWith", { n: t.sharedWith }) : ""}
                          </div>
                        </>
                      ) : (
                        <span className="text-slate-300">{tr("targeting.audiencePage.notRun")}</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-xs text-slate-600">
                      {t.persona && <p className="font-medium text-violet-700">{t.persona}</p>}
                      {t.reason}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
