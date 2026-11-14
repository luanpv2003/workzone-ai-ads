import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { AlertTriangle } from "lucide-react";
import { db } from "@/lib/db";
import { requirePageClient } from "@/lib/access";
import { dateOnly, dateTime, money, num } from "@/lib/format";
import { ensureLiftMeta, liftView, overlappingCampaigns, parseIds, type LiftView } from "@/lib/sales-lift";
import { deleteLiftAction, refreshLiftMetaAction, applyFirstSpendAction } from "@/app/sales-lift-actions";
import { ActionButton } from "@/components/action-button";
import { Badge, Card, Stat } from "@/components/ui";
import { LiftSettings } from "@/components/sales-lift/lift-settings";
import { getT } from "@/i18n/server";
import type { T } from "@/i18n/translate";

// Sales lift by SKU: KiotViet sales of the advertised SKUs vs. the baseline period and the control group, divided by Meta spend,
// plus comments brought in by ads and order comments on the post. Every number is computed by code (lib/sales-lift*.ts), not by AI.

const signed = (v: number | null | undefined, digits = 0) => (v == null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${num(Math.abs(v) * 100, digits)}%`);
const tone = (v: number | null | undefined) => (v == null ? "" : v > 0 ? "text-emerald-700" : v < 0 ? "text-rose-700" : "");

/** Verbal conclusion, generated from the numbers (not AI). */
function verdict(v: LiftView, t: T): { text: string; tone: "good" | "bad" | "info" | "warn" } {
  const r = v.result;
  if (!v.enough)
    return {
      tone: "warn",
      text: t("settings.liftDetail.notEnough", { run: r.runDays, base: r.baseDays, min: v.minDays }),
    };
  if (r.lift == null) return { tone: "info", text: t("settings.liftDetail.cannotCompute") };
  const range = r.liftRange ? ` (${t("settings.liftDetail.swing", { from: signed(r.liftRange[0]), to: signed(r.liftRange[1]) })})` : "";
  if (r.liftRange && r.liftRange[0] > 0) return { tone: "good", text: t("settings.liftDetail.verdictGood", { lift: signed(r.lift), range }) };
  if (r.liftRange && r.liftRange[1] < 0) return { tone: "bad", text: t("settings.liftDetail.verdictBad", { lift: signed(r.lift), range }) };
  return { tone: "info", text: t("settings.liftDetail.verdictInfo", { lift: signed(r.lift), range }) };
}

const BOX = { good: "border-emerald-200 bg-emerald-50 text-emerald-900", bad: "border-rose-200 bg-rose-50 text-rose-900", info: "border-sky-200 bg-sky-50 text-sky-900", warn: "border-amber-200 bg-amber-50 text-amber-900" };

/** Daily index (baseline period = 100) of the ad group and the control group. */
function IndexChart({ v, t }: { v: LiftView; t: T }) {
  const d = v.result.daily;
  if (d.length < 2) return null;
  const mean = (k: "test" | "control") => {
    const b = d.filter((x) => x.period === "base");
    return b.length ? b.reduce((s, x) => s + x[k], 0) / b.length : 0;
  };
  const mt = mean("test");
  const mc = mean("control");
  if (!mt || !mc) return null;
  const pts = d.map((x) => ({ ...x, t: (x.test / mt) * 100, c: (x.control / mc) * 100 }));
  const max = Math.max(150, ...pts.map((p) => Math.max(p.t, p.c)));
  const W = 600;
  const H = 160;
  const x = (i: number) => (i / (pts.length - 1)) * W;
  const y = (val: number) => H - (val / max) * H;
  const line = (k: "t" | "c") => pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[k]).toFixed(1)}`).join(" ");
  const runAt = pts.findIndex((p) => p.period === "run");
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-40 w-full" preserveAspectRatio="none" role="img" aria-label={t("settings.liftDetail.chartAria")}>
        {runAt > 0 && <rect x={x(runAt) - W / pts.length / 2} y={0} width={W - x(runAt) + W / pts.length / 2} height={H} className="fill-indigo-50" />}
        <line x1={0} x2={W} y1={y(100)} y2={y(100)} className="stroke-slate-300" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
        <path d={line("c")} fill="none" className="stroke-slate-400" strokeWidth={2} vectorEffect="non-scaling-stroke" />
        <path d={line("t")} fill="none" className="stroke-indigo-600" strokeWidth={2.5} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="mt-1 flex justify-between text-[11px] text-mut">
        <span>{dateOnly(pts[0].date)}</span>
        {runAt > 0 && <span>{t("settings.liftDetail.adStarted", { date: dateOnly(pts[runAt].date) })}</span>}
        <span>{dateOnly(pts.at(-1)!.date)}</span>
      </div>
      <p className="mt-1 text-xs text-mut">
        <span className="font-medium text-indigo-700">━ {t("settings.liftDetail.adGroup")}</span> · <span className="font-medium text-slate-500">━ {v.result.controlKind === "store" ? t("settings.liftDetail.wholeStore") : t("settings.liftDetail.controlGroup")}</span> · {t("settings.liftDetail.chartLegend")}
      </p>
    </div>
  );
}

