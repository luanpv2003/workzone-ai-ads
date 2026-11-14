"use client";

import { useState, useTransition } from "react";
import { createLeadFormAction, listCustomAudiencesAction, listLeadFormsAction } from "@/app/actions";
import type { EditableAd, Positions, Welcome } from "@/lib/ai/schemas";
import type { CustomAudienceRef, LeadForm, LeadFormInput, LeadFormQuestion } from "@/lib/meta/types";
import { DEFAULT_POSITIONS, POSITION_OPTS } from "@/lib/ads-options";
import { dateOnly } from "@/lib/format";
import { norm } from "@/lib/text";
import { btnClass, inputClass } from "../ui";
import { Spinner } from "../action-button";
import { Chip, Label, Radio, TextArea, TextInput, Toggle } from "./fields";
import { useT } from "@/i18n/client";
import type { MessageKey, T } from "@/i18n/translate";

// Ads Manager-style input sections for Engagement, Leads (form) and Messages campaigns.

type AudienceRef = { id: string; name: string; subtype?: string; size?: number | null };

const SUBTYPE_KEYS = {
  ENGAGEMENT: "campaigns.adsFields.subtype.ENGAGEMENT",
  LOOKALIKE: "campaigns.adsFields.subtype.LOOKALIKE",
  CUSTOM: "campaigns.adsFields.subtype.CUSTOM",
  WEBSITE: "campaigns.adsFields.subtype.WEBSITE",
  VIDEO: "campaigns.adsFields.subtype.VIDEO",
  IG_BUSINESS: "campaigns.adsFields.subtype.IG_BUSINESS",
  FB_EVENT: "campaigns.adsFields.subtype.FB_EVENT",
  OFFLINE_CONVERSION: "campaigns.adsFields.subtype.OFFLINE_CONVERSION",
  LEAD_AD: "campaigns.adsFields.subtype.LEAD_AD",
} as const;
const subtypeLabel = (t: T, s: string) => (s in SUBTYPE_KEYS ? t(SUBTYPE_KEYS[s as keyof typeof SUBTYPE_KEYS]) : s);

const fmtSize = (t: T, n?: number | null) =>
  n == null ? "" : n >= 1e6 ? t("campaigns.adsFields.sizeMillions", { n: (n / 1e6).toFixed(1) }) : n >= 1000 ? t("campaigns.adsFields.sizeThousands", { n: Math.round(n / 1000) }) : t("campaigns.adsFields.sizePeople", { n });

