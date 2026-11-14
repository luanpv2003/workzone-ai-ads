"use server";

import { db } from "@/lib/db";
import { getT } from "@/i18n/server";
import { requireClient } from "@/lib/access";
import { errorMessage } from "@/lib/activity";
import { clientPages } from "@/lib/client-pages";
import { getMetaClient } from "@/lib/meta";
import type { PageVideo } from "@/lib/meta/types";

/** Videos / Reels published on the client's Page, to pick as the video for a new ad. */
export async function listVideosAction(clientId: string, pageId?: string | null): Promise<{ ok: true; videos: PageVideo[] } | { ok: false; error: string }> {
  try {
    await requireClient(clientId, "view");
    const t = await getT();
    const client = await db.client.findUniqueOrThrow({ where: { id: clientId } });
    if (client.dataSource === "meta" && !client.metaPageId) throw new Error(t("customers.videoActions.noPage"));
    if (pageId && !clientPages(client).some((p) => p.id === pageId)) throw new Error(t("customers.videoActions.pageNotOwned"));
    return { ok: true, videos: await getMetaClient(client).listVideos(100, pageId ?? undefined) };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
