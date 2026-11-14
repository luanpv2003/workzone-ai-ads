import Link from "next/link";
import { connection } from "next/server";
import { db } from "@/lib/db";
import { dateTime, money, stageLabels } from "@/lib/format";
import type { AccountAudit, ConversationAnalysis, CreativeAnalysis } from "@/lib/ai/schemas";
import type { CheckStatus, HealthReport } from "@/lib/health-checks";
import { byPriority, currentBudgets, toRecView } from "@/lib/recview";
import { RecommendationCard } from "@/components/recommendation-card";
import { Badge, Card, Empty, type Tone } from "@/components/ui";
import { requirePageClient } from "@/lib/access";
import { getT } from "@/i18n/server";
import type { T } from "@/i18n/translate";

const SEVERITY: Record<string, { tone: Tone }> = {
  critical: { tone: "red" },
  warning: { tone: "amber" },
  info: { tone: "blue" },
};
const AREAS = ["structure", "budget", "targeting", "creative", "tracking", "funnel", "messaging"];

function List({ items }: { items: string[] }) {
  if (!items.length) return <p className="text-sm text-slate-400">—</p>;
  return (
    <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
      {items.map((x, i) => <li key={i}>{x}</li>)}
    </ul>
  );
}

const CHECK_STATUS: Record<CheckStatus, { tone: Tone }> = {
  fail: { tone: "red" },
  unknown: { tone: "amber" },
  pass: { tone: "green" },
  na: { tone: "mut" },
};

function HealthCard({ h, t }: { h: HealthReport; t: T }) {
  const shown = h.checks.filter((c) => c.status !== "na");
  const na = h.checks.filter((c) => c.status === "na");
  return (
    <Card title={t("workflow.audits.healthTitle", { count: shown.length })} action={<span className="text-xs text-slate-500">{h.window}</span>}>
      <ul className="divide-y divide-line">
        {shown.map((c) => (
          <li key={c.key} className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2.5 first:pt-0">
            <div className="flex w-full items-center gap-2 @2xl:w-64 @2xl:shrink-0">
              <Badge tone={CHECK_STATUS[c.status].tone}>{t(`workflow.audits.checkStatus.${c.status}`)}</Badge>
              <span className="text-sm font-medium text-slate-900">{c.label}</span>
            </div>
            <p className="min-w-0 flex-1 text-sm text-slate-700">
              {c.detail} <span className="text-xs text-slate-400">· {t("workflow.audits.level")} {t(`workflow.audits.checkSeverity.${c.severity}`)}</span>
            </p>
          </li>
        ))}
      </ul>
      {na.length > 0 && <p className="mt-3 text-xs text-slate-400">{t("workflow.audits.notApplicable")}: {na.map((c) => c.label).join(", ")}.</p>}
      <p className="mt-3 text-xs text-slate-500">
        {t("workflow.audits.scoreNote")}
      </p>
    </Card>
  );
}

