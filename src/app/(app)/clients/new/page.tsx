import { NewClient } from "@/components/new-client";
import { Empty, PageHeader } from "@/components/ui";
import { requirePageUser } from "@/lib/auth";
import { memberWorkspaces } from "@/lib/access";
import { getT } from "@/i18n/server";

export default async function NewClientPage() {
  const t = await getT();
  const user = await requirePageUser(); // check the session right on the page: the layout may not re-run on client-side navigation
  const workspaces = (await memberWorkspaces(user)).map((w) => ({ id: w.id, name: w.name }));
  return (
    <>
      <PageHeader title={t("customers.newClientPage.title")} subtitle={t("customers.newClientPage.subtitle")} />
      {workspaces.length ? <NewClient workspaces={workspaces} /> : <Empty>{t("customers.newClientPage.noWorkspace")}</Empty>}
    </>
  );
}
