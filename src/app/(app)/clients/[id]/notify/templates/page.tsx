import { connection } from "next/server";
import { db } from "@/lib/db";
import { parseLeadNotify } from "@/lib/lead-notify-config";
import { NotifyTemplatesEditor } from "@/components/notify-templates-editor";
import { globalTemplates } from "@/lib/notify-templates-db";
import { Card } from "@/components/ui";
import { requirePageClient } from "@/lib/access";
import { getT } from "@/i18n/server";

export default async function NotifyTemplatesPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  const t = await getT();
  await requirePageClient(id); // check access right on the page: the layout may not re-run on client-side navigation
  const [client, global] = await Promise.all([db.client.findUniqueOrThrow({ where: { id }, select: { name: true, leadNotify: true } }), globalTemplates()]);
  return (
    <Card title={t("notify.templatesPage.card")}>
      <p className="mb-4 text-sm text-mut">{t("notify.templatesPage.intro")}</p>
      <NotifyTemplatesEditor clientId={id} clientName={client.name} own={parseLeadNotify(client.leadNotify).templates} global={global} canEdit />
    </Card>
  );
}
