import Link from "next/link";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requirePageUser } from "@/lib/auth";
import { asClientRole, asWorkspaceRole, isSystemAdmin, manageableWorkspaces } from "@/lib/access";
import { PageHeader } from "@/components/ui";
import { UserAdmin, WorkspaceList } from "@/components/user-admin";
import { WorkspaceClaude } from "@/components/workspace-claude";
import { getT } from "@/i18n/server";
import { workspaceAi } from "@/lib/ai/credential";

// Users & permissions, Business Manager style: workspace → people (workspace role) → permissions on each client.
export default async function UsersPage({ searchParams }: { searchParams: Promise<{ w?: string }> }) {
  await connection();
  const t = await getT();
  const me = await requirePageUser();
  const workspaces = await manageableWorkspaces(me);
  if (!workspaces.length) notFound();
  const { w } = await searchParams;
  const ws = workspaces.find((x) => x.id === w) ?? workspaces[0];
  const sys = isSystemAdmin(me);

  const [members, clients, invites, counts] = await Promise.all([
    db.workspaceMember.findMany({
      where: { workspaceId: ws.id },
      orderBy: { createdAt: "asc" },
      include: { user: { include: { clientAccess: { where: { client: { workspaceId: ws.id } }, select: { clientId: true, role: true } } } } },
    }),
    db.client.findMany({ where: { workspaceId: ws.id }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    db.invite.findMany({ where: { workspaceId: ws.id, usedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" } }),
    sys
      ? Promise.all([
          db.workspaceMember.groupBy({ by: ["workspaceId"], _count: true }),
          db.client.groupBy({ by: ["workspaceId"], _count: true }),
        ])
      : null,
  ]);
  // Own Claude: external workspaces only (the platform workspace uses System settings → Claude AI).
  const ai = ws.platform ? null : await workspaceAi(ws.id);
  const myRole = sys ? "owner" : asWorkspaceRole(members.find((m) => m.userId === me.id)?.role ?? "member");

  return (
    <>
      <PageHeader
        title={t("system.users.title")}
        subtitle={t("system.users.subtitle")}
      />
      {workspaces.length > 1 && (
        <div className="mb-4 flex flex-wrap gap-1.5">
          {workspaces.map((x) => (
            <Link
              key={x.id}
              href={`/users?w=${x.id}`}
              scroll={false}
              className={`inline-flex h-7 items-center rounded-full px-3 text-xs font-medium ${x.id === ws.id ? "bg-ink text-panel" : "border border-line bg-panel text-ink2 hover:bg-hover"}`}
            >
              {x.name}
            </Link>
          ))}
        </div>
      )}
      <UserAdmin
        key={ws.id}
        meId={me.id}
        sysAdmin={sys}
        myRole={myRole}
        workspace={{ id: ws.id, name: ws.name, platform: ws.platform }}
        clients={clients}
        members={members.map((m) => ({
          id: m.user.id,
          email: m.user.email,
          name: m.user.name,
          sysAdmin: m.user.role === "admin",
          active: m.user.active,
          lastLoginAt: m.user.lastLoginAt?.toISOString() ?? null,
          role: asWorkspaceRole(m.role),
          access: Object.fromEntries(m.user.clientAccess.flatMap((a) => (asClientRole(a.role) ? [[a.clientId, asClientRole(a.role)!]] : []))),
        }))}
        invites={invites.map((i) => ({ id: i.id, email: i.email, role: asWorkspaceRole(i.role), createdBy: i.createdBy, expiresAt: i.expiresAt.toISOString() }))}
      />
      {!ws.platform && (
        <WorkspaceClaude
          key={`ai-${ws.id}`}
          workspaceId={ws.id}
          cred={ai?.cred ? { label: ai.cred.label, kind: ai.cred.kind, savedBy: ai.cred.savedBy, savedAt: ai.cred.savedAt } : null}
        />
      )}
      {counts && (
        <WorkspaceList
          current={ws.id}
          items={workspaces.map((x) => ({
            id: x.id,
            name: x.name,
            platform: x.platform,
            members: counts[0].find((c) => c.workspaceId === x.id)?._count ?? 0,
            clients: counts[1].find((c) => c.workspaceId === x.id)?._count ?? 0,
          }))}
        />
      )}
    </>
  );
}