export default async function LiftPage({ params }: { params: Promise<{ id: string; liftId: string }> }) {
  await connection();
  const t = await getT();
  const { id, liftId } = await params;
  await requirePageClient(id); // check access right on the page: the layout may not re-run on client-side navigation
  const lift = await db.salesLift.findFirst({ where: { id: liftId, clientId: id } });
  if (!lift) notFound();
  const client = await db.client.findUniqueOrThrow({ where: { id } });
  const meta = await ensureLiftMeta(lift, client);
  const [v, overlap] = await Promise.all([liftView(lift, client, meta), overlappingCampaigns(lift)]);
  const r = v.result;
  const cur = client.currency;
  const vd = verdict(v, t);
  const flagged = r.products.filter((p) => p.flags.length && parseIds(lift.testIds).includes(p.id));
  const testIds = new Set(parseIds(lift.testIds));
  const groupRows = [
    { label: t("settings.liftDetail.adGroup"), g: r.test, n: testIds.size },
    ...(r.controlKind === "products" ? [{ label: t("settings.liftDetail.controlGroup"), g: r.control, n: parseIds(lift.controlIds).length }] : []),
  ];

  return (
    <>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href={`/clients/${id}/lift`} className="text-xs text-mut hover:underline">
            {t("settings.liftDetail.back")}
          </Link>
          <h2 className="mt-1 text-lg font-semibold text-ink">{lift.name}</h2>
          <p className="text-sm text-mut">
            {lift.level === "ad" ? t("settings.liftDetail.levelAd") : t("settings.liftDetail.levelCampaign")} {lift.objectName} · {t("settings.liftDetail.runPeriod", { start: dateOnly(v.run.start), end: dateOnly(v.run.end) })} · {t("settings.liftDetail.basePeriod", { start: dateOnly(v.base.start), end: dateOnly(v.base.end) })}
          </p>
        </div>
        <div className="flex flex-wrap items-start gap-2">
          <ActionButton action={refreshLiftMetaAction.bind(null, lift.id)} pending={t("settings.liftDetail.readingMeta")}>
            {t("settings.liftDetail.rereadMeta")}
          </ActionButton>
          <ActionButton action={deleteLiftAction.bind(null, lift.id)} variant="ghost" confirm={t("settings.liftDetail.confirmDelete")} redirectTo={`/clients/${id}/lift?x=`}>
            {t("settings.liftDetail.delete")}
          </ActionButton>
        </div>
      </div>

      {meta.error && <p className="mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{t("settings.liftDetail.metaUnreadable", { error: meta.error })}</p>}
      {v.firstSpend && v.firstSpend !== lift.runStart && (
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <span className="flex-1">
            {t("settings.liftDetail.firstSpendBefore", { kind: lift.level === "ad" ? t("settings.liftDetail.kindAd") : t("settings.liftDetail.kindCampaign") })}<b>{dateOnly(v.firstSpend)}</b>{t("settings.liftDetail.firstSpendAfter", { date: dateOnly(lift.runStart) })}
          </span>
          <ActionButton action={applyFirstSpendAction.bind(null, lift.id, v.firstSpend)} pending={t("settings.liftDetail.changing")}>
            {t("settings.liftDetail.useDate", { date: dateOnly(v.firstSpend) })}
          </ActionButton>
        </div>
      )}

      <div className={`mb-4 rounded-lg border px-4 py-3 text-sm ${BOX[vd.tone]}`}>
        <p className="font-medium">{vd.text}</p>
      </div>

      <div className={`mb-6 grid gap-3 @xl:grid-cols-3 ${v.enough ? "" : "opacity-70"}`}>
        <Stat
          label={v.enough ? t("settings.liftDetail.liftEstimate") : t("settings.liftDetail.liftProvisional")}
          value={<span className={tone(r.lift)}>{signed(r.lift, 1)}</span>}
          hint={r.liftRange ? t("settings.liftDetail.range", { from: signed(r.liftRange[0]), to: signed(r.liftRange[1]) }) : t("settings.liftDetail.needDays")}
        />
        <Stat label={t("settings.liftDetail.extraRevenue")} value={money(r.incRevenue, cur)} hint={r.incQty != null ? t("settings.liftDetail.extraUnits", { n: num(r.incQty, 1) }) : undefined} />
        <Stat label={t("settings.liftDetail.metaSpend")} value={money(v.spend, cur)} hint={v.spendSource === "manual" ? t("settings.liftDetail.manual") : v.spendSource === "meta" ? t("settings.liftDetail.readMeta", { when: meta.at ? dateTime(meta.at) : "" }) : t("settings.liftDetail.none")} />
        <Stat label={t("settings.liftDetail.extraPerSpend")} value={v.roas == null ? "—" : `${num(v.roas, 2)}×`} hint={v.costPerUnit ? t("settings.liftDetail.costPerUnit", { cost: money(v.costPerUnit, cur) }) : t("settings.liftDetail.revenueNote")} />
        <Stat label={t("settings.liftDetail.adComments")} value={num(v.metaComments)} hint={v.costPerComment ? t("settings.liftDetail.perComment", { cost: money(v.costPerComment, cur) }) : undefined} />
        <Stat
          label={`${t("settings.liftDetail.orderComments")}${lift.manualOrders != null ? ` ${t("settings.liftDetail.manualEdit")}` : ""}`}
          value={num(v.orders)}
          hint={v.costPerOrder ? t("settings.liftDetail.perOrderComment", { cost: money(v.costPerOrder, cur) }) : v.postIds.length ? undefined : t("settings.liftDetail.noSourcePost")}
        />
      </div>

      <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50/60 px-4 py-3 text-sm text-amber-950">
        <p className="mb-1 flex items-center gap-1.5 font-medium">
          <AlertTriangle className="size-4" /> {t("settings.liftDetail.caveatTitle")}
        </p>
        <ul className="ml-5 list-disc space-y-0.5">
          <li>{t("settings.liftDetail.caveatOthers")}</li>
          {overlap.map((o) => (
            <li key={o.name}>
              {t("settings.liftDetail.caveatOverlap")}<b>{o.name}</b> ({o.ads.join(", ")}).
            </li>
          ))}
          <li>{t("settings.liftDetail.caveatPrice")}{flagged.length ? ` ${t("settings.liftDetail.caveatFlagged", { count: flagged.length })}` : ""}</li>
          <li>{t("settings.liftDetail.caveatSeason")}</li>
          <li>{t("settings.liftDetail.caveatComments")}</li>
        </ul>
      </div>

      <div className="mb-6 grid gap-6 @4xl:grid-cols-2">
        <Card title={t("settings.liftDetail.byDay")}>
          <IndexChart v={v} t={t} />
          {r.daily.length < 2 && <p className="text-sm text-mut">{t("settings.liftDetail.notEnoughDays")}</p>}
        </Card>
        <Card title={t("settings.liftDetail.compareGroups")}>
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-slate-400">
              <tr>
                <th className="py-1 pr-3 font-medium">{t("settings.liftDetail.colGroup")}</th>
                <th className="py-1 pr-3 text-right font-medium">{t("settings.liftDetail.colBasePerDay")}</th>
                <th className="py-1 pr-3 text-right font-medium">{t("settings.liftDetail.colRunPerDay")}</th>
                <th className="py-1 text-right font-medium">{t("settings.liftDetail.colChange")}</th>
              </tr>
            </thead>
            <tbody>
              {groupRows.map(({ label, g, n }) => (
                <tr key={label} className="border-t border-line">
                  <td className="py-1.5 pr-3">
                    {label} <span className="text-xs text-mut">{t("settings.liftDetail.codes", { n })}</span>
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{money(g.baseValue, cur)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{money(g.runValue, cur)}</td>
                  <td className={`py-1.5 text-right font-medium tabular-nums ${tone(g.growth)}`}>{signed(g.growth, 1)}</td>
                </tr>
              ))}
              <tr className="border-t border-line text-mut">
                <td className="py-1.5 pr-3">{t("settings.liftDetail.wholeStore")} {r.controlKind === "store" ? <Badge tone="warn">{t("settings.liftDetail.usedAsControl")}</Badge> : <span className="text-xs">{t("settings.liftDetail.reference")}</span>}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{money(r.store.baseRevenue, cur)}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{money(r.store.runRevenue, cur)}</td>
                <td className={`py-1.5 text-right tabular-nums ${tone(r.store.growth)}`}>{signed(r.store.growth, 1)}</td>
              </tr>
            </tbody>
          </table>
          <p className="mt-2 text-xs text-mut">
            {t("settings.liftDetail.groupNote", { control: r.controlKind === "store" ? t("settings.liftDetail.wholeStoreLower") : t("settings.liftDetail.controlLower"), base: r.baseDays, run: r.runDays })}
          </p>
        </Card>
      </div>

      <Card title={t("settings.liftDetail.perProduct")} className="mb-6">
        <div className="-mx-5 overflow-x-auto px-5">
          <table className="w-full text-sm">
            <thead className="text-left text-xs whitespace-nowrap text-slate-400">
              <tr>
                <th className="py-1 pr-3 font-medium">{t("settings.liftDetail.colProduct")}</th>
                <th className="py-1 pr-3 text-right font-medium">{t("settings.liftDetail.colQtyBase")}</th>
                <th className="py-1 pr-3 text-right font-medium">{t("settings.liftDetail.colQtyRun")}</th>
                <th className="py-1 pr-3 text-right font-medium">{t("settings.liftDetail.colChange")}</th>
                <th className="py-1 pr-3 text-right font-medium">{t("settings.liftDetail.colPrice")}</th>
                <th className="py-1 pr-3 text-right font-medium">{t("settings.liftDetail.colExtraQty")}</th>
                <th className="py-1 pr-3 text-right font-medium">{t("settings.liftDetail.colExtraRev")}</th>
                <th className="py-1 font-medium">{t("settings.liftDetail.colNote")}</th>
              </tr>
            </thead>
            <tbody>
              {r.products.map((p) => {
                const isTest = testIds.has(p.id);
                return (
                  <tr key={p.id} className="border-t border-line align-top">
                    <td className="py-1.5 pr-3">
                      <Badge tone={isTest ? "pri" : "mut"}>{isTest ? t("settings.liftDetail.badgeAd") : t("settings.liftDetail.badgeControl")}</Badge> <span className="text-ink">{v.productName(p.id)}</span> <span className="text-xs text-mut">{v.productCode(p.id)}</span>
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{num(p.baseQty, 1)}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{num(p.runQty, 1)}</td>
                    <td className={`py-1.5 pr-3 text-right tabular-nums ${tone(p.growth)}`}>{signed(p.growth)}</td>
                    <td className="py-1.5 pr-3 text-right whitespace-nowrap tabular-nums">
                      {money(p.basePrice, cur)} → {money(p.runPrice, cur)}
                    </td>
                    <td className={`py-1.5 pr-3 text-right tabular-nums ${tone(p.incQty)}`}>{isTest ? num(p.incQty, 1) : ""}</td>
                    <td className={`py-1.5 pr-3 text-right tabular-nums ${tone(p.incRevenue)}`}>{isTest ? money(p.incRevenue, cur) : ""}</td>
                    <td className="py-1.5 text-xs text-amber-800">{p.flags.join(" ")}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-mut">{t("settings.liftDetail.productNote")}</p>
      </Card>

      <div className="mb-6 grid gap-6 @4xl:grid-cols-2">
        <Card title={t("settings.liftDetail.commentsByAd")}>
          {v.ads.length ? (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-slate-400">
                <tr>
                  <th className="py-1 pr-3 font-medium">{t("settings.liftDetail.colAd")}</th>
                  <th className="py-1 pr-3 text-right font-medium">{t("settings.liftDetail.colSpend")}</th>
                  <th className="py-1 pr-3 text-right font-medium">{t("settings.liftDetail.colComments")}</th>
                  <th className="py-1 text-right font-medium">{t("settings.liftDetail.colCostPerComment")}</th>
                </tr>
              </thead>
              <tbody>
                {[...v.ads]
                  .sort((a, b) => b.spend - a.spend)
                  .map((a) => (
                    <tr key={a.id} className="border-t border-line">
                      <td className="py-1.5 pr-3">
                        {a.name}
                        {a.status && a.status !== "ACTIVE" && <span className="ml-1 text-xs text-mut">({a.status === "DELETED" ? t("settings.liftDetail.deleted") : t("settings.liftDetail.off")})</span>}
                      </td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{money(a.spend, cur)}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{num(a.comments)}</td>
                      <td className="py-1.5 text-right tabular-nums">{money(a.comments ? a.spend / a.comments : null, cur)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-mut">{t("settings.liftDetail.noMetaByAd")}</p>
          )}
          <p className="mt-2 text-xs text-mut">{t("settings.liftDetail.commentsNote")}</p>
        </Card>

        <Card title={t("settings.liftDetail.orderComments")}>
          <p className="text-sm">
            {t("settings.liftDetail.runLabel")}<b>{num(v.autoOrders)}</b>{t("settings.liftDetail.autoOrdersOf", { n: num(v.comments.length) })}
            {lift.manualOrders != null && <> · {t("settings.liftDetail.usingManual")}<b>{num(lift.manualOrders)}</b></>}.
          </p>
          <p className="mt-0.5 text-xs text-mut">
            {t("settings.liftDetail.baseOrders", { n: num(v.baseOrders), perDay: num(v.baseOrderDays ? v.baseOrders / v.baseOrderDays : null, 1) })}
          </p>
          {v.byBranch.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {v.byBranch.map(([b, n]) => (
                <Badge key={b} tone="info">
                  {b}: {n}
                </Badge>
              ))}
            </div>
          )}
          {v.comments.length > 0 ? (
            <details className="mt-3">
              <summary className="cursor-pointer text-sm text-indigo-700">{t("settings.liftDetail.viewComments", { count: v.comments.length })}</summary>
              <ul className="mt-2 max-h-96 divide-y divide-line overflow-y-auto text-sm">
                {v.comments.slice(0, 300).map((c) => (
                  <li key={c.id} className="flex gap-2 py-1.5">
                    <span className="w-20 shrink-0 text-xs text-mut">{dateOnly(c.createdTime)}</span>
                    <span className="min-w-0 flex-1">{c.message}</span>
                    {c.order ? <Badge tone="good">{t("settings.liftDetail.orderBadge")}{c.branch ? ` · ${c.branch}` : ""}</Badge> : <span className="text-xs text-mut">—</span>}
                  </li>
                ))}
              </ul>
            </details>
          ) : (
            <p className="mt-2 text-sm text-mut">{v.postIds.length ? t("settings.liftDetail.noComments") : t("settings.liftDetail.noSourcePostLong")}</p>
          )}
          <p className="mt-2 text-xs text-mut">{t("settings.liftDetail.orderDefinition")}</p>
        </Card>
      </div>

      <Card title={t("settings.liftDetail.setupTitle")} className="mb-6">
        <LiftSettings
          liftId={lift.id}
          baseDays={r.baseDays}
          initial={{
            name: lift.name,
            runStart: lift.runStart,
            runEnd: lift.runEnd ?? "",
            baseStart: lift.baseStart,
            baseEnd: lift.baseEnd,
            testIds: parseIds(lift.testIds),
            controlIds: parseIds(lift.controlIds),
            branchWords: lift.branchWords,
            manualSpend: lift.manualSpend == null ? "" : String(lift.manualSpend),
            manualOrders: lift.manualOrders == null ? "" : String(lift.manualOrders),
          }}
          products={v.products.map((p) => ({ id: p.id, code: p.code, name: p.name, perDay: r.baseDays ? p.baseQty / r.baseDays : 0 }))}
        />
        {lift.note && (
          <details className="mt-4">
            <summary className="cursor-pointer text-sm text-mut">{t("settings.liftDetail.whySuggested")}</summary>
            <ul className="mt-2 ml-5 list-disc space-y-0.5 text-xs text-mut">
              {lift.note.split("\n").map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          </details>
        )}
      </Card>
    </>
  );
}
