import Link from "next/link";
import { connection } from "next/server";
import { db } from "@/lib/db";
import { dateOnly, dateTime, money, num, pct } from "@/lib/format";
import { backfillProgress, kiotRunning, parseKiotState } from "@/lib/kiotviet-sync";
import { customerSummary, phoneRateLevel, salesStats } from "@/lib/kiotviet-stats";
import { requestKiotSyncAction } from "@/app/kiotviet-actions";
import { ActionButton } from "@/components/action-button";
import { AutoRefresh } from "@/components/auto-refresh";
import { Card, Empty, Stat } from "@/components/ui";
import { requirePageClient } from "@/lib/access";
import { getT } from "@/i18n/server";

// Sales (KiotViet, read-only): revenue by store, share of invoices with a phone number, best-selling items, customers with phone numbers.
// The share of invoices with a phone number determines how far the next steps (Meta customer audiences, matching messages to orders, sending in-store orders to Meta) can go.

const RANGES = [7, 30, 90, 365] as const;

const LEVEL = {
  good: { box: "border-emerald-200 bg-emerald-50 text-emerald-900" },
  ok: { box: "border-amber-200 bg-amber-50 text-amber-900" },
  low: { box: "border-rose-200 bg-rose-50 text-rose-900" },
};

export default async function SalesPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ d?: string }> }) {
  await connection();
  const t = await getT();
  const { id } = await params;
  await requirePageClient(id); // check access right on the page: the layout may not re-run on client-side navigation
  const { d } = await searchParams;
  const days = RANGES.find((r) => String(r) === d) ?? 30;
  const client = await db.client.findUniqueOrThrow({ where: { id } });

  if (!client.kiotSecret) {
    return (
      <Empty>
        {t("settings.salesPage.notConnected")}{" "}
        <Link href={`/clients/${id}/settings/integrations#kiotviet`} className="text-indigo-600 hover:underline">
          {t("settings.salesPage.settingsLink")}
        </Link>{" "}
        {t("settings.salesPage.toPaste")}
      </Empty>
    );
  }

  const st = parseKiotState(client.kiotState);
  const prog = backfillProgress(st, client.kiotMonths);
  const running = kiotRunning(client);
  const waiting = !running && !!client.kiotRequestAt && (!client.kiotSyncAt || client.kiotRequestAt > client.kiotSyncAt);
  const [s, cust] = await Promise.all([salesStats(id, days), customerSummary(id)]);
  const level = phoneRateLevel(s.total.phoneRate);
  const partial = !!st.oldest && st.oldest > s.since;
  const maxRev = Math.max(1, ...s.daily.map((x) => x.revenue));

  const head = (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div className="text-sm">
        <span className="font-medium text-ink">KiotViet</span> <span className="font-mono text-mut">{client.kiotRetailer}</span>
        <span className="ml-2 text-xs text-mut">
          {running ? `${t("settings.salesPage.syncing")}${st.phase ? `: ${st.phase}` : ""}…` : waiting ? t("settings.salesPage.waiting") : t("settings.salesPage.synced", { when: client.kiotSyncAt ? dateTime(client.kiotSyncAt) : t("settings.salesPage.never") })}
        </span>
        {!prog.complete && (
          <p className="mt-1 text-xs text-mut">
            {t("settings.salesPage.backfill", { done: num(prog.done), total: num(prog.total) })}{st.oldest ? ` ${t("settings.salesPage.haveSince", { date: dateOnly(st.oldest) })}` : ""}{t("settings.salesPage.backfillTail")}
          </p>
        )}
        {client.kiotSyncError && <p className="mt-1 text-xs text-rose-700">{t("settings.salesPage.lastError", { error: client.kiotSyncError })}</p>}
      </div>
      <div className="flex items-center gap-2">
        <nav className="flex gap-1">
          {RANGES.map((r) => (
            <Link key={r} href={`?d=${r}`} className={`rounded-lg px-2.5 py-1 text-xs ${r === days ? "bg-ink text-panel" : "border border-line text-ink2 hover:bg-hover"}`}>
              {t("settings.salesPage.rangeDays", { count: r })}
            </Link>
          ))}
        </nav>
        <ActionButton action={requestKiotSyncAction.bind(null, id)} pending={t("settings.salesPage.sending")}>
          {t("settings.salesPage.syncNow")}
        </ActionButton>
      </div>
    </div>
  );

  if (!s.total.invoices) {
    return (
      <>
        <AutoRefresh on={running || waiting} />
        {head}
        <Empty>{running || waiting || !client.kiotSyncAt ? t("settings.salesPage.firstPull") : t("settings.salesPage.noInvoices", { days })}</Empty>
      </>
    );
  }

  return (
    <>
      <AutoRefresh on={running || waiting} />
      {head}

      {level && (
        <div className={`mb-4 rounded-lg border px-4 py-3 text-sm ${LEVEL[level].box}`}>
          <p>
            <b>{t("settings.salesPage.phoneShare", { pct: pct(s.total.phoneRate, 0), days })}</b> ({t("settings.salesPage.phoneDetail", { withPhone: num(s.total.withPhone), invoices: num(s.total.invoices), unique: num(s.total.uniquePhones) })}) {t(`settings.salesPage.level.${level}` as const)}
          </p>
        </div>
      )}
      {partial && <p className="mb-4 text-xs text-amber-700">{t("settings.salesPage.partial", { date: dateOnly(st.oldest) })}</p>}

      <div className="mb-6 grid gap-3 @xl:grid-cols-3 @4xl:grid-cols-5">
        <Stat label={t("settings.salesPage.revenueDays", { days })} value={money(s.total.revenue)} />
        <Stat label={t("settings.salesPage.invoices")} value={num(s.total.invoices)} hint={t("settings.salesPage.perSellingDay", { n: num(s.total.invoices / Math.max(1, s.daily.length), 0) })} />
        <Stat label={t("settings.salesPage.avgInvoice")} value={money(s.total.invoices ? s.total.revenue / s.total.invoices : null)} />
        <Stat label={t("settings.salesPage.withCustomer")} value={pct(s.total.invoices ? (s.total.withCustomer / s.total.invoices) * 100 : null, 0)} hint={t("settings.salesPage.invoiceCount", { n: num(s.total.withCustomer) })} />
        <Stat label={t("settings.salesPage.withPhone")} value={pct(s.total.phoneRate, 0)} tone={level === "good" ? "good" : level === "low" ? "bad" : undefined} hint={t("settings.salesPage.uniquePhones", { n: num(s.total.uniquePhones) })} />
      </div>

      {days <= 90 && s.daily.length > 1 && (
        <Card title={t("settings.salesPage.dailyRevenue")} className="mb-6">
          <div className="flex h-32 items-end gap-px">
            {s.daily.map((x) => (
              <div
                key={x.date}
                className="flex-1 rounded-t bg-indigo-500/80 hover:bg-indigo-600"
                style={{ height: `${Math.max(2, (x.revenue / maxRev) * 100)}%` }}
                title={t("settings.salesPage.dayTitle", { date: dateOnly(x.date), revenue: money(x.revenue), invoices: num(x.invoices), pct: pct(x.invoices ? (x.withPhone / x.invoices) * 100 : null, 0) })}
              />
            ))}
          </div>
          <div className="mt-1 flex justify-between text-[11px] text-mut">
            <span>{dateOnly(s.daily[0].date)}</span>
            <span>{dateOnly(s.daily.at(-1)!.date)}</span>
          </div>
        </Card>
      )}

      <Card title={<>{t("settings.salesPage.byStore")} <span className="font-normal text-slate-400">· {s.branches.length}</span></>} className="mb-6">
        <div className="-mx-5 overflow-x-auto px-5">
          <table className="w-full text-sm">
            <thead className="text-left text-xs whitespace-nowrap text-slate-400">
              <tr>
                <th className="py-1 pr-3 font-medium">{t("settings.salesPage.colStore")}</th>
                <th className="py-1 pr-3 text-right font-medium">{t("settings.salesPage.colRevenue")}</th>
                <th className="py-1 pr-3 text-right font-medium">{t("settings.salesPage.colShare")}</th>
                <th className="py-1 pr-3 text-right font-medium">{t("settings.salesPage.colInvoices")}</th>
                <th className="py-1 pr-3 text-right font-medium">{t("settings.salesPage.colAvg")}</th>
                <th className="py-1 pr-3 text-right font-medium">{t("settings.salesPage.colPhone")}</th>
              </tr>
            </thead>
            <tbody>
              {s.branches.map((b) => {
                const lv = phoneRateLevel(b.phoneRate);
                return (
                  <tr key={b.branchId} className="border-t border-line">
                    <td className="py-1.5 pr-3 text-ink">{b.name}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{money(b.revenue)}</td>
                    <td className="py-1.5 pr-3 text-right text-mut tabular-nums">{pct(s.total.revenue ? (b.revenue / s.total.revenue) * 100 : null, 0)}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{num(b.invoices)}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{money(b.invoices ? b.revenue / b.invoices : null)}</td>
                    <td className={`py-1.5 pr-3 text-right font-medium tabular-nums ${lv === "good" ? "text-emerald-700" : lv === "low" ? "text-rose-700" : "text-amber-700"}`}>{pct(b.phoneRate, 0)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="mb-6 grid gap-6 @4xl:grid-cols-2">
        <Card title={t("settings.salesPage.topProducts")}>
          {days > 120 && <p className="mb-2 text-xs text-mut">{t("settings.salesPage.productsKept")}</p>}
          {s.products.length ? (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-slate-400">
                <tr>
                  <th className="py-1 pr-3 font-medium">{t("settings.salesPage.colProduct")}</th>
                  <th className="py-1 pr-3 text-right font-medium">{t("settings.salesPage.colQty")}</th>
                  <th className="py-1 text-right font-medium">{t("settings.salesPage.colSales")}</th>
                </tr>
              </thead>
              <tbody>
                {s.products.map((p) => (
                  <tr key={p.id} className="border-t border-line">
                    <td className="py-1.5 pr-3 text-ink">
                      {p.name} <span className="text-xs text-mut">{p.code}</span>
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{num(p.qty, 1)}</td>
                    <td className="py-1.5 text-right tabular-nums">{money(p.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-mut">{t("settings.salesPage.noProducts")}</p>
          )}
          <p className="mt-2 text-xs text-mut">{t("settings.salesPage.salesNote")}</p>
        </Card>

        <Card title={t("settings.salesPage.customersTitle")}>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-xs text-mut">{t("settings.salesPage.custAll")}</dt>
              <dd className="text-lg font-semibold tabular-nums">{num(cust.all)}</dd>
              <dd className="text-xs text-mut">{t("settings.salesPage.custValidPhone", { n: num(cust.withPhone) })}</dd>
            </div>
            <div>
              <dt className="text-xs text-mut">{t("settings.salesPage.custBuyers")}</dt>
              <dd className="text-lg font-semibold tabular-nums">{num(cust.buyers)}</dd>
            </div>
            <div>
              <dt className="text-xs text-mut">{t("settings.salesPage.custActive")}</dt>
              <dd className="text-lg font-semibold tabular-nums">{num(cust.active30)}</dd>
            </div>
            <div>
              <dt className="text-xs text-mut">{t("settings.salesPage.custRepeat")}</dt>
              <dd className="text-lg font-semibold tabular-nums">{num(cust.repeat)}</dd>
            </div>
            <div>
              <dt className="text-xs text-mut">{t("settings.salesPage.custLapsed")}</dt>
              <dd className="text-lg font-semibold tabular-nums">{num(cust.lapsed)}</dd>
            </div>
          </dl>
          <p className="mt-3 text-xs text-mut">
            {t("settings.salesPage.audienceNote")}
          </p>
        </Card>
      </div>
    </>
  );
}
