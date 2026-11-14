import Link from "next/link";
import type { ReactNode } from "react";
import { connection } from "next/server";
import { db } from "@/lib/db";
import { requirePageClient } from "@/lib/access";
import { TabLink } from "@/components/nav-link";
import { Badge } from "@/components/ui";
import { parseLeadNotify } from "@/lib/lead-notify-config";
import { zaloBotStatus } from "@/lib/zalo-bot";
import { smtpStatus, telegramStatus } from "@/lib/report-channels";
import { botChatStats } from "@/lib/lead-bot-report";
import { getT } from "@/i18n/server";

// A client's notifications & reports: what the bot posts, to which group, when; the bot answers questions in the group. 5 tabs, one page per tab.
// Channels (Zalo Bot, Telegram, Email) are set up globally in System settings → Sending channels.
export default async function NotifyLayout({ children, params }: { children: ReactNode; params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  const t = await getT();
  await requirePageClient(id);
  const base = `/clients/${id}/notify`;
  const [client, schedules, zalo, tg, smtp, bot] = await Promise.all([
    db.client.findUniqueOrThrow({ where: { id }, select: { leadNotify: true } }),
    db.reportSchedule.count({ where: { clientId: id, active: true } }),
    zaloBotStatus().catch(() => null),
    telegramStatus().catch(() => null),
    smtpStatus().catch(() => null),
    botChatStats(id),
  ]);
  const lead = parseLeadNotify(client.leadNotify);
  const channels: [string, string | null | undefined][] = [
    ["Zalo Bot", zalo?.name],
    ["Telegram", tg?.username && `@${tg.username}`],
    ["Email", smtp?.user],
  ];
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-mut">
        <span>{t("notify.layout.channels")}</span>
        {channels.map(([label, who]) => (
          <span key={label} className="inline-flex items-center gap-1.5" title={who ?? t("notify.layout.notConnected")}>
            <span className={`size-2 rounded-full ${who ? "bg-emerald-500" : "bg-slate-300"}`} />
            {label}
          </span>
        ))}
        <Link href="/connections/channels" className="text-indigo-600 hover:underline">
          {t("notify.layout.setup")}
        </Link>
      </div>
      <nav className="mb-5 flex gap-1 overflow-x-auto border-b border-line [scrollbar-width:none]">
        <TabLink href={base} exact>
          {t("notify.layout.tabLead")} <Badge tone={lead.on ? "good" : "mut"}>{lead.on ? t("notify.layout.on") : t("notify.layout.off")}</Badge>
        </TabLink>
        <TabLink href={`${base}/reports`}>
          {t("notify.layout.tabReports")} <Badge tone={schedules ? "good" : "mut"}>{schedules ? t("notify.layout.schedulesN", { n: schedules }) : t("notify.layout.off")}</Badge>
        </TabLink>
        <TabLink href={`${base}/bot`}>
          {t("notify.layout.tabBot")} {bot.notes > 0 ? <Badge tone="warn">{t("notify.layout.notesPending", { n: bot.notes })}</Badge> : bot.unanswered > 0 && <Badge tone="warn">{t("notify.layout.unanswered", { n: bot.unanswered })}</Badge>}
        </TabLink>
        <TabLink href={`${base}/templates`}>{t("notify.layout.tabTemplates")}</TabLink>
        <TabLink href={`${base}/history`}>{t("notify.layout.tabHistory")}</TabLink>
      </nav>
      {children}
    </>
  );
}
