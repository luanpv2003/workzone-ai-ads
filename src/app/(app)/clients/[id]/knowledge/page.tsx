import { connection } from "next/server";
import { db } from "@/lib/db";
import { AI_CONTEXT_CHARS, knowledgeContext, looksGarbled } from "@/lib/knowledge";
import { norm } from "@/lib/text";
import { KnowledgeBoard, type KnowledgeRow } from "@/components/knowledge-board";
import { requirePageClient } from "@/lib/access";

export default async function KnowledgePage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  await requirePageClient(id); // check access right on the page: the layout may not re-run on client-side navigation
  const [docs, ctx] = await Promise.all([
    db.knowledgeDoc.findMany({ where: { clientId: id }, orderBy: { updatedAt: "desc" } }),
    knowledgeContext(id),
  ]);

  const rows: KnowledgeRow[] = docs.map((d) => ({
    id: d.id,
    title: d.title,
    category: d.category,
    useForAi: d.useForAi,
    fileName: d.fileName,
    fileSize: d.fileSize,
    chars: d.content.length,
    preview: d.content.replace(/---\s*Trang \d+\s*---/g, " ").replace(/\s+/g, " ").slice(0, 220),
    // Accent-free search string (title, file name and the start of the content).
    search: norm(`${d.title} ${d.fileName ?? ""} ${d.content.slice(0, 5000)}`),
    issue: d.content.length < 50 ? "empty" : looksGarbled(d.content) ? "garbled" : null,
    updatedAt: d.updatedAt.toISOString(),
  }));

  return (
    <KnowledgeBoard
      clientId={id}
      rows={rows}
      usage={{ used: ctx.used, total: ctx.total, chars: ctx.chars, budget: AI_CONTEXT_CHARS, truncated: ctx.truncated }}
    />
  );
}
