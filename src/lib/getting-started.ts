import { db } from "./db";
import type { CurrentUser } from "./auth";
import { clientWhere, isPlatformStaff } from "./access";
import { storedCredential } from "./ai/credential";

/**
 * "Bắt đầu" (Getting started) checklist status for one user: connect Meta for a client, connect their own AI (MCP), and the optional
 * built-in Claude key. Cheap queries only: it also feeds the reminder on the home page.
 */
export async function gettingStartedStatus(user: CurrentUser) {
  const where = await clientWhere(user);
  const [firstClient, metaClients, aiConnections, staff, cred] = await Promise.all([
    db.client.findFirst({ where, orderBy: { createdAt: "asc" }, select: { id: true } }),
    db.client.count({ where: { ...where, dataSource: "meta", metaAccessToken: { not: null } } }),
    db.mcpToken.count({ where: { userId: user.id, revokedAt: null, lastUsedAt: { not: null }, OR: [{ kind: "personal" }, { refreshExpiresAt: { gt: new Date() } }] } }),
    isPlatformStaff(user),
    storedCredential(),
  ]);
  const meta = metaClients > 0;
  const ai = aiConnections > 0;
  return {
    firstClientId: firstClient?.id ?? null,
    metaClients,
    aiConnections,
    claudeKey: !!cred,
    /** Only root-workspace members can open the shared Claude AI settings. */
    canSetClaude: staff,
    meta,
    ai,
    /** Required steps still open (the Claude key is optional). */
    left: Number(!meta) + Number(!ai),
  };
}
