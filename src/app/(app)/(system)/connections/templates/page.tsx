import { connection } from "next/server";
import { requirePlatformPage } from "@/lib/access";
import { Card, PageHeader } from "@/components/ui";
import { NotifyTemplatesEditor } from "@/components/notify-templates-editor";
import { globalTemplates } from "@/lib/notify-templates-db";
import { getT } from "@/i18n/server";

export default async function TemplatesPage() {
  const user = await requirePlatformPage(); // shared settings: only members of the platform workspace
  await connection();
  const t = await getT();
  return (
    <>
      <PageHeader title={t("system.templates.title")} subtitle={t("system.templates.subtitle")} />
      <Card>
        <NotifyTemplatesEditor clientId={null} clientName={t("system.templates.exampleClient")} own={await globalTemplates()} global={{}} canEdit={user?.role === "admin"} />
      </Card>
    </>
  );
}
