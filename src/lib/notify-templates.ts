// Message templates the Zalo / Telegram bot sends (lead notices, test message, group confirmation). Shared by server + browser.
// Two levels: shared templates (System settings, admin; stored in Setting "notify.templates") and per-client templates (Lead notifications; stored in
// Client.leadNotify.templates). Empty client template = use the shared one; empty shared template = the defaults below (same as the old content).
//
// Syntax:
// - {bien}: replaced with data. Variables not in the list are left as literal text.
// - A line with variables (outside [ ]) where all of them are empty is dropped entirely (e.g. "Email: {email}" when the lead has no email).
// - [ ... {bien} ... ]: the bracketed section only shows when the variable inside has data (brackets without variables are kept as is).

export type TemplateKey = "form" | "formRepeat" | "phone" | "phoneRepeat" | "chat" | "digest" | "remind" | "recall" | "ack" | "result" | "test" | "groupAck" | "autoAction";
export type Templates = Partial<Record<TemplateKey, string>>;
export type TemplateVars = Record<string, string | number | null | undefined>;

import { translator, type T } from "@/i18n/translate";
import { BRAND } from "./brand";

export const TEMPLATE_MAX = 1500; // Zalo max 2000 characters / message, leaving room for data

const VAR_NAMES = ["khach_hang", "ten", "sdt", "ten_sdt", "email", "cau_tra_loi", "form", "quang_cao", "nguon", "tin_nhan", "link_hop_thu", "lan_thu", "thoi_gian", "so_lead", "danh_sach", "loai", "ten_bot", "ma_nhom", "ten_nhom", "viec_da_lam", "link_hoan_tac", "link_xac_nhan", "nguoi", "ket_qua", "ghi_chu", "phut", "nguoi_truc"] as const;
type VarName = (typeof VAR_NAMES)[number];

const FORM_VARS: VarName[] = ["khach_hang", "ten", "sdt", "ten_sdt", "email", "cau_tra_loi", "form", "quang_cao", "lan_thu", "thoi_gian", "nguoi_truc", "link_xac_nhan"];
const CHAT_VARS: VarName[] = ["khach_hang", "ten", "sdt", "ten_sdt", "tin_nhan", "nguon", "quang_cao", "link_hop_thu", "lan_thu", "thoi_gian", "nguoi_truc", "link_xac_nhan"];
const VI = translator("vi");
/** Confirmation link line in the default template; if an edited template lacks {link_xac_nhan}, the system appends this line at the end. */
export const confirmLine = (t: T = VI) => t("notify.templates.lines.confirm");
/** On-duty line; if an edited template lacks {nguoi_truc}, the system inserts this line before the link line (lib/lead-notify.ts withDuty). */
export const dutyLine = (t: T = VI) => t("notify.templates.lines.duty");
export const DUTY_LINE = dutyLine();

export type TemplateDef = {
  key: TemplateKey;
  label: string;
  hint: string;
  scope: "client" | "global"; // client: editable per client too; global: shared template only
  vars: VarName[];
  sample: TemplateVars; // sample data for preview (not real data)
  default: string;
};

/** Variable descriptions in the language of `t`. */
export const varLabels = (t: T): Record<string, string> => Object.fromEntries(VAR_NAMES.map((n) => [n, t(`notify.templates.vars.${n}`)]));

