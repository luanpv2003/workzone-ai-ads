import { readFile } from "node:fs/promises";
import { uploadFilePath } from "@/lib/uploads";
import { currentUser } from "@/lib/auth";
import { clientRoleOf } from "@/lib/access";
import { db } from "@/lib/db";

const TYPES: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

/** Image folder: <draftId>/ (a draft's images) or rv_<reviewId>/ (a Content review batch's images) → owning client. */
async function ownerOf(folder: string) {
  const row = folder.startsWith("rv_")
    ? await db.contentReview.findUnique({ where: { id: folder.slice(3) }, select: { clientId: true } })
    : await db.campaignDraft.findUnique({ where: { id: folder }, select: { clientId: true } });
  return row?.clientId ?? null;
}

export async function GET(_req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const user = await currentUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const { path } = await ctx.params;
  const rel = path.join("/");
  try {
    // Draft / review batch deleted: owning client unknown, keep the old behavior (login only; file names are UUIDs).
    const clientId = path.length > 1 ? await ownerOf(path[0]) : null;
    if (clientId && !(await clientRoleOf(user, clientId))) throw new Error("no access");
    const data = await readFile(uploadFilePath(rel));
    return new Response(new Uint8Array(data), {
      headers: { "Content-Type": TYPES[rel.split(".").pop() ?? ""] ?? "application/octet-stream", "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
