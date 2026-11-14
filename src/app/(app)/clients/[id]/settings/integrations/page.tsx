import { connection } from "next/server";
import { db } from "@/lib/db";
import { requirePageClient } from "@/lib/access";
import { Card } from "@/components/ui";
import { GoogleAdsClient } from "@/components/google-ads-client";
import { googleAdsStatus } from "@/lib/google-ads";
import { KiotvietConnect } from "@/components/kiotviet-connect";
import { kiotRunning, parseKiotState } from "@/lib/kiotviet-sync";
import { HighlevelConnect } from "@/components/highlevel-connect";
import { parseGhlPipelines, parseReverseMap, parseStageMap } from "@/lib/highlevel-sync";
import { publicUrl } from "@/lib/zalo";
import { FEEDBACK_FIELDS, dateToSince } from "@/lib/lead-sheet";
import { getT } from "@/i18n/server";

// Client settings → Google Ads & KiotViet: link a Google Ads account (via the shared MCC) and a KiotViet store (read-only).
export default async function IntegrationsPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const t = await getT();
  const { id } = await params;
  await requirePageClient(id); // check access right on the page: the layout may not re-run on client-side navigation
  const [c, ghlLinked, ghlStaged] = await Promise.all([
    db.client.findUniqueOrThrow({ where: { id } }),
    db.ghlLink.count({ where: { clientId: id } }),
    db.ghlLink.count({ where: { clientId: id, stageId: { not: null } } }),
  ]);
  const kiotPhase = kiotRunning(c) ? parseKiotState(c.kiotState).phase ?? "" : null;

  return (
    <div className="space-y-6 [&>div[id]]:scroll-mt-28">
      <div id="google">
        <Card title="Google Ads">
          <GoogleAdsClient
            clientId={id}
            connected={!!(await googleAdsStatus())?.connected}
            current={{ id: c.googleCustomerId, name: c.googleAccountName, syncedAt: c.googleSyncedAt?.toISOString() ?? null, error: c.googleSyncError }}
          />
        </Card>
      </div>
      <div id="kiotviet">
        <Card title={t("settings.integrationsPage.kiotTitle")}>
          <KiotvietConnect
            clientId={id}
            current={{
              retailer: c.kiotRetailer,
              clientId: c.kiotClientId,
              hasSecret: !!c.kiotSecret,
              months: c.kiotMonths,
              syncedAt: c.kiotSyncAt?.toISOString() ?? null,
              error: c.kiotSyncError,
              status: kiotPhase == null ? null : `${t("settings.integrationsPage.syncing")}${kiotPhase ? `: ${kiotPhase}` : ""}…`,
            }}
          />
        </Card>
      </div>
      <div id="highlevel">
        <Card title="HighLevel CRM">
          <HighlevelConnect
            clientId={id}
            fields={FEEDBACK_FIELDS.filter((f) => f.field !== "note").map((f) => ({ field: f.field as "contact" | "quality" | "outcome", label: t(f.labelKey), options: f.options }))}
            current={{
              locationId: c.ghlLocationId,
              hasToken: !!c.ghlToken,
              location: c.ghlLocation,
              pipelines: parseGhlPipelines(c.ghlPipelines),
              pipelineId: c.ghlPipelineId,
              stageId: c.ghlStageId,
              stageMap: parseStageMap(c.ghlStageMap),
              push: c.ghlPush,
              since: dateToSince(c.ghlSince) || dateToSince(new Date()),
              syncedAt: c.ghlSyncAt?.toISOString() ?? null,
              error: c.ghlSyncError,
              requested: !!c.ghlRequestAt,
              linked: ghlLinked,
              withStage: ghlStaged,
              reverseMap: parseReverseMap(c.ghlReverseMap),
              dealPipelineId: c.ghlDealPipelineId,
              hookUrl: c.ghlHookKey ? `${publicUrl()}/api/ghl/${c.ghlHookKey}` : null,
            }}
          />
        </Card>
      </div>
    </div>
  );
}