/** All message types (labels, hints, samples and default templates) in the language of `t`. */
export function templateDefs(t: T): TemplateDef[] {
  const s = (k: "formAnswers" | "formName" | "adName" | "source" | "chatMsg" | "chatMsgNew" | "dutyPerson" | "claimer" | "result" | "note" | "groupType" | "botName" | "groupName" | "digestList" | "remindList" | "recallList" | "autoDone") => t(`notify.templates.sample.${k}`, { app: BRAND.app });
  const SAMPLE_FORM = {
    ten: "Nguyễn Thị Lan",
    sdt: "0912345678",
    ten_sdt: "Nguyễn Thị Lan · 0912345678",
    email: "lan.nguyen@example.com",
    cau_tra_loi: s("formAnswers"),
    form: s("formName"),
    quang_cao: s("adName"),
    thoi_gian: "14:05 27/10",
    nguoi_truc: s("dutyPerson"),
    link_xac_nhan: "https://ads.example.com/l/Xk3pQ9aB",
  };
  const SAMPLE_CHAT = {
    ten: "Trần Văn Minh",
    sdt: "0987654321",
    ten_sdt: "Trần Văn Minh · 0987654321",
    tin_nhan: s("chatMsg"),
    nguon: s("source"),
    quang_cao: s("adName"),
    link_hop_thu: "https://business.facebook.com/latest/inbox/messenger?asset_id=…",
    thoi_gian: "14:05 27/10",
    nguoi_truc: s("dutyPerson"),
    link_xac_nhan: "https://ads.example.com/l/Xk3pQ9aB",
  };
  const lines = { dutyLine: dutyLine(t), confirmLine: confirmLine(t), dutyTodayLine: t("notify.templates.lines.dutyToday") };
  const def = (k: TemplateKey, scope: "client" | "global", vars: VarName[], sample: TemplateVars): TemplateDef => ({
    key: k,
    label: t(`notify.templates.defs.${k}.label`),
    hint: t(`notify.templates.defs.${k}.hint`),
    scope,
    vars,
    sample,
    default: t(`notify.templates.defs.${k}.default`, lines),
  });
  return [
    def("form", "client", FORM_VARS, { ...SAMPLE_FORM, lan_thu: 1 }),
    def("formRepeat", "client", FORM_VARS, { ...SAMPLE_FORM, lan_thu: 2 }),
    def("phone", "client", CHAT_VARS, { ...SAMPLE_CHAT, lan_thu: 1 }),
    def("phoneRepeat", "client", CHAT_VARS, { ...SAMPLE_CHAT, lan_thu: 2 }),
    def("chat", "client", CHAT_VARS.filter((x) => x !== "lan_thu"), { ...SAMPLE_CHAT, tin_nhan: s("chatMsgNew"), sdt: "", ten_sdt: "Trần Văn Minh" }),
    def("digest", "client", ["khach_hang", "so_lead", "danh_sach"], { so_lead: 6, danh_sach: s("digestList") }),
    def("remind", "client", ["khach_hang", "so_lead", "danh_sach", "phut", "nguoi_truc"], { so_lead: 2, phut: 30, nguoi_truc: s("dutyPerson"), danh_sach: s("remindList") }),
    def("recall", "client", ["khach_hang", "so_lead", "danh_sach", "nguoi_truc"], { so_lead: 2, nguoi_truc: s("dutyPerson"), danh_sach: s("recallList") }),
    def("ack", "client", ["khach_hang", "nguoi", "ten_sdt", "thoi_gian"], { nguoi: s("claimer"), ten_sdt: "Nguyễn Thị Lan · 0912345678", thoi_gian: "14:12 27/10" }),
    def("result", "client", ["khach_hang", "nguoi", "ten_sdt", "ket_qua", "ghi_chu"], { nguoi: s("claimer"), ten_sdt: "Nguyễn Thị Lan · 0912345678", ket_qua: s("result"), ghi_chu: s("note") }),
    def("test", "client", ["khach_hang"], {}),
    def("groupAck", "global", ["loai", "ten_bot", "ma_nhom", "ten_nhom"], { loai: s("groupType"), ten_bot: s("botName"), ma_nhom: "E895", ten_nhom: s("groupName") }),
    def("autoAction", "global", ["khach_hang", "thoi_gian", "viec_da_lam", "link_hoan_tac"], { thoi_gian: "11:00 27/10", viec_da_lam: s("autoDone"), link_hoan_tac: "https://ads.example.com/clients/…/recommendations" }),
  ];
}

/** Vietnamese defaults: used where no translator is at hand (storage comparison, background jobs). */
const TEMPLATE_DEFS: TemplateDef[] = templateDefs(VI);

