import { publicUrl } from "@/lib/zalo";
import { connection } from "next/server";
import { requirePlatformPage } from "@/lib/access";
import { db } from "@/lib/db";
import { Card, PageHeader } from "@/components/ui";
import { WebhookPanel } from "@/components/webhook-panel";
import { verifyToken } from "@/lib/webhook";
import { getT } from "@/i18n/server";

export default async function WebhookPage() {
  const user = await requirePlatformPage(); // shared settings: only members of the platform workspace
  await connection();
  const t = await getT();
  const now = new Date().getTime();
  const meta = await db.client.findMany({ where: { dataSource: "meta" }, orderBy: { name: "asc" } });
  return (
    <>
      <PageHeader title={t("system.webhook.title")} subtitle={t("system.webhook.subtitle")} />
      <Card>
        <p className="mb-3 text-sm text-slate-600">
          {t("system.webhook.p1a")}<b>{t("system.webhook.p1b")}</b>{t("system.webhook.p1c")}{" "}
          {t("system.webhook.p2a")}<b>{t("system.webhook.p2b")}</b>{t("system.webhook.p2c")}{" "}
          {t("system.webhook.p3a")}<code>messages</code>, <code>message_echoes</code>{t("system.webhook.p3b")}, <code>messaging_referrals</code>, <code>messaging_postbacks</code>{t("system.webhook.p3c")}
        </p>
        <WebhookPanel
          callbackUrl={`${publicUrl()}/api/meta/webhook`}
          verifyToken={await verifyToken()}
          isAdmin={user?.role === "admin"}
          apps={await Promise.all(
            (await db.webhookApp.findMany({ orderBy: { createdAt: "asc" } })).map(async (a) => ({
              appId: a.appId,
              name: a.name,
              lastEventAt: a.lastEventAt?.toISOString() ?? null,
              referrals7d: await db.adReferral.count({ where: { appId: a.appId, createdAt: { gt: new Date(now - 7 * 86400000) } } }),
            })),
          )}
          clients={await Promise.all(
            meta.map(async (c) => ({
              id: c.id,
              name: c.name,
              appHint: c.metaTokenOwner ? t("system.webhook.tokenOf", { owner: c.metaTokenOwner }) : t("system.webhook.tokenUnchecked"),
              fromAds: await db.conversation.count({ where: { clientId: c.id, sourceAdId: { not: null } } }),
            })),
          )}
        />
      </Card>
    </>
  );
}