function AccountReport({ r, t }: { r: AccountAudit & { score?: number | null; health?: HealthReport }; t: T }) {
  const s = r.score ?? null;
  return (
    <div className="space-y-6">
      <Card>
        <div className="flex items-start gap-5">
          <div className="shrink-0 text-center">
            <div
              className={`grid size-20 place-items-center rounded-full text-2xl font-bold ${s == null ? "bg-slate-100 text-slate-400" : s >= 75 ? "bg-emerald-50 text-emerald-600" : s >= 50 ? "bg-amber-50 text-amber-600" : "bg-rose-50 text-rose-600"}`}
            >
              {s ?? "—"}
            </div>
            <div className="mt-1.5 max-w-20 text-[11px] leading-tight text-slate-500">
              {r.health ? t("workflow.audits.gradeCoverage", { grade: t(`workflow.audits.grade.${r.health.grade}`), coverage: r.health.coverage }) : t("workflow.audits.oldScore")}
            </div>
          </div>
          <div>
            <h3 className="font-semibold text-slate-900">{t("workflow.audits.summary")}</h3>
            <p className="mt-1 text-sm whitespace-pre-line text-slate-700">{r.summary}</p>
          </div>
        </div>
      </Card>
      {r.health && <HealthCard h={r.health} t={t} />}
      <div className="grid gap-6 @3xl:grid-cols-[1fr_2fr]">
        <Card title={t("workflow.audits.strengths")}><List items={r.strengths} /></Card>
        <Card title={t("workflow.audits.issues", { count: r.issues.length })}>
          <ul className="space-y-4">
            {r.issues.map((x, i) => (
              <li key={i}>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={SEVERITY[x.severity]?.tone}>{SEVERITY[x.severity] ? t(`workflow.audits.severity.${x.severity}` as "workflow.audits.severity.critical") : x.severity}</Badge>
                  <Badge>{AREAS.includes(x.area) ? t(`workflow.audits.area.${x.area}` as "workflow.audits.area.structure") : x.area}</Badge>
                  <span className="font-medium text-slate-900">{x.title}</span>
                </div>
                <p className="mt-1 text-sm text-slate-700">{x.detail}</p>
                <p className="mt-0.5 text-xs text-slate-500">{t("workflow.audits.evidence")}: {x.evidence}</p>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}

function ConversationReport({ r, t }: { r: ConversationAnalysis; t: T }) {
  const stages = r.conversations.reduce<Record<string, number>>((a, c) => ((a[c.stage] = (a[c.stage] ?? 0) + 1), a), {});
  const hot = r.conversations.filter((c) => c.lead_score >= 75).length;
  return (
    <div className="space-y-6">
      <Card>
        <h3 className="font-semibold text-slate-900">
          {t("workflow.audits.convSummary", { count: r.analyzed_count ?? r.conversations.length })}
          {r.analyzed_count && r.analyzed_count > r.conversations.length ? t("workflow.audits.convReadMore", { count: r.conversations.length }) : ""}
        </h3>
        <p className="mt-1 text-sm whitespace-pre-line text-slate-700">{r.summary}</p>
        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          <Badge tone="green">{t("workflow.audits.hotLeads", { count: hot })}</Badge>
          {Object.entries(stages).map(([k, v]) => <Badge key={k}>{stageLabels(t)[k] ?? k}: {v}</Badge>)}
        </div>
      </Card>
      <div className="grid gap-6 @3xl:grid-cols-2">
        <Card title={t("workflow.audits.topQuestions")}>
          <ul className="space-y-3 text-sm">
            {r.top_questions.map((q, i) => (
              <li key={i}>
                <div className="font-medium text-slate-900">{q.question} <span className="text-xs font-normal text-slate-400">×{q.count}</span></div>
                <div className="text-slate-600">→ {q.suggested_answer}</div>
              </li>
            ))}
          </ul>
        </Card>
        <Card title={t("workflow.audits.objections")}>
          <ul className="space-y-3 text-sm">
            {r.objections.map((o, i) => (
              <li key={i}>
                <div className="font-medium text-slate-900">{o.objection} <span className="text-xs font-normal text-slate-400">×{o.count}</span></div>
                <div className="text-slate-600">→ {o.how_to_handle}</div>
              </li>
            ))}
          </ul>
        </Card>
        <Card title={t("workflow.audits.personas")}>
          <ul className="space-y-4 text-sm">
            {r.personas.map((p, i) => (
              <li key={i}>
                <div className="font-medium text-slate-900">{p.name}</div>
                <p className="text-slate-700">{p.description}</p>
                <p className="mt-1 text-xs text-slate-500">{t("workflow.audits.painPoints")}: {p.pain_points.join("; ")}</p>
                <p className="mt-1 text-xs text-indigo-700">🎯 {p.targeting_hint}</p>
              </li>
            ))}
          </ul>
        </Card>
        <div className="space-y-6">
          <Card title={t("workflow.audits.buyingSignals")}><List items={r.buying_signals} /></Card>
          <Card title={t("workflow.audits.serviceIssues")}><List items={r.service_issues} /></Card>
        </div>
      </div>
      <Card title={t("workflow.audits.contentIdeas")}>
        <div className="grid gap-4 @2xl:grid-cols-2">
          {r.content_ideas.map((c, i) => (
            <div key={i} className="rounded-lg border border-slate-200 p-3 text-sm">
              <div className="text-xs font-semibold text-violet-700 uppercase">{c.angle}</div>
              <div className="mt-1 font-medium text-slate-900">{c.hook}</div>
              <p className="mt-1 whitespace-pre-line text-slate-600">{c.primary_text}</p>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

type CreativeAd = { adId: string; adName: string; tag: string; format: string | null; headline: string; imageUrl: string | null; spend: number; results: number; impressions: number; clicks: number; plays3s: number; thruplays: number };

function CreativeReport({ r, currency, t }: { r: CreativeAnalysis & { ads: CreativeAd[]; ref: number; days: number }; currency: string; t: T }) {
  const note = new Map(r.per_ad.map((x) => [x.ad_id, x]));
  const Ad = ({ a }: { a: CreativeAd }) => (
    <div className="flex gap-3 rounded-lg border border-slate-200 p-3">
      {a.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={a.imageUrl} alt="" className="size-20 shrink-0 rounded-md bg-slate-100 object-cover" />
      ) : (
        <div className="grid size-20 shrink-0 place-items-center rounded-md bg-slate-100 text-xs text-slate-400">{a.format ?? "?"}</div>
      )}
      <div className="min-w-0 text-sm">
        <p className="truncate font-medium text-slate-900" title={a.adName}>{a.adName}</p>
        <p className="text-xs text-slate-500 tabular-nums">
          {money(a.spend, currency)} · {t("workflow.audits.resultsShort", { count: a.results })} · CPR {a.results ? money(a.spend / a.results, currency) : "—"} · CTR {a.impressions ? ((a.clicks / a.impressions) * 100).toFixed(2) : 0}%
          {a.plays3s > 0 && ` · ${t("workflow.audits.view3s", { pct: ((a.plays3s / a.impressions) * 100).toFixed(1) })} · ${t("workflow.audits.viewFull", { pct: ((a.thruplays / a.plays3s) * 100).toFixed(1) })}`}
        </p>
        {note.get(a.adId) && <p className="mt-1 text-xs text-slate-700">{note.get(a.adId)!.verdict}</p>}
        {note.get(a.adId)?.fix && <p className="text-xs text-amber-700">{t("workflow.audits.fix")}: {note.get(a.adId)!.fix}</p>}
      </div>
    </div>
  );
  return (
    <div className="space-y-6">
      <Card title={t("workflow.audits.creativeTitle", { days: r.days })}>
        <p className="text-sm whitespace-pre-line text-slate-700">{r.summary}</p>
        <p className="mt-2 text-xs text-slate-500">{t("workflow.audits.creativeRef", { value: money(r.ref, currency) })}</p>
      </Card>
      <div className="grid gap-4 @3xl:grid-cols-2">
        <Card title={t("workflow.audits.winningAds")}>
          <div className="space-y-2">{r.ads.filter((a) => a.tag === "THẮNG").map((a) => <Ad key={a.adId} a={a} />)}</div>
          <ul className="mt-3 space-y-1 text-sm">
            {r.winning_patterns.map((p, i) => (
              <li key={i}>
                <b className="text-emerald-700">{p.pattern}</b> <span className="text-xs text-slate-500">({p.evidence})</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card title={t("workflow.audits.losingAds")}>
          <div className="space-y-2">{r.ads.filter((a) => a.tag === "THUA").map((a) => <Ad key={a.adId} a={a} />)}</div>
          <ul className="mt-3 space-y-1 text-sm">
            {r.losing_patterns.map((p, i) => (
              <li key={i}>
                <b className="text-rose-700">{p.pattern}</b> <span className="text-xs text-slate-500">({p.evidence})</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
      {r.video_notes && (
        <Card title={t("workflow.audits.video")}>
          <p className="text-sm text-slate-700">{r.video_notes}</p>
        </Card>
      )}
      <Card title={t("workflow.audits.newAds", { count: r.new_ads.length })}>
        <div className="grid gap-3 @3xl:grid-cols-2">
          {r.new_ads.map((n, i) => (
            <div key={i} className="space-y-1.5 rounded-lg border border-slate-200 p-3 text-sm">
              <p className="font-medium text-slate-900">
                {n.angle} <span className="text-xs font-normal text-slate-500">· {n.format === "video" ? t("workflow.audits.formatVideo") : n.format === "carousel" ? t("workflow.audits.formatCarousel") : t("workflow.audits.formatImage")}</span>
              </p>
              <p className="text-xs text-slate-500">{t("workflow.audits.visual")}: {n.visual_brief}</p>
              <p className="whitespace-pre-line text-slate-700">{n.primary_text}</p>
              <p className="text-xs text-slate-600">
                <b>{n.headline}</b>
                {n.description && ` · ${n.description}`}
              </p>
              <p className="text-[11px] text-slate-400">{t("workflow.audits.basedOn")}: {n.based_on}</p>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-slate-500">{t("workflow.audits.useTemplate")}</p>
      </Card>
      {r.tests.length > 0 && (
        <Card title={t("workflow.audits.tests")}>
          <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
            {r.tests.map((x, i) => (
              <li key={i}>
                <b>{x.hypothesis}</b> · {x.how}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

export default async function AuditsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ a?: string }> }) {
  await connection();
  const t = await getT();
  const { id } = await params;
  await requirePageClient(id); // check access right on the page: the layout may not re-run on client-side navigation
  const { a } = await searchParams;
  const [client, audits] = await Promise.all([
    db.client.findUniqueOrThrow({ where: { id } }),
    db.audit.findMany({ where: { clientId: id }, orderBy: { createdAt: "desc" }, select: { id: true, kind: true, score: true, createdAt: true } }),
  ]);
  const selectedId = a ?? audits[0]?.id;
  const audit = selectedId
    ? await db.audit.findFirst({ where: { id: selectedId, clientId: id }, include: { recommendations: { include: { audit: { select: { kind: true } } } } } })
    : null;
  const recs = audit ? [...audit.recommendations].sort(byPriority) : [];
  const budgets = await currentBudgets(recs);

  return (
    <div className="grid gap-6 @2xl:grid-cols-[200px_minmax(0,1fr)]">
      <Card title={t("workflow.audits.history")} className="@2xl:self-start">
        {!audits.length ? (
          <p className="text-sm text-slate-500">{t("workflow.audits.noReports")}</p>
        ) : (
          <ul className="-mx-2 space-y-0.5">
            {audits.map((x) => (
              <li key={x.id}>
                <Link href={`?a=${x.id}`} className={`block rounded-md px-2 py-1.5 text-sm ${x.id === selectedId ? "bg-indigo-50 text-indigo-700" : "text-slate-600 hover:bg-slate-50"}`}>
                  <div className="font-medium">{x.kind === "account" ? t("workflow.audits.accountAudit") + (x.score != null ? ` · ${x.score}` : "") : x.kind === "creative" ? t("workflow.audits.creativeAds") : t("workflow.audits.messageAnalysis")}</div>
                  <div className="text-xs text-slate-400">{dateTime(x.createdAt)}</div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {!audit ? (
        <Empty>{t("workflow.audits.emptyAll")}</Empty>
      ) : (
        <div className="@container min-w-0 space-y-6">
          <p className="text-xs text-slate-400">
            {dateTime(audit.createdAt)} · {audit.model} · {t("workflow.audits.tokens", { input: audit.inputTokens.toLocaleString("vi-VN"), output: audit.outputTokens.toLocaleString("vi-VN") })}
          </p>
          {audit.kind === "account" ? (
            <AccountReport r={JSON.parse(audit.report)} t={t} />
          ) : audit.kind === "creative" ? (
            <CreativeReport r={JSON.parse(audit.report)} currency={client.currency} t={t} />
          ) : (
            <ConversationReport r={JSON.parse(audit.report)} t={t} />
          )}
          <div>
            <h2 className="mb-3 text-sm font-semibold text-slate-800">{t("workflow.audits.recommendations", { count: recs.length })}</h2>
            <div className="space-y-3">
              {recs.map((r) => (
                <RecommendationCard key={r.id} rec={toRecView(r)} currency={client.currency} currentBudget={r.targetId ? budgets.get(r.targetId) : null} />
              ))}
              {!recs.length && <Empty>{t("workflow.audits.noRecs")}</Empty>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
