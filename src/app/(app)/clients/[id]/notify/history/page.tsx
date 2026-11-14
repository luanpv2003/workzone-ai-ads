import { connection } from "next/server";
import { db } from "@/lib/db";
import { dateTime } from "@/lib/format";
import { MERGED_NOTICE, NOTIFY_CHANNEL_LABEL, type NotifyChannel } from "@/lib/lead-notify-config";
import { Card, Empty } from "@/components/ui";
import { requirePageClient } from "@/lib/access";
import { getT } from "@/i18n/server";

export default async function NotifyHistoryPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  const t = await getT();
  await requirePageClient(id); // check access right on the page: the layout may not re-run on client-side navigation
  const notices = await db.leadNotice.findMany({ where: { clientId: id, NOT: { text: MERGED_NOTICE } }, orderBy: { createdAt: "desc" }, take: 30 });
  return (
    <Card title={t("notify.history.title")}>
      {!notices.length ? (
        <Empty>{t("notify.history.empty")}</Empty>
      ) : (
        <ul className="divide-y divide-slate-100 text-sm">
          {notices.map((n) => {
            let sends: { channel: NotifyChannel; ok: boolean; error?: string }[] = [];
            try {
              sends = JSON.parse(n.sends);
            } catch {}
            const failed = sends.filter((s) => !s.ok);
            return (
              <li key={n.id} className="py-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-slate-500">
                  <span>
                    {dateTime(n.createdAt)} · {n.kind === "form" ? t("notify.history.kindForm") : n.kind === "chat" ? t("notify.history.kindChat") : n.kind === "phone" ? t("notify.history.kindPhone") : n.kind}
                  </span>
                  <span className={failed.length ? "text-rose-600" : "text-emerald-700"}>
                    {!sends.length ? t("notify.history.sending") : failed.length ? t("notify.history.failed", { list: failed.map((f) => `${NOTIFY_CHANNEL_LABEL[f.channel] ?? f.channel} ${f.error}`).join("; ") }) : t("notify.history.sent", { n: sends.length })}
                  </span>
                </div>
                <p className="mt-1 whitespace-pre-line text-slate-700">{n.text}</p>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
