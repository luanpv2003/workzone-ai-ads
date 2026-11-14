"use server";

import { createHash, randomBytes } from "node:crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { hashPassword, login, logout, requireAdmin, requireUser } from "@/lib/auth";
import { asClientRole, asWorkspaceRole, requireClient, requireWorkspaceAdmin, type ClientRole, type WorkspaceRole } from "@/lib/access";
import { publicUrl } from "@/lib/zalo";
import { errorMessage, logActivity } from "@/lib/activity";
import { getT } from "@/i18n/server";

/** Only allow returning to internal paths (prevents open-redirect abuse to external sites). */
function safeNext(v: FormDataEntryValue | null) {
  const s = typeof v === "string" ? v : "";
  // Same-origin relative path only: no "//host", no backslash (browsers read "/\host" as "//host"), no control characters or schemes.
  if (!s.startsWith("/") || /[\\\u0000-\u001f\u007f]/.test(s) || s.startsWith("//")) return "/";
  try {
    const u = new URL(s, "http://local.invalid");
    if (u.origin !== "http://local.invalid" || u.pathname.startsWith("/login")) return "/";
    return u.pathname + u.search + u.hash;
  } catch {
    return "/";
  }
}

export async function loginAction(_prev: { error: string } | null, form: FormData): Promise<{ error: string } | null> {
  const email = String(form.get("email") ?? "");
  const password = String(form.get("password") ?? "");
  if (!email || !password) return { error: (await getT())("system.authActions.enterCreds") };
  const err = await login(email, password);
  if (err) return { error: err };
  redirect(safeNext(form.get("next")));
}

export async function logoutAction() {
  await logout();
  redirect("/login");
}

// ------------------------------------------------------------ Users & permissions (Business Manager style, see lib/access.ts)

type Result = { ok: true } | { ok: false; error: string };

