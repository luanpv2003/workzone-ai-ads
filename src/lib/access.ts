import { cache } from "react";
import { notFound } from "next/navigation";
import { db } from "./db";
import { getT } from "@/i18n/server";
import { requirePageUser, requireUser, type CurrentUser } from "./auth";

// Permissions modeled on Meta Business Manager:
// - System admin (User.role "admin"): sees and can do everything, including System settings.
// - A business (Workspace) owns clients. Business Owner / Admin: full access to every client of that business.
// - Employee: only clients assigned to them (ClientAccess) with 1 of 3 roles: Full access / Advertiser / Analyst.
// Every Server Action, Route Handler and page checks for itself (requireClient / requirePageClient); the proxy additionally guards /clients/<id>.

export * from "./access-roles";
import type { AccessLevel, ClientRole, WorkspaceRole } from "./access-roles";
import { CLIENT_ROLES, WORKSPACE_ROLES } from "./access-roles";

const RANK: Record<ClientRole, number> = { analyst: 1, advertiser: 2, admin: 3 };
const NEED: Record<AccessLevel, number> = { view: 1, edit: 2, manage: 3 };
const denied = async (level: AccessLevel) => (await getT())(`system.access.denied.${level}`);

export const isSystemAdmin = (u: Pick<CurrentUser, "role"> | null | undefined) => u?.role === "admin";
export const roleAllows = (role: ClientRole | null, level: AccessLevel) => !!role && RANK[role] >= NEED[level];
export const asClientRole = (r: string): ClientRole | null => ((CLIENT_ROLES as string[]).includes(r) ? (r as ClientRole) : null);
export const asWorkspaceRole = (r: string): WorkspaceRole => ((WORKSPACE_ROLES as string[]).includes(r) ? (r as WorkspaceRole) : "member");

// ------------------------------------------------------------ A person's permissions

type Grants = { workspaces: { id: string; role: WorkspaceRole }[]; clients: Map<string, ClientRole> };

/** A person's businesses + roles on clients. Called multiple times in one request, the DB is queried only once. */
export const userGrants = cache(async (userId: string): Promise<Grants> => {
  const [members, access] = await Promise.all([
    db.workspaceMember.findMany({ where: { userId }, select: { workspaceId: true, role: true } }),
    db.clientAccess.findMany({ where: { userId }, select: { clientId: true, role: true } }),
  ]);
  const clients = new Map<string, ClientRole>();
  for (const a of access) {
    const r = asClientRole(a.role);
    if (r) clients.set(a.clientId, r);
  }
  return { workspaces: members.map((m) => ({ id: m.workspaceId, role: asWorkspaceRole(m.role) })), clients };
});

const isWsAdmin = (r: WorkspaceRole) => r === "owner" || r === "admin";

/** The user's role on a client; null = no access (or the client does not exist). */
export async function clientRoleOf(user: CurrentUser, clientId: string): Promise<ClientRole | null> {
  const client = await db.client.findUnique({ where: { id: clientId }, select: { workspaceId: true } });
  if (!client) return null;
  if (isSystemAdmin(user)) return "admin";
  const g = await userGrants(user.id);
  if (g.workspaces.some((w) => w.id === client.workspaceId && isWsAdmin(w.role))) return "admin";
  return g.clients.get(clientId) ?? null;
}

/** Ids of clients the user may view; null = all clients (system admin). */
export async function visibleClientIds(user: CurrentUser): Promise<string[] | null> {
  if (isSystemAdmin(user)) return null;
  const g = await userGrants(user.id);
  const wsIds = g.workspaces.filter((w) => isWsAdmin(w.role)).map((w) => w.id);
  const owned = wsIds.length ? await db.client.findMany({ where: { workspaceId: { in: wsIds } }, select: { id: true } }) : [];
  return [...new Set([...owned.map((c) => c.id), ...g.clients.keys()])];
}

