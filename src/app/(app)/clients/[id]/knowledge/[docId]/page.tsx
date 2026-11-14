import { notFound } from "next/navigation";
import { connection } from "next/server";
import { db } from "@/lib/db";
import { looksGarbled } from "@/lib/knowledge";
import { claudeConn, claudeConnFor } from "@/lib/ai/credential";
import { KnowledgeEditor } from "@/components/knowledge-editor";
import { requirePageClient } from "@/lib/access";

export default async function KnowledgeDocPage({ params }: { params: Promise<{ id: string; docId: string }> }) {
  await connection();
  const { id, docId } = await params;
  await requirePageClient(id); // check access right on the page: the layout may not re-run on client-side navigation
  const doc = await db.knowledgeDoc.findFirst({ where: { id: docId, clientId: id } });
  if (!doc) notFound();

  return (
    <KnowledgeEditor
      // Claude finished re-reading → updatedAt changes → load the new content.
      key={doc.updatedAt.toISOString()}
      clientId={id}
      doc={{
        id: doc.id,
        title: doc.title,
        category: doc.category,
        content: doc.content,
        useForAi: doc.useForAi,
        fileName: doc.fileName,
        fileSize: doc.fileSize,
        createdAt: doc.createdAt.toISOString(),
        updatedAt: doc.updatedAt.toISOString(),
      }}
      issue={doc.content.length < 50 ? "empty" : looksGarbled(doc.content) ? "garbled" : null}
      provider={(await claudeConnFor({ clientId: id }).catch(() => claudeConn())).provider}
    />
  );
}
