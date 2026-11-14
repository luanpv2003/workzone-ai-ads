"use client";

import { useEffect, useRef, useState } from "react";
import { estimateAudienceAction } from "@/app/actions";
import type { EditableAdSet } from "@/lib/ai/schemas";
import type { AudienceEstimate as Est } from "@/lib/meta/types";
import { Spinner } from "../action-button";
import { useT } from "@/i18n/client";
import type { T } from "@/i18n/translate";

const fmt = (v: number) => new Intl.NumberFormat("vi-VN").format(v);

function verdict(upper: number, t: T) {
  if (upper < 1000) return { label: t("campaigns.audienceEstimate.tooNarrow"), tone: "text-rose-600", bar: 5, hint: t("campaigns.audienceEstimate.tooNarrowHint") };
  if (upper < 20000) return { label: t("campaigns.audienceEstimate.narrow"), tone: "text-amber-600", bar: 25, hint: t("campaigns.audienceEstimate.narrowHint") };
  if (upper < 300000) return { label: t("campaigns.audienceEstimate.medium"), tone: "text-emerald-600", bar: 55, hint: t("campaigns.audienceEstimate.mediumHint") };
  if (upper < 3000000) return { label: t("campaigns.audienceEstimate.fairlyBroad"), tone: "text-emerald-600", bar: 75, hint: t("campaigns.audienceEstimate.fairlyBroadHint") };
  return { label: t("campaigns.audienceEstimate.broad"), tone: "text-sky-600", bar: 95, hint: t("campaigns.audienceEstimate.broadHint") };
}

/** "Quy mô đối tượng" (Audience size) gauge like Ads Manager, calling Meta's estimate API (debounce 1.2 seconds). */
export function AudienceEstimate({ clientId, resultType, adSet, currency }: { clientId: string; resultType: string; adSet: EditableAdSet; currency: string }) {
  const t = useT();
  const [est, setEst] = useState<Est | null | undefined>(undefined);
  const [sentences, setSentences] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  // Only re-fetch when fields that affect the audience change (not when typing the ad set name, hypothesis, schedule).
  const key = JSON.stringify({ ...adSet, name: "", hypothesis: "", start_time: null, end_time: null }) + resultType;

  useEffect(() => {
    const n = ++seq.current;
    const t = setTimeout(async () => {
      setLoading(true);
      const r = await estimateAudienceAction(clientId, resultType, adSet);
      if (n !== seq.current) return;
      setLoading(false);
      if (r.ok) {
        setEst(r.estimate);
        setSentences(r.sentences);
        setError(null);
      } else setError(r.error);
    }, 1200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, clientId]);

  const upper = est?.upper ?? null;
  const v = upper != null ? verdict(upper, t) : null;
  // Rough frequency/week estimate assuming a CPM of 60,000 VND (travel/language audiences are usually pricier).
  const weeklyImpr = adSet.daily_budget ? (adSet.daily_budget * 7 * 1000) / 60000 : null;
  const freq = weeklyImpr && upper ? weeklyImpr / ((upper + (est?.lower ?? upper)) / 2) : null;

  return (
    <div className="border-t border-slate-100 pt-3">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-medium text-slate-500">{t("campaigns.audienceEstimate.title")}</span>
        {loading && <Spinner />}
      </div>
      {est === null && !error && <p className="text-xs text-slate-400">{t("campaigns.audienceEstimate.sampleMode")}</p>}
      {error && <p className="text-xs text-rose-600">{error}</p>}
      {est && upper != null && v && (
        <>
          <div className="text-lg font-semibold text-slate-900 tabular-nums">
            {est.lower != null ? `${fmt(est.lower)} – ` : ""}
            {fmt(upper)} <span className="text-sm font-normal text-slate-500">{t("campaigns.audienceEstimate.people")}</span>
          </div>
          <div className="my-2 h-2 rounded-full bg-gradient-to-r from-rose-300 via-emerald-300 to-sky-300">
            <div className="relative h-2" style={{ width: `${v.bar}%` }}>
              <span className="absolute -top-1 right-0 size-4 translate-x-1/2 rounded-full border-2 border-white bg-slate-800 shadow" />
            </div>
          </div>
          <p className={`text-xs font-medium ${v.tone}`}>{v.label}</p>
          <p className="text-xs text-slate-500">{v.hint}</p>
          {freq != null && (
            <p className={`mt-1 text-xs ${freq > 3 ? "text-amber-600" : "text-slate-500"}`}>
              {t("campaigns.audienceEstimate.frequency", { budget: fmt(adSet.daily_budget!), currency, freq: freq.toFixed(1) })}
            </p>
          )}
          {est.daily != null && <p className="text-xs text-slate-400">{t("campaigns.audienceEstimate.daily", { count: fmt(est.daily) })}</p>}
          {est.notes.length > 0 && <p className="mt-1 text-xs text-amber-600">{est.notes.join(" · ")}</p>}
        </>
      )}
      {est === undefined && !error && !loading && <p className="text-xs text-slate-400">{t("campaigns.audienceEstimate.waiting")}</p>}

      {adSet.custom_locations.length > 0 && (
        <div className="mt-3 space-y-1 border-t border-slate-100 pt-3 text-xs">
          <div className="font-medium text-slate-500">{t("campaigns.audienceEstimate.pins")}</div>
          {adSet.custom_locations.map((c, i) => (
            <a
              key={i}
              href={`https://www.google.com/maps/search/?api=1&query=${c.latitude},${c.longitude}`}
              target="_blank"
              rel="noreferrer"
              className="block text-indigo-600 hover:underline"
            >
              📌 {c.label} · {c.latitude.toFixed(5)}, {c.longitude.toFixed(5)} · +{c.radius_km} km ↗
            </a>
          ))}
        </div>
      )}
      {sentences.length > 0 && (
        <div className="mt-3 space-y-1 border-t border-slate-100 pt-3 text-xs">
          <div className="font-medium text-slate-500">{t("campaigns.audienceEstimate.metaShows")}</div>
          {sentences.map((l, i) => (
            <p key={i} className="text-slate-600">{l}</p>
          ))}
          {adSet.custom_locations.length > 0 && (
            <p className="text-amber-600">
              {t("campaigns.audienceEstimate.placeNameWarning")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
