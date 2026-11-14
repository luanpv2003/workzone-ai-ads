import { readKnowledgeFile } from "@/lib/knowledge";
import { currentUser } from "@/lib/auth";
import { clientIdOf, clientRoleOf } from "@/lib/access";

const TYPES: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  json: "application/json",
};

/** Download the original file of a Knowledge base document (always as a download, never rendering HTML in the browser). */
export async function GET(_req: Request, ctx: { params: Promise<{ docId: string }> }) {
  const user = await currentUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const { docId } = await ctx.params;
  try {
    if (!(await clientRoleOf(user, await clientIdOf("knowledgeDoc", docId)))) throw new Error("no access");
    const { doc, data } = await readKnowledgeFile(docId);
    const ext = doc.fileName?.split(".").pop()?.toLowerCase() ?? "";
    const name = encodeURIComponent(doc.fileName ?? "tai-lieu");
    return new Response(new Uint8Array(data), {
      headers: {
        "Content-Type": TYPES[ext] ?? "application/octet-stream",
        "Content-Disposition": `${ext === "pdf" ? "inline" : "attachment"}; filename*=UTF-8''${name}`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
