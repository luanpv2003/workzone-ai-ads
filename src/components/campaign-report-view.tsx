import Link from "next/link";
import type { ReactNode } from "react";
import { change, cprOf, type CampaignReport, type CampaignRow, type Diagnosis, type Indicator, type Row, type SegmentRow, type Tone } from "@/lib/campaign-report";
import { dateOnly, dateTime, money, num, resultLabels, statusLabels } from "@/lib/format";
import { getT } from "@/i18n/server";
import type { T } from "@/i18n/translate";

// Full campaign evaluation report: shared by the web page (Campaign report tab) and the PDF print version.

const TONE: Record<Tone, string> = {
  good: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  warn: "bg-amber-50 text-amber-700 ring-amber-200",
  bad: "bg-rose-50 text-rose-700 ring-rose-200",
  info: "bg-slate-100 text-slate-600 ring-slate-200",
};
const DOT: Record<Tone, string> = { good: "bg-emerald-500", warn: "bg-amber-500", bad: "bg-rose-500", info: "bg-slate-400" };
const STATUS_OVERRIDES = ["CAMPAIGN_PAUSED", "ADSET_PAUSED", "WITH_ISSUES", "IN_PROCESS", "DISAPPROVED", "PENDING_REVIEW"] as const;
const statusLabel = (s: string, t: T) => ((STATUS_OVERRIDES as readonly string[]).includes(s) ? t(`notify.campaignView.status.${s as (typeof STATUS_OVERRIDES)[number]}`) : (statusLabels(t)[s] ?? s));
const ymd = (s: string) => s.split("-").reverse().join("/");

