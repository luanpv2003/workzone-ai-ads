import type { Client } from "@prisma/client";
import { db } from "./db";
import { decrypt, encrypt } from "./crypto";
import { logActivity } from "./activity";
import { cleanToken, inspectToken, type TokenInspection } from "./meta/inspect";
import { getT } from "@/i18n/server";

// Track the status of each client's Meta Access Token.

const WARN_DAYS = 7;

export type TokenLevel = "ok" | "warning" | "expired" | "error" | "missing" | "unchecked";

type TokenFields = Pick<Client, "dataSource" | "metaAccessToken" | "metaTokenExpiresAt" | "metaTokenError" | "metaTokenMissing" | "metaTokenCheckedAt">;

/** Warning level for coloring in the UI. */
export function tokenLevel(c: TokenFields, now = Date.now()): TokenLevel {
  if (!c.metaAccessToken) return "missing";
  if (c.metaTokenError) return "error";
  if (c.metaTokenExpiresAt && c.metaTokenExpiresAt.getTime() < now) return "expired";
  if (!c.metaTokenCheckedAt) return "unchecked";
  if (c.metaTokenExpiresAt && c.metaTokenExpiresAt.getTime() - now < WARN_DAYS * 86400000) return "warning";
  if (c.metaTokenMissing && JSON.parse(c.metaTokenMissing).length) return "warning";
  return "ok";
}

function statusData(info: TokenInspection) {
  return {
    metaTokenOwnerId: info.userId,
    metaTokenOwner: info.userName,
    // If the expiry can't be read, keep the old one; don't record "never expires".
    ...(info.expiresAt !== undefined && { metaTokenExpiresAt: info.expiresAt ? new Date(info.expiresAt) : null }),
    metaTokenMissing: JSON.stringify(info.missingPermissions),
    metaTokenError: null,
    metaTokenCheckedAt: new Date(),
  };
}

/** Re-check the client's saved token and write the result to the DB. */
export async function checkClientToken(clientId: string) {
  const t = await getT();
  const c = await db.client.findUniqueOrThrow({ where: { id: clientId } });
  if (!c.metaAccessToken) throw new Error(t("settings.tokenStatus.noToken"));
  try {
    const info = await inspectToken(decrypt(c.metaAccessToken));
    await db.client.update({ where: { id: clientId }, data: statusData(info) });
    return info;
  } catch (err) {
    // A network error (fetch failed) doesn't mean the token is broken: don't flag a token error.
    if (!(err instanceof TypeError)) {
      const msg = err instanceof Error ? err.message : String(err);
      await db.client.update({ where: { id: clientId }, data: { metaTokenError: msg, metaTokenCheckedAt: new Date() } });
    }
    throw err;
  }
}

/** Check the tokens of all clients connected to Meta. Returns the number of failing tokens. */
export async function checkAllTokens() {
  const clients = await db.client.findMany({ where: { dataSource: "meta", metaAccessToken: { not: null } }, select: { id: true } });
  let failed = 0;
  for (const c of clients) await checkClientToken(c.id).catch(() => failed++);
  return { total: clients.length, failed };
}

/**
 * Save a new token after validating it. If applyToSameOwner, also update other clients
 * using a token from the same Facebook account (one token shared across multiple clients).
 */
export async function replaceToken(clientId: string, rawToken: string, applyToSameOwner: boolean) {
  const t = await getT();
  const token = cleanToken(rawToken);
  if (!token) throw new Error(t("settings.tokenStatus.notPasted"));
  const info = await inspectToken(token); // on error stop, don't overwrite the old token
  const current = await db.client.findUniqueOrThrow({ where: { id: clientId } });
  const data = { metaAccessToken: encrypt(token), ...statusData(info) };

  // Only apply to clients using a token of the SAME Facebook account that owns the new token.
  // (Pasting person B's token into a client using person A's token must not spread to A's other clients.)
  const targets =
    applyToSameOwner
      ? await db.client.findMany({ where: { OR: [{ id: clientId }, { metaTokenOwnerId: info.userId }] }, select: { id: true, name: true } })
      : [{ id: clientId, name: current.name }];
  const expiry = info.expiresAt ? new Date(info.expiresAt).toLocaleDateString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }) : info.expiresAt === null ? t("settings.tokenStatus.never") : t("settings.tokenStatus.unknown");
  for (const target of targets) {
    await db.client.update({ where: { id: target.id }, data });
    await logActivity(target.id, "sync", t("settings.tokenStatus.updated", { owner: info.userName, expiry }));
  }
  return { info, updated: targets.map((x) => x.name) };
}

/** Flag a token error when sync hits an authentication error. */
export async function markTokenError(clientId: string, message: string) {
  await db.client.update({ where: { id: clientId }, data: { metaTokenError: message, metaTokenCheckedAt: new Date() } });
}
