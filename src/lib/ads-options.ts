// Options mirroring Ads Manager (verified with validate_only against Graph API v23): shared by server + browser.
import type { EditableAdSet, EditablePlan } from "./ai/schemas";
import type { MessageKey } from "@/i18n/translate";

// `label` / `hint` are catalogue keys: render them with t(opt.label).
type Opt = { value: string; label: MessageKey; hint?: MessageKey };

/** "Performance goal" per campaign type. The first entry is the default. */
export function performanceGoals(result: string, s?: Pick<EditableAdSet, "lead_destination">): Opt[] {
  switch (result) {
    case "messages":
      return [
        { value: "CONVERSATIONS", label: "campaigns.adsOptions.goal.conversations", hint: "campaigns.adsOptions.goal.conversationsHint" },
        { value: "LINK_CLICKS", label: "campaigns.adsOptions.goal.linkClicks", hint: "campaigns.adsOptions.goal.linkClicksMsgHint" },
      ];
    case "leads":
      return s?.lead_destination === "messenger"
        ? [{ value: "LEAD_GENERATION", label: "campaigns.adsOptions.goal.leads", hint: "campaigns.adsOptions.goal.leadsMessengerHint" }]
        : [
            { value: "LEAD_GENERATION", label: "campaigns.adsOptions.goal.leads", hint: "campaigns.adsOptions.goal.leadsFormHint" },
            { value: "QUALITY_LEAD", label: "campaigns.adsOptions.goal.qualityLead", hint: "campaigns.adsOptions.goal.qualityLeadHint" },
          ];
    case "engagement":
      return [
        { value: "POST_ENGAGEMENT", label: "campaigns.adsOptions.goal.postEngagement", hint: "campaigns.adsOptions.goal.postEngagementHint" },
        { value: "REACH", label: "campaigns.adsOptions.goal.reach" },
      ];
    case "video_views":
      return [
        { value: "THRUPLAY", label: "campaigns.adsOptions.goal.thruplay", hint: "campaigns.adsOptions.goal.thruplayHint" },
        { value: "TWO_SECOND_CONTINUOUS_VIDEO_VIEWS", label: "campaigns.adsOptions.goal.twoSecond" },
      ];
    case "page_likes":
      return [{ value: "PAGE_LIKES", label: "campaigns.adsOptions.goal.pageLikes" }];
    case "link_clicks":
      return [
        { value: "LINK_CLICKS", label: "campaigns.adsOptions.goal.linkClicks" },
        { value: "LANDING_PAGE_VIEWS", label: "campaigns.adsOptions.goal.landingPageViews", hint: "campaigns.adsOptions.goal.landingPageViewsHint" },
        { value: "REACH", label: "campaigns.adsOptions.goal.reach" },
      ];
    case "profile_visits":
      return [{ value: "VISIT_INSTAGRAM_PROFILE", label: "campaigns.adsOptions.goal.igProfile" }];
    default:
      return [{ value: "REACH", label: "campaigns.adsOptions.goal.reach" }];
  }
}

export const goalOf = (result: string, s: Pick<EditableAdSet, "performance_goal" | "lead_destination">) => {
  const list = performanceGoals(result, s);
  return list.find((g) => g.value === s.performance_goal)?.value ?? list[0].value;
};

/** Conversion location for messaging campaigns. */
export const MESSAGE_DESTINATION_OPTS: (Opt & { needsIg?: boolean; needsWa?: boolean; api: string })[] = [
  { value: "messenger", label: "campaigns.adsOptions.dest.messenger", api: "MESSENGER" },
  { value: "instagram", label: "campaigns.adsOptions.dest.instagram", api: "INSTAGRAM_DIRECT", needsIg: true },
  { value: "whatsapp", label: "campaigns.adsOptions.dest.whatsapp", api: "WHATSAPP", needsWa: true },
  { value: "both", label: "campaigns.adsOptions.dest.both", api: "MESSAGING_INSTAGRAM_DIRECT_MESSENGER", needsIg: true },
  { value: "messenger_whatsapp", label: "campaigns.adsOptions.dest.messengerWhatsapp", api: "MESSAGING_MESSENGER_WHATSAPP", needsWa: true },
  { value: "instagram_whatsapp", label: "campaigns.adsOptions.dest.instagramWhatsapp", api: "MESSAGING_INSTAGRAM_DIRECT_WHATSAPP", needsIg: true, needsWa: true },
  { value: "all", label: "campaigns.adsOptions.dest.all", api: "MESSAGING_INSTAGRAM_DIRECT_MESSENGER_WHATSAPP", needsIg: true, needsWa: true },
];

