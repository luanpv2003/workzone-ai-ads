import { db } from "./db";
import { getT } from "@/i18n/server";
import { translator, type T } from "@/i18n/translate";

// Default documents in every client's Knowledge base: created when adding a new client (and backfilled once for existing clients).
// Users edit / turn off "Used by Claude" / delete them like normal documents; once deleted they are not recreated.

/** The default documents in the language of the translator (the category is fixed). */
function defaultKnowledge(t: T) {
  return [{ title: t("settings.knowledgeDefaults.adCopyFrame.title"), category: "creative", content: t("settings.knowledgeDefaults.adCopyFrame.content") }];
}

/** Add missing default documents (compared by title); skipped if the user already deleted that document (per the activity log). */
export async function ensureDefaultKnowledge(clientId: string) {
  let added = 0;
  const t = await getT();
  const titlesVi = defaultKnowledge(translator("vi")).map((d) => d.title);
  const titlesEn = defaultKnowledge(translator("en")).map((d) => d.title);
  for (const [i, d] of defaultKnowledge(t).entries()) {
    // Same document in either language counts as existing / deleted.
    const exists = await db.knowledgeDoc.findFirst({ where: { clientId, title: { in: [titlesVi[i], titlesEn[i]] } }, select: { id: true } });
    const deleted = await db.activity.findFirst({ where: { clientId, OR: [{ message: { contains: `xóa "${titlesVi[i]}"` } }, { message: { contains: `deleted "${titlesEn[i]}"` } }] }, select: { id: true } });
    if (exists || deleted) continue;
    await db.knowledgeDoc.create({ data: { clientId, title: d.title, category: d.category, content: d.content, useForAi: true } });
    added++;
  }
  return added;
}
