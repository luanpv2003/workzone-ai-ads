import type { NurtureCheck } from "./ai/schemas";
import type { Tone } from "@/components/ui";
import type { MessageKey, T } from "@/i18n/translate";

// Re-engagement: rules shared by browser + server (sending window, policy check, personalization).

/** Selectable stages (spam is never sent to). "_none" = conversation not yet analyzed by Claude. */
export const NURTURE_STAGES = [
  { key: "interested", labelKey: "customers.nurtureRules.stages.interested" },
  { key: "considering", labelKey: "customers.nurtureRules.stages.considering" },
  { key: "ready_to_buy", labelKey: "customers.nurtureRules.stages.ready_to_buy" },
  { key: "new", labelKey: "customers.nurtureRules.stages.new" },
  { key: "_none", labelKey: "customers.nurtureRules.stages._none" },
  { key: "purchased", labelKey: "customers.nurtureRules.stages.purchased" },
  { key: "lost", labelKey: "customers.nurtureRules.stages.lost" },
] as const satisfies readonly { key: string; labelKey: MessageKey }[];
export const DEFAULT_STAGES = ["interested", "considering", "ready_to_buy"];

/** Sending hours (client's local time): never send outside this window, even when clicking "Gửi ngay" (send now). */
export const SEND_FROM = 8;
export const SEND_TO = 21;
/** Meta allows sending within 24 hours of the customer's last message; keep a 1-hour margin to avoid rejection mid-send. */
export const WINDOW_HOURS = 23;
export const MAX_TEXT = 1000;

export type NurturePolicy = NurtureCheck & { key: string; at: string };

function fnv(s: string, seed: number) {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Content fingerprint: editing the message requires re-checking. */
export function messageKey(text: string) {
  const t = text.trim();
  return fnv(t, 2166136261) + fnv(t, 0x9e3779b9);
}

export function parsePolicy(s: string | null | undefined): NurturePolicy | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as NurturePolicy;
  } catch {
    return null;
  }
}

/** Required before approving / sending: the current content was checked, with no severe issues. */
export function nurtureGate(message: string, policy: NurturePolicy | null, t: T): { ok: boolean; reason: string | null; warn: boolean } {
  if (!message.trim()) return { ok: false, reason: t("customers.nurtureRules.gate.empty"), warn: false };
  if (message.length > MAX_TEXT) return { ok: false, reason: t("customers.nurtureRules.gate.tooLong", { max: MAX_TEXT }), warn: false };
  if (!policy || policy.key !== messageKey(message)) return { ok: false, reason: t("customers.nurtureRules.gate.notChecked"), warn: false };
  if (policy.verdict === "reject" || policy.issues.some((i) => i.severity === "high")) return { ok: false, reason: t("customers.nurtureRules.gate.rejected"), warn: false };
  return { ok: true, reason: null, warn: policy.verdict === "fix" };
}

/** Vietnamese given name = last word of the full name ("Nguyễn Văn An" → "An"). null if the name is unclear. */
function givenName(full: string) {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  const last = parts.at(-1);
  if (!last || /^(khách|facebook|user)$/i.test(last) || !/\p{L}/u.test(last)) return null;
  return last;
}

export function personalize(text: string, customerName: string) {
  return text.replace(/\{ten\}/g, givenName(customerName) ?? "anh/chị").trim();
}

/** Customer asked to stop receiving messages. Only short messages are checked to avoid confusing proper names ("Huy"); unambiguous phrases are checked at any length. */
export function isOptOut(text: string) {
  const t = text.trim().toLowerCase();
  if (/(không|ko|k|đừng|dung|ngừng|thôi)\s+(muốn\s+)?(nhận|nhắn|gửi)\s+tin/.test(t)) return true;
  return t.length <= 25 && /^(dừng|dừng lại|stop|hủy|huỷ|unsubscribe|đừng nhắn nữa)[\s.!]*$/.test(t);
}

export function parseStages(s: string | null | undefined): string[] {
  try {
    const v = JSON.parse(s ?? "[]");
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export const FLOW_STATUS: Record<string, { labelKey: MessageKey; tone: Tone }> = {
  draft: { labelKey: "customers.nurtureRules.flowStatus.draft", tone: "mut" },
  active: { labelKey: "customers.nurtureRules.flowStatus.active", tone: "good" },
  paused: { labelKey: "customers.nurtureRules.flowStatus.paused", tone: "warn" },
};
export const SEND_STATUS: Record<string, { labelKey: MessageKey; tone: Tone }> = {
  sent: { labelKey: "customers.nurtureRules.sendStatus.sent", tone: "good" },
  manual: { labelKey: "customers.nurtureRules.sendStatus.manual", tone: "info" },
  test: { labelKey: "customers.nurtureRules.sendStatus.test", tone: "info" },
  failed: { labelKey: "customers.nurtureRules.sendStatus.failed", tone: "bad" },
};
