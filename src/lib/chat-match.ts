import { requireUser } from "./auth";
import { isPlatformStaff } from "./access";
import { chatCode } from "./lead-notify-config";
import { getT } from "@/i18n/server";
import { viT } from "./format";
import type { T } from "@/i18n/translate";

/**
 * Zalo / Telegram bots are shared by all businesses: users outside the root business only see groups matching the EXACT name (text typed after /id, or the Telegram group name)
 * or the group code the bot replied with, so other businesses' chat groups are not exposed. Platform-workspace users leaving it empty see everything.
 */
export async function chatMatcher(query = "") {
  return matchChat(query, await isPlatformStaff(await requireUser()), await getT());
}

const norm = (x: string) => x.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();

function matchChat(query: string, staff: boolean, t: T = viT) {
  const q = norm(query);
  if (!q && !staff) throw new Error(t("core.chatMatch.needName"));
  return (c: { chatId: string; title: string }) => !q || norm(c.title) === q || chatCode(c.chatId) === q.toUpperCase();
}
