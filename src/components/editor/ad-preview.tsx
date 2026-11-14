"use client";

import { useState } from "react";
import type { EditableAd } from "@/lib/ai/schemas";
import { isCarousel } from "@/lib/carousel";
import { useT } from "@/i18n/client";
import type { T } from "@/i18n/translate";

const CTA_KEYS = {
  MESSAGE_PAGE: "campaigns.cta.MESSAGE_PAGE",
  LEARN_MORE: "campaigns.cta.LEARN_MORE",
  SHOP_NOW: "campaigns.cta.SHOP_NOW",
  SIGN_UP: "campaigns.cta.SIGN_UP",
  CONTACT_US: "campaigns.cta.CONTACT_US",
  GET_OFFER: "campaigns.cta.GET_OFFER",
  BOOK_NOW: "campaigns.cta.BOOK_NOW",
  VIEW_INSTAGRAM_PROFILE: "campaigns.cta.VIEW_INSTAGRAM_PROFILE",
  WHATSAPP_MESSAGE: "campaigns.cta.WHATSAPP_MESSAGE",
  APPLY_NOW: "campaigns.cta.APPLY_NOW",
  GET_QUOTE: "campaigns.cta.GET_QUOTE",
  SUBSCRIBE: "campaigns.cta.SUBSCRIBE",
  DOWNLOAD: "campaigns.cta.DOWNLOAD",
  LIKE_PAGE: "campaigns.cta.LIKE_PAGE",
} as const;

/** Localised label of a call-to-action code (falls back to the raw code). */
export function ctaLabel(t: T, code: string): string {
  return code in CTA_KEYS ? t(CTA_KEYS[code as keyof typeof CTA_KEYS]) : code;
}

/** Mock-up of the ad as it appears in the Facebook Feed. */
export function AdPreview({ ad, pageName, isMessages, noCta }: { ad: EditableAd; pageName: string; isMessages: boolean; noCta?: boolean }) {
  const t = useT();
  const existing = ad.source === "existing" ? ad.post_preview : null;
  const imageSrc = existing ? existing.picture : ad.image_path ? `/api/uploads/${ad.image_path}` : (ad.video_preview?.picture ?? null);
  const isVideo = !existing && !!ad.video_id;
  const carousel = isCarousel(ad);
  const [expanded, setExpanded] = useState(false);
  const text = (existing ? existing.message : ad.primary_text) || t("campaigns.adPreview.primaryTextPlaceholder");
  const long = text.length > 125;
  const domain = isMessages ? "MESSENGER" : (ad.link_url ?? "").replace(/^https?:\/\//, "").split("/")[0].toUpperCase();

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-panel text-[13px] shadow-sm">
      <div className="flex items-center gap-2 px-3 pt-3">
        <div className="grid size-9 place-items-center rounded-full bg-indigo-600 font-semibold text-white">{pageName.charAt(0)}</div>
        <div className="leading-tight">
          <div className="font-semibold text-slate-900">{pageName}</div>
          <div className="text-xs text-slate-500">{t("campaigns.adPreview.sponsored")}</div>
        </div>
      </div>
      <p className="px-3 py-2 whitespace-pre-line text-slate-900">
        {long && !expanded ? `${text.slice(0, 125)}… ` : text}
        {long && !expanded && (
          <button type="button" className="font-medium text-slate-500" onClick={() => setExpanded(true)}>
            {t("campaigns.adPreview.seeMore")}
          </button>
        )}
      </p>
      {carousel ? (
        <div className="flex snap-x gap-2 overflow-x-auto px-3 pb-3">
          {(ad.cards.length ? ad.cards : [null, null]).map((c, i) => (
            <div key={i} className="w-[72%] shrink-0 snap-start overflow-hidden rounded-md border border-slate-200">
              {c?.image_path ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`/api/uploads/${c.image_path}`} alt="" className="aspect-square w-full bg-slate-100 object-cover" />
              ) : (
                <div className="grid aspect-square w-full place-items-center bg-slate-100 text-xs text-slate-400">{t("campaigns.adPreview.cardNoImage", { n: i + 1 })}</div>
              )}
              {!noCta && (
                <div className="flex items-center justify-between gap-2 bg-slate-50 px-2 py-2">
                  <div className="min-w-0">
                    <div className="truncate font-semibold text-slate-900">{c?.headline || ad.headline || t("campaigns.adPreview.cardHeadlinePlaceholder")}</div>
                    {(c?.description || ad.description) && <div className="truncate text-xs text-slate-500">{c?.description || ad.description}</div>}
                  </div>
                  <span className="shrink-0 rounded-md bg-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-800">{ctaLabel(t, ad.call_to_action)}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      ) : imageSrc ? (
        <div className="relative">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imageSrc} alt="" className="aspect-square w-full bg-slate-100 object-cover" />
          {isVideo && <span className="absolute inset-0 grid place-items-center"><span className="grid size-14 place-items-center rounded-full bg-black/55 text-2xl text-white">▶</span></span>}
        </div>
      ) : (
        <div className="grid aspect-square w-full place-items-center bg-slate-100 p-6 text-center text-xs text-slate-400">
          {ad.creative_brief ? t("campaigns.adPreview.imageNeeded", { brief: ad.creative_brief }) : t("campaigns.adPreview.noImage")}
        </div>
      )}
      {!noCta && !existing && !carousel && <div className="flex items-center justify-between gap-3 bg-slate-50 px-3 py-2.5">
        <div className="min-w-0">
          {domain && <div className="truncate text-[11px] text-slate-500">{domain}</div>}
          <div className="truncate font-semibold text-slate-900">{ad.headline || t("campaigns.adPreview.headlinePlaceholder")}</div>
          {ad.description && <div className="truncate text-xs text-slate-500">{ad.description}</div>}
        </div>
        <span className="shrink-0 rounded-md bg-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-800">{ctaLabel(t, ad.call_to_action)}</span>
      </div>}
      <div className="flex justify-around border-t border-slate-100 py-1.5 text-xs text-slate-500">
        <span>{t("campaigns.adPreview.like")}</span>
        <span>{t("campaigns.adPreview.comment")}</span>
        <span>{t("campaigns.adPreview.share")}</span>
      </div>
    </div>
  );
}