async function guard(fn: () => Promise<void>): Promise<Result> {
  try {
    await fn();
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const INVITE_DAYS = 7;
const validEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

type Grant = { clientId: string; role: ClientRole };

/** Only keep permissions on clients belonging to this workspace (can't grant clients of another workspace). */
async function cleanGrants(workspaceId: string, grants: { clientId: string; role: string }[]): Promise<Grant[]> {
  const own = new Set((await db.client.findMany({ where: { workspaceId, id: { in: grants.map((g) => g.clientId) } }, select: { id: true } })).map((c) => c.id));
  return grants.flatMap((g) => {
    const role = asClientRole(g.role);
    return role && own.has(g.clientId) ? [{ clientId: g.clientId, role }] : [];
  });
}

/** Only an Owner (or a system admin) can assign / remove the Owner role. */
async function assertCanSetOwner(actorRole: WorkspaceRole, ...roles: string[]) {
  if (roles.includes("owner") && actorRole !== "owner") throw new Error((await getT())("system.authActions.ownerOnly"));
}

async function ownersLeft(workspaceId: string, exceptUserId: string) {
  return db.workspaceMember.count({ where: { workspaceId, role: "owner", userId: { not: exceptUserId } } });
}

/** A system admin creates a new workspace (e.g. another agency / freelancer), then invites the Owner. */
export async function createWorkspaceAction(name: string): Promise<Result & { id?: string }> {
  try {
    const admin = await requireAdmin();
    if (!name.trim()) throw new Error((await getT())("system.authActions.noWsName"));
    const ws = await db.workspace.create({ data: { name: name.trim().slice(0, 100) } });
    await logActivity(null, "sync", (await getT())("system.authActions.logCreateWs", { actor: admin.name, ws: ws.name }));
    revalidatePath("/users");
    return { ok: true, id: ws.id };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function renameWorkspaceAction(workspaceId: string, name: string): Promise<Result> {
  return guard(async () => {
    await requireWorkspaceAdmin(workspaceId);
    if (!name.trim()) throw new Error((await getT())("system.authActions.noWsName"));
    await db.workspace.update({ where: { id: workspaceId }, data: { name: name.trim().slice(0, 100) } });
  });
}

/**
 * Add a person to the workspace. Email already has an account → added immediately; otherwise → create an invite link (single use, 7 days)
 * for the manager to send via Zalo/email. Per-client permissions can be granted upfront.
 */
export async function inviteMemberAction(
  workspaceId: string,
  input: { email: string; role: string; grants: { clientId: string; role: string }[] },
): Promise<{ ok: true; added?: string; url?: string } | { ok: false; error: string }> {
  try {
    const { user: actor, role: actorRole } = await requireWorkspaceAdmin(workspaceId);
    const email = input.email.trim().toLowerCase();
    if (!validEmail(email)) throw new Error((await getT())("system.authActions.invalidEmail"));
    const role = asWorkspaceRole(input.role);
    await assertCanSetOwner(actorRole, role);
    const grants = role === "member" ? await cleanGrants(workspaceId, input.grants) : [];
    const ws = await db.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    const existing = await db.user.findUnique({ where: { email } });
    if (existing) {
      if (await db.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId: existing.id } } }))
        throw new Error((await getT())("system.authActions.alreadyMember", { name: existing.name }));
      await db.$transaction([
        db.workspaceMember.create({ data: { workspaceId, userId: existing.id, role } }),
        ...grants.map((g) =>
          db.clientAccess.upsert({
            where: { clientId_userId: { clientId: g.clientId, userId: existing.id } },
            create: { ...g, userId: existing.id, grantedBy: actor.name },
            update: { role: g.role, grantedBy: actor.name },
          }),
        ),
      ]);
      await logActivity(null, "sync", (await getT())("system.authActions.logAdded", { actor: actor.name, name: existing.name, ws: ws.name }));
      revalidatePath("/users");
      return { ok: true, added: existing.name };
    }
    const code = randomBytes(24).toString("base64url");
    await db.invite.create({
      data: { id: sha256(code), workspaceId, email, role, access: JSON.stringify(grants), createdBy: actor.name, expiresAt: new Date(Date.now() + INVITE_DAYS * 86400000) },
    });
    await logActivity(null, "sync", (await getT())("system.authActions.logInvited", { actor: actor.name, email, ws: ws.name }));
    revalidatePath("/users");
    return { ok: true, url: `${publicUrl()}/invite/${code}` };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function revokeInviteAction(inviteId: string): Promise<Result> {
  return guard(async () => {
    const inv = await db.invite.findUniqueOrThrow({ where: { id: inviteId } });
    await requireWorkspaceAdmin(inv.workspaceId);
    await db.invite.delete({ where: { id: inviteId } });
  });
}

export async function setMemberRoleAction(workspaceId: string, userId: string, role: string): Promise<Result> {
  return guard(async () => {
    const { user: actor, role: actorRole } = await requireWorkspaceAdmin(workspaceId);
    if (userId === actor.id) throw new Error((await getT())("system.authActions.noSelfRole"));
    const m = await db.workspaceMember.findUniqueOrThrow({ where: { workspaceId_userId: { workspaceId, userId } }, include: { user: true } });
    const next = asWorkspaceRole(role);
    await assertCanSetOwner(actorRole, m.role, next);
    if (m.role === "owner" && next !== "owner" && !(await ownersLeft(workspaceId, userId))) throw new Error((await getT())("system.authActions.needOneOwner"));
    await db.workspaceMember.update({ where: { id: m.id }, data: { role: next } });
    await logActivity(null, "sync", (await getT())("system.authActions.logRoleChanged", { actor: actor.name, name: m.user.name, role: next }));
  });
}

/** Remove a person from the workspace: they also lose permissions on all of this workspace's clients (the account remains). */
export async function removeMemberAction(workspaceId: string, userId: string): Promise<Result> {
  return guard(async () => {
    const { user: actor, role: actorRole } = await requireWorkspaceAdmin(workspaceId);
    if (userId === actor.id) throw new Error((await getT())("system.authActions.noSelfRemove"));
    const m = await db.workspaceMember.findUniqueOrThrow({ where: { workspaceId_userId: { workspaceId, userId } }, include: { user: true } });
    await assertCanSetOwner(actorRole, m.role);
    if (m.role === "owner" && !(await ownersLeft(workspaceId, userId))) throw new Error((await getT())("system.authActions.needOneOwner"));
    await db.$transaction([
      db.clientAccess.deleteMany({ where: { userId, client: { workspaceId } } }),
      db.workspaceMember.delete({ where: { id: m.id } }),
    ]);
    await logActivity(null, "sync", (await getT())("system.authActions.logRemoved", { actor: actor.name, name: m.user.name }));
  });
}

/** Grant / change / remove a person's permission on a client (role null = remove). The person must belong to the client's workspace. */
export async function setClientAccessAction(clientId: string, userId: string, role: string | null): Promise<Result> {
  return guard(async () => {
    const { user: actor } = await requireClient(clientId, "manage");
    const client = await db.client.findUniqueOrThrow({ where: { id: clientId }, select: { name: true, workspaceId: true } });
    const target = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { name: true } });
    if (!role) {
      if (userId === actor.id) throw new Error((await getT())("system.authActions.noSelfRevoke"));
      await db.clientAccess.deleteMany({ where: { clientId, userId } });
      await logActivity(clientId, "sync", (await getT())("system.authActions.logRevoked", { actor: actor.name, name: target.name, client: client.name }));
      return;
    }
    const r = asClientRole(role);
    if (!r) throw new Error((await getT())("system.authActions.invalidRole"));
    if (!(await db.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: client.workspaceId, userId } } })))
      throw new Error((await getT())("system.authActions.notInWs", { name: target.name }));
    await db.clientAccess.upsert({
      where: { clientId_userId: { clientId, userId } },
      create: { clientId, userId, role: r, grantedBy: actor.name },
      update: { role: r, grantedBy: actor.name },
    });
    await logActivity(clientId, "sync", (await getT())("system.authActions.logGranted", { actor: actor.name, role: r, client: client.name, name: target.name }));
  });
}

/**
 * Move a client to another workspace (e.g. hand an old platform client over to a new agency): the actor must be Owner / Admin
 * of both workspaces (or a system admin). Per-client grants of people outside the new workspace are removed; client data stays as is.
 */
