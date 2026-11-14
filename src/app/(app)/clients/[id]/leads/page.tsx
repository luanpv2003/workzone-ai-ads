import Link from "next/link";
import { InboxLink } from "@/components/inbox-link";
import { connection } from "next/server";
import { headers } from "next/headers";
import { db } from "@/lib/db";
import { requirePageClient } from "@/lib/access";
import { appsScript, feedbackGood, dateToSince, FEEDBACK_FIELDS, SHEET_EVERY_MIN, SHEET_SCRIPT_V, sheetKeyOf, sheetRows, type SheetRow } from "@/lib/lead-sheet";
import { maskEmail, maskPhone } from "@/lib/pii";
import { dateTime, num } from "@/lib/format";
import { Badge, Card, Empty, Stat } from "@/components/ui";
import { RevealContact } from "@/components/reveal-contact";
import { CopyButton } from "@/components/copy-button";
import { ActionButton } from "@/components/action-button";
import { FeedbackCells } from "@/components/lead-sheet/feedback-cells";
import { SheetStatus } from "@/components/lead-sheet/sheet-status";
import { SheetSince } from "@/components/lead-sheet/sheet-since";
import { createSheetLinkAction, revokeSheetLinkAction } from "@/app/lead-sheet-actions";
import { ManualNotifyButton } from "@/components/manual-notify-button";
import { notifiedRows, parseLeadNotify } from "@/lib/lead-notify";
import { ackedRows } from "@/lib/lead-confirm";
import { getT } from "@/i18n/server";
import { BRAND } from "@/lib/brand";
import type { T } from "@/i18n/translate";

export async function generateMetadata() {
  const t = await getT();
  return { title: `${t("nav.sections.leads.label")} · ${BRAND.app}` };
}

const SOURCES = [
  { key: "", labelKey: "customers.leadsPage.src.all" },
  { key: "form", labelKey: "customers.leadsPage.src.form" },
  { key: "mess", labelKey: "customers.leadsPage.src.mess" },
] as const;
const VIEWS = [
  { key: "", labelKey: "customers.leadsPage.view.all" },
  { key: "todo", labelKey: "customers.leadsPage.view.todo" },
  { key: "ads", labelKey: "customers.leadsPage.view.ads" },
] as const;
const DAYS = [
  { key: "7", labelKey: "customers.leadsPage.days.7" },
  { key: "30", labelKey: "customers.leadsPage.days.30" },
  { key: "all", labelKey: "customers.leadsPage.days.all" },
] as const;

const sinceMs = (days: string) => (days === "all" ? 0 : Date.now() - Number(days) * 86400000);
const rated = (r: SheetRow) => !!(r.fb.contact || r.fb.quality || r.fb.outcome);

/** Aggregated by source ad: the sales team's actual rating (not the AI score). */
function byAd(rows: SheetRow[], t: T) {
  const m = new Map<string, { id: string; ad: string; campaign: string; n: number; form: number; mess: number; rated: number; good: number; bad: number; won: number }>();
  for (const r of rows) {
    const k = r.adId ?? "";
    const g = m.get(k) ?? m.set(k, { id: k, ad: r.adId ? r.ad : t("customers.leadsPage.unknownAd"), campaign: r.adId ? r.campaign : "", n: 0, form: 0, mess: 0, rated: 0, good: 0, bad: 0, won: 0 }).get(k)!;
    g.n++;
    if (r.source === "Form") g.form++;
    else g.mess++;
    const good = feedbackGood(r.fb);
    if (good !== null) g.rated++;
    if (good === true) g.good++;
    if (good === false) g.bad++;
    if (r.fb.outcome === "Đã chốt") g.won++;
  }
  return [...m.values()].sort((a, b) => b.n - a.n);
}