/** Prisma condition filtering a table with a clientId column to viewable clients. Usage: `where: { ...(await clientScope(user)), status: "pending" }`. */
export async function clientScope(user: CurrentUser): Promise<{ clientId?: { in: string[] } }> {
  const ids = await visibleClientIds(user);
  return ids ? { clientId: { in: ids } } : {};
}

/** Like clientScope but for the Client table itself (filters by id). */
export async function clientWhere(user: CurrentUser): Promise<{ id?: { in: string[] } }> {
  const ids = await visibleClientIds(user);
  return ids ? { id: { in: ids } } : {};
}

// ------------------------------------------------------------ Checks inside Server Action / Route Handler / page

/** Server Action / Route Handler: throws a readable error when not logged in or lacking permission. Returns the user + role. */
export async function requireClient(clientId: string, level: AccessLevel = "view") {
  const user = await requireUser();
  const role = await clientRoleOf(user, clientId);
  if (!roleAllows(role, level)) throw new Error(await denied(role ? level : "view"));
  return { user, role: role! };
}

/** A client's page/layout: without view access, report not found (does not reveal whether the client exists). */
export async function requirePageClient(clientId: string, level: AccessLevel = "view") {
  const user = await requirePageUser();
  const role = await clientRoleOf(user, clientId);
  if (!roleAllows(role, level)) notFound();
  return { user, role: role! };
}

// Records belonging to a client: look up clientId by record id, then check permission. Add new tables here as needed.
const OWNER = {
  campaign: (id: string) => db.campaign.findUnique({ where: { id }, select: { clientId: true } }),
  adSet: (id: string) => db.adSet.findUnique({ where: { id }, select: { clientId: true } }),
  ad: (id: string) => db.ad.findUnique({ where: { id }, select: { clientId: true } }),
  conversation: (id: string) => db.conversation.findUnique({ where: { id }, select: { clientId: true } }),
  audit: (id: string) => db.audit.findUnique({ where: { id }, select: { clientId: true } }),
  recommendation: (id: string) => db.recommendation.findUnique({ where: { id }, select: { clientId: true } }),
  campaignDraft: (id: string) => db.campaignDraft.findUnique({ where: { id }, select: { clientId: true } }),
  knowledgeDoc: (id: string) => db.knowledgeDoc.findUnique({ where: { id }, select: { clientId: true } }),
  audienceAnalysis: (id: string) => db.audienceAnalysis.findUnique({ where: { id }, select: { clientId: true } }),
  clientJob: (id: string) => db.clientJob.findUnique({ where: { id }, select: { clientId: true } }),
  campaignProposal: (id: string) => db.campaignProposal.findUnique({ where: { id }, select: { clientId: true } }),
  contentReview: (id: string) => db.contentReview.findUnique({ where: { id }, select: { clientId: true } }),
  nurtureFlow: (id: string) => db.nurtureFlow.findUnique({ where: { id }, select: { clientId: true } }),
  clientReport: (id: string) => db.clientReport.findUnique({ where: { id }, select: { clientId: true } }),
  reportSchedule: (id: string) => db.reportSchedule.findUnique({ where: { id }, select: { clientId: true } }),
  lead: (id: string) => db.lead.findUnique({ where: { id }, select: { clientId: true } }),
  leadNotice: (id: string) => db.leadNotice.findUnique({ where: { id }, select: { clientId: true } }),
  salesLift: (id: string) => db.salesLift.findUnique({ where: { id }, select: { clientId: true } }),
  ghlLink: (id: string) => db.ghlLink.findUnique({ where: { id }, select: { clientId: true } }),
  gAdsChange: (id: string) => db.gAdsChange.findUnique({ where: { id }, select: { clientId: true } }),
} satisfies Record<string, (id: string) => Promise<{ clientId: string } | null>>;

type OwnedModel = keyof typeof OWNER;