export const TEMPLATE_DEF = Object.fromEntries(TEMPLATE_DEFS.map((d) => [d.key, d])) as Record<TemplateKey, TemplateDef>;
export const VAR_LABEL: Record<string, string> = varLabels(VI);

const VAR_RE = /\{([a-z_]+)\}/g;
const isEmpty = (v: TemplateVars[string]) => v == null || String(v).trim() === "";

/** Fill variables into a template (see syntax at the top of the file). Only variables in `known` are replaced. */
export function renderTemplate(tpl: string, vars: TemplateVars, known: readonly string[] = Object.keys(vars)): string {
  const k = new Set(known);
  const namesIn = (s: string) => [...s.matchAll(VAR_RE)].map((m) => m[1]).filter((n) => k.has(n));
  const fill = (s: string) => s.replace(VAR_RE, (m, n: string) => (k.has(n) ? (isEmpty(vars[n]) ? "" : String(vars[n])) : m));
  const out: string[] = [];
  const BRACKET = /\[([^[\]\n]*)\]/g;
  for (const line of tpl.replace(/\r\n?/g, "\n").split("\n")) {
    // Variables outside [ ] decide whether the line is hidden; variables inside [ ] only decide whether that bracketed section is hidden.
    const outside = namesIn(line.replace(BRACKET, (m, inner: string) => (namesIn(inner).length ? "" : m)));
    if (outside.length && outside.every((n) => isEmpty(vars[n]))) continue;
    const kept = line.replace(BRACKET, (m, inner: string) => {
      const ns = namesIn(inner);
      if (!ns.length) return m;
      return ns.every((n) => isEmpty(vars[n])) ? "" : inner;
    });
    if (namesIn(line).length && !kept.trim()) continue;
    out.push(fill(kept));
  }
  return out.join("\n").trim();
}

/** Active template: client's own → shared → default. */
export function pickTemplate(key: TemplateKey, own?: Templates, global?: Templates, t?: T) {
  return own?.[key]?.trim() || global?.[key]?.trim() || (t ? t(`notify.templates.defs.${key}.default`, { dutyLine: dutyLine(t), confirmLine: confirmLine(t), dutyTodayLine: t("notify.templates.lines.dutyToday") }) : TEMPLATE_DEF[key].default);
}

/** Fill the active template for a message type (`t` = language of the default template; omitted = Vietnamese). */
export function renderNotice(key: TemplateKey, vars: TemplateVars, own?: Templates, global?: Templates, t?: T) {
  return renderTemplate(pickTemplate(key, own, global, t), vars, TEMPLATE_DEF[key].vars);
}

/** Read / sanitize saved templates: drop unknown keys, empty templates, truncate length. */
export function cleanTemplates(v: unknown, scope: "client" | "global"): Templates {
  const out: Templates = {};
  if (!v || typeof v !== "object") return out;
  for (const d of TEMPLATE_DEFS) {
    if (scope === "client" && d.scope !== "client") continue;
    const s = (v as Record<string, unknown>)[d.key];
    if (typeof s !== "string") continue;
    const t = s.replace(/\r\n?/g, "\n").trim().slice(0, TEMPLATE_MAX);
    // Drop shared templates identical to the default. Client templates identical to the default are kept: the client wants the default while the shared one was edited.
    if (t && (scope === "client" || t !== d.default)) out[d.key] = t;
  }
  return out;
}

export function parseTemplates(json: string | null | undefined, scope: "client" | "global"): Templates {
  try {
    return cleanTemplates(JSON.parse(json || "{}"), scope);
  } catch {
    return {};
  }
}

/** Unknown variables in a template (typos) to warn the author. */
export function unknownVars(key: TemplateKey, tpl: string) {
  const ok = new Set<string>(TEMPLATE_DEF[key].vars);
  return [...new Set([...tpl.matchAll(VAR_RE)].map((m) => m[1]).filter((n) => !ok.has(n)))];
}
