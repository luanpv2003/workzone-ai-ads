import { createHash, randomBytes } from "node:crypto";
import { db } from "../db";
import { publicUrl } from "../zalo";
import type { CurrentUser } from "../auth";

// MCP gateway (phase 4): authenticate users by token.
// - Personal token: created on the web (System settings → Your Claude connection), pasted into Claude Code. Valid until revoked.
// - OAuth 2.1 (Claude.ai / Claude Desktop do it automatically): dynamic client registration (RFC 7591), authorization code + PKCE S256, 7-day token,
//   90-day refresh token (rotated on each use).
// Only sha256 of tokens / codes is stored. Permissions = the user's permissions on the web (business, clients) — no MCP-specific permissions.

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const token = (prefix: string) => `${prefix}_${randomBytes(32).toString("base64url")}`;

const ACCESS_TTL_MS = 7 * 86400_000;
const REFRESH_TTL_MS = 90 * 86400_000;
const CODE_TTL_MS = 10 * 60_000;

export const mcpUrl = () => `${publicUrl()}/api/mcp`;
export const issuer = () => publicUrl();

/** New personal token: returns the token (shown once) — only the hash is stored. */
export async function createPersonalToken(userId: string, name: string) {
  const t = token("wza");
  await db.mcpToken.create({ data: { userId, kind: "personal", name: name.trim().slice(0, 60) || "Claude Code", accessHash: sha256(t) } });
  return t;
}

/** Issue an OAuth token pair to the client. */
export async function issueOAuthTokens(userId: string, clientId: string, clientName: string) {
  const access = token("wza");
  const refresh = token("wzr");
  await db.mcpToken.create({
    data: {
      userId,
      kind: "oauth",
      name: clientName.slice(0, 60),
      mcpClientId: clientId,
      accessHash: sha256(access),
      refreshHash: sha256(refresh),
      expiresAt: new Date(Date.now() + ACCESS_TTL_MS),
      refreshExpiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    },
  });
  return { access_token: access, token_type: "Bearer", expires_in: Math.floor(ACCESS_TTL_MS / 1000), refresh_token: refresh, scope: "wzone" };
}

/** Exchange a refresh token: revoke the old set, issue a new one. null if invalid. */
export async function rotateRefresh(refresh: string, clientId: string | null) {
  const t = await db.mcpToken.findUnique({ where: { refreshHash: sha256(refresh) }, include: { user: true } });
  if (!t || t.revokedAt || !t.user.active || (t.refreshExpiresAt && t.refreshExpiresAt < new Date())) return null;
  if (clientId && t.mcpClientId && clientId !== t.mcpClientId) return null;
  await db.mcpToken.update({ where: { id: t.id }, data: { revokedAt: new Date() } });
  return issueOAuthTokens(t.userId, t.mcpClientId ?? clientId ?? "", t.name);
}

/** User for a token (Authorization: Bearer … header). null if missing / wrong / expired / revoked / account locked. */
export async function mcpUser(authorization: string | null): Promise<CurrentUser | null> {
  const m = authorization?.match(/^Bearer\s+(\S+)$/i);
  if (!m) return null;
  const t = await db.mcpToken.findUnique({ where: { accessHash: sha256(m[1]) }, include: { user: true } });
  if (!t || t.revokedAt || !t.user.active || (t.expiresAt && t.expiresAt < new Date())) return null;
  if (!t.lastUsedAt || Date.now() - t.lastUsedAt.getTime() > 5 * 60_000) {
    await db.mcpToken.update({ where: { id: t.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  }
  return { id: t.user.id, email: t.user.email, name: t.user.name, role: t.user.role };
}

// ------------------------------------------------------------ OAuth client + authorization code

/** Valid redirect_uri: https, or http on the local machine (localhost / 127.0.0.1 / [::1]) for Claude Code / Desktop. */
export function validRedirect(uri: string) {
  try {
    if (uri.length > 2000) return false;
    const u = new URL(uri);
    // No fragment, no user:password@ part (it makes the real host hard to read on the consent page).
    if (u.hash || u.username || u.password || !u.hostname) return false;
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

/** Redirect hosts of the hosted connectors (Claude.ai / Claude Desktop, ChatGPT). Others get a warning on the consent page. */
const KNOWN_REDIRECT_HOSTS = /(^|\.)(claude\.ai|claude\.com|anthropic\.com|chatgpt\.com|openai\.com)$/;

/** How the consent page describes a redirect_uri: its host, and whether it is local / a known connector. */
export function redirectInfo(uri: string) {
  const u = new URL(uri);
  const local = u.protocol === "http:";
  return { host: u.host, local, known: local || (u.protocol === "https:" && KNOWN_REDIRECT_HOSTS.test(u.hostname)) };
}

export async function registerClient(name: string, redirectUris: string[]) {
  const id = `wzc_${randomBytes(16).toString("hex")}`;
  await db.mcpClient.create({ data: { id, name: name.trim().slice(0, 80) || "Claude", redirectUris: JSON.stringify(redirectUris) } });
  return id;
}

export async function oauthClient(id: string) {
  const c = await db.mcpClient.findUnique({ where: { id } });
  if (!c) return null;
  let uris: string[] = [];
  try {
    uris = JSON.parse(c.redirectUris);
  } catch {}
  return { id: c.id, name: c.name, redirectUris: uris };
}

/** One-time authorization code after the user clicks Allow. */
export async function createCode(userId: string, clientId: string, redirectUri: string, challenge: string) {
  const code = randomBytes(32).toString("base64url");
  await db.mcpCode.create({ data: { id: sha256(code), userId, clientId, redirectUri, challenge, expiresAt: new Date(Date.now() + CODE_TTL_MS) } });
  // Clean up old codes (expired more than 1 day ago).
  void db.mcpCode.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 86400_000) } } }).catch(() => {});
  return code;
}

/** Exchange a code for a token: checks client, redirect_uri, PKCE (S256), expiry, single use. Returns userId or an error. */
export async function redeemCode(code: string, clientId: string, redirectUri: string, verifier: string): Promise<{ userId: string } | { error: string }> {
  const row = await db.mcpCode.findUnique({ where: { id: sha256(code) } });
  if (!row || row.usedAt || row.expiresAt < new Date()) return { error: "invalid_grant" };
  // Mark as used first (blocks parallel reuse); on wrong details the code is discarded too.
  const used = await db.mcpCode.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
  if (!used.count) return { error: "invalid_grant" };
  if (row.clientId !== clientId || row.redirectUri !== redirectUri) return { error: "invalid_grant" };
  const expected = createHash("sha256").update(verifier).digest("base64url");
  if (!verifier || expected !== row.challenge) return { error: "invalid_grant" };
  return { userId: row.userId };
}

/** CORS for the OAuth / MCP endpoints (clients run in the browser or on Anthropic's servers). */
export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id",
};
