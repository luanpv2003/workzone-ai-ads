import Link from "next/link";
import { connection } from "next/server";
import { db } from "@/lib/db";
import { dateTime } from "@/lib/format";
import { requirePageClient } from "@/lib/access";
import { chatCode, parseLeadNotify } from "@/lib/lead-notify-config";
import { botChatStats, botSettings, GUIDE_MAX, pendingNotes } from "@/lib/lead-bot-report";
import { Badge, Card, Empty, type Tone } from "@/components/ui";
import { BRAND } from "@/lib/brand";
import { BotNoteItem, BotSettingsForm, BotTester } from "@/components/bot-settings-form";
import { getT } from "@/i18n/server";

// Bot replies in groups: someone in the group mentions the bot and asks → the bot replies (lib/lead-bot-report.ts).
// This page: enable Claude, bot instructions, test questions, Q&A history to check whether the bot answers correctly.

const MODE: Record<string, { key: "ai" | "report" | "fallback" | "unlinked"; tone: Tone }> = {
  ai: { key: "ai", tone: "info" },
  report: { key: "report", tone: "gray" },
  fallback: { key: "fallback", tone: "warn" },
  unlinked: { key: "unlinked", tone: "mut" },
};

export default async function NotifyBotPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ only?: string }> }) {
  await connection();
  const { id } = await params;
  const t = await getT();
  const { user } = await requirePageClient(id); // check access right on the page: the layout may not re-run on client-side navigation
  const only = (await searchParams).only === "unanswered";
  const [client, own, global, chats, stats, notes] = await Promise.all([
    db.client.findUniqueOrThrow({ where: { id }, select: { leadNotify: true } }),
    botSettings(id),
    botSettings(null),
    db.botChat.findMany({ where: { clientId: id, ...(only && { answered: false }) }, orderBy: { createdAt: "desc" }, take: 50 }),
    botChatStats(id),
    pendingNotes(id),
  ]);
  const groups = new Map(parseLeadNotify(client.leadNotify).targets.map((x) => [x.chatId, x.title || t("notify.botPage.group", { code: chatCode(x.chatId) })]));
  const base = `/clients/${id}/notify/bot`;
  return (
    <div className="space-y-6">
      {notes.length > 0 && (
        <Card title={t("notify.botPage.notesTitle", { n: notes.length })}>
          <p className="mb-3 text-sm text-mut">{t("notify.botPage.notesIntro")}</p>
          <ul className="divide-y divide-line">
            {notes.map((n) => (
              <li key={n.id} className="space-y-2 py-3 first:pt-0">
                <p className="text-xs text-mut">
                  {dateTime(n.createdAt)} · <b className="text-ink2">{n.fromName || t("notify.botPage.someone")}:</b> {n.question}
                </p>
                <BotNoteItem clientId={id} id={n.id} note={n.note ?? ""} />
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title={t("notify.botPage.card")}>
        <p className="mb-4 text-sm text-mut">{t("notify.botPage.intro", { app: BRAND.app })}</p>
        <BotSettingsForm clientId={id} initial={own} maxLen={GUIDE_MAX} />
        <details className="mt-4 text-sm">
          <summary className="cursor-pointer text-mut">{t("notify.botPage.globalGuide", { info: global.guide ? t("notify.botPage.chars", { n: global.guide.length }) : t("notify.botPage.empty") })}</summary>
          <p className="mt-2 whitespace-pre-line rounded-lg bg-slate-50 p-3 text-ink2">{global.guide || t("notify.botPage.none")}</p>
          <p className="mt-1 text-xs text-mut">
            {user.role === "admin" ? (
              <Link href="/connections/channels#bot-guide" className="text-indigo-600 hover:underline">
                {t("notify.botPage.editAt")}
              </Link>
            ) : (
              t("notify.botPage.adminEdits")
            )}
          </p>
        </details>
      </Card>

      <Card title={t("notify.botPage.test")}>
        <BotTester clientId={id} />
      </Card>

      <Card
        title={t("notify.botPage.history", { n: stats.total })}
        action={
          <div className="flex gap-2 text-sm">
            <Link href={base} className={only ? "text-indigo-600 hover:underline" : "font-medium text-ink"}>
              {t("notify.botPage.all")}
            </Link>
            <Link href={`${base}?only=unanswered`} className={only ? "font-medium text-ink" : "text-indigo-600 hover:underline"}>
              {t("notify.botPage.unansweredLink", { n: stats.unanswered })}
            </Link>
          </div>
        }
      >
        {!chats.length ? (
          <Empty>{only ? t("notify.botPage.emptyUnanswered") : t("notify.botPage.emptyAll")}</Empty>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {chats.map((c) => {
              const m = MODE[c.mode] ? { label: t(`notify.botPage.mode.${MODE[c.mode].key}`), tone: MODE[c.mode].tone } : { label: c.mode, tone: "gray" as Tone };
              return (
                <li key={c.id} className="space-y-2 py-3">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-mut">
                    <span>{dateTime(c.createdAt)}</span>
                    <span>· {groups.get(c.chatId) ?? t("notify.botPage.group", { code: chatCode(c.chatId) })}</span>
                    <Badge tone={m.tone}>{m.label}</Badge>
                    {!c.answered && <Badge tone="warn">{t("notify.botPage.unanswered")}</Badge>}
                    {c.noteStatus && <Badge tone={c.noteStatus === "pending" ? "warn" : c.noteStatus === "added" ? "good" : "mut"}>{c.noteStatus === "pending" ? t("notify.botPage.notePending") : c.noteStatus === "added" ? t("notify.botPage.noteAdded") : t("notify.botPage.noteDismissed")}</Badge>}
                    {!c.sent && <Badge tone="bad">{t("notify.botPage.notSent")}</Badge>}
                    {c.ms > 0 && <span>{t("notify.botPage.seconds", { n: (c.ms / 1000).toFixed(1) })}</span>}
                  </div>
                  <p className="break-words">
                    <b>{c.fromName || t("notify.botPage.someone")}:</b> {c.question}
                  </p>
                  <p className="whitespace-pre-line break-words rounded-lg bg-slate-50 p-3 text-ink2">{c.answer}</p>
                  {c.error && <p className="text-xs text-rose-600">{c.error}</p>}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
