"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createLiftAction } from "@/app/sales-lift-actions";
import { Spinner } from "@/components/action-button";
import { btnClass, inputClass } from "@/components/ui";
import { useT } from "@/i18n/client";

type Camp = { id: string; name: string; status: string; type: string; engagement: boolean; ads: { id: string; name: string; status: string }[] };

/** Pick a campaign (or 1 ad within it) → the system suggests SKUs, control, comparison period → open the measurement page to edit. */
export function NewLiftForm({ clientId, campaigns }: { clientId: string; campaigns: Camp[] }) {
  const t = useT();
  const sorted = [...campaigns].sort((a, b) => Number(b.engagement) - Number(a.engagement));
  const [campaignId, setCampaignId] = useState(sorted[0]?.id ?? "");
  const [adId, setAdId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const camp = campaigns.find((c) => c.id === campaignId);

  return (
    <div className="grid gap-3 @3xl:grid-cols-[2fr_1.5fr_auto] @3xl:items-end">
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-ink2">{t("settings.newLift.campaign")}</span>
        <select
          className={inputClass}
          value={campaignId}
          onChange={(e) => {
            setCampaignId(e.target.value);
            setAdId("");
          }}
        >
          {sorted.map((c) => (
            <option key={c.id} value={c.id}>
              {c.engagement ? "★ " : ""}
              {c.name} · {c.type} · {c.status === "ACTIVE" ? t("settings.newLift.active") : c.status === "PAUSED" ? t("settings.newLift.paused") : c.status}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-ink2">{t("settings.newLift.scope")}</span>
        <select className={inputClass} value={adId} onChange={(e) => setAdId(e.target.value)}>
          <option value="">{t("settings.newLift.wholeCampaign")}</option>
          {camp?.ads.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
              {a.status !== "ACTIVE" ? ` ${t("settings.newLift.off")}` : ""}
            </option>
          ))}
        </select>
      </label>
      <div className="flex flex-col items-start gap-1">
        <button
          type="button"
          className={btnClass("primary")}
          disabled={pending || !campaignId}
          onClick={() => {
            setError(null);
            start(async () => {
              const r = await createLiftAction(clientId, adId ? { level: "ad", objectId: adId } : { level: "campaign", objectId: campaignId });
              if (!r.ok) setError(r.error);
              else router.push(`/clients/${clientId}/lift/${r.id}`);
            });
          }}
        >
          {pending && <Spinner />}
          {pending ? t("settings.newLift.suggesting") : t("settings.newLift.create")}
        </button>
      </div>
      {error && <p className="text-sm text-rose-600 @3xl:col-span-3">{error}</p>}
      <p className="text-xs text-mut @3xl:col-span-3">{t("settings.newLift.help")}</p>
    </div>
  );
}
