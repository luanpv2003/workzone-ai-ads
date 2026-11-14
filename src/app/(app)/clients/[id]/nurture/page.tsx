import Link from "next/link";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { Plus } from "lucide-react";
import { db } from "@/lib/db";
import { Badge, Card, Empty, Stat } from "@/components/ui";
import { ActionButton } from "@/components/action-button";
import { dateTime } from "@/lib/format";
import { createFlowAction } from "@/app/nurture-actions";
import { OptOutButton } from "@/components/nurture/opt-out-button";
import { FLOW_STATUS, SEND_FROM, SEND_STATUS, SEND_TO } from "@/lib/nurture-rules";
import { nurtureOverview } from "@/lib/nurture-stats";
import { requirePageClient } from "@/lib/access";
import { getT } from "@/i18n/server";

// Re-engagement: message flows for people who messaged the Page (within Meta's 24-hour window) + retargeting audiences for those past 24 hours.
export default async function NurturePage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const t = await getT();
  const { id } = await params;
  await requirePageClient(id); // check access right on the page: the layout may not re-run on client-side navigation
  const client = await db.client.findUnique({ where: { id } });
  if (!client) notFound();
  const { flows, sends, optOuts, in24, weekSent, weekReplied, replied } = await nurtureOverview(id);
  const base = `/clients/${id}/nurture`;

  return (
    <div className="space-y-6">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-3xl">
            <h2 className="text-[15px] font-semibold text-ink">{t("customers.nurturePage.title")}</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-mut">
              <li>
                {t("customers.nurturePage.b1a")}<b className="text-ink2">{t("customers.nurturePage.b1b")}</b>{t("customers.nurturePage.b1c")}
              </li>
              <li>{t("customers.nurturePage.b2")}</li>
              <li>
                {t("customers.nurturePage.b3", { from: SEND_FROM, to: SEND_TO })}
              </li>
              <li>{t("customers.nurturePage.b4")}</li>
            </ul>
          </div>
          <ActionButton action={createFlowAction.bind(null, id, "")} variant="primary" pending={t("customers.nurturePage.creating")} redirectTo={`${base}/`}>
            <Plus /> {t("customers.nurturePage.create")}
          </ActionButton>
        </div>
      </Card>

      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label={t("customers.nurturePage.stat.in24")} value={in24} hint={t("customers.nurturePage.stat.in24Hint")} />
        <Stat label={t("customers.nurturePage.stat.sent7")} value={weekSent} />
        <Stat label={t("customers.nurturePage.stat.replied")} value={weekSent ? `${weekReplied} (${Math.round((weekReplied / weekSent) * 100)}%)` : "–"} hint={t("customers.nurturePage.stat.repliedHint")} />
        <Stat label={t("customers.nurturePage.stat.optOut")} value={optOuts.length} />
      </div>

      <Card title={t("customers.nurturePage.flows")}>
        {flows.length ? (
          <ul className="divide-y divide-line">
            {flows.map((f) => {
              const s = FLOW_STATUS[f.status] ?? FLOW_STATUS.draft;
              return (
                <li key={f.id}>
                  <Link href={`${base}/${f.id}`} className="flex flex-wrap items-center justify-between gap-2 py-3 hover:bg-hover">
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-ink">{f.name}</span>
                      <span className="text-xs text-mut">
                        {f.auto ? t("customers.nurturePage.autoEvery", { hours: f.everyHours }) : t("customers.nurturePage.onClick")}{t("customers.nurturePage.sendsCount", { n: f._count.sends })}
                        {f.lastRunNote ? ` · ${dateTime(f.lastRunAt)}: ${f.lastRunNote}` : ""}
                      </span>
                    </span>
                    <Badge tone={s.tone}>{t(s.labelKey)}</Badge>
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : (
          <Empty>{t("customers.nurturePage.empty")}</Empty>
        )}
      </Card>

      {sends.length > 0 && (
        <Card title={t("customers.nurturePage.recent")}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-mut">
                <tr>
                  <th className="py-1.5 pr-3 font-medium">{t("customers.nurturePage.col.at")}</th>
                  <th className="py-1.5 pr-3 font-medium">{t("customers.nurturePage.col.customer")}</th>
                  <th className="py-1.5 pr-3 font-medium">{t("customers.nurturePage.col.flow")}</th>
                  <th className="py-1.5 pr-3 font-medium">{t("customers.nurturePage.col.status")}</th>
                  <th className="py-1.5 font-medium">{t("customers.nurturePage.col.reply")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {sends.map((s) => (
                  <tr key={s.id}>
                    <td className="py-2 pr-3 whitespace-nowrap text-mut">{dateTime(s.sentAt)}</td>
                    <td className="py-2 pr-3">{s.customerName}</td>
                    <td className="py-2 pr-3">
                      <Link href={`${base}/${s.flow.id}`} className="text-indigo-600 hover:underline">
                        {s.flow.name}
                      </Link>
                    </td>
                    <td className="py-2 pr-3">
                      <Badge tone={SEND_STATUS[s.status]?.tone}>{SEND_STATUS[s.status] ? t(SEND_STATUS[s.status].labelKey) : s.status}</Badge>
                      {s.error && <span className="ml-2 text-xs text-rose-600">{s.error}</span>}
                    </td>
                    <td className="py-2">{s.status === "failed" ? "" : replied.has(s.id) ? <Badge tone="good">{t("customers.nurturePage.replied")}</Badge> : <span className="text-xs text-mut">{t("customers.nurturePage.notYet")}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-mut">{t("customers.nurturePage.repliedNote")}</p>
        </Card>
      )}

      {optOuts.length > 0 && (
        <Card title={t("customers.nurturePage.optOutTitle")}>
          <ul className="divide-y divide-line text-sm">
            {optOuts.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  {o.name || o.psid} <span className="text-xs text-mut">· {o.reason} · {dateTime(o.createdAt)}</span>
                </span>
                <OptOutButton clientId={id} pageId={o.pageId} psid={o.psid} name={o.name} on={false} />
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
