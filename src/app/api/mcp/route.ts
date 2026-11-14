import { connection } from "next/server";
import { CORS, mcpUser } from "@/lib/mcp/auth";
import { handleRpc } from "@/lib/mcp/server";
import { publicUrl } from "@/lib/zalo";
import { getT } from "@/i18n/server";
import { BRAND } from "@/lib/brand";

// MCP endpoint: the user's own Claude (Claude.ai, Claude Desktop, Claude Code) calls the platform's tools.
// Auth: Authorization: Bearer <token> (OAuth or personal token). Missing / invalid → 401 with the OAuth metadata URL so the client can log in on its own.

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json", ...extra } });

export async function POST(req: Request) {
  await connection();
  const t = await getT();
  const user = await mcpUser(req.headers.get("authorization"));
  if (!user) {
    return json({ error: "unauthorized", error_description: t("system.hooks.mcpUnauthorized", { app: BRAND.app }) }, 401, {
      "WWW-Authenticate": `Bearer resource_metadata="${publicUrl()}/.well-known/oauth-protected-resource/api/mcp"`,
    });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }
  if (Array.isArray(body)) {
    const replies = (await Promise.all(body.map((m) => handleRpc(user, m)))).filter(Boolean);
    return replies.length ? json(replies) : new Response(null, { status: 202, headers: CORS });
  }
  const reply = await handleRpc(user, body as Parameters<typeof handleRpc>[1]);
  return reply ? json(reply) : new Response(null, { status: 202, headers: CORS });
}

// Stateless sessions, no server-initiated SSE stream.
export function GET() {
  return new Response(null, { status: 405, headers: { ...CORS, Allow: "POST, OPTIONS" } });
}
export function DELETE() {
  return new Response(null, { status: 405, headers: { ...CORS, Allow: "POST, OPTIONS" } });
}
export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