/** Custom / lookalike audiences: include or exclude (like the "Đối tượng tùy chỉnh" (Custom audiences) field in Ads Manager). */
export function CustomAudiencePicker({
  clientId,
  include,
  exclude,
  onChange,
}: {
  clientId: string;
  include: AudienceRef[];
  exclude: AudienceRef[];
  onChange: (include: AudienceRef[], exclude: AudienceRef[]) => void;
}) {
  const t = useT();
  const [list, setList] = useState<CustomAudienceRef[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [mode, setMode] = useState<"include" | "exclude">("include");
  const [loading, start] = useTransition();
  const load = () =>
    start(async () => {
      setError(null);
      const r = await listCustomAudiencesAction(clientId);
      if (r.ok) setList(r.audiences);
      else setError(r.error);
    });
  const used = new Set([...include, ...exclude].map((a) => a.id));
  const shown = (list ?? []).filter((a) => !used.has(a.id) && (!q.trim() || norm(a.name).includes(norm(q))));
  const add = (a: CustomAudienceRef) => {
    const ref = { id: a.id, name: a.name, subtype: a.subtype, size: a.size };
    if (mode === "include") onChange([...include, ref], exclude);
    else onChange(include, [...exclude, ref]);
  };

  return (
    <div className="space-y-2">
      {(include.length > 0 || exclude.length > 0) && (
        <div className="flex flex-wrap gap-1.5">
          {include.map((a) => (
            <Chip key={a.id} tone="indigo" onRemove={() => onChange(include.filter((x) => x.id !== a.id), exclude)}>
              + {a.name}
            </Chip>
          ))}
          {exclude.map((a) => (
            <Chip key={a.id} onRemove={() => onChange(include, exclude.filter((x) => x.id !== a.id))}>
              <span className="text-rose-600">− {a.name}</span>
            </Chip>
          ))}
        </div>
      )}
      {list === null ? (
        <button type="button" className={btnClass("secondary")} onClick={load} disabled={loading}>
          {loading && <Spinner />}{t("campaigns.adsFields.pickExisting")}
        </button>
      ) : (
        <div className="rounded-lg border border-slate-200">
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-2">
            <div className="flex gap-1 rounded-md bg-slate-100 p-0.5 text-xs">
              {(["include", "exclude"] as const).map((m) => (
                <button key={m} type="button" onClick={() => setMode(m)} className={`rounded px-2 py-1 ${mode === m ? "bg-panel font-medium shadow-sm" : "text-slate-500"}`}>
                  {m === "include" ? t("campaigns.adsFields.include") : t("campaigns.adsFields.exclude")}
                </button>
              ))}
            </div>
            <input className={`${inputClass} min-w-0 flex-1 py-1 text-sm`} placeholder={t("campaigns.adsFields.searchAudience")} value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <ul className="max-h-56 overflow-y-auto text-sm">
            {shown.map((a) => (
              <li key={a.id}>
                <button type="button" onClick={() => add(a)} className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left hover:bg-slate-50" disabled={a.status !== "ready"}>
                  <span className={`min-w-0 truncate ${a.status === "ready" ? "text-slate-800" : "text-slate-400"}`}>{a.name}</span>
                  <span className="shrink-0 text-xs text-slate-400">
                    {subtypeLabel(t, a.subtype)}
                    {a.size ? ` · ${fmtSize(t, a.size)}` : ""}
                    {a.status !== "ready" ? t("campaigns.adsFields.notReady") : ""}
                  </span>
                </button>
              </li>
            ))}
            {!shown.length && <li className="px-3 py-2 text-xs text-slate-400">{list.length ? t("campaigns.adsFields.noMoreAudiences") : t("campaigns.adsFields.noAudiences")}</li>}
          </ul>
        </div>
      )}
      {error && <p className="text-xs text-rose-600">{error}</p>}
    </div>
  );
}

/** Manual ad placements per platform. */
export function PositionsPicker({ value, onChange }: { value: Positions | null; onChange: (v: Positions) => void }) {
  const t = useT();
  const pos = value ?? DEFAULT_POSITIONS;
  const toggle = (platform: keyof Positions, item: string, on: boolean) => {
    const g = POSITION_OPTS.find((x) => x.platform === platform)!;
    let list = on ? [...pos[platform], item] : pos[platform].filter((x) => x !== item);
    // Selecting a secondary placement also selects its required placement; deselecting a required placement also removes its dependents.
    const needs = g.items.find((i) => i.value === item)?.needs;
    if (on && needs && !list.includes(needs)) list.push(needs);
    if (!on) list = list.filter((x) => g.items.find((i) => i.value === x)?.needs !== item);
    onChange({ ...pos, [platform]: [...new Set(list)] });
  };
  return (
    <div className="grid gap-3 @md:grid-cols-2">
      {POSITION_OPTS.map((g) => {
        const all = g.items.every((i) => pos[g.platform].includes(i.value));
        return (
          <div key={g.platform} className="rounded-lg border border-slate-200 p-3">
            <label className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-800">
              <input
                type="checkbox"
                className="accent-indigo-600"
                checked={pos[g.platform].length > 0}
                ref={(el) => {
                  if (el) el.indeterminate = pos[g.platform].length > 0 && !all;
                }}
                onChange={(e) => onChange({ ...pos, [g.platform]: e.target.checked ? g.items.map((i) => i.value) : [] })}
              />
              {g.label}
            </label>
            <div className="space-y-1 pl-5">
              {g.items.map((i) => (
                <label key={i.value} className="flex items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" className="accent-indigo-600" checked={pos[g.platform].includes(i.value)} onChange={(e) => toggle(g.platform, i.value, e.target.checked)} />
                  {t(i.label)}
                </label>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const STD_QUESTIONS: { type: string; label: MessageKey }[] = [
  { type: "FULL_NAME", label: "campaigns.adsFields.question.FULL_NAME" },
  { type: "PHONE", label: "campaigns.adsFields.question.PHONE" },
  { type: "EMAIL", label: "campaigns.adsFields.question.EMAIL" },
  { type: "CITY", label: "campaigns.adsFields.question.CITY" },
  { type: "PROVINCE", label: "campaigns.adsFields.question.PROVINCE" },
  { type: "DOB", label: "campaigns.adsFields.question.DOB" },
  { type: "GENDER", label: "campaigns.adsFields.question.GENDER" },
  { type: "JOB_TITLE", label: "campaigns.adsFields.question.JOB_TITLE" },
  { type: "COMPANY_NAME", label: "campaigns.adsFields.question.COMPANY_NAME" },
];
const Q_LABEL: Record<string, MessageKey> = Object.fromEntries(STD_QUESTIONS.map((q) => [q.type, q.label]));

/** Pick an existing Instant Form on the Page, or create a new form. */
export function LeadFormPicker({
  clientId,
  pageId,
  value,
  privacyUrl,
  onChange,
}: {
  clientId: string;
  pageId?: string | null;
  value: EditableAd["lead_form"];
  privacyUrl?: string | null;
  onChange: (v: EditableAd["lead_form"]) => void;
}) {
  const t = useT();
  const [forms, setForms] = useState<LeadForm[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [loading, start] = useTransition();
  const load = () =>
    start(async () => {
      setError(null);
      const r = await listLeadFormsAction(clientId, pageId);
      if (r.ok) setForms(r.forms);
      else setError(r.error);
    });

  if (creating) {
    return (
      <LeadFormBuilder
        clientId={clientId}
        pageId={pageId}
        privacyUrl={privacyUrl}
        onCancel={() => setCreating(false)}
        onCreated={(f) => {
          setForms((l) => [f, ...(l ?? [])]);
          onChange({ id: f.id, name: f.name });
          setCreating(false);
        }}
      />
    );
  }
  return (
    <div className="space-y-2">
      {value && (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-indigo-200 bg-indigo-50/40 px-3 py-2 text-sm">
          <span className="min-w-0 truncate">📝 <b>{value.name}</b></span>
          <button type="button" className="text-xs text-slate-500 hover:text-rose-600" onClick={() => onChange(null)}>{t("campaigns.adsFields.deselect")}</button>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={btnClass("secondary")} onClick={load} disabled={loading}>
          {loading && <Spinner />}
          {forms ? t("campaigns.adsFields.reloadList") : value ? t("campaigns.adsFields.changeForm") : t("campaigns.adsFields.pickForm")}
        </button>
        <button type="button" className={btnClass("secondary")} onClick={() => setCreating(true)}>{t("campaigns.adsFields.newForm")}</button>
      </div>
      {forms && (
        <ul className="max-h-60 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200 text-sm">
          {forms.map((f) => (
            <li key={f.id}>
              <button
                type="button"
                disabled={f.status !== "ACTIVE"}
                onClick={() => onChange({ id: f.id, name: f.name })}
                className={`w-full px-3 py-2 text-left hover:bg-slate-50 ${value?.id === f.id ? "bg-indigo-50" : ""}`}
              >
                <div className={`truncate ${f.status === "ACTIVE" ? "text-slate-800" : "text-slate-400"}`}>{f.name}</div>
                <div className="text-xs text-slate-400">
                  {dateOnly(f.created)} · {f.questions.map((q) => (q in Q_LABEL ? t(Q_LABEL[q]) : q)).join(", ")}
                  {f.leads != null ? t("campaigns.adsFields.leadsCount", { count: f.leads }) : ""}
                  {f.status !== "ACTIVE" ? t("campaigns.adsFields.archived") : ""}
                </div>
              </button>
            </li>
          ))}
          {!forms.length && <li className="px-3 py-2 text-xs text-slate-400">{t("campaigns.adsFields.noForms")}</li>}
        </ul>
      )}
      {error && <p className="text-xs text-rose-600">{error}</p>}
    </div>
  );
}

function LeadFormBuilder({
  clientId,
  pageId,
  privacyUrl,
  onCancel,
  onCreated,
}: {
  clientId: string;
  pageId?: string | null;
  privacyUrl?: string | null;
  onCancel: () => void;
  onCreated: (f: LeadForm) => void;
}) {
  const t = useT();
  const [f, setF] = useState<LeadFormInput>({
    name: t("campaigns.adsFields.formDefaultName", { date: new Date().toLocaleDateString("vi-VN") }),
    higherIntent: false,
    introTitle: "",
    introText: "",
    questions: [{ type: "FULL_NAME" }, { type: "PHONE" }],
    privacyUrl: privacyUrl ?? "",
    privacyText: "",
    thanksTitle: t("campaigns.adsFields.defaultThanksTitle"),
    thanksBody: t("campaigns.adsFields.defaultThanksBody"),
    thanksButton: "VIEW_WEBSITE",
    websiteUrl: "",
    phone: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, start] = useTransition();
  const set = (patch: Partial<LeadFormInput>) => setF((x) => ({ ...x, ...patch }));
  const setQ = (i: number, patch: Partial<LeadFormQuestion>) => set({ questions: f.questions.map((q, j) => (j === i ? { ...q, ...patch } : q)) });
  const has = (type: string) => f.questions.some((q) => q.type === type);
  const create = () =>
    start(async () => {
      setError(null);
      const r = await createLeadFormAction(clientId, f, pageId);
      if (r.ok) onCreated(r.form);
      else setError(r.error);
    });

  return (
    <div className="space-y-4 rounded-lg border border-indigo-200 bg-indigo-50/30 p-4">
      <div className="flex items-center justify-between">
        <h4 className="font-semibold text-slate-900">{t("campaigns.adsFields.createFormTitle")}</h4>
        <button type="button" className="text-xs text-slate-500 hover:text-slate-800" onClick={onCancel}>{t("campaigns.adsFields.cancel")}</button>
      </div>
      <div>
        <Label>{t("campaigns.adsFields.formName")}</Label>
        <TextInput value={f.name} onChange={(v) => set({ name: v })} />
      </div>
      <div>
        <Label>{t("campaigns.adsFields.formType")}</Label>
        <Radio
          value={f.higherIntent ? "high" : "volume"}
          onChange={(v) => set({ higherIntent: v === "high" })}
          options={[
            { value: "volume", label: t("campaigns.adsFields.typeVolume"), hint: t("campaigns.adsFields.typeVolumeHint") },
            { value: "high", label: t("campaigns.adsFields.typeHigh"), hint: t("campaigns.adsFields.typeHighHint") },
          ]}
        />
      </div>
      <div className="grid gap-3 @md:grid-cols-2">
        <div>
          <Label hint={t("campaigns.adsFields.optional")}>{t("campaigns.adsFields.introTitle")}</Label>
          <TextInput value={f.introTitle} onChange={(v) => set({ introTitle: v })} placeholder={t("campaigns.adsFields.introTitlePh")} maxHint={60} />
        </div>
        <div>
          <Label hint={t("campaigns.adsFields.optional")}>{t("campaigns.adsFields.introText")}</Label>
          <TextInput value={f.introText} onChange={(v) => set({ introText: v })} placeholder={t("campaigns.adsFields.introTextPh")} />
        </div>
      </div>
      <div>
        <Label hint={t("campaigns.adsFields.questionsHint")}>{t("campaigns.adsFields.questions")}</Label>
        <div className="mb-2 flex flex-wrap gap-1.5">
          {STD_QUESTIONS.map((q) => (
            <button
              key={q.type}
              type="button"
              onClick={() => set({ questions: has(q.type) ? f.questions.filter((x) => x.type !== q.type) : [...f.questions, { type: q.type }] })}
              className={`rounded-full border px-2.5 py-1 text-xs ${has(q.type) ? "border-indigo-500 bg-indigo-600 text-white" : "border-slate-200 bg-panel text-slate-700 hover:border-slate-300"}`}
            >
              {has(q.type) ? "✓ " : "+ "}
              {t(q.label)}
            </button>
          ))}
        </div>
        <div className="space-y-2">
          {f.questions.map((q, i) =>
            q.type === "CUSTOM" ? (
              <div key={i} className="space-y-1 rounded-md border border-slate-200 bg-panel p-2">
                <div className="flex gap-2">
                  <input className={`${inputClass} flex-1`} value={q.label ?? ""} placeholder={t("campaigns.adsFields.customQuestionPh")} onChange={(e) => setQ(i, { label: e.target.value })} />
                  <button type="button" className="text-xs text-slate-400 hover:text-rose-600" onClick={() => set({ questions: f.questions.filter((_, j) => j !== i) })}>{t("campaigns.adsFields.delete")}</button>
                </div>
                <input
                  className={`${inputClass} text-sm`}
                  value={(q.options ?? []).join("; ")}
                  placeholder={t("campaigns.adsFields.optionsPh")}
                  onChange={(e) => setQ(i, { options: e.target.value.split(";").map((x) => x.trim()).filter(Boolean) })}
                />
              </div>
            ) : null,
          )}
          <button type="button" className="text-xs font-medium text-indigo-600 hover:underline" onClick={() => set({ questions: [...f.questions, { type: "CUSTOM", label: "" }] })}>
            {t("campaigns.adsFields.addCustomQuestion")}
          </button>
        </div>
      </div>
      <div className="grid gap-3 @md:grid-cols-2">
        <div>
          <Label hint={t("campaigns.adsFields.required")}>{t("campaigns.adsFields.privacyLink")}</Label>
          <TextInput value={f.privacyUrl} onChange={(v) => set({ privacyUrl: v })} placeholder="https://" />
        </div>
        <div>
          <Label hint={t("campaigns.adsFields.optional")}>{t("campaigns.adsFields.linkText")}</Label>
          <TextInput value={f.privacyText} onChange={(v) => set({ privacyText: v })} placeholder={t("campaigns.adsFields.privacyPolicy")} />
        </div>
      </div>
      <div className="grid gap-3 @md:grid-cols-2">
        <div>
          <Label>{t("campaigns.adsFields.thanksTitle")}</Label>
          <TextInput value={f.thanksTitle} onChange={(v) => set({ thanksTitle: v })} maxHint={60} />
        </div>
        <div>
          <Label>{t("campaigns.adsFields.thanksBody")}</Label>
          <TextInput value={f.thanksBody} onChange={(v) => set({ thanksBody: v })} />
        </div>
      </div>
      <div className="grid gap-3 @md:grid-cols-2">
        <div>
          <Label>{t("campaigns.adsFields.buttonAfter")}</Label>
          <select className={inputClass} value={f.thanksButton} onChange={(e) => set({ thanksButton: e.target.value as LeadFormInput["thanksButton"] })}>
            <option value="VIEW_WEBSITE">{t("campaigns.adsFields.btnWebsite")}</option>
            <option value="CALL_BUSINESS">{t("campaigns.adsFields.btnCall")}</option>
            <option value="MESSAGE_BUSINESS">{t("campaigns.adsFields.btnMessage")}</option>
          </select>
        </div>
        {f.thanksButton === "VIEW_WEBSITE" && (
          <div>
            <Label>{t("campaigns.adsFields.websiteLink")}</Label>
            <TextInput value={f.websiteUrl} onChange={(v) => set({ websiteUrl: v })} placeholder="https://" />
          </div>
        )}
        {f.thanksButton === "CALL_BUSINESS" && (
          <div>
            <Label>{t("campaigns.adsFields.phone")}</Label>
            <TextInput value={f.phone} onChange={(v) => set({ phone: v })} placeholder="+84901234567" />
          </div>
        )}
      </div>
      {error && <p className="text-sm text-rose-600">{error}</p>}
      <div className="flex items-center gap-3">
        <button type="button" className={btnClass("primary")} onClick={create} disabled={saving}>
          {saving && <Spinner />}{t("campaigns.adsFields.createOnPage")}
        </button>
        <span className="text-xs text-slate-500">{t("campaigns.adsFields.formNote")}</span>
      </div>
    </div>
  );
}

/** Welcome message template: greeting + up to 4 suggested questions for the customer to tap (optionally with automatic answers). */
export function WelcomeEditor({ value, onChange }: { value: Welcome | null; onChange: (v: Welcome | null) => void }) {
  const t = useT();
  if (!value) {
    return (
      <Toggle
        checked={false}
        onChange={() => onChange({ greeting: t("campaigns.adsFields.defaultGreeting"), questions: [{ q: t("campaigns.adsFields.defaultQuestion"), a: "" }] })}
        label={t("campaigns.adsFields.customTemplate")}
        hint={t("campaigns.adsFields.customTemplateHint")}
      />
    );
  }
  const setQ = (i: number, patch: Partial<Welcome["questions"][number]>) => onChange({ ...value, questions: value.questions.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  return (
    <div className="space-y-3">
      <Toggle checked onChange={() => onChange(null)} label={t("campaigns.adsFields.customTemplate")} />
      <div>
        <Label>{t("campaigns.adsFields.greeting")}</Label>
        <TextArea rows={2} value={value.greeting} onChange={(v) => onChange({ ...value, greeting: v })} />
      </div>
      <div>
        <Label hint={`${value.questions.length}/4`}>{t("campaigns.adsFields.suggestedQuestions")}</Label>
        <p className="mb-1 text-xs text-slate-500">{t("campaigns.adsFields.chatbotNote")}</p>
        <div className="space-y-2">
          {value.questions.map((x, i) => (
            <div key={i} className="grid gap-2 rounded-md border border-slate-200 p-2 @md:grid-cols-2">
              <input className={inputClass} value={x.q} maxLength={80} placeholder={t("campaigns.adsFields.questionPh")} onChange={(e) => setQ(i, { q: e.target.value })} />
              <div className="flex gap-2">
                <input className={`${inputClass} flex-1`} value={x.a} placeholder={t("campaigns.adsFields.autoAnswerPh")} onChange={(e) => setQ(i, { a: e.target.value })} />
                <button type="button" className="text-xs text-slate-400 hover:text-rose-600" onClick={() => onChange({ ...value, questions: value.questions.filter((_, j) => j !== i) })}>{t("campaigns.adsFields.delete")}</button>
              </div>
            </div>
          ))}
          {value.questions.length < 4 && (
            <button type="button" className="text-xs font-medium text-indigo-600 hover:underline" onClick={() => onChange({ ...value, questions: [...value.questions, { q: "", a: "" }] })}>
              {t("campaigns.adsFields.addQuestion")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Preview the message template as a Messenger chat window. */
export function WelcomePreview({ value, pageName }: { value: Welcome; pageName: string }) {
  const t = useT();
  return (
    <div className="rounded-lg border border-slate-200 bg-panel p-3 text-[13px] shadow-sm">
      <div className="mb-2 text-xs font-medium text-slate-500">{t("campaigns.adsFields.chatPreview")}</div>
      <div className="mb-2 flex items-end gap-2">
        <div className="grid size-6 shrink-0 place-items-center rounded-full bg-indigo-600 text-[10px] font-semibold text-white">{pageName.charAt(0)}</div>
        <div className="rounded-2xl rounded-bl-sm bg-slate-100 px-3 py-2 whitespace-pre-line text-slate-900">{value.greeting || "…"}</div>
      </div>
      <div className="flex flex-col items-end gap-1">
        {value.questions.filter((x) => x.q.trim()).map((x, i) => (
          <span key={i} className="rounded-full border border-indigo-300 px-3 py-1 text-indigo-700">{x.q}</span>
        ))}
      </div>
    </div>
  );
}