/** The record's clientId; throws if the record does not exist. */
export async function clientIdOf(model: OwnedModel, id: string) {
  const row = await OWNER[model](id);
  if (!row) throw new Error((await getT())("system.access.notFound"));
  return row.clientId;
}

/** requireClient by child record id (draft, proposal, document…). Also returns clientId. */
export async function requireClientOf(model: OwnedModel, id: string, level: AccessLevel = "view") {
  const user = await requireUser(); // report session expiry before looking up the record
  const clientId = await clientIdOf(model, id);
  const role = await clientRoleOf(user, clientId);
  if (!roleAllows(role, level)) throw new Error(await denied(role ? level : "view"));
  return { user, role: role!, clientId };
}

// ------------------------------------------------------------ Businesses

/** Members of the root business (the platform workspace) or system admins: may view shared System settings (webhook, Claude, messaging channels…). */
export async function isPlatformStaff(user: CurrentUser) {
  if (isSystemAdmin(user)) return true;
  const g = await userGrants(user.id);
  if (!g.workspaces.length) return false;
  return (await db.workspace.count({ where: { id: { in: g.workspaces.map((w) => w.id) }, platform: true } })) > 0;
}

/** Server Action changing shared configuration of the root business (e.g. scanning the Targeting library). */
export async function requirePlatformStaff() {
  const user = await requireUser();
  if (!(await isPlatformStaff(user))) throw new Error((await getT())("system.access.platformOnly"));
  return user;
}

/** Shared System settings page: root-business members only. */
export async function requirePlatformPage() {
  const user = await requirePageUser();
  if (!(await isPlatformStaff(user))) notFound();
  return user;
}

/** Businesses the user can manage (add people, assign roles). System admin: all businesses. */
export async function manageableWorkspaces(user: CurrentUser) {
  if (isSystemAdmin(user)) return db.workspace.findMany({ orderBy: [{ platform: "desc" }, { name: "asc" }] });
  const g = await userGrants(user.id);
  const ids = g.workspaces.filter((w) => isWsAdmin(w.role)).map((w) => w.id);
  return ids.length ? db.workspace.findMany({ where: { id: { in: ids } }, orderBy: { name: "asc" } }) : [];
}

/** Businesses the user is a member of (may create clients in them). */
export async function memberWorkspaces(user: CurrentUser) {
  if (isSystemAdmin(user)) return db.workspace.findMany({ orderBy: [{ platform: "desc" }, { name: "asc" }] });
  const g = await userGrants(user.id);
  return db.workspace.findMany({ where: { id: { in: g.workspaces.map((w) => w.id) } }, orderBy: { name: "asc" } });
}

/** Business billed for Claude calls not tied to a single client (multi-client Ask Claude, creating a client from documents). Root-business members: null (the platform's Claude). */
export async function aiWorkspaceOf(user: CurrentUser): Promise<string | null> {
  if (await isPlatformStaff(user)) return null;
  return (await memberWorkspaces(user))[0]?.id ?? null;
}

/** Throws if the user cannot manage the business (Owner / Admin, or system admin). */
export async function requireWorkspaceAdmin(workspaceId: string) {
  const user = await requireUser();
  if (isSystemAdmin(user)) return { user, role: "owner" as WorkspaceRole };
  const g = await userGrants(user.id);
  const m = g.workspaces.find((w) => w.id === workspaceId);
  if (!m || !isWsAdmin(m.role)) throw new Error((await getT())("system.access.wsAdminOnly"));
  return { user, role: m.role };
}

/** Throws if the user does not belong to the business. */
export async function requireWorkspaceMember(workspaceId: string) {
  const user = await requireUser();
  if (isSystemAdmin(user)) return { user, role: "owner" as WorkspaceRole };
  const m = (await userGrants(user.id)).workspaces.find((w) => w.id === workspaceId);
  if (!m) throw new Error((await getT())("system.access.notMember"));
  return { user, role: m.role };
}
