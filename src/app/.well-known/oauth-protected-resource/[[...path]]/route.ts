import { BRAND } from "@/lib/brand";
import { connection } from "next/server";
import { CORS, issuer, mcpUrl } from "@/lib/mcp/auth";

// RFC 9728: describes the MCP resource and the authorization server (clients read it after a 401). Also served with the path suffix (/api/mcp).
export async function GET() {
  await connection();
  return Response.json(
    { resource: mcpUrl(), authorization_servers: [issuer()], bearer_methods_supported: ["header"], scopes_supported: ["wzone"], resource_name: BRAND.app },
    { headers: CORS },
  );
}
export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
