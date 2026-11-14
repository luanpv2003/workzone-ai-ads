import { BRAND } from "@/lib/brand";
import { cmpAvg, cmpPrev, cprChange, dayWord, extraNote, goodTitle, perUnitOf, remindLine, type DailyDigest } from "@/lib/client-daily-report";
import { money, num } from "@/lib/format";
import { getT } from "@/i18n/server";
import type { T } from "@/i18n/translate";

// Client-facing daily report page (link /r/<code>): easy-to-read version without advertising jargon.
// Mobile: 1 column. Desktop (lg): 2 newspaper-style columns (CSS columns), cards are not split.

const dayIndex = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay() as 0 | 1 | 2 | 3 | 4 | 5 | 6;
const wd = (date: string, t: T) => t(`notify.dailyView.wdShort.d${dayIndex(date)}`);
const dmy = (s: string) => s.split("-").reverse().join("/");

function Chip({ tone, children }: { tone: "good" | "bad" | "flat"; children: React.ReactNode }) {
  const c = tone === "good" ? "bg-emerald-100 text-emerald-700" : tone === "bad" ? "bg-rose-100 text-rose-700" : "bg-slate-200 text-slate-600";
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${c}`}>{children}</span>;
}

const CARD = "mb-3 break-inside-avoid rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200/60 lg:mb-4 lg:p-5";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className={CARD}>
      <h2 className="mb-2 text-[15px] font-semibold text-slate-900">{title}</h2>
      {children}
    </section>
  );
}

/** Bar chart of results over 7 days (static SVG). */
function Bars({ d, t }: { d: DailyDigest; t: T }) {
  const W = 320;
  const n = d.days.length;
  const bw = 30;
  const gap = (W - bw * n) / (n + 1);
  const max = Math.max(1, ...d.days.map((x) => x.results));
  const down = (d.prevResults != null && d.results < d.prevResults) || (cprChange(d) ?? 0) >= 0.15;
  return (
    <svg viewBox="0 0 320 150" className="w-full" role="img" aria-label={t("notify.dailyView.aria", { unit: d.unit })}>
      {d.days.map((x, i) => {
        const h = (x.results / max) * 100;
        const xx = gap + i * (bw + gap);
        const y = 118 - h;
        const last = i === n - 1;
        return (
          <g key={x.date}>
            <rect x={xx} y={y} width={bw} height={Math.max(h, 1.5)} rx={5} fill={last ? (down ? "#e11d48" : "#2f7fd1") : "#c2daf3"} />
            <text x={xx + bw / 2} y={y - 5} textAnchor="middle" fontSize={11} fontWeight={last ? 700 : 500} fill="#334155">
              {num(x.results)}
            </text>
            <text x={xx + bw / 2} y={136} textAnchor="middle" fontSize={11} fill="#64748b">
              {wd(x.date, t)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function Funnel({ rows }: { rows: [string, number][] }) {
  const top = Math.max(1, rows[0][1]);
  return (
    <div className="space-y-1.5">
      {rows.map(([label, v]) => (
        <div key={label} className="grid grid-cols-[1fr_auto] items-center gap-2 text-[13px]">
          <div className="relative h-[22px] overflow-hidden rounded-md bg-indigo-50">
            <div className="absolute inset-y-0 left-0 rounded-md bg-indigo-500/80" style={{ width: `${Math.max(4, (v / top) * 100)}%` }} />
            <span className="relative pl-2 text-xs leading-[22px] font-semibold whitespace-nowrap text-indigo-950">{label}</span>
          </div>
          <b className="tabular-nums">{num(v)}</b>
        </div>
      ))}
    </div>
  );
}

function Mix({ parts, note }: { parts: [string, number, string][]; note?: string }) {
  const total = parts.reduce((a, p) => a + p[1], 0);
  if (!total) return null;
  return (
    <>
      <div className="mt-3 mb-2 flex h-3 overflow-hidden rounded-md">
        {parts.filter((p) => p[1]).map(([label, v, color]) => (
          <div key={label} style={{ width: `${(v / total) * 100}%`, background: color }} />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[12.5px] text-slate-700">
        {parts.map(([label, v, color]) => (
          <div key={label} className="flex items-center gap-1.5">
            <span className="inline-block size-2.5 rounded-sm" style={{ background: color }} />
            {label}: <b>{num(v)}</b>
          </div>
        ))}
      </div>
      {note && <p className="mt-2 text-[11px] text-slate-500">{note}</p>}
    </>
  );
}

const C = { hot: "#2f7fd1", mid: "#93bce8", warn: "#fbbf24", bad: "#fb7185" };

export async function DailyReportView({ name, cur, d, createdAt }: { name: string; cur: string; d: DailyDigest; createdAt: Date }) {
  const t = await getT();
  const prev = cmpPrev(d, t);
  const avg = cmpAvg(d, t);
  const c = cprChange(d);
  const diff = d.prevResults == null ? 0 : d.results - d.prevResults;
  const m = d.opts.quality ? d.msg : null;
  const l = d.opts.quality ? d.lead : null;
  const remind = remindLine(d, t);
  const perUnit = perUnitOf(d.unit, t);
  // Don't show target cost or cost per lead: those are internal numbers for the operator to act on.
  const mt = d.mtd ?? null;
  const good = d.goodAdSets ?? [];
  const day = dayWord(d, t);
  return (
    <div className="mx-auto max-w-md pb-6 lg:max-w-5xl lg:px-6 lg:pt-6">
      <header className="bg-gradient-to-br from-indigo-700 via-indigo-600 to-violet-600 px-5 pt-5 pb-6 text-white sm:rounded-b-2xl lg:flex lg:items-end lg:justify-between lg:rounded-2xl lg:px-8 lg:py-7">
        <div>
          <div className="flex items-center gap-1.5 text-xs font-semibold">
            <span className="rounded-md bg-white/15 px-1.5 py-0.5 text-[10px] ring-1 ring-white/30">{BRAND.agency.slice(0, 2).toUpperCase()}</span> {BRAND.agency}
          </div>
          <p className="mt-5 text-[11px] tracking-[0.14em] text-indigo-100 uppercase">{d.live ? t("notify.dailyView.titleLive") : t("notify.dailyView.titleDay")}</p>
          <h1 className="mt-0.5 text-[22px] leading-tight font-bold lg:text-[28px]">{name}</h1>
        </div>
        <p className="mt-0.5 text-xs text-indigo-100 lg:text-sm">
          {t(`notify.dailyView.wdFull.d${dayIndex(d.date)}`)}, {dmy(d.date)}
          {d.live && t("notify.dailyView.until", { live: d.live })}
        </p>
      </header>

      <div className="mt-3 px-3.5 lg:mt-5 lg:columns-2 lg:gap-4 lg:px-0">
        <section className={CARD}>
          <p className="text-[13px] text-slate-500">{d.live ? t("notify.dailyView.headlineLive", { live: d.live }) : t("notify.dailyView.headline")}</p>
          <p className="mt-1 text-[44px] leading-none font-extrabold tracking-tight text-slate-900 tabular-nums lg:text-[52px]">{num(d.results)}</p>
          <p className="mt-1 text-[15px] text-slate-500">{d.unit}</p>
          {d.extra ? <p className="mt-0.5 text-[12px] text-slate-500">{t("notify.dailyView.extra", { note: extraNote(d.extra, t) ?? "", perUnit })}</p> : null}
          <div className="mt-3.5 grid grid-cols-2 gap-2.5">
            <div className="rounded-xl bg-slate-100 p-2.5">
              <p className="text-[11.5px] text-slate-500">{t("notify.dailyView.spend")}</p>
              <p className="text-[17px] font-bold tabular-nums">{money(d.spend, cur)}</p>
            </div>
            <div className="rounded-xl bg-slate-100 p-2.5">
              <p className="text-[11.5px] text-slate-500">{t("notify.dailyView.avgPer", { perUnit })}</p>
              <p className="text-[17px] font-bold tabular-nums">{d.cpr != null ? money(d.cpr, cur) : "—"}</p>
            </div>
          </div>
          {(prev || avg) && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {prev && (
                <Chip tone={diff > 0 ? "good" : diff < 0 ? "bad" : "flat"}>
                  {diff >= 0 ? "▲" : "▼"} {prev}
                </Chip>
              )}
              {avg && <Chip tone={c == null || Math.abs(c) < 0.03 ? "flat" : c < 0 ? "good" : "bad"}>{avg}</Chip>}
            </div>
          )}
        </section>

        {mt && (
          <section className={CARD}>
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-[15px] font-semibold text-slate-900">{t("notify.dailyView.mtd")}</h2>
              <span className="text-[11.5px] text-slate-500">
                {dmy(mt.since).slice(0, 5)} – {dmy(d.date).slice(0, 5)} · {t("notify.dailyView.daysN", { n: mt.days })}
              </span>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2.5">
              <div>
                <p className="text-[28px] leading-none font-extrabold text-slate-900 tabular-nums">{num(mt.results)}</p>
                <p className="mt-1 text-[12.5px] text-slate-500">
                  {d.unit}
                  {mt.extra ? `, ${extraNote(mt.extra, t)}` : ""}
                </p>
              </div>
              {mt.prospect && mt.prospect.count > 0 && (
                <div>
                  <p className="text-[28px] leading-none font-extrabold text-indigo-700 tabular-nums">{num(mt.prospect.count)}</p>
                  <p className="mt-1 text-[12.5px] text-slate-500">{mt.prospect.label}</p>
                </div>
              )}
            </div>
            <p className="mt-3 text-[13px] text-slate-600">
              {t("notify.dailyView.avgA")}<b className="text-slate-900 tabular-nums">{mt.cpr != null ? money(mt.cpr, cur) : "—"}</b>{t("notify.dailyView.avgB", { perUnit, spend: money(mt.spend, cur) })}
            </p>
          </section>
        )}

        {good.length > 0 && (
          <Section title={goodTitle(d, t)}>
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[11.5px] text-slate-500">
                  <th className="pb-1.5 font-medium">{t("notify.dailyView.thGroup")}</th>
                  <th className="pb-1.5 text-right font-medium">{d.unit[0].toUpperCase() + d.unit.slice(1)}</th>
                  <th className="pb-1.5 pl-3 text-right font-medium">{t("notify.dailyView.thPer", { perUnit })}</th>
                </tr>
              </thead>
              <tbody>
                {good.map((g) => (
                  <tr key={g.name} className="border-t border-slate-100">
                    <td className="py-1.5 pr-2 text-slate-800">{g.name}</td>
                    <td className="py-1.5 text-right font-semibold tabular-nums">{num(g.results)}</td>
                    <td className="py-1.5 pl-3 text-right font-semibold whitespace-nowrap text-emerald-700 tabular-nums">{money(g.cpr, cur)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        )}

        <Section title={t("notify.dailyView.week")}>
          <Bars d={d} t={t} />
          <p className="mt-1 text-[11px] text-slate-500">{t("notify.dailyView.weekNote", { unit: d.unit, which: d.live ? t("notify.dailyView.whichLive", { live: d.live }) : t("notify.dailyView.whichYesterday") })}</p>
        </Section>

        {m && (
          <Section title={t("notify.dailyView.msgTitle", { day, all: m.scope === "all" ? t("notify.dailyView.allNote") : "" })}>
            <Funnel
              rows={[
                [t("notify.dailyView.messaged"), m.total],
                [t("notify.dailyView.hot"), m.hot],
                [t("notify.dailyView.phone"), m.phones],
                ...(m.closed ? [[t("notify.dailyView.closed"), m.closed] as [string, number]] : []),
              ]}
            />
            <Mix
              parts={[
                [t("notify.dailyView.hot"), m.hot, C.hot],
                [t("notify.dailyView.exploring"), m.exploring, C.mid],
                [t("notify.dailyView.silent"), m.silent, C.warn],
                [t("notify.dailyView.junk"), m.junk, C.bad],
              ]}
              note={t("notify.dailyView.msgNote", { read: num(m.total - m.unanalyzed), total: num(m.total), unread: m.unanalyzed ? t("notify.dailyView.unread", { n: num(m.unanalyzed) }) : "", rated: m.saleRated ? t("notify.dailyView.rated", { n: num(m.saleRated) }) : "" })}
            />
          </Section>
        )}

        {l && (
          <Section title={t("notify.dailyView.leadTitle", { day })}>
            <Funnel
              rows={[
                [t("notify.dailyView.left"), l.total],
                [t("notify.dailyView.reached"), l.contacted],
                [t("notify.dailyView.goodQ"), l.good],
                ...(l.closed ? [[t("notify.dailyView.closed"), l.closed] as [string, number]] : []),
              ]}
            />
            <Mix
              parts={[
                [t("notify.dailyView.good"), l.good, C.hot],
                [t("notify.dailyView.avg"), l.avg, C.mid],
                [t("notify.dailyView.bad"), l.bad, C.warn],
                [t("notify.dailyView.wrongTarget"), l.wrongTarget, C.bad],
              ]}
              note={t("notify.dailyView.leadNote", { extra: l.noAnswer || l.wrongNumber ? t("notify.dailyView.leadExtra", { a: num(l.noAnswer), b: num(l.wrongNumber) }) : "" })}
            />
            {!(l.good + l.avg + l.bad + l.wrongTarget) && <p className="mt-2 text-[12.5px] text-slate-500">{t("notify.dailyView.noUpdate", { day })}</p>}
          </Section>
        )}

        {remind && <p className="mb-3 break-inside-avoid rounded-xl bg-orange-50 px-3 py-2.5 text-[13px] text-orange-800 lg:mb-4">{remind[0].toUpperCase() + remind.slice(1)}</p>}

        {d.actions && d.actions.length > 0 && (
          <Section title={t("notify.dailyView.did", { day })}>
            <ul className="space-y-1.5 text-[13.5px] text-slate-700">
              {d.actions.map((a) => (
                <li key={a} className="flex gap-2">
                  <span className="text-emerald-600">✓</span>
                  {a}
                </li>
              ))}
            </ul>
          </Section>
        )}

        {d.notes.length > 0 && (
          <Section title={t("notify.dailyView.notes")}>
            <ul className="list-disc space-y-1 pl-5 text-[13.5px] text-slate-700">
              {d.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </Section>
        )}

        {d.todo && (
          <Section title={d.live ? t("notify.dailyView.todoLive") : t("notify.dailyView.todo")}>
            <p className="text-[13.5px] whitespace-pre-line text-slate-700">{d.todo}</p>
          </Section>
        )}
      </div>

      <p className="px-4.5 pt-1 text-[10.5px] text-slate-400 lg:px-1">
        {t("notify.dailyView.footer", { time: createdAt.toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit", year: "numeric" }), unit: d.unit })}
      </p>
    </div>
  );
}