function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ring-1 ${TONE[tone]}`}>{children}</span>;
}

/** Change vs. the previous period; lowerIsBetter for CPR / CPM. */
function Delta({ now, prev, lowerIsBetter }: { now: number | null; prev: number | null; lowerIsBetter?: boolean }) {
  const c = change(now, prev);
  if (c == null || !Number.isFinite(c)) return null;
  const good = lowerIsBetter ? c < 0 : c > 0;
  const flat = Math.abs(c) < 0.03;
  return (
    <span className={`text-[11px] font-medium whitespace-nowrap tabular-nums ${flat ? "text-slate-400" : good ? "text-emerald-600" : "text-rose-600"}`}>
      {c >= 0 ? "▲" : "▼"} {Math.round(Math.abs(c) * 100)}%
    </span>
  );
}

function Head({ n, title, meta }: { n: string; title: string; meta?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-baseline gap-3 border-b-2 border-slate-900 pb-1.5">
      <span className="rounded bg-indigo-600 px-1.5 py-0.5 font-mono text-[10px] tracking-wider text-white">{n}</span>
      <h2 className="text-[17px] font-semibold tracking-tight text-slate-900">{title}</h2>
      {meta && <span className="ml-auto text-[11px] text-slate-500">{meta}</span>}
    </header>
  );
}

function Kpi({ label, value, delta, hint }: { label: string; value: string; delta?: ReactNode; hint?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-panel px-3.5 py-2.5">
      <p className="text-[10.5px] text-slate-500">{label}</p>
      <p className="mt-0.5 flex items-baseline gap-2">
        <span className="text-[18px] font-semibold text-slate-900 tabular-nums">{value}</span>
        {delta}
      </p>
      {hint && <p className="text-[10px] text-slate-400">{hint}</p>}
    </div>
  );
}

/** Bar chart of spend + line of results per day, or per month when viewing all time (static SVG, prints to PDF unchanged). */
function DailySvg({ data, cur, label, monthly = false, t }: { data: CampaignReport["daily"]; cur: string; label: string; monthly?: boolean; t: T }) {
  const unit = monthly ? t("notify.campaignView.month") : t("notify.campaignView.day");
  if (data.length < 2) return null;
  const W = 720;
  const H = 170;
  const P = { l: 8, r: 8, t: 12, b: 22 };
  const maxS = Math.max(...data.map((d) => d.spend), 1);
  const maxR = Math.max(...data.map((d) => d.results), 1);
  const bw = (W - P.l - P.r) / data.length;
  const y = (v: number, max: number) => P.t + (H - P.t - P.b) * (1 - v / max);
  const pts = data.map((d, i) => `${P.l + bw * i + bw / 2},${y(d.results, maxR)}`).join(" ");
  const step = Math.ceil(data.length / 10);
  return (
    <div className="rounded-xl border border-slate-200 p-3">
      <div className="mb-1 flex flex-wrap items-center gap-4 text-[11px] text-slate-500">
        <span className="flex items-center gap-1">
          <i className="size-2.5 rounded-sm bg-indigo-200" /> {t("notify.campaignView.spendPer", { unit, max: money(maxS, cur) })}
        </span>
        <span className="flex items-center gap-1">
          <i className="h-0.5 w-3 bg-emerald-500" /> {t("notify.campaignView.resultsPer", { label, unit, max: num(maxR) })}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full">
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={P.l} x2={W - P.r} y1={P.t + (H - P.t - P.b) * f} y2={P.t + (H - P.t - P.b) * f} stroke="#e2e8f0" strokeDasharray="3 3" />
        ))}
        {data.map((d, i) => (
          <rect key={d.date} x={P.l + bw * i + bw * 0.15} width={bw * 0.7} y={y(d.spend, maxS)} height={H - P.b - y(d.spend, maxS)} rx={2} fill="var(--p300)" />
        ))}
        <polyline points={pts} fill="none" stroke="#10b981" strokeWidth={2} strokeLinejoin="round" />
        {data.map((d, i) => (
          <circle key={d.date} cx={P.l + bw * i + bw / 2} cy={y(d.results, maxR)} r={2.2} fill="#10b981" />
        ))}
        {data.map((d, i) =>
          i % step === 0 ? (
            <text key={d.date} x={P.l + bw * i + bw / 2} y={H - 6} textAnchor="middle" fontSize={10} fill="#94a3b8">
              {monthly ? `${d.date.slice(5, 7)}/${d.date.slice(2, 4)}` : `${d.date.slice(8, 10)}/${d.date.slice(5, 7)}`}
            </text>
          ) : null,
        )}
      </svg>
    </div>
  );
}

function ShareBar({ v, tone = "bg-indigo-400" }: { v: number; tone?: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="h-1.5 w-14 overflow-hidden rounded-full bg-slate-100">
        <span className={`block h-full rounded-full ${tone}`} style={{ width: `${Math.min(100, v)}%` }} />
      </span>
      <span className="text-[10.5px] text-slate-500 tabular-nums">{Math.round(v)}%</span>
    </span>
  );
}

const BORDER: Record<Tone, string> = { good: "border-l-emerald-500", warn: "border-l-amber-500", bad: "border-l-rose-500", info: "border-l-slate-300" };
const PRIORITY: Record<1 | 2 | 3, { key: "p1" | "p2" | "p3"; tone: Tone }> = { 1: { key: "p1", tone: "bad" }, 2: { key: "p2", tone: "warn" }, 3: { key: "p3", tone: "info" } };

function Tags({ d }: { d: Diagnosis }) {
  if (!d.tags.length) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {d.tags.map((t) => (
        <span key={t.text} className={`rounded px-1.5 py-px text-[10px] font-medium ring-1 ${TONE[t.tone]}`}>
          {t.text}
        </span>
      ))}
    </div>
  );
}

function IndicatorCard({ i, t }: { i: Indicator; t: T }) {
  return (
    <div className={`break-inside-avoid rounded-lg border border-l-4 border-slate-200 bg-panel px-2.5 py-2 ${BORDER[i.tone]}`}>
      <p className="text-[10px] text-slate-500">{i.label}</p>
      <p className="font-semibold text-slate-900 tabular-nums">
        {i.value}
        {i.bench && <span className="ml-1.5 text-[10px] font-normal text-slate-400">{t("notify.campaignView.bench", { v: i.bench })}</span>}
      </p>
      <p className="text-[10.5px] leading-snug text-slate-600">{i.note}</p>
    </div>
  );
}

/** Why + what to do for one campaign / ad set. */
function Why({ d, t }: { d: Diagnosis; t: T }) {
  if (!d.causes.length && !d.actions.length) return null;
  return (
    <div className="grid gap-2.5 @2xl:grid-cols-2 print:grid-cols-2">
      <div className="rounded-lg bg-slate-50 p-2.5">
        <p className="text-[10.5px] font-semibold tracking-wide text-slate-700 uppercase">{t("notify.campaignView.why")}</p>
        {d.causes.length ? (
          <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-[11.5px]">
            {d.causes.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        ) : (
          <p className="text-[11.5px] text-slate-500">{t("notify.campaignView.noIssue")}</p>
        )}
      </div>
      <div className="rounded-lg border-l-2 border-indigo-400 bg-indigo-50/60 p-2.5">
        <p className="text-[10.5px] font-semibold tracking-wide text-indigo-700 uppercase">{t("notify.campaignView.todo")}</p>
        <ul className="mt-0.5 space-y-1 text-[11.5px]">
          {d.actions.map((a, i) => (
            <li key={i} className="flex items-start gap-1.5">
              <Pill tone={PRIORITY[a.priority].tone}>{t(`notify.campaignView.priority.${PRIORITY[a.priority].key}`)}</Pill>
              <span>{a.text}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

const th = "px-2 py-1.5 font-medium";
const td = "px-2 py-1.5";

function CampaignTable({ rows, cur, base, t }: { rows: CampaignRow[]; cur: string; base: string | null; t: T }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 print:overflow-visible">
      <table className="w-full text-[11.5px]">
        <thead className="bg-slate-50 text-left text-[10px] text-slate-500 uppercase">
          <tr>
            <th className={`${th} min-w-48`}>{t("notify.campaignView.th.campaign")}</th>
            <th className={`${th} text-right`}>{t("notify.campaignView.th.spend")}</th>
            <th className={`${th} text-right`}>{t("notify.campaignView.th.results")}</th>
            <th className={`${th} text-right`}>{t("notify.campaignView.th.cpr")}</th>
            <th className={`${th} text-right`}>{t("notify.campaignView.th.ctrFreq")}</th>
            <th className={`${th} min-w-52`}>{t("notify.campaignView.th.verdict")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id} className="break-inside-avoid align-top [&>td]:border-t [&>td]:border-slate-100">
              <td className={td}>
                {base ? (
                  <Link href={`${base}/campaigns/${c.id}`} className="font-medium text-slate-900 hover:text-indigo-600 hover:underline">
                    {c.name}
                  </Link>
                ) : (
                  <p className="font-medium text-slate-900">{c.name}</p>
                )}
                <p className="text-[10.5px] text-slate-500">
                  {statusLabel(c.status, t)} · {resultLabels(t)[c.resultType] ?? c.resultType}
                  {c.budget && ` · ${c.budget}`}
                </p>
              </td>
              <td className={`${td} text-right whitespace-nowrap tabular-nums`}>
                <div>{money(c.m.spend, cur)}</div>
                <div className="flex justify-end">
                  <ShareBar v={c.share} />
                </div>
              </td>
              <td className={`${td} text-right whitespace-nowrap tabular-nums`}>
                <div>{num(c.m.results)}</div>
                <Delta now={c.m.results} prev={c.prev.results} />
              </td>
              <td className={`${td} text-right whitespace-nowrap tabular-nums`}>
                <div className="font-medium text-slate-900">{c.cpr != null ? money(c.cpr, cur) : "—"}</div>
                <Delta now={c.cpr} prev={c.prevCpr} lowerIsBetter />
              </td>
              <td className={`${td} text-right whitespace-nowrap text-slate-600 tabular-nums`}>
                <div>{c.ctr != null ? `${c.ctr.toFixed(2)}%` : "—"}</div>
                <div className="text-[10.5px]">{c.freq != null ? c.freq.toFixed(2) : "—"}</div>
              </td>
              <td className={td}>
                <Pill tone={c.verdict.tone}>{c.verdict.text}</Pill>
                <p className="mt-0.5 text-[10.5px] text-slate-500">{c.verdict.why}</p>
                <Tags d={c.diag} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ObjTable({ rows, cur, kind, quality, t }: { rows: (Row & { adSetName?: string; budget?: number | null })[]; cur: string; kind: "adset" | "ad"; quality: boolean; t: T }) {
  const video = kind === "ad" && rows.some((r) => r.m.plays3s > 0);
  return (
    <table className="w-full text-[11px]">
      <thead className="text-left text-[10px] text-slate-500 uppercase">
        <tr className="[&>th]:border-b [&>th]:border-slate-200">
          <th className={`${th} min-w-44`}>{kind === "adset" ? t("notify.campaignView.th.adset") : t("notify.campaignView.th.ad")}</th>
          <th className={`${th} text-right`}>{t("notify.campaignView.th.spend")}</th>
          <th className={`${th} text-right`}>{t("notify.campaignView.th.kq")}</th>
          <th className={`${th} text-right`}>{t("notify.campaignView.th.cpr")}</th>
          <th className={`${th} text-right`}>{t("notify.campaignView.th.ctr")}</th>
          <th className={`${th} text-right`}>{kind === "adset" ? t("notify.campaignView.th.freq") : t("notify.campaignView.th.cpm")}</th>
          {video && <th className={`${th} text-right`}>{t("notify.campaignView.th.view3s")}</th>}
          {quality && <th className={`${th} text-right`}>{t("notify.campaignView.th.goodLead")}</th>}
          <th className={`${th} min-w-44`}>{t("notify.campaignView.th.verdict")}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} className="break-inside-avoid align-top [&>td]:border-t [&>td]:border-slate-100">
            <td className={td}>
              <p className="text-slate-800">{r.name}</p>
              <p className="text-[10px] text-slate-400">
                {statusLabel(r.status, t)}
                {kind === "adset" && r.budget ? ` · ${t("notify.campaignView.perDay", { v: money(r.budget, cur) })}` : ""}
                {kind === "ad" && r.adSetName ? ` · ${r.adSetName}` : ""}
              </p>
            </td>
            <td className={`${td} text-right whitespace-nowrap tabular-nums`}>
              {money(r.m.spend, cur)}
              <div className="text-[10px] text-slate-400">{Math.round(r.share)}%</div>
            </td>
            <td className={`${td} text-right tabular-nums`}>{num(r.m.results)}</td>
            <td className={`${td} text-right whitespace-nowrap tabular-nums`}>{r.cpr != null ? money(r.cpr, cur) : "—"}</td>
            <td className={`${td} text-right tabular-nums`}>{r.ctr != null ? `${r.ctr.toFixed(2)}%` : "—"}</td>
            <td className={`${td} text-right whitespace-nowrap tabular-nums`}>{kind === "adset" ? (r.freq != null ? r.freq.toFixed(2) : "—") : r.cpm != null ? money(r.cpm, cur) : "—"}</td>
            {video && <td className={`${td} text-right tabular-nums`}>{r.m.plays3s && r.m.impressions ? `${((r.m.plays3s / r.m.impressions) * 100).toFixed(1)}%` : "—"}</td>}
            {quality && <td className={`${td} text-right whitespace-nowrap tabular-nums`}>{r.quality ? `${Math.round(r.quality.rate * 100)}% (${r.quality.n})` : "—"}</td>}
            <td className={td}>
              <Pill tone={r.verdict.tone}>{r.verdict.text}</Pill>
              <p className="mt-0.5 text-[10px] text-slate-500">{r.verdict.why}</p>
              <Tags d={r.diag} />
              {r.diag.actions[0] && r.diag.actions[0].priority <= 2 && <p className="mt-0.5 text-[10px] text-indigo-700">→ {r.diag.actions[0].text}</p>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SegTable({ title, rows, cur, warnPct }: { title: string; rows: SegmentRow[]; cur: string; warnPct: number }) {
  if (!rows.length) return null;
  return (
    <div className="break-inside-avoid rounded-xl border border-slate-200 p-3">
      <p className="mb-1.5 text-[12px] font-semibold text-slate-900">{title}</p>
      <table className="w-full text-[11px]">
        <tbody>
          {rows.map((s) => {
            const bad = s.share >= 15 && s.diff != null && s.diff * 100 >= warnPct;
            return (
              <tr key={s.key} className="[&>td]:py-0.5">
                <td className={bad ? "font-medium text-rose-700" : "text-slate-700"}>{s.label}</td>
                <td>
                  <ShareBar v={s.share} tone={bad ? "bg-rose-400" : "bg-indigo-400"} />
                </td>
                <td className="text-right whitespace-nowrap tabular-nums">{num(s.m.results)}</td>
                <td className={`text-right whitespace-nowrap tabular-nums ${bad ? "text-rose-700" : "text-slate-600"}`}>{s.cpr != null ? money(s.cpr, cur) : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export async function CampaignReportView({ r, cur, base }: { r: CampaignReport; cur: string; base: string | null }) {
  const t = await getT();
  const primary = r.types[0];
  const cpr = cprOf(r.total);
  let n = 0;
  const next = () => String(++n).padStart(2, "0");
  const spent = r.campaigns.filter((c) => c.m.spend > 0);
  const counts = (["good", "info", "warn", "bad"] as Tone[]).map((tone) => [tone, r.campaigns.filter((c) => c.verdict.tone === tone).length] as const);
  const seg = (dim: SegmentRow["dim"]) => r.segments.filter((s) => s.dim === dim);

  return (
    <div className="space-y-7 text-[12.5px] leading-relaxed text-slate-700">
      <section className="space-y-3">
        <Head
          n={next()}
          title={t("notify.campaignView.overview")}
          meta={`${r.range.since === r.range.until ? ymd(r.range.since) : `${ymd(r.range.since)} – ${ymd(r.range.until)}`}${r.days === "today" ? t("notify.campaignView.untilRead") : ""}${
            r.prevRange.since ? t("notify.campaignView.vsRange", { range: r.prevRange.since === r.prevRange.until ? ymd(r.prevRange.since) : `${ymd(r.prevRange.since)} – ${ymd(r.prevRange.until)}` }) : ""
          }`}
        />
        <div className="grid grid-cols-2 gap-2.5 @2xl:grid-cols-3 print:grid-cols-3">
          <Kpi label={t("notify.campaignView.kpi.spend")} value={money(r.total.spend, cur)} delta={<Delta now={r.total.spend} prev={r.prevTotal.spend} />} />
          {primary && (
            <>
              <Kpi label={`${primary.label}`} value={num(primary.m.results)} delta={<Delta now={primary.m.results} prev={primary.prev.results} />} />
              <Kpi label={t("notify.campaignView.kpi.cprOf", { label: primary.label.toLowerCase() })} value={primary.cpr != null ? money(primary.cpr, cur) : "—"} delta={<Delta now={primary.cpr} prev={primary.prevCpr} lowerIsBetter />} />
            </>
          )}
          <Kpi label={t("notify.campaignView.kpi.impressions")} value={num(r.total.impressions)} delta={<Delta now={r.total.impressions} prev={r.prevTotal.impressions} />} />
          <Kpi
            label={t("notify.campaignView.kpi.ctr")}
            value={r.total.impressions ? `${((r.total.clicks / r.total.impressions) * 100).toFixed(2)}%` : "—"}
            hint={t("notify.campaignView.kpi.cpmHint", { v: r.total.impressions ? money((r.total.spend / r.total.impressions) * 1000, cur) : "—" })}
          />
          {r.total.revenue > 0 ? (
            <Kpi label={t("notify.campaignView.kpi.revenue")} value={money(r.total.revenue, cur)} hint={t("notify.campaignView.kpi.roasHint", { v: (r.total.revenue / Math.max(1, r.total.spend)).toFixed(2) })} />
          ) : (
            <Kpi label={t("notify.campaignView.kpi.spentCampaigns")} value={`${spent.length} / ${r.campaigns.length}`} hint={cpr != null && r.types.length === 1 ? undefined : t("notify.campaignView.kpi.typesHint", { n: r.types.length })} />
          )}
        </div>
        {r.types.length > 1 && (
          <div className="flex flex-wrap gap-2 text-[11px]">
            {r.types.map((ty) => (
              <span key={ty.resultType} className="rounded-lg bg-slate-50 px-2.5 py-1 ring-1 ring-slate-200">
                <b className="text-slate-800">{ty.label}</b>: {num(ty.m.results)} · CPR {ty.cpr != null ? money(ty.cpr, cur) : "—"} <Delta now={ty.cpr} prev={ty.prevCpr} lowerIsBetter /> ·{" "}
                {money(ty.m.spend, cur)}
              </span>
            ))}
          </div>
        )}
        <DailySvg data={r.daily} cur={cur} label={r.primaryLabel} monthly={r.days === "lifetime"} t={t} />
      </section>

      {r.highlights.length > 0 && (
        <section className="break-inside-avoid space-y-2">
          <Head n={next()} title={t("notify.campaignView.highlights")} />
          <ul className="space-y-1.5">
            {r.highlights.map((h, i) => (
              <li key={i} className="flex gap-2">
                <span className={`mt-1.5 size-2 shrink-0 rounded-full ${DOT[h.tone]}`} />
                <span>{h.text}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {r.plan.length > 0 && (
        <section className="break-inside-avoid space-y-2">
          <Head n={next()} title={t("notify.campaignView.plan")} meta={t("notify.campaignView.planMeta")} />
          <ol className="space-y-1.5">
            {r.plan.map((a, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="w-4 shrink-0 text-right font-mono text-[11px] text-slate-400">{i + 1}.</span>
                <Pill tone={PRIORITY[a.priority].tone}>{t(`notify.campaignView.priority.${PRIORITY[a.priority].key}`)}</Pill>
                <span>
                  <b className="text-slate-900">{a.campaign}:</b> {a.text}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <section className="space-y-2.5">
        <Head
          n={next()}
          title={t("notify.campaignView.table", { n: r.campaigns.length })}
          meta={
            <span className="flex gap-1.5">
              {counts
                .filter(([, c]) => c)
                .map(([tone, c]) => (
                  <Pill key={tone} tone={tone}>
                    {c} {t(`notify.campaignView.counts.${tone}`)}
                  </Pill>
                ))}
            </span>
          }
        />
        {r.campaigns.length ? <CampaignTable rows={r.campaigns} cur={cur} base={base} t={t} /> : <p className="text-slate-500">{t("notify.campaignView.noCampaigns")}</p>}
      </section>

      {r.segments.length > 0 && (
        <section className="space-y-2.5">
          <Head n={next()} title={t("notify.campaignView.segments", { label: r.primaryLabel.toLowerCase() })} meta={t("notify.campaignView.segMeta")} />
          <div className="grid gap-2.5 @3xl:grid-cols-3 print:grid-cols-3">
            <SegTable title={t("notify.campaignView.age")} rows={seg("age")} cur={cur} warnPct={r.thresholds.warnPct} />
            <SegTable title={t("notify.campaignView.gender")} rows={seg("gender")} cur={cur} warnPct={r.thresholds.warnPct} />
            <SegTable title={t("notify.campaignView.platform")} rows={seg("platform")} cur={cur} warnPct={r.thresholds.warnPct} />
          </div>
        </section>
      )}

      {spent.length > 0 && (
        <section className="space-y-4 print:break-before-page">
          <Head n={next()} title={t("notify.campaignView.detail")} />
          {spent.map((c) => (
            <div key={c.id} className="space-y-2 rounded-xl border border-slate-200 p-3.5">
              <div className="flex flex-wrap items-start justify-between gap-2 break-inside-avoid">
                <div>
                  <p className="text-[14px] font-semibold text-slate-900">{c.name}</p>
                  <p className="text-[11px] text-slate-500">
                    {statusLabel(c.status, t)} · {resultLabels(t)[c.resultType] ?? c.resultType}
                    {c.budget && ` · ${c.budget}`}{t("notify.campaignView.benchRef", { v: c.ref != null ? `${money(c.ref, cur)} (${c.refLabel})` : t("notify.campaignView.none") })}
                  </p>
                </div>
                <Pill tone={c.verdict.tone}>{c.verdict.text}</Pill>
              </div>
              <div className="grid grid-cols-4 gap-2 text-[11px] print:grid-cols-4">
                {[
                  [t("notify.campaignView.th.spend"), money(c.m.spend, cur), <Delta key="d" now={c.m.spend} prev={c.prev.spend} />],
                  [t("notify.campaignView.th.results"), num(c.m.results), <Delta key="d" now={c.m.results} prev={c.prev.results} />],
                  [t("notify.campaignView.reach"), num(c.m.reach), null],
                  [t("notify.campaignView.kpi.impressions"), num(c.m.impressions), null],
                ].map(([l, v, d], i) => (
                  <div key={i} className="rounded-lg bg-slate-50 px-2.5 py-1.5">
                    <p className="text-[10px] text-slate-500">{l}</p>
                    <p className="font-semibold text-slate-900 tabular-nums">
                      {v} {d}
                    </p>
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-2 @3xl:grid-cols-3 print:grid-cols-3">
                {c.diag.indicators.map((i) => (
                  <IndicatorCard key={i.key} i={i} t={t} />
                ))}
              </div>
              <Why d={c.diag} t={t} />
              {c.adSets.length > 0 && <ObjTable rows={c.adSets} cur={cur} kind="adset" quality={r.hasQuality} t={t} />}
              {c.ads.length > 0 && <ObjTable rows={c.ads.slice(0, 12)} cur={cur} kind="ad" quality={r.hasQuality} t={t} />}
              {c.ads.length > 12 && <p className="text-[10.5px] text-slate-400">{t("notify.campaignView.moreAds", { n: c.ads.length - 12 })}</p>}
            </div>
          ))}
        </section>
      )}

      {(r.optimizations.length > 0 || r.pending > 0) && (
        <section className="break-inside-avoid space-y-2">
          <Head n={next()} title={t("notify.campaignView.optimizations")} meta={r.pending ? t("notify.campaignView.pendingMeta", { n: r.pending }) : undefined} />
          {r.optimizations.length ? (
            <ul className="space-y-1">
              {r.optimizations.map((o, i) => (
                <li key={i} className="flex flex-wrap items-baseline gap-2">
                  <span className="text-[11px] text-slate-400 tabular-nums">{o.executedAt ? dateOnly(o.executedAt) : ""}</span>
                  <span className="text-slate-800">{o.title}</span>
                  {o.verdict && <Pill tone={/tốt/.test(o.verdict) ? "good" : /kém/.test(o.verdict) ? "bad" : "info"}>{t("notify.campaignView.afterOpt", { v: o.verdict })}</Pill>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-slate-500">{t("notify.campaignView.noOpt")}</p>
          )}
        </section>
      )}

      <section className="break-inside-avoid rounded-xl bg-slate-50 p-3.5 text-[11px] text-slate-600">
        <p className="font-semibold text-slate-800">{t("notify.campaignView.how.title")}</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-4">
          <li>{t("notify.campaignView.how.li1")}</li>
          <li>
            {t("notify.campaignView.how.li2a", { x: r.thresholds.minSpendX })}<b>{t("notify.campaignView.how.expensive")}</b>
            {t("notify.campaignView.how.li2b", { pause: r.thresholds.pausePct, conf: Math.round(r.thresholds.confidence * 100) })}{" "}
            <b>{t("notify.campaignView.how.slightly")}</b>
            {t("notify.campaignView.how.li2c", { warn: r.thresholds.warnPct })}<b>{t("notify.campaignView.how.good")}</b>
            {t("notify.campaignView.how.li2d", { conf: Math.round(r.thresholds.confidence * 100) })}
          </li>
          <li>
            {t("notify.campaignView.how.li3", { freq: r.thresholds.freqMax })}
          </li>
          <li>
            {r.hasQuality ? t("notify.campaignView.how.li4q") : t("notify.campaignView.how.li4n")}
          </li>
          <li>{t("notify.campaignView.how.li5")}</li>
          <li>{t("notify.campaignView.how.li6", { time: dateTime(r.generatedAt) })}</li>
        </ul>
      </section>
    </div>
  );
}
