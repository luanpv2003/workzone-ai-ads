import { readMessageImage } from "@/lib/msg-images";
import { currentUser } from "@/lib/auth";
import { clientRoleOf } from "@/lib/access";

// Images customers sent in messages (compressed, JPEG), path <clientId>/<file>: only users who can view that client.
export async function GET(_req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const user = await currentUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const { path } = await ctx.params;
  try {
    if (!(await clientRoleOf(user, path[0]))) throw new Error("no access");
    const data = await readMessageImage(path.join("/"));
    return new Response(new Uint8Array(data), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" } });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
