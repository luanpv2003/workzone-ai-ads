import type { Client } from "@prisma/client";

// A client can have multiple Fanpages (sharing one persona). Main Page = metaPageId; secondary Pages are stored as JSON in metaExtraPages.
export type ClientPage = { id: string; name: string; instagramId: string | null; primary: boolean };

export function parseExtraPages(json: string | null | undefined): Omit<ClientPage, "primary">[] {
  try {
    const v = JSON.parse(json ?? "[]");
    return Array.isArray(v)
      ? v.filter((p) => p && /^\d{5,}$/.test(String(p.id))).map((p) => ({ id: String(p.id), name: String(p.name || p.id), instagramId: p.instagramId ? String(p.instagramId) : null }))
      : [];
  } catch {
    return [];
  }
}

/** All of the client's Pages, main Page first. */
export function clientPages(c: Pick<Client, "metaPageId" | "metaPageName" | "metaInstagramId" | "metaExtraPages">): ClientPage[] {
  const out: ClientPage[] = c.metaPageId ? [{ id: c.metaPageId, name: c.metaPageName || c.metaPageId, instagramId: c.metaInstagramId, primary: true }] : [];
  for (const p of parseExtraPages(c.metaExtraPages)) if (!out.some((x) => x.id === p.id)) out.push({ ...p, primary: false });
  return out;
}

/** Page name for display (old data not tied to a Page = main Page). */
export function pageLabel(pages: ClientPage[], pageId: string | null | undefined) {
  const p = pages.find((x) => x.id === (pageId ?? pages[0]?.id));
  return p?.name ?? pageId ?? "";
}

/** Prisma condition filtering data by Page (the main Page includes old data not tied to a Page). undefined = all Pages. */
export function pageWhere(pages: ClientPage[], pageId: string | undefined) {
  const p = pages.find((x) => x.id === pageId);
  if (!p || pages.length < 2) return {};
  return p.primary ? { OR: [{ pageId: p.id }, { pageId: null }] } : { pageId: p.id };
}
