import type { EditableAd } from "./ai/schemas";
import { viT } from "./format";
import type { T } from "@/i18n/translate";

// Carousel ads: pure rules, shared by the editor (browser), reviewPlan and the Meta publishing layer.
//
// Meta API: link_data.child_attachments 2–10 cards (tested with generatepreviews 27/10/2026: 1 card fails with #194, 7–10 cards accepted even with
// multi_share_optimized off). Instagram only shows the first 5 cards and has no end card.
// "Flexible format" (multiple images for Meta to choose from, creative_asset_groups_spec) is currently only open via API for Sales / App promotion objectives,
// two objectives the system does not publish automatically yet, so it is not implemented.

export const CAROUSEL_MIN = 2;
export const CAROUSEL_MAX = 10;

/** Objectives that can publish as a carousel (each card needs a link: messaging / form use the link Meta requires, others use the website link). */
const CAROUSEL_RESULTS = new Set(["messages", "leads", "link_clicks", "reach"]);

/** Reason a carousel can't be used with this objective (null = usable). */
export function carouselBlockReason(result: string, t: T = viT): string | null {
  if (CAROUSEL_RESULTS.has(result)) return null;
  switch (result) {
    case "engagement":
      return t("core.carousel.engagement");
    case "page_likes":
      return t("core.carousel.pageLikes");
    case "profile_visits":
      return t("core.carousel.profileVisits");
    case "video_views":
      return t("core.carousel.videoViews");
    default:
      return t("core.carousel.unsupported");
  }
}

export const isCarousel = (a: Pick<EditableAd, "source" | "format">) => a.source !== "existing" && a.format === "carousel";

type Cta = { type: string; value?: Record<string, unknown> };
type LinkData = { message?: string; name?: string; description?: string; link?: string; image_hash?: string; call_to_action?: Cta; page_welcome_message?: unknown };

/**
 * Convert the link_data of a single-image ad (with button, form, message template matching the objective) into a carousel.
 * Each card reuses the ad's button; for website objectives each card has its own link (empty = the ad's link).
 * `hashes[i]` = image_hash of card i.
 */
export function carouselLinkData(base: LinkData, ad: EditableAd, hashes: string[], goal: string) {
  const cta = base.call_to_action;
  const websiteGoal = goal === "link_clicks" || goal === "reach";
  const child_attachments = ad.cards.map((c, i) => {
    const link = websiteGoal ? (c.link_url?.trim() || base.link || "") : (base.link ?? "");
    return {
      link,
      image_hash: hashes[i],
      name: c.headline.trim() || ad.headline,
      ...((c.description.trim() || ad.description) && { description: c.description.trim() || ad.description }),
      ...(cta && { call_to_action: websiteGoal ? { type: cta.type, value: { link } } : cta }),
    };
  });
  return {
    message: base.message,
    link: base.link,
    child_attachments,
    multi_share_optimized: ad.carousel_auto_order,
    // End card (Page profile picture + link): only suits ads driving to a website.
    multi_share_end_card: websiteGoal,
    ...(cta && { call_to_action: cta }),
    ...(base.page_welcome_message ? { page_welcome_message: base.page_welcome_message } : {}),
  };
}
