import type { Client } from "@prisma/client";
import { decrypt } from "../crypto";
import { GraphMetaClient } from "./graph";
import { MockMetaClient } from "./mock";
import type { MetaClient } from "./types";
import { clientPages } from "../client-pages";
import { DEFAULT_LOCALE } from "@/i18n/config";
import { translator } from "@/i18n/translate";

export function getMetaClient(client: Client): MetaClient {
  if (client.dataSource !== "meta") return new MockMetaClient(client.id);
  if (!client.metaAdAccountId || !client.metaAccessToken) {
    // Sync function (33 callers), so no cookie lookup is possible here: uses the default locale.
    throw new Error(translator(DEFAULT_LOCALE)("targeting.meta.noCredentials", { name: client.name }));
  }
  return new GraphMetaClient({
    adAccountId: client.metaAdAccountId,
    pageId: client.metaPageId,
    pageIds: clientPages(client).map((p) => p.id),
    pageInstagram: Object.fromEntries(clientPages(client).map((p) => [p.id, p.instagramId])),
    instagramId: client.metaInstagramId,
    token: decrypt(client.metaAccessToken),
    currency: client.currency,
    primaryResult: client.primaryResult,
    timezone: client.timezone,
  });
}

