import { db } from "./db";
import { hashPassword } from "./auth";
import { BRAND } from "./brand";
import { getT } from "@/i18n/server";

// First-run setup: on a fresh installation (no account at all) the first visitor creates the system admin in the browser.
// Once any account exists this is closed for good: further accounts come from invites or `npm run user:add`.

const validEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

export class SetupClosedError extends Error {}

/** The root workspace (owns shared System settings). Created on first use; `tx` lets it join a transaction. */
export async function rootWorkspace(tx: Pick<typeof db, "workspace"> = db) {
  return (await tx.workspace.findFirst({ where: { platform: true }, orderBy: { createdAt: "asc" } })) ?? (await tx.workspace.create({ data: { name: BRAND.agency, platform: true } }));
}

/**
 * Create the first admin (system admin + Owner of the root workspace). Race-safe: a transaction-level advisory lock
 * serialises concurrent calls, and the "no user yet" check runs inside the lock, so two requests at once can never both succeed.
 */
export async function createFirstAdmin(input: { name: string; email: string; password: string }) {
  const t = await getT();
  const name = input.name.trim().slice(0, 100);
  const email = input.email.trim().toLowerCase();
  if (!name) throw new Error(t("system.authActions.enterName"));
  if (!validEmail(email)) throw new Error(t("system.authActions.invalidEmail"));
  const passwordHash = await hashPassword(input.password); // enforces MIN_PASSWORD; hashed before taking the lock (scrypt is slow)
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('workzone-ai-ads:first-run-setup'))`;
    if ((await tx.user.count()) > 0) throw new SetupClosedError(t("system.setup.closed"));
    const user = await tx.user.create({ data: { email, name, passwordHash, role: "admin" } });
    const ws = await rootWorkspace(tx);
    await tx.workspaceMember.create({ data: { workspaceId: ws.id, userId: user.id, role: "owner" } });
    return user;
  });
}
