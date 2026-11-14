import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { db } from "@/lib/db";
import { requirePageClient } from "@/lib/access";
import { AudienceReportSchema } from "@/lib/ai/schemas";
import { CUSTOM_TYPE, isVerified, type FitItem, type RankedTargeting } from "@/lib/audience";
import { buildBoardSections, samePersona } from "@/lib/targeting-board";
import type { BoardItem, BoardSection } from "@/components/targeting-board";
import { typeLabel as targetingTypeLabel } from "@/lib/targeting";
import { dateOnly, money, num, resultLabels } from "@/lib/format";
import { PrintButton } from "@/components/print-button";
import { BRAND } from "@/lib/brand";
import type { T } from "@/i18n/translate";
import { getT } from "@/i18n/server";

// Customer persona + targeting report to send to the client (print / save PDF from the browser), laid out like the Persona page on the web.
// Contains no personal information of the people who messaged.

export async function generateMetadata() {
  return { title: (await getT())("notify.audienceReport.title") };
}

const genderLabel = (g: string, t: T) => (g === "all" || g === "female" || g === "male" ? t(`notify.audienceReport.gender.${g}`) : g);
const typeLabel = (k: string, t: T) => (k === CUSTOM_TYPE ? t("notify.audienceReport.customType") : targetingTypeLabel(t, k));

/** Section heading in the web targeting-table style: number label + title + bold rule. */
function SectionHead({ num: n, title, meta, muted }: { num: string; title: string; meta?: string; muted?: boolean }) {
  return (
    <header className="flex items-baseline gap-3 border-b-2 border-slate-900 pb-1.5">
      <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] tracking-wider text-white ${muted ? "bg-slate-400" : "bg-indigo-600"}`}>{n}</span>
      <h2 className="text-[17px] font-semibold tracking-tight text-slate-900">{title}</h2>
      {meta && <span className="ml-auto font-mono text-[11px] text-slate-500 tabular-nums">{meta}</span>}
    </header>
  );
}

const Chip = ({ children, tone = "violet" }: { children: ReactNode; tone?: "violet" | "sky" }) => (
  <span className={`inline-block rounded-full px-2.5 py-0.5 text-[11px] font-medium ring-1 ${tone === "sky" ? "bg-sky-50 text-sky-700 ring-sky-200" : "bg-violet-50 text-violet-800 ring-violet-100"}`}>{children}</span>
);

function chipClass(i: BoardItem) {
  if (i.dead) return "bg-slate-50 text-slate-400 line-through";
  const s = i.score ?? 0;
  if (s >= 75) return "bg-emerald-50 text-emerald-900 ring-1 ring-emerald-200";
  if (s >= 55) return "bg-indigo-50 text-indigo-900 ring-1 ring-indigo-100";
  return "bg-slate-100 text-slate-700";
}

/** Targeting cards by group (static version of TargetingBoard). */
function BoardCards({ section }: { section: BoardSection }) {
  if (!section.cards.length) return null;
  return (
    <div className="mt-3 grid grid-cols-2 gap-2.5">
      {section.cards.map((c) => (
        <div key={c.title} className="break-inside-avoid rounded-xl border border-slate-200 bg-panel p-3">
          <div className="mb-2 flex items-baseline gap-2">
            <b className="flex-1 text-[12.5px] font-semibold text-slate-900">{c.title}</b>
            <i className="font-mono text-[10px] text-slate-400 not-italic">{c.items.length}</i>
          </div>
          <div className="flex flex-wrap gap-1">
            {c.items.map((i) => (
              <span key={i.key} className={`rounded-md px-1.5 py-0.5 text-[11px] leading-tight ${chipClass(i)}`}>
                {i.rank && i.rank <= 20 && <span className="mr-1 font-mono text-[9px] text-slate-400">#{i.rank}</span>}
                {i.name}
                {i.verified && <span className="ml-1 text-emerald-600">✓</span>}
                {i.spend > 0 && !i.verified && <span className="ml-1 text-amber-600">◔</span>}
                {i.size && <em className="ml-1 font-mono text-[9.5px] text-slate-400 not-italic tabular-nums">{i.size}</em>}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function Bar({ v, tone }: { v: number | null; tone: string }) {
  if (v == null) return <span className="text-slate-300">—</span>;
  return (
    <span className="flex items-center gap-1">
      <span className="h-1.5 w-9 overflow-hidden rounded-full bg-slate-100">
        <span className={`block h-full rounded-full ${tone}`} style={{ width: `${v}%` }} />
      </span>
      <span className="tabular-nums">{v}</span>
    </span>
  );
}

function Status({ item, tr }: { item: RankedTargeting; tr: T }) {
  const [label, cls] = item.perf == null ? [tr("notify.audienceReport.status.predicted"), "bg-slate-100 text-slate-600"] : isVerified(item) ? [tr("notify.audienceReport.status.verified"), "bg-emerald-50 text-emerald-700"] : [tr("notify.audienceReport.status.verifying"), "bg-amber-50 text-amber-700"];
  return <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium whitespace-nowrap ${cls}`}>{label}</span>;
}

