import { connection } from "next/server";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { clientPages } from "@/lib/client-pages";
import { getMetaClient } from "@/lib/meta";
import type { CustomAudienceRef } from "@/lib/meta/types";
import { errorMessage } from "@/lib/activity";
import { AudienceBuilder } from "@/components/audience-builder";
import { requirePageClient } from "@/lib/access";
import { CrmAudience } from "@/components/crm-audience";
import { DEFAULT_EXCLUDE_TAGS } from "@/lib/crm-audience";
import { parseGhlPipelines } from "@/lib/highlevel-sync";

/** Short client name for the suggested file name: first letter of each word (drop the part after – / -). */
const shortName = (name: string) => {
  const words = name.split(/\s[–-]\s/)[0].normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[đĐ]/g, "D").split(/\s+/).filter(Boolean);
  return words.length > 1 ? words.map((w) => w[0].toUpperCase()).join("") : (words[0] ?? "");
};

export default async function AudiencesPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  await requirePageClient(id); // check access right on the page: the layout may not re-run on client-side navigation
  const client = await db.client.findUnique({ where: { id } });
  if (!client) notFound();
  const connected = client.dataSource === "meta" && !!client.metaAdAccountId && !!client.metaAccessToken;
  let audiences: CustomAudienceRef[] = [];
  let error: string | null = null;
  if (connected) {
    try {
      audiences = await getMetaClient(client).listCustomAudiences();
    } catch (err) {
      error = errorMessage(err);
    }
  }
  return (
    <div className="space-y-6">
      <AudienceBuilder
        clientId={id} clientName={client.name} connected={connected}
        pages={clientPages(client).map((p) => ({ id: p.id, name: p.name }))}
        audiences={audiences} listError={error}
      />
      {connected && client.ghlToken && (
        <CrmAudience
          clientId={id}
          shortName={shortName(client.name)}
          location={client.ghlLocation}
          pipelines={parseGhlPipelines(client.ghlPipelines).map((p) => ({ id: p.id, name: p.name }))}
          defaultExclude={DEFAULT_EXCLUDE_TAGS.join(", ")}
        />
      )}
    </div>
  );
}
