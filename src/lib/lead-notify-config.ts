// A client's "Thông báo lead mới" (new lead notifications) config (shared by server + browser). See lib/lead-notify.ts.

import { translator, type T } from "@/i18n/translate";
import { cleanTemplates, type Templates } from "./notify-templates";

export type NotifyChannel = "zalobot" | "telegram";
export const NOTIFY_CHANNEL_LABEL: Record<NotifyChannel, string> = { zalobot: "Zalo", telegram: "Telegram" };
export type NotifyTarget = { channel: NotifyChannel; chatId: string; title: string };
/** Short code to tell Zalo groups apart (Zalo doesn't send the group name to the bot): last 4 chars of the group id, echoed by the bot when replying to /id. */
export const chatCode = (chatId: string) => chatId.replace(/[^a-z0-9]/gi, "").slice(-4).toUpperCase();
/** chat: off = no message notices · phone = when the customer leaves a phone number · new = every new customer message (with phone if any) */
export type ChatMode = "off" | "phone" | "new";
/** Chat notice options in the language of `t`. */
export const chatModes = (t: T): { key: ChatMode; label: string }[] => [
  { key: "phone", label: t("notify.config.chatModes.phone") },
  { key: "new", label: t("notify.config.chatModes.new") },
  { key: "off", label: t("notify.config.chatModes.off") },
];
/** Vietnamese labels, kept for callers that only need the keys. */
export const CHAT_MODES = chatModes(translator("vi"));
export type LeadNotifyConfig = {
  on: boolean;
  since: string | null; // only notify leads / messages since enabling (no backlog of old leads)
  form: boolean; // leads from Instant Forms
  chat: ChatMode;
  targets: NotifyTarget[];
  templates: Templates; // client-specific message templates, overriding the shared templates (lib/notify-templates.ts)
  confirm: boolean; // include a "claim lead / report result" link in each message (/l/<code> page, no login required)
  remindMin: number; // if unclaimed after N minutes, the bot reminds once (0 = no reminder)
  showPhone: boolean; // show full phone numbers in group messages; when off (default) mask as 09123xxx, visible only via the link — applies only when the confirmation link is on
  recallMax: number; // "Không nghe máy" (no answer) leads: remind the group to call back up to N times, then stop (0 = no reminder)
  duty: string[]; // on-duty person by weekday, 7 entries indexed by Date.getDay() (0 = Sunday); "" = none recorded that day
};
/** Display order on the web (Monday → Sunday); values are Date.getDay() indexes. */
export const dutyDays = (t: T): { day: number; label: string }[] =>
  [1, 2, 3, 4, 5, 6, 0].map((day) => ({ day, label: t(`notify.config.days.d${day}` as "notify.config.days.d0") }));
/** Vietnamese labels (see dutyDays for the translated version). */
export const DUTY_DAYS = dutyDays(translator("vi"));
export const DUTY_MAX = 60;
/** On-duty person for the day of time d (client timezone); "" if not set. */
export function dutyAt(cfg: Pick<LeadNotifyConfig, "duty">, d: Date, tz: string) {
  const day = new Date(`${d.toLocaleDateString("en-CA", { timeZone: tz })}T12:00:00Z`).getUTCDay();
  return cfg.duty[day] ?? "";
}
/** Stored in LeadNotice.text for notices folded into another one (data marker, filtered out of lists; not shown to users as is). */
export const MERGED_NOTICE = "(gộp trong thông báo khác)";
export const REMIND_OPTIONS = [0, 15, 30, 60, 120];
export const RECALL_OPTIONS = [0, 1, 2, 3, 4, 5];
/** Delay before each call-back reminder, counted from picking "Không nghe máy" / the previous reminder: 2 hours, then once a day. */
export const RECALL_GAP_HOURS = [2, 24, 24, 24, 24];
/** Lead form "Question: answer"; if the question already ends with "?" / ":", don't add ":" (avoid "dịch vụ nào?: …"). */
export const qaLine = (q: string, a: string) => (/[?:：]\s*$/.test(q) ? `${q.trim()} ${a}` : `${q}: ${a}`);

export function parseLeadNotify(json: string | null | undefined): LeadNotifyConfig {
  let v: Partial<LeadNotifyConfig> = {};
  try {
    v = JSON.parse(json || "{}");
  } catch {}
  const targets = Array.isArray(v.targets)
    ? v.targets.filter((t) => t && (t.channel === "zalobot" || t.channel === "telegram") && t.chatId).map((t) => ({ channel: t.channel, chatId: String(t.chatId), title: String(t.title ?? "") }))
    : [];
  return {
    on: !!v.on,
    since: typeof v.since === "string" ? v.since : null,
    form: v.form !== false,
    chat: v.chat === "off" || v.chat === "new" ? v.chat : "phone",
    targets,
    templates: cleanTemplates(v.templates, "client"),
    confirm: v.confirm !== false,
    remindMin: REMIND_OPTIONS.includes(Number(v.remindMin)) ? Number(v.remindMin) : 30,
    showPhone: v.showPhone === true,
    recallMax: RECALL_OPTIONS.includes(Number(v.recallMax)) ? Number(v.recallMax) : 3,
    duty: Array.from({ length: 7 }, (_, i) => (Array.isArray(v.duty) ? String(v.duty[i] ?? "") : "").replace(/\s+/g, " ").trim().slice(0, DUTY_MAX)),
  };
}