export default async function LeadsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ src?: string; v?: string; d?: string; n?: string }> }) {
  await connection();
  const t = await getT();
  const { id } = await params;
  const { role } = await requirePageClient(id); // check access right on the page: the layout may not re-run on client-side navigation
  const sp = await searchParams;
  const days = sp.d ?? "30";
  const [client, all, sheetFeedback] = await Promise.all([
    db.client.findUniqueOrThrow({ where: { id }, select: { name: true, leadNotify: true, sheetKey: true, sheetSeenAt: true, sheetLinkedAt: true, sheetRows: true, sheetFeedbackAt: true, sheetScriptV: true, sheetAuto: true, sheetSince: true } }),
    sheetRows(id),
    db.salesFeedback.count({ where: { clientId: id, source: "sheet" } }),
  ]);
  const admin = role === "admin"; // Full access on the client: download CSV, Google Sheet code
  const since = sinceMs(days);
  const inRange = all.filter((r) => r.date.getTime() >= since);
  const rows = inRange.filter(
    (r) => (!sp.src || (sp.src === "form" ? r.source === "Form" : r.source === "Tin nhắn")) && (sp.v !== "todo" || !rated(r)) && (sp.v !== "ads" || !!r.adId),
  );
  const limit = Math.min(2000, Math.max(200, Number(sp.n) || 200));
  const shown = rows.slice(0, limit);
  // The "Báo nhóm" (Notify group) button (manual post to the Zalo / Telegram group) only shows once the client has chosen receiving groups in Lead notifications.
  const canNotify = parseLeadNotify(client.leadNotify).targets.length > 0;
  const [notified, acked] = canNotify ? await Promise.all([notifiedRows(id, shown.map((r) => r.key)), ackedRows(id, shown.map((r) => r.key))]) : [new Map<string, Date>(), new Map<string, { by: string; at: Date }>()];

  const ratedRows = inRange.filter((r) => feedbackGood(r.fb) !== null);
  const goodRate = ratedRows.length ? ratedRows.filter((r) => feedbackGood(r.fb)).length / ratedRows.length : null;
  const ads = byAd(inRange, t);

  const key = admin ? sheetKeyOf(client) : null;
  const sheetCount = all.filter((r) => r.date.getTime() >= (client.sheetSince?.getTime() ?? 0)).length;
  const sinceBox = <SheetSince clientId={id} value={dateToSince(client.sheetSince)} count={sheetCount} total={all.length} />;
  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "https"}://${h.get("x-forwarded-host") ?? h.get("host")}`;
  const sheetUrl = key ? `${origin}/api/sheet/${key}` : null;

  const qs = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams(Object.entries({ src: sp.src, v: sp.v, d: sp.d, ...patch }).filter(([, v]) => v) as [string, string][]);
    return `?${p}`;
  };
  const pill = (on: boolean) => `inline-flex h-7 items-center rounded-lg px-2.5 text-xs whitespace-nowrap ${on ? "bg-ink font-medium text-panel" : "border border-line bg-panel text-ink2 hover:bg-hover"}`;

  return (
    <>
      {/* Page title + description live in the client page header (lib/client-sections.ts). */}
      {admin && (
        <div className="-mt-2 mb-4 flex justify-end">
          <a href={`/api/clients/${id}/leads`} className="inline-flex h-8 items-center rounded-lg border border-line bg-panel px-3 text-sm font-medium text-ink hover:bg-hover">
            {t("customers.leadsPage.downloadCsv")}
          </a>
        </div>
      )}

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label={t("customers.leadsPage.stat.customers", { range: DAYS.find((d) => d.key === days) ? t(DAYS.find((d) => d.key === days)!.labelKey) : days })} value={num(inRange.length)} hint={t("customers.leadsPage.stat.customersHint", { form: num(inRange.filter((r) => r.source === "Form").length), mess: num(inRange.filter((r) => r.source === "Tin nhắn").length) })} />
        <Stat label={t("customers.leadsPage.stat.contact")} value={num(inRange.filter((r) => r.phones.length || r.email).length)} />
        <Stat label={t("customers.leadsPage.stat.rated")} value={num(ratedRows.length)} hint={t("customers.leadsPage.stat.ratedHint", { n: num(inRange.filter((r) => !rated(r)).length) })} />
        <Stat label={t("customers.leadsPage.stat.good")} value={goodRate == null ? "—" : `${Math.round(goodRate * 100)}%`} hint={t("customers.leadsPage.stat.goodHint")} tone={goodRate == null ? undefined : goodRate >= 0.3 ? "good" : "bad"} />
        <Stat label={t("customers.leadsPage.stat.won")} value={num(inRange.filter((r) => r.fb.outcome === "Đã chốt").length)} />
      </div>

      <div className="mb-5 grid gap-5 xl:grid-cols-[3fr_2fr]">
        <Card title={t("customers.leadsPage.quality.title")}>
          {ads.length ? (
            <div className="-m-5 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs text-slate-500">
                  <tr>
                    <th className="px-4 py-2 font-medium">{t("customers.leadsPage.quality.ad")}</th>
                    <th className="px-3 py-2 text-right font-medium">{t("customers.leadsPage.quality.customers")}</th>
                    <th className="px-3 py-2 text-right font-medium">{t("customers.leadsPage.quality.rated")}</th>
                    <th className="px-3 py-2 text-right font-medium">{t("customers.leadsPage.quality.good")}</th>
                    <th className="px-3 py-2 text-right font-medium">{t("customers.leadsPage.quality.bad")}</th>
                    <th className="px-3 py-2 text-right font-medium">{t("customers.leadsPage.quality.won")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {ads.map((a) => (
                    <tr key={a.id}>
                      <td className="px-4 py-2">
                        <div className="font-medium text-ink">{a.ad}</div>
                        <div className="text-xs text-mut">
                          {a.campaign && `${a.campaign} · `}
                          {t("customers.leadsPage.quality.sub", { form: a.form, mess: a.mess })}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{a.n}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{a.rated}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {a.good}
                        {a.rated > 0 && <span className="text-xs text-mut"> ({Math.round((a.good / a.rated) * 100)}%)</span>}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{a.bad}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{a.won}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>{t("customers.leadsPage.quality.empty")}</Empty>
          )}
          <p className="mt-6 text-xs text-mut">{t("customers.leadsPage.quality.note")}</p>
        </Card>

        <Card title={t("customers.leadsPage.sheet.title")} action={!client.sheetKey && <Badge tone="mut">{t("customers.leadsPage.sheet.notLinked")}</Badge>}>
          {!admin ? (
            <p className="text-sm text-mut">{t("customers.leadsPage.sheet.adminOnly")}</p>
          ) : !sheetUrl ? (
            <div className="space-y-3 text-sm text-ink2">
              <p>{t("customers.leadsPage.sheet.intro")}</p>
              {sinceBox}
              <ActionButton action={createSheetLinkAction.bind(null, id)} variant="primary" pending={t("customers.leadsPage.sheet.creating")}>
                {t("customers.leadsPage.sheet.create")}
              </ActionButton>
            </div>
          ) : (
            <div className="space-y-3 text-sm text-ink2">
              <SheetStatus
                linkedAt={client.sheetLinkedAt?.toISOString() ?? null}
                seenAt={client.sheetSeenAt?.toISOString() ?? null}
                rows={client.sheetRows}
                feedbackAt={client.sheetFeedbackAt?.toISOString() ?? null}
                feedbackTotal={sheetFeedback}
                everyMin={SHEET_EVERY_MIN}
                scriptV={client.sheetScriptV}
                latestV={SHEET_SCRIPT_V}
                auto={client.sheetAuto}
              />
              {sinceBox}
              <ol className="list-decimal space-y-1 pl-5">
                <li>{t("customers.leadsPage.sheet.step1a")}<b>{t("customers.leadsPage.sheet.step1b")}</b>.</li>
                <li>{t("customers.leadsPage.sheet.step2")}</li>
                <li>{t("customers.leadsPage.sheet.step3a")}<code className="rounded bg-slate-100 px-1">caiDat</code>{t("customers.leadsPage.sheet.step3b")}<b>{t("customers.leadsPage.sheet.run")}</b>{t("customers.leadsPage.sheet.step3c")}<b>{t("customers.leadsPage.sheet.triggers")}</b>{t("customers.leadsPage.sheet.step3d")}<code className="rounded bg-slate-100 px-1">dongBo</code>.</li>
                <li>{t("customers.leadsPage.sheet.step4a")}<b>Khách hàng</b>{t("customers.leadsPage.sheet.step4b")}<b>{BRAND.app} → Đồng bộ ngay</b>{t("customers.leadsPage.sheet.step4c")}</li>
              </ol>
              <div className="flex flex-wrap items-center gap-2">
                <CopyButton text={appsScript(sheetUrl)} />
                <span className="text-xs text-mut">{t("customers.leadsPage.sheet.copyHelp")}</span>
              </div>
              <details className="text-xs">
                <summary className="cursor-pointer text-mut">{t("customers.leadsPage.sheet.viewCode")}</summary>
                <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-slate-50 p-3 text-[11px] leading-relaxed">{appsScript(sheetUrl)}</pre>
              </details>
              <p className="text-xs text-amber-700">{t("customers.leadsPage.sheet.warn")}</p>
              <div className="flex flex-wrap gap-2">
                <ActionButton action={createSheetLinkAction.bind(null, id)} pending={t("customers.leadsPage.sheet.changing")} confirm={t("customers.leadsPage.sheet.confirmChange")}>
                  {t("customers.leadsPage.sheet.change")}
                </ActionButton>
                <ActionButton action={revokeSheetLinkAction.bind(null, id)} variant="ghost" pending={t("customers.leadsPage.sheet.revoking")} confirm={t("customers.leadsPage.sheet.confirmRevoke")}>
                  {t("customers.leadsPage.sheet.revoke")}
                </ActionButton>
              </div>
            </div>
          )}
        </Card>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {SOURCES.map((s) => (
          <Link key={s.key} href={qs({ src: s.key || undefined })} className={pill((sp.src ?? "") === s.key)}>
            {t(s.labelKey)}
          </Link>
        ))}
        <span className="mx-1 h-4 w-px bg-line" />
        {VIEWS.map((s) => (
          <Link key={s.key} href={qs({ v: s.key || undefined })} className={pill((sp.v ?? "") === s.key)}>
            {t(s.labelKey)}
          </Link>
        ))}
        <span className="mx-1 h-4 w-px bg-line" />
        {DAYS.map((s) => (
          <Link key={s.key} href={qs({ d: s.key === "30" ? undefined : s.key })} className={pill(days === s.key)}>
            {t(s.labelKey)}
          </Link>
        ))}
        <span className="ml-auto text-xs text-mut">{t("customers.leadsPage.count", { n: num(rows.length) })}</span>
      </div>

      {!canNotify && shown.length > 0 && (
        <p className="mb-2 text-xs text-mut">
          {t("customers.leadsPage.notifyHint1")}{" "}
          <Link href={`/clients/${id}/notify`} className="text-indigo-600 hover:underline">
            {t("nav.sections.notify.label")}
          </Link>{" "}
          {t("customers.leadsPage.notifyHint2")}
        </p>
      )}
      {shown.length ? (
        <div className="overflow-x-auto rounded-xl border border-line bg-panel">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium whitespace-nowrap">{t("customers.leadsPage.th.date")}</th>
                <th className="px-3 py-2 font-medium">{t("customers.leadsPage.th.customer")}</th>
                <th className="px-3 py-2 font-medium">{t("customers.leadsPage.th.contact")}</th>
                <th className="px-3 py-2 font-medium">{t("customers.leadsPage.th.need")}</th>
                <th className="px-3 py-2 font-medium">{t("customers.leadsPage.th.ad")}</th>
                {FEEDBACK_FIELDS.map((f) => (
                  <th key={f.field} className="px-1.5 py-2 font-medium">{t(f.labelKey)}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {shown.map((r) => (
                <tr key={r.key} className="align-top">
                  <td className="px-4 py-2 text-xs whitespace-nowrap text-mut tabular-nums">{dateTime(r.date)}</td>
                  <td className="min-w-36 px-3 py-2">
                    <div className="font-medium text-ink">{r.name}</div>
                    <div className="mt-0.5 flex flex-wrap gap-1">
                      <Badge tone={r.source === "Form" ? "info" : "pri"}>{t(r.source === "Form" ? "customers.leadsPage.src.form" : "customers.leadsPage.src.mess")}</Badge>
                      {r.score != null && <Badge tone={r.score >= 75 ? "good" : r.score >= 50 ? "warn" : "mut"}>AI {r.score}</Badge>}
                      {r.dup.length > 0 && <Badge tone="warn">{t("customers.leadsPage.dupPhone")}</Badge>}
                    </div>
                    {r.link && (
                      <InboxLink href={r.link} name={r.name} className="text-[11px] text-indigo-600 hover:underline">
                        {t("customers.leadsPage.openInbox")}
                      </InboxLink>
                    )}
                    {canNotify && <ManualNotifyButton clientId={id} rowKey={r.key} sentAt={notified.get(r.key)?.toISOString() ?? null} ack={acked.has(r.key) ? { by: acked.get(r.key)!.by, at: acked.get(r.key)!.at.toISOString() } : null} />}
                  </td>
                  <td className="px-3 py-2">
                    <RevealContact kind={r.source === "Form" ? "lead" : "conversation"} id={r.key.slice(2)} phone={r.phones[0] ? maskPhone(r.phones[0]) : null} email={r.email ? maskEmail(r.email) : null} more={r.phones.length - 1} />
                  </td>
                  <td className="min-w-56 max-w-80 px-3 py-2 text-xs text-ink2">{r.need || <span className="text-mut2">—</span>}</td>
                  <td className="min-w-32 max-w-48 px-3 py-2 text-xs text-ink2">{r.ad || <span className="text-mut2">—</span>}</td>
                  <FeedbackCells clientId={id} rowKey={r.key} fb={r.fb} fields={FEEDBACK_FIELDS} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>{t("customers.leadsPage.empty")}</Empty>
      )}
      {rows.length > shown.length && (
        <div className="mt-3 text-center">
          <Link href={qs({ n: String(limit + 200) })} className="text-sm text-indigo-600 hover:underline">
            {t("customers.leadsPage.more", { n: num(rows.length - shown.length) })}
          </Link>
        </div>
      )}
    </>
  );
}