const Legend = ({ t }: { t: T }) => (
  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10.5px] text-slate-500">
    <span className="flex items-center gap-1"><i className="size-2.5 rounded-sm bg-emerald-300" />{t("notify.audienceReport.legend.veryFit")}</span>
    <span className="flex items-center gap-1"><i className="size-2.5 rounded-sm bg-indigo-200" />{t("notify.audienceReport.legend.fit")}</span>
    <span className="flex items-center gap-1"><i className="size-2.5 rounded-sm bg-slate-300" />{t("notify.audienceReport.legend.tryIt")}</span>
    <span><span className="text-emerald-600">✓</span> {t("notify.audienceReport.legend.verified")}</span>
    <span><span className="text-amber-600">◔</span> {t("notify.audienceReport.legend.partial")}</span>
    <span className="font-mono">{t("notify.audienceReport.legend.rank")}</span>
  </div>
);

export default async function AudienceReport({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ r?: string; print?: string }> }) {
  await connection();
  const t = await getT();
  const { id } = await params;
  await requirePageClient(id); // id is the client id
  const { r, print } = await searchParams;
  const [client, analysis] = await Promise.all([
    db.client.findUnique({ where: { id } }),
    db.audienceAnalysis.findFirst({ where: { clientId: id }, orderBy: { createdAt: "desc" } }),
  ]);
  if (!client || !analysis) notFound();
  const ranking = r
    ? await db.targetingRanking.findFirst({ where: { id: r, clientId: id } })
    : await db.targetingRanking.findFirst({ where: { clientId: id }, orderBy: { createdAt: "desc" } });
  const parsed = AudienceReportSchema.safeParse(JSON.parse(analysis.report));
  if (!parsed.success) notFound();
  const report = parsed.data;
  const stats = JSON.parse(analysis.stats) as { conversations?: number; adSets?: number; spend?: number; documents?: number };
  const items: RankedTargeting[] = ranking ? JSON.parse(ranking.items) : [];
  const fits: FitItem[] = JSON.parse(analysis.candidates);
  const cur = client.currency;
  const hasAds = items.some((i) => i.spend > 0);
  const sections = await buildBoardSections(report, fits, items);
  const personaSection = (idx: number) => sections.find((s) => s.id === `p${idx}`);
  const extra = sections.filter((s) => s.id === "explore" || s.id === "rest" || s.id === "ads");
  const verified = items.filter(isVerified).length;
  let n = 0;
  const next = () => String(++n).padStart(2, "0");

  const kpis: [string, string][] = [
    [t("notify.audienceReport.kpi.conversations"), num(stats.conversations ?? 0)],
    [t("notify.audienceReport.kpi.adSets"), num(stats.adSets ?? 0)],
    [t("notify.audienceReport.kpi.spend"), stats.spend ? money(stats.spend, cur) : "—"],
    [t("notify.audienceReport.kpi.docs"), num(stats.documents ?? 0)],
    [t("notify.audienceReport.kpi.personas"), String(report.personas.length)],
    [t("notify.audienceReport.kpi.targeting"), items.length ? `${items.length}${verified ? ` · ${verified} ✓` : ""}` : String(fits.length)],
  ];

  return (
    <div data-theme="light" className="min-h-full bg-slate-100 text-ink print:bg-panel" style={{ printColorAdjust: "exact", WebkitPrintColorAdjust: "exact" }}>
      <style>{`
        @page { size: A4; margin: 12mm 11mm 14mm; @bottom-right { content: "${t("notify.print.page")} " counter(page) " / " counter(pages); font: 9px Inter, sans-serif; color: #94a3b8; } @bottom-left { content: "${BRAND.agency.replace(/["\\]/g, "")} · ${client.name.replace(/["\\]/g, "")}"; font: 9px Inter, sans-serif; color: #94a3b8; } }
        @media print { .sheet { box-shadow: none !important; } }
      `}</style>
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-slate-200 bg-panel px-6 py-3 print:hidden">
        <p className="text-sm text-slate-600">
          {t("notify.print.a")}<b>{t("notify.print.b")}</b>{t("notify.print.c")}<b>{t("notify.print.d")}</b>{t("notify.print.e")}<b>{t("notify.print.f")}</b>{t("notify.print.g")}
        </p>
        <PrintButton auto={print !== "0"} />
      </div>

      <main className="sheet mx-auto my-6 max-w-[210mm] space-y-7 bg-panel px-9 py-9 text-[12.5px] leading-relaxed text-slate-700 shadow-sm print:m-0 print:max-w-none print:p-0">
        {/* Cover */}
        <header className="overflow-hidden rounded-2xl bg-gradient-to-br from-indigo-700 via-indigo-600 to-violet-600 p-6 text-white">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <span className="grid size-7 place-items-center rounded-lg bg-white/15 text-[11px] font-bold ring-1 ring-white/30">{BRAND.agency.slice(0, 2).toUpperCase()}</span>
              <span className="text-sm font-semibold">{BRAND.agency}</span>
            </div>
            {BRAND.site && <span className="text-[11px] text-indigo-100">{BRAND.site}</span>}
          </div>
          <p className="mt-6 text-[11px] font-semibold tracking-[0.18em] text-indigo-100 uppercase">{t("notify.audienceReport.cover")}</p>
          <h1 className="mt-1 text-[28px] leading-tight font-bold">{client.name}</h1>
          <p className="mt-1.5 text-[12px] text-indigo-100">
            {t("notify.audienceReport.coverMeta", { industry: client.industry, result: resultLabels(t)[client.primaryResult] ?? client.primaryResult, date: dateOnly(analysis.createdAt) })}
          </p>
        </header>

        <div className="grid grid-cols-3 gap-2.5">
          {kpis.map(([label, value]) => (
            <div key={label} className="rounded-xl border border-slate-200 px-3.5 py-2.5">
              <p className="text-[10.5px] text-slate-500">{label}</p>
              <p className="mt-0.5 text-[17px] font-semibold text-slate-900 tabular-nums">{value}</p>
            </div>
          ))}
        </div>

        {/* Summary */}
        <section className="space-y-3">
          <SectionHead num={next()} title={t("notify.audienceReport.summary")} />
          <p className="whitespace-pre-line text-[13px] text-slate-700">{report.summary}</p>
          <div className="flex flex-wrap items-center gap-1.5 rounded-xl bg-slate-50 px-3.5 py-2.5">
            <span className="mr-1 text-[11px] font-semibold text-slate-600">{t("notify.audienceReport.demo")}</span>
            <Chip>{t("notify.audienceReport.ageRange", { min: report.demographics.age_min, max: report.demographics.age_max })}</Chip>
            <Chip>{genderLabel(report.demographics.genders, t)}</Chip>
            {report.demographics.note && <span className="w-full pt-1 text-[11.5px] text-slate-600">{report.demographics.note}</span>}
          </div>
        </section>

        {/* Persona + targeting per persona */}
        {report.personas.map((p, i) => {
          const sec = personaSection(i);
          const count = fits.filter((f) => samePersona(f.persona, p.name)).length;
          return (
            <section key={i} className={`space-y-3 ${i === 0 ? "break-before-page" : ""}`}>
              <SectionHead num={next()} title={t("notify.audienceReport.persona", { n: i + 1, name: p.name })} meta={count ? t("notify.audienceReport.itemsN", { n: count }) : undefined} />
              <div className="break-inside-avoid space-y-2.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Chip>{t("notify.audienceReport.ageText", { range: p.age_range })}</Chip>
                  <Chip>{genderLabel(p.gender, t)}</Chip>
                  <Chip tone="sky">{p.locations}</Chip>
                  {p.share && <span className="ml-auto text-[11px] font-medium text-indigo-700">{p.share}</span>}
                </div>
                <p className="text-[13px] text-slate-700">{p.description}</p>
                <div className="grid grid-cols-2 gap-2.5">
                  <div className="rounded-xl border border-emerald-100 bg-emerald-50/50 p-3">
                    <p className="text-[10.5px] font-semibold tracking-wide text-emerald-700 uppercase">{t("notify.audienceReport.why")}</p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-4 text-slate-700">
                      {p.motivations.map((m, j) => (
                        <li key={j}>{m}</li>
                      ))}
                    </ul>
                  </div>
                  <div className="rounded-xl border border-rose-100 bg-rose-50/50 p-3">
                    <p className="text-[10.5px] font-semibold tracking-wide text-rose-700 uppercase">{t("notify.audienceReport.hesitate")}</p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-4 text-slate-700">
                      {p.objections.map((m, j) => (
                        <li key={j}>{m}</li>
                      ))}
                    </ul>
                  </div>
                </div>
                <div className="rounded-lg border-l-2 border-indigo-400 bg-indigo-50/60 px-3 py-2">
                  <p className="text-[10.5px] font-semibold tracking-wide text-indigo-700 uppercase">{t("notify.audienceReport.angles")}</p>
                  <ul className="mt-1 space-y-0.5">
                    {p.message_angles.map((a, j) => (
                      <li key={j}>· {a}</li>
                    ))}
                  </ul>
                </div>
                <p className="text-[11px] text-slate-500">
                  <b className="text-slate-600">{t("notify.audienceReport.evidence")}</b> {p.evidence}
                </p>
              </div>
              {sec && <BoardCards section={sec} />}
            </section>
          );
        })}

        {extra.map((s) => (
          <section key={s.id} className="space-y-2">
            <SectionHead num={next()} title={s.title} meta={s.meta} muted />
            {s.sub && <p className="text-[12px] text-slate-600">{s.sub}</p>}
            <BoardCards section={s} />
          </section>
        ))}
        {sections.length > 0 && <Legend t={t} />}

        {/* Ranking table */}
        {items.length > 0 && (
          <section className="break-before-page space-y-3">
            <SectionHead num={next()} title={t("notify.audienceReport.top", { n: items.length })} meta={ranking?.stage === "with_ads" ? t("notify.audienceReport.stageAds") : t("notify.audienceReport.stagePred")} />
            <div className="grid grid-cols-3 gap-2.5 text-[11px]">
              <div className="rounded-xl bg-slate-50 p-3">
                <p className="font-semibold text-indigo-700">{t("notify.audienceReport.fitTitle")}</p>
                <p className="mt-0.5 text-slate-600">{t("notify.audienceReport.fitDesc")}</p>
              </div>
              <div className="rounded-xl bg-slate-50 p-3">
                <p className="font-semibold text-emerald-700">{t("notify.audienceReport.perfTitle")}</p>
                <p className="mt-0.5 text-slate-600">{t("notify.audienceReport.perfDesc", { bench: ranking?.benchmarkCpr ? money(ranking.benchmarkCpr, cur) : t("notify.audienceReport.benchDefault"), days: client.analysisDays })}</p>
              </div>
              <div className="rounded-xl bg-slate-50 p-3">
                <p className="font-semibold text-slate-800">{t("notify.audienceReport.scoreTitle")}</p>
                <p className="mt-0.5 text-slate-600">{t("notify.audienceReport.scoreDesc", { min: client.minResults })}</p>
              </div>
            </div>
            <table className="w-full border-separate border-spacing-0 overflow-hidden rounded-xl border border-slate-200 text-[11px]">
              <thead className="bg-slate-50 text-left text-[10px] text-slate-500 uppercase">
                <tr>
                  <th className="px-2 py-2 text-right font-medium">#</th>
                  <th className="px-2 py-2 font-medium">{t("notify.audienceReport.th.targeting")}</th>
                  <th className="px-2 py-2 font-medium">{t("notify.audienceReport.th.score")}</th>
                  <th className="px-2 py-2 font-medium">{t("notify.audienceReport.th.fitPerf")}</th>
                  {hasAds && <th className="px-2 py-2 text-right font-medium whitespace-nowrap">{t("notify.audienceReport.th.adsData")}</th>}
                  <th className="px-2 py-2 font-medium">{t("notify.audienceReport.th.personaReason")}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => (
                  <tr key={it.key} className="break-inside-avoid align-top [&>td]:border-t [&>td]:border-slate-100">
                    <td className="px-2 py-2 text-right font-semibold text-slate-900 tabular-nums">{it.rank}</td>
                    <td className="px-2 py-2">
                      <p className="font-medium text-slate-900">{it.name}</p>
                      <p className="text-[10px] text-slate-500">
                        {typeLabel(it.type, t)}
                        {it.size && ` · ${it.size}`}
                      </p>
                      <div className="mt-1">
                        <Status item={it} tr={t} />
                      </div>
                    </td>
                    <td className="px-2 py-2">
                      <span
                        className={`inline-flex h-7 w-9 items-center justify-center rounded-lg text-[12px] font-bold tabular-nums ${it.score >= 75 ? "bg-emerald-50 text-emerald-700" : it.score >= 55 ? "bg-indigo-50 text-indigo-700" : "bg-slate-100 text-slate-600"}`}
                      >
                        {it.score}
                      </span>
                    </td>
                    <td className="space-y-1 px-2 py-2 whitespace-nowrap">
                      <Bar v={it.fit} tone="bg-indigo-500" />
                      <Bar v={it.perf} tone="bg-emerald-500" />
                    </td>
                    {hasAds && (
                      <td className="px-2 py-2 text-right whitespace-nowrap text-slate-600 tabular-nums">
                        {it.spend ? (
                          <>
                            <div>{money(it.spend, cur)}</div>
                            <div>
                              {num(it.results)} {t("notify.audienceReport.results")}{it.cpr != null && ` · ${money(it.cpr, cur)}`}
                            </div>
                          </>
                        ) : (
                          <span className="text-slate-300">{t("notify.audienceReport.notRun")}</span>
                        )}
                      </td>
                    )}
                    <td className="px-2 py-2 text-slate-600">
                      {it.persona && <p className="font-medium text-violet-700">{it.persona}</p>}
                      {it.reason}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {report.data_gaps.length > 0 && (
          <section className="break-inside-avoid space-y-2">
            <SectionHead num={next()} title={t("notify.audienceReport.gaps")} muted />
            <ul className="list-disc space-y-0.5 pl-5">
              {report.data_gaps.map((g, i) => (
                <li key={i}>{g}</li>
              ))}
            </ul>
          </section>
        )}

        <footer className="border-t border-slate-200 pt-3 text-[10.5px] text-slate-400">
          {t("notify.audienceReport.footer", { name: client.name })}
        </footer>
      </main>
    </div>
  );
}
