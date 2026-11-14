// Optimization automation config (shared by server + browser). See lib/auto-rules.ts.

import type { NotifyTarget } from "./lead-notify-config";
import type { T } from "@/i18n/translate";

/** Destinations for automatic notifications (internal group / private chat with the bot), stored in Client.autoNotifyTargets. Never a group shared with the client. */
export function parseAutoTargets(json: string | null | undefined): NotifyTarget[] {
  let v: unknown = [];
  try {
    v = JSON.parse(json || "[]");
  } catch {}
  return Array.isArray(v)
    ? v.filter((t) => t && (t.channel === "zalobot" || t.channel === "telegram") && t.chatId).map((t) => ({ channel: t.channel, chatId: String(t.chatId), title: String(t.title ?? "") }))
    : [];
}

/** Valid destinations from the form (at most 5). */
export const cleanAutoTargets = (list: NotifyTarget[]) =>
  (Array.isArray(list) ? list : [])
    .filter((t) => (t.channel === "zalobot" || t.channel === "telegram") && String(t.chatId ?? "").trim())
    .slice(0, 5)
    .map((t) => ({ channel: t.channel, chatId: String(t.chatId).trim(), title: String(t.title ?? "").trim().slice(0, 80) }));

/** Vietnamese defaults; for the UI language use `autoModes(t)`. */
export const AUTO_MODES = [
  { key: "off", label: "Tắt", hint: "Chỉ đề xuất vào Chờ duyệt như cũ" },
  { key: "dryrun", label: "Chạy thử", hint: "Không đổi gì trên Meta: gắn nhãn những việc đáng lẽ đã tự làm để bạn xem trước" },
  { key: "on", label: "Bật", hint: "Tự tắt / tăng ngân sách trong giới hạn bên dưới, báo lại và cho hoàn tác" },
] as const;

/** Automation modes with label / hint in the UI language. */
export const autoModes = (t: T) =>
  AUTO_MODES.map((m) => ({ key: m.key, label: t(`core.autoModes.${m.key}.label`), hint: t(`core.autoModes.${m.key}.hint`) }));
export type AutoMode = (typeof AUTO_MODES)[number]["key"];
export const toAutoMode = (v: unknown): AutoMode => (AUTO_MODES.some((m) => m.key === v) ? (v as AutoMode) : "off");

/** Automation parameters + quick rules (early cut, scale up when budget runs out) configured in Settings → Automation. */
export type AutoSettings = {
  autoMode: AutoMode;
  autoPause: boolean;
  autoScale: boolean;
  autoFromHour: number;
  autoToHour: number;
  autoNotify: boolean;
  autoNotifyTargets: NotifyTarget[];
  optMinAgeDays: number;
  optEarlyPct: number;
  optEarlySpendX: number;
  optScaleGapHours: number;
  optScaleMinResults: number;
  optScaleConfidence: number;
  optScaleSpendPct: number;
  optScaleBeforeHour: number;
};
export const DEFAULT_AUTO: AutoSettings = {
  autoMode: "off",
  autoPause: true,
  autoScale: true,
  autoFromHour: 7,
  autoToHour: 22,
  autoNotify: true,
  autoNotifyTargets: [],
  optMinAgeDays: 1,
  optEarlyPct: 100,
  optEarlySpendX: 3,
  optScaleGapHours: 24,
  optScaleMinResults: 5,
  optScaleConfidence: 80,
  optScaleSpendPct: 90,
  optScaleBeforeHour: 18,
};