export async function moveClientAction(clientId: string, workspaceId: string): Promise<Result> {
  return guard(async () => {
    const { user: actor } = await requireClient(clientId, "manage");
    const client = await db.client.findUniqueOrThrow({ where: { id: clientId }, select: { name: true, workspaceId: true } });
    if (client.workspaceId === workspaceId) return;
    if (client.workspaceId) await requireWorkspaceAdmin(client.workspaceId);
    await requireWorkspaceAdmin(workspaceId);
    const target = await db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { name: true } });
    const members = await db.workspaceMember.findMany({ where: { workspaceId }, select: { userId: true } });
    await db.$transaction([
      db.client.update({ where: { id: clientId }, data: { workspaceId } }),
      db.clientAccess.deleteMany({ where: { clientId, userId: { notIn: members.map((m) => m.userId) } } }),
    ]);
    await logActivity(clientId, "sync", (await getT())("system.authActions.logMoved", { actor: actor.name, client: client.name, ws: target.name }));
  });
}

// Accounts (login, lock, system admin rights) are shared across all workspaces → system admins only.

export async function resetPasswordAction(userId: string, password: string): Promise<Result> {
  return guard(async () => {
    const admin = await requireAdmin();
    const u = await db.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(password) } });
    await db.session.deleteMany({ where: { userId } }); // sign the user out of all devices
    await logActivity(null, "sync", (await getT())("system.authActions.logPwReset", { actor: admin.name, name: u.name }));
  });
}

export async function setUserActiveAction(userId: string, active: boolean): Promise<Result> {
  return guard(async () => {
    const admin = await requireAdmin();
    if (userId === admin.id) throw new Error((await getT())("system.authActions.noSelfLock"));
    const u = await db.user.update({ where: { id: userId }, data: { active } });
    if (!active) await db.session.deleteMany({ where: { userId } });
    await logActivity(null, "sync", (await getT())(active ? "system.authActions.logUnlocked" : "system.authActions.logLocked", { actor: admin.name, name: u.name }));
  });
}

/** Toggle system admin rights (sees all workspaces, System settings). */
export async function setUserRoleAction(userId: string, role: string): Promise<Result> {
  return guard(async () => {
    const admin = await requireAdmin();
    if (userId === admin.id) throw new Error((await getT())("system.authActions.noSelfAdmin"));
    const u = await db.user.update({ where: { id: userId }, data: { role: role === "admin" ? "admin" : "member" } });
    await logActivity(null, "sync", (await getT())(u.role === "admin" ? "system.authActions.logAdminOn" : "system.authActions.logAdminOff", { actor: admin.name, name: u.name }));
  });
}

// ------------------------------------------------------------ Accept invite (public page /invite/<code>)

async function openInvite(code: string) {
  const inv = await db.invite.findUnique({ where: { id: sha256(code) }, include: { workspace: true } });
  if (!inv || inv.usedAt || inv.expiresAt < new Date()) throw new Error((await getT())("system.authActions.inviteInvalid"));
  return inv;
}

async function joinWorkspace(inv: Awaited<ReturnType<typeof openInvite>>, userId: string) {
  const grants = await cleanGrants(inv.workspaceId, JSON.parse(inv.access) as Grant[]);
  await db.$transaction([
    db.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId: inv.workspaceId, userId } },
      create: { workspaceId: inv.workspaceId, userId, role: inv.role },
      update: {},
    }),
    ...grants.map((g) =>
      db.clientAccess.upsert({
        where: { clientId_userId: { clientId: g.clientId, userId } },
        create: { ...g, userId, grantedBy: inv.createdBy },
        update: {},
      }),
    ),
    db.invite.update({ where: { id: inv.id }, data: { usedAt: new Date() } }),
  ]);
}

/** No account yet: create the account (email fixed by the invite) then log in right away. */
export async function acceptInviteAction(_prev: { error: string } | null, form: FormData): Promise<{ error: string } | null> {
  try {
    const inv = await openInvite(String(form.get("code") ?? ""));
    const name = String(form.get("name") ?? "").trim();
    const password = String(form.get("password") ?? "");
    if (!name) throw new Error((await getT())("system.authActions.enterName"));
    if (password !== String(form.get("confirm") ?? "")) throw new Error((await getT())("system.authActions.pwMismatch"));
    if (await db.user.findUnique({ where: { email: inv.email } })) throw new Error((await getT())("system.authActions.emailHasAccount"));
    const user = await db.user.create({ data: { email: inv.email, name: name.slice(0, 100), passwordHash: await hashPassword(password), role: "member" } });
    await joinWorkspace(inv, user.id);
    const err = await login(inv.email, password);
    if (err) throw new Error(err);
  } catch (err) {
    return { error: errorMessage(err) };
  }
  redirect("/");
}

/** Already has an account (logged in with the invited email): accept the invite. */
export async function joinInviteAction(code: string): Promise<Result> {
  try {
    const user = await requireUser();
    const inv = await openInvite(code);
    if (user.email !== inv.email) throw new Error((await getT())("system.authActions.inviteForOther", { email: inv.email }));
    await joinWorkspace(inv, user.id);
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
