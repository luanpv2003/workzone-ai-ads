import { translator, type T } from "@/i18n/translate";
import type { ZaloParam, ZaloTemplate } from "./zalo";

const VI = translator("vi");

// Server + browser shared part of "Báo cáo gửi khách" (Client reports), no DB access. See lib/client-report.ts.

/** Weekday names, Monday first. */
export const weekdays = (t: T = VI) => (["d1", "d2", "d3", "d4", "d5", "d6", "d7"] as const).map((d) => t(`notify.report.weekdays.${d}`));

export type Recipient = { name: string; phone: string };
export function parseRecipients(json: string | null | undefined): Recipient[] {
  try {
    const v = JSON.parse(json ?? "[]");
    return Array.isArray(v) ? v.filter((r) => r && typeof r.phone === "string").map((r) => ({ name: String(r.name ?? ""), phone: String(r.phone) })) : [];
  } catch {
    return [];
  }
}

export type EmailTo = { name: string; email: string };
export type TelegramTo = { title: string; chatId: string };
/** zalobot: a Zalo group shared with the client via the platform's Zalo Bot (no OA needed); zalo: Zalo OA template message to a phone number. */
export type Channel = "email" | "telegram" | "zalobot" | "zalo";
export const channelLabels = (t: T = VI): Record<Channel, string> => ({ email: "Email", telegram: "Telegram", zalobot: t("notify.report.channels.zalobot"), zalo: "Zalo OA" });

const parseList = <T>(json: string | null | undefined, ok: (r: Record<string, unknown>) => T | null): T[] => {
  try {
    const v = JSON.parse(json ?? "[]");
    return Array.isArray(v) ? v.map((r) => (r && typeof r === "object" ? ok(r) : null)).filter((r): r is T => r != null) : [];
  } catch {
    return [];
  }
};
export const parseEmails = (json: string | null | undefined) => parseList<EmailTo>(json, (r) => (typeof r.email === "string" ? { name: String(r.name ?? ""), email: r.email } : null));
export const parseTelegram = (json: string | null | undefined) => parseList<TelegramTo>(json, (r) => (r.chatId != null ? { title: String(r.title ?? ""), chatId: String(r.chatId) } : null));
export const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);

/** Auto-composed report message (email, Telegram, copy-paste to Zalo). The approver can edit it before sending. */
export function reportMessage(v: Vars, t: T = VI) {
  return [
    t("notify.report.message.title", { period: v.ky_bao_cao ?? "", range: v.khoang_ngay ?? "", name: v.ten_khach ?? "" }),
    t("notify.report.message.spend", { v: v.chi_tieu ?? "" }),
    t("notify.report.message.result", { v: v.ket_qua ?? "" }),
    t("notify.report.message.cpr", { v: v.gia_ket_qua ?? "" }),
    `• ${v.so_ky_truoc}`,
    v.nhan_xet ? t("notify.report.message.comment", { v: v.nhan_xet }) : null,
    t("notify.report.message.link", { v: v.link_bao_cao ?? "" }),
  ]
    .filter(Boolean)
    .join("\n");
}

/** Variables from the report used to fill template message parameters. "ten_nguoi_nhan" differs per recipient. */
export const REPORT_VAR_KEYS = ["ten_khach", "ten_nguoi_nhan", "ky_bao_cao", "khoang_ngay", "tu_ngay", "den_ngay", "chi_tieu", "so_ket_qua", "loai_ket_qua", "ket_qua", "gia_ket_qua", "so_ky_truoc", "tiep_can", "hien_thi", "nhan_xet", "link_bao_cao", "ma_bao_cao", "ngay_lap"] as const;
/** Variables with their label and sample value in the language of `t`. */
export const reportVarList = (t: T = VI) => REPORT_VAR_KEYS.map((key) => ({ key, label: t(`notify.report.vars.${key}.label`), sample: t(`notify.report.vars.${key}.sample`) }));
export const REPORT_VARS = reportVarList();
export type VarKey = (typeof REPORT_VAR_KEYS)[number];
export type Vars = Partial<Record<VarKey, string>>;

/** Guess the variable for a parameter by name (the user can change it). */
export function guessVar(param: string): string {
  const p = param.toLowerCase();
  if (REPORT_VARS.some((v) => v.key === p)) return `var:${p}`;
  const rules: [RegExp, VarKey][] = [
    [/link|url|duong_dan/, "link_bao_cao"],
    [/ma_|code|key|token/, "ma_bao_cao"],
    [/nguoi_nhan|recipient|lien_he|contact/, "ten_nguoi_nhan"],
    [/ten|name|customer|khach|brand/, "ten_khach"],
    [/chi_phi_|gia|cpr|cost_per|don_gia/, "gia_ket_qua"],
    [/chi|spend|ngan_sach|budget|amount|tien/, "chi_tieu"],
    [/ky_truoc|so_sanh|compare|thay_doi|change/, "so_ky_truoc"],
    [/loai/, "loai_ket_qua"],
    [/tin_nhan|ket_qua|result|lead|so_luong|quantity/, "so_ket_qua"],
    [/tiep_can|reach/, "tiep_can"],
    [/hien_thi|impression/, "hien_thi"],
    [/nhan_xet|ghi_chu|note|comment|danh_gia/, "nhan_xet"],
    [/tu_ngay|start|from|bat_dau/, "tu_ngay"],
    [/den_ngay|end|to_date|ket_thuc/, "den_ngay"],
    [/ky|period|thoi_gian|time|ngay|date/, "khoang_ngay"],
  ];
  const hit = rules.find(([re]) => re.test(p));
  return hit ? `var:${hit[1]}` : "text:";
}

export const defaultMap = (params: ZaloParam[]) => Object.fromEntries(params.map((p) => [p.name, guessVar(p.name)]));

/** Per-parameter errors (missing / too long / too short), before sending. */
export function checkData(t: ZaloTemplate, data: Record<string, string>, tr: T = VI) {
  const errors: { param: string; error: string }[] = [];
  for (const p of t.params) {
    const v = data[p.name] ?? "";
    if (!v && (p.require || !p.acceptNull)) errors.push({ param: p.name, error: tr("notify.report.check.missing") });
    else if (p.maxLength && v.length > p.maxLength) errors.push({ param: p.name, error: tr("notify.report.check.tooLong", { len: v.length, max: p.maxLength }) });
    else if (v && p.minLength && v.length < p.minLength) errors.push({ param: p.name, error: tr("notify.report.check.tooShort", { min: p.minLength }) });
  }
  return errors;
}


/** "0987 654 321" / "+84987654321" → "84987654321" (format Zalo requires). null if not a valid Vietnamese phone number. */
export function normalizePhone(raw: string): string | null {
  let p = raw.replace(/[\s.\-()]/g, "");
  if (p.startsWith("+")) p = p.slice(1);
  if (p.startsWith("0")) p = `84${p.slice(1)}`;
  return /^84[35789]\d{8}$/.test(p) ? p : null;
}
/** 84987654321 → 0987 654 321 */
export const displayPhone = (p: string) => `0${p.slice(2)}`.replace(/^(\d{4})(\d{3})(\d+)$/, "$1 $2 $3");

