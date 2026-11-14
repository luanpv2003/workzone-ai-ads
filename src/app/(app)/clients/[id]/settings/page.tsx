import { connection } from "next/server";
import { db } from "@/lib/db";
import { deleteClientAction, updateClientAction } from "@/app/actions";
import { ClientForm } from "@/components/client-form";
import { ConfirmButton } from "@/components/confirm-button";
import { Card } from "@/components/ui";
import { asClientRole, asWorkspaceRole, manageableWorkspaces, requirePageClient } from "@/lib/access";
import { ClientPeople } from "@/components/client-people";
import { getT } from "@/i18n/server";

export default async function SettingsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ new?: string }> }) {
  await connection();
  const t = await getT();
  const { id } = await params;
  const { user, role } = await requirePageClient(id); // check access right on the page: the layout may not re-run on client-side navigation
  const { new: isNew } = await searchParams;
  const [c, docs] = await Promise.all([db.client.findUniqueOrThrow({ where: { id }, include: { workspace: true } }), db.knowledgeDoc.count({ where: { clientId: id } })]);
  // People in the client's workspace + their permissions on this client (like the People tab of a Meta ad account).
  const members = c.workspaceId
    ? await db.workspaceMember.findMany({
        where: { workspaceId: c.workspaceId },
        orderBy: { createdAt: "asc" },
        include: { user: { select: { id: true, name: true, email: true, active: true, clientAccess: { where: { clientId: id }, select: { role: true } } } } },
      })
    : [];
  // Move the client to another workspace: only if the user can manage both the current workspace and at least one other workspace.
  const mine = role === "admin" ? await manageableWorkspaces(user) : [];
  const moveTo = mine.some((w) => w.id === c.workspaceId) ? mine.filter((w) => w.id !== c.workspaceId).map((w) => ({ id: w.id, name: w.name })) : [];
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the KiotViet secret is not sent to the browser
  const { metaAccessToken, kiotSecret, ghlToken, workspace, ...rest } = c;

  return (
    <div className="space-y-6">
      {isNew && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
          <p className="font-medium">{t("settings.settingsPage.created")}{docs ? ` · ${t("settings.settingsPage.docsInKb", { count: docs })}` : ""}</p>
          <p className="mt-1">
            {t("settings.settingsPage.nextBefore")}<b>{t("settings.settingsPage.nextSource")}</b>{t("settings.settingsPage.nextAfterSource")}<b>{t("settings.settingsPage.nextCheck")}</b>{t("settings.settingsPage.nextAfterCheck")}<b>{t("settings.settingsPage.nextSave")}</b>{t("settings.settingsPage.nextAfterSave")}<b>{t("settings.settingsPage.nextUpdate")}</b>{t("settings.settingsPage.nextEnd")}
          </p>
        </div>
      )}
      <div id="info">
        <Card>
          <ClientForm clientId={id} initial={{ ...rest, hasToken: !!metaAccessToken }} update={updateClientAction.bind(null, id)} />
        </Card>
      </div>
      <div id="people">
        <ClientPeople
          clientId={id}
          meId={user.id}
          canManage={role === "admin"}
          workspace={workspace?.name ?? null}
          moveTo={moveTo}
          people={members.map((m) => ({
            id: m.user.id,
            name: m.user.name,
            email: m.user.email,
            active: m.user.active,
            wsRole: asWorkspaceRole(m.role),
            role: m.user.clientAccess[0] ? asClientRole(m.user.clientAccess[0].role) : null,
          }))}
        />
      </div>
      <div id="delete">
        <Card title={t("settings.settingsPage.deleteTitle")}>
          <form action={deleteClientAction.bind(null, id)} className="flex items-center justify-between gap-4">
            <p className="text-sm text-slate-600">{t("settings.settingsPage.deleteDesc")}</p>
            <ConfirmButton message={t("settings.settingsPage.deleteConfirm", { name: c.name })}>
              {t("settings.settingsPage.deleteBtn")}
            </ConfirmButton>
          </form>
        </Card>
      </div>
    </div>
  );
}
