import { connection } from "next/server";
import { CORS, issuer } from "@/lib/mcp/auth";

// RFC 8414: OAuth authorization server metadata for the platform (public clients + PKCE S256 only, dynamic registration).
export async function GET() {
  await connection();
  const base = issuer();
  return Response.json(
    {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/api/oauth/token`,
      registration_endpoint: `${base}/api/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["wzone"],
    },
    { headers: CORS },
  );
}
export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
