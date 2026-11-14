import { CORS, issueOAuthTokens, oauthClient, redeemCode, rotateRefresh } from "@/lib/mcp/auth";
import { db } from "@/lib/db";
import { getT } from "@/i18n/server";

// Exchange an authorization code (PKCE) or refresh token for an access token. Accepts form-urlencoded (standard) or JSON.
const err = (error: string, description?: string, status = 400) =>
  Response.json({ error, ...(description && { error_description: description }) }, { status, headers: { ...CORS, "Cache-Control": "no-store" } });

export async function POST(req: Request) {
  const t = await getT();
  let p: URLSearchParams;
  try {
    p = (req.headers.get("content-type") ?? "").includes("application/json")
      ? new URLSearchParams(Object.entries((await req.json()) as Record<string, string>).map(([k, v]) => [k, String(v)]))
      : new URLSearchParams(await req.text());
  } catch {
    return err("invalid_request");
  }
  const grant = p.get("grant_type");
  const clientId = p.get("client_id") ?? "";

  if (grant === "authorization_code") {
    const client = await oauthClient(clientId);
    if (!client) return err("invalid_client", undefined, 401);
    const r = await redeemCode(p.get("code") ?? "", clientId, p.get("redirect_uri") ?? "", p.get("code_verifier") ?? "");
    if ("error" in r) return err(r.error, t("system.hooks.badCode"));
    const user = await db.user.findUnique({ where: { id: r.userId }, select: { active: true } });
    if (!user?.active) return err("invalid_grant", t("system.hooks.locked"));
    await db.mcpClient.update({ where: { id: clientId }, data: { lastUsedAt: new Date() } }).catch(() => {});
    return Response.json(await issueOAuthTokens(r.userId, clientId, client.name), { headers: { ...CORS, "Cache-Control": "no-store" } });
  }

  if (grant === "refresh_token") {
    const tok = await rotateRefresh(p.get("refresh_token") ?? "", clientId || null);
    if (!tok) return err("invalid_grant", t("system.hooks.badRefresh"));
    return Response.json(tok, { headers: { ...CORS, "Cache-Control": "no-store" } });
  }

  return err("unsupported_grant_type");
}
export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
