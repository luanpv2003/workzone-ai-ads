import { connection } from "next/server";
import { requirePlatformPage } from "@/lib/access";
import { Card, PageHeader } from "@/components/ui";
import { GoogleAdsConnect } from "@/components/google-ads-connect";
import { getT } from "@/i18n/server";
import { googleAdsStatus, googleCallbackUrl } from "@/lib/google-ads";

export default async function GooglePage({ searchParams }: { searchParams: Promise<{ google?: string; google_error?: string }> }) {
  const user = await requirePlatformPage(); // shared settings: only members of the platform workspace
  await connection();
  const sp = await searchParams;
  const t = await getT();
  return (
    <>
      <PageHeader title="Google Ads" subtitle={t("system.google.subtitle")} />
      <Card>
        <GoogleAdsConnect
          status={await googleAdsStatus()}
          callbackUrl={googleCallbackUrl()}
          isAdmin={user?.role === "admin"}
          flash={sp.google === "ok" ? { ok: true, text: t("system.google.connected") } : sp.google_error ? { ok: false, text: sp.google_error } : null}
        />
      </Card>
    </>
  );
}
