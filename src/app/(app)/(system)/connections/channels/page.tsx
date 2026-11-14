import { connection } from "next/server";
import { requirePlatformPage } from "@/lib/access";
import { Badge, Card, PageHeader } from "@/components/ui";
import { ZaloConnect } from "@/components/zalo-connect";
import { ReportChannelsConnect } from "@/components/report-channels-connect";
import { ZaloBotConnect } from "@/components/zalo-bot-connect";
import { BotSettingsForm } from "@/components/bot-settings-form";
import { botSettings, GUIDE_MAX } from "@/lib/lead-bot-report";
import { zaloBotStatus } from "@/lib/zalo-bot";
import { smtpStatus, telegramStatus } from "@/lib/report-channels";
import { callbackUrl, loadTemplate, oaStatus } from "@/lib/zalo";
import { getT } from "@/i18n/server";

export default async function ChannelsPage({ searchParams }: { searchParams: Promise<{ zalo?: string; zalo_error?: string }> }) {
  const user = await requirePlatformPage(); // shared settings: only members of the platform workspace
  await connection();
  const sp = await searchParams;
  const t = await getT();
  const [zalo, tg, smtp, oa, botGuide] = await Promise.all([zaloBotStatus().catch(() => null), telegramStatus().catch(() => null), smtpStatus().catch(() => null), oaStatus().catch(() => null), botSettings(null)]);
  return (
    <>
      <PageHeader title={t("system.channels.title")} subtitle={t("system.channels.subtitle")} />
      <div className="mb-6 flex flex-wrap gap-2 text-sm">
        {[
          [t("system.channels.zaloBot"), zalo?.name],
          ["Telegram", tg?.username && `@${tg.username}`],
          [t("system.channels.email"), smtp?.user],
          [t("system.channels.zaloOaOptional"), oa?.connected ? oa.oaName || "OA" : null],
        ].map(([label, who]) => (
          <span key={label} className="inline-flex items-center gap-2 rounded-lg border border-line bg-panel px-3 py-1.5">
            {label} <Badge tone={who ? "good" : "mut"}>{who ? t("system.channels.connectedWho", { who: String(who) }) : t("system.channels.notConnected")}</Badge>
          </span>
        ))}
      </div>
      <div className="space-y-6">
        <div id="zalo-bot" className="scroll-mt-20">
          <Card title={t("system.channels.zaloBotCard")}>
            <ZaloBotConnect status={zalo} isAdmin={user?.role === "admin"} />
          </Card>
        </div>
        <div id="bot-guide" className="scroll-mt-20">
          <Card title={t("system.channels.botGuideCard")}>
            <p className="mb-3 text-sm text-mut">{t("system.channels.botGuideDesc")}</p>
            {user?.role === "admin" ? <BotSettingsForm clientId={null} initial={botGuide} maxLen={GUIDE_MAX} /> : <p className="whitespace-pre-line text-sm">{botGuide.guide || t("system.channels.none")}</p>}
          </Card>
        </div>
        <div id="report-channels" className="scroll-mt-20">
          <Card title={t("system.channels.emailTelegramCard")}>
            <ReportChannelsConnect smtp={smtp} telegram={tg} isAdmin={user?.role === "admin"} />
          </Card>
        </div>
        <div id="zalo" className="scroll-mt-20">
          <Card title={t("system.channels.zaloOaCard")}>
            <ZaloConnect
              status={oa}
              template={await loadTemplate()}
              callbackUrl={callbackUrl()}
              isAdmin={user?.role === "admin"}
              flash={sp.zalo === "ok" ? { ok: true, text: t("system.channels.zaloOaConnected") } : sp.zalo_error ? { ok: false, text: sp.zalo_error } : null}
            />
          </Card>
        </div>
      </div>
    </>
  );
}
