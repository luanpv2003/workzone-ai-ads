import { getT } from "@/i18n/server";
import { CORS, registerClient, validRedirect } from "@/lib/mcp/auth";

// RFC 7591: dynamic client registration (Claude.ai / Desktop / Code call it themselves). Public clients only (no secret), https or localhost redirects.
export async function POST(req: Request) {
  let b: { client_name?: unknown; redirect_uris?: unknown };
  try {
    b = await req.json();
  } catch {
    return Response.json({ error: "invalid_client_metadata" }, { status: 400, headers: CORS });
  }
  const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.map(String).slice(0, 10) : [];
  if (!uris.length || !uris.every(validRedirect)) {
    return Response.json({ error: "invalid_redirect_uri", error_description: (await getT())("system.hooks.redirectUris") }, { status: 400, headers: CORS });
  }
  // Display name only (the consent page also shows the redirect host). Control characters removed; missing name = redirect host.
  const rawName = typeof b.client_name === "string" ? b.client_name.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "").trim() : "";
  if (rawName.length > 100) {
    return Response.json({ error: "invalid_client_metadata", error_description: (await getT())("system.hooks.clientName") }, { status: 400, headers: CORS });
  }
  const name = rawName || new URL(uris[0]).host;
  const id = await registerClient(name, uris);
  return Response.json(
    {
      client_id: id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: name,
      redirect_uris: uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    { status: 201, headers: CORS },
  );
}
export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