/** Detailed placements. `needs`: must be selected together with this placement (required by Meta). */
export const POSITION_OPTS: { platform: "facebook" | "instagram" | "messenger" | "audience_network"; label: string; items: (Opt & { needs?: string })[] }[] = [
  {
    platform: "facebook",
    label: "Facebook",
    items: [
      { value: "feed", label: "campaigns.adsOptions.pos.feed" },
      { value: "profile_feed", label: "campaigns.adsOptions.pos.profileFeed", needs: "feed" },
      { value: "marketplace", label: "campaigns.adsOptions.pos.marketplace", needs: "feed" },
      { value: "search", label: "campaigns.adsOptions.pos.search", needs: "feed" },
      { value: "story", label: "campaigns.adsOptions.pos.stories", needs: "feed" },
      { value: "facebook_reels", label: "campaigns.adsOptions.pos.reels" },
      { value: "instream_video", label: "campaigns.adsOptions.pos.instream" },
    ],
  },
  {
    platform: "instagram",
    label: "Instagram",
    items: [
      { value: "stream", label: "campaigns.adsOptions.pos.feed" },
      { value: "profile_feed", label: "campaigns.adsOptions.pos.profileFeed", needs: "stream" },
      { value: "ig_search", label: "campaigns.adsOptions.pos.search", needs: "stream" },
      { value: "story", label: "campaigns.adsOptions.pos.stories" },
      { value: "reels", label: "campaigns.adsOptions.pos.reels" },
      { value: "profile_reels", label: "campaigns.adsOptions.pos.profileReels" },
    ],
  },
  {
    platform: "messenger",
    label: "Messenger",
    items: [
      { value: "messenger_home", label: "campaigns.adsOptions.pos.inbox" },
      { value: "story", label: "campaigns.adsOptions.pos.stories" },
    ],
  },
  {
    platform: "audience_network",
    label: "Audience Network",
    items: [
      { value: "classic", label: "campaigns.adsOptions.pos.classic" },
      { value: "rewarded_video", label: "campaigns.adsOptions.pos.rewarded" },
    ],
  },
];

export const DEFAULT_POSITIONS = { facebook: ["feed", "story", "facebook_reels"], instagram: ["stream", "story", "reels"], messenger: [], audience_network: [] };

/** Call-to-action buttons suited to each objective (first entry is the default). */
export function ctasFor(result: string, s?: Pick<EditableAdSet, "message_destination" | "lead_destination">): EditablePlan["ads"][number]["call_to_action"][] {
  switch (result) {
    case "messages":
      return s?.message_destination === "whatsapp" ? ["WHATSAPP_MESSAGE"] : ["MESSAGE_PAGE"];
    case "leads":
      return s?.lead_destination === "messenger" ? ["MESSAGE_PAGE"] : ["SIGN_UP", "APPLY_NOW", "GET_QUOTE", "LEARN_MORE", "SUBSCRIBE", "BOOK_NOW", "DOWNLOAD", "GET_OFFER", "CONTACT_US"];
    case "page_likes":
      return ["LIKE_PAGE"];
    case "profile_visits":
      return ["VIEW_INSTAGRAM_PROFILE"];
    case "engagement":
    case "video_views":
      return ["LEARN_MORE", "MESSAGE_PAGE", "BOOK_NOW", "SHOP_NOW", "CONTACT_US"];
    default:
      return ["LEARN_MORE", "SHOP_NOW", "SIGN_UP", "BOOK_NOW", "CONTACT_US", "GET_OFFER", "GET_QUOTE", "APPLY_NOW", "DOWNLOAD", "SUBSCRIBE"];
  }
}

export const BID_OPTS: (Opt & { needsAmount?: boolean })[] = [
  { value: "lowest_cost", label: "campaigns.adsOptions.bid.lowestCost", hint: "campaigns.adsOptions.bid.lowestCostHint" },
  { value: "cost_cap", label: "campaigns.adsOptions.bid.costCap", hint: "campaigns.adsOptions.bid.costCapHint", needsAmount: true },
  { value: "bid_cap", label: "campaigns.adsOptions.bid.bidCap", hint: "campaigns.adsOptions.bid.bidCapHint", needsAmount: true },
];
