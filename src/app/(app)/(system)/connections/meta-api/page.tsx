import { connection } from "next/server";
import { requirePlatformPage } from "@/lib/access";
import { db } from "@/lib/db";
import { PageHeader } from "@/components/ui";
import { readUsage } from "@/lib/meta/rate-limit";
import { ApiUsagePanel } from "@/components/api-usage-panel";
import { getT } from "@/i18n/server";

export default async function MetaApiPage() {
  await requirePlatformPage(); // shared settings: only members of the platform workspace
  await connection();
  const t = await getT();
  const [clients, usage] = await Promise.all([db.client.findMany({ orderBy: { name: "asc" } }), readUsage()]);
  return (
    <>
      <PageHeader title={t("system.metaApi.title")} subtitle={t("system.metaApi.subtitle")} />
      <ApiUsagePanel
        snap={usage}
        names={new Map(clients.flatMap((c) => [...(c.metaAdAccountId ? [[c.metaAdAccountId.replace(/^act_/, ""), c.name] as [string, string]] : []), ...(c.metaPageId ? [[c.metaPageId, c.metaPageName || c.name] as [string, string]] : [])]))}
      />
    </>
  );
}
