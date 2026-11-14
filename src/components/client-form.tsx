"use client";

import { useActionState, useState, useTransition } from "react";
import { inspectTokenAction, type ActionResult } from "@/app/actions";
import type { TokenInspection } from "@/lib/meta/inspect";
import { Combobox } from "./combobox";
import { btnClass, Field, inputClass } from "./ui";
import { dateOnly } from "@/lib/format";
import { Spinner } from "./action-button";
import { guessIndustry, industryLabels, INDUSTRIES } from "@/lib/industries";
import { parseExtraPages } from "@/lib/client-pages";
import { AUDIENCE_ORIGINS } from "@/lib/audience-origin";
import { useT } from "@/i18n/client";

export type ClientFormValues = {
  name: string;
  industry: string;
  industryKey?: string | null;
  brief: string;
  currency: string;
  primaryResult: string;
  audienceOrigin?: string;
  targetCpr: number | null;
  autoTargetCpr?: number | null;
  autoTargetCprNote?: string | null;
  targetRoas: number | null;
  maxDailyBudget: number | null;
  maxBudgetChangePct: number;
  analysisDays?: number;
  minResults?: number;
  conversationLimit?: number;
  readImages?: boolean;
  dataSource: string;
  metaAdAccountId: string | null;
  metaPageId: string | null;
  metaPageName?: string | null;
  metaExtraPages?: string;
  metaInstagramId: string | null;
  storeLat: number | null;
  storeLng: number | null;
  hasToken: boolean;
  metaTokenExpiresAt: Date | null;
};

/** Auto-suggested target CPR: the system computes it from history when the user hasn't entered one; click to fill the field, then edit freely. */
function AutoTargetHint({ v, currency, empty, onUse }: { v?: ClientFormValues; currency: string; empty: boolean; onUse: (s: string) => void }) {
  const t = useT();
  if (!v?.autoTargetCpr) return <span className="mt-1 block text-xs text-slate-500">{t("settings.clientForm.autoEmpty")}</span>;
  let note: { days?: number; results?: number; avgCpr?: number } = {};
  try {
    note = v.autoTargetCprNote ? JSON.parse(v.autoTargetCprNote) : {};
  } catch {}
  const f = (n: number) => `${n.toLocaleString("vi-VN")} ${currency}`;
  return (
    <span className="mt-1 block text-xs text-slate-500">
      {t("settings.clientForm.autoSuggested")}<b className="text-slate-700">{f(v.autoTargetCpr)}</b>
      {note.avgCpr ? ` (${t("settings.clientForm.autoBasis", { avg: f(note.avgCpr), results: note.results?.toLocaleString("vi-VN") ?? "", days: note.days ?? "" })})` : ""}.
      {empty ? ` ${t("settings.clientForm.autoUsingEmpty")} ` : ` ${t("settings.clientForm.autoUsingYours")} `}
      <button type="button" className="font-medium text-blue-600 hover:underline" onClick={() => onUse(String(v.autoTargetCpr))}>
        {t("settings.clientForm.autoFill")}
      </button>
    </span>
  );
}

function Submit({ label, pending }: { label: string; pending: boolean }) {
  return (
    <button className={btnClass("primary")} disabled={pending}>
      {pending && <Spinner />}
      {label}
    </button>
  );
}

export function ClientForm({
  clientId,
  initial,
  create,
  update,
  hidden,
  workspaces,
}: {
  clientId?: string;
  /** When creating a client: the businesses the user belongs to (≥2 lets them choose which business owns the client). */
  workspaces?: { id: string; name: string }[];
  initial?: ClientFormValues;
  /** Hidden fields sent along (e.g. a temporary document id when creating a client from a file). */
  hidden?: Record<string, string>;
  create?: (prev: ActionResult | null, form: FormData) => Promise<ActionResult>;
  update?: (prev: ActionResult | null, form: FormData) => Promise<ActionResult>;
}) {
  const t = useT();
  const [state, formAction, pending] = useActionState(create ?? update ?? (async () => null), null);
  const [, startSubmit] = useTransition();
  const [source, setSource] = useState(initial?.dataSource ?? "mock");
  const [currency, setCurrency] = useState(initial?.currency ?? "VND");
  const [targetCpr, setTargetCpr] = useState(initial?.targetCpr != null ? String(initial.targetCpr) : "");
  const v = initial;

  return (
    // Submit via onSubmit instead of <form action>: React clears the form after an action, even on error,
    // losing what the user just typed.
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        startSubmit(() => formAction(fd));
      }}
      className="@container space-y-6"
    >
      {hidden && Object.entries(hidden).map(([k, val]) => <input key={k} type="hidden" name={k} value={val} />)}
      {workspaces && workspaces.length > 1 && (
        <Field label={t("settings.clientForm.workspace")} hint={t("settings.clientForm.workspaceHint")}>
          <select name="workspaceId" defaultValue={workspaces[0].id} className={`${inputClass} max-w-sm`}>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <div className="grid gap-4 @xl:grid-cols-3">
        <Field label={t("settings.clientForm.name")}>
          <input name="name" required defaultValue={v?.name} className={inputClass} placeholder={t("settings.clientForm.namePlaceholder")} />
        </Field>
        <Field label={t("settings.clientForm.industry")}>
          <input name="industry" defaultValue={v?.industry} className={inputClass} placeholder={t("settings.clientForm.industryPlaceholder")} />
        </Field>
        <Field label={t("settings.clientForm.industryKey")} hint={v?.industryKey ? t("settings.clientForm.industryKeyHintSet") : t("settings.clientForm.industryKeyHintGuess")}>
          <select name="industryKey" defaultValue={v?.industryKey ?? guessIndustry(v?.industry, v?.name) ?? ""} className={inputClass}>
            <option value="">{t("settings.clientForm.notSelected")}</option>
            {INDUSTRIES.map((i) => (
              <option key={i.key} value={i.key}>{industryLabels(t)[i.key]}</option>
            ))}
          </select>
        </Field>
      </div>
      <Field label={t("settings.clientForm.brief")} hint={t("settings.clientForm.briefHint")}>
        <textarea name="brief" rows={6} defaultValue={v?.brief} className={inputClass} />
      </Field>

      <Field label={t("settings.clientForm.audience")} hint={t("settings.clientForm.audienceHint")}>
        <select name="audienceOrigin" defaultValue={v?.audienceOrigin ?? "vn"} className={inputClass}>
          {AUDIENCE_ORIGINS.map((o) => (
            <option key={o.value} value={o.value}>
              {t(o.labelKey)}
            </option>
          ))}
        </select>
      </Field>

      <Field label={t("settings.clientForm.coords")} hint={t("settings.clientForm.coordsHint")}>
        <input name="storeCoords" defaultValue={v?.storeLat != null ? `${v.storeLat}, ${v.storeLng}` : ""} className={inputClass} placeholder={t("settings.clientForm.coordsPlaceholder")} />
      </Field>

      <fieldset className="grid gap-4 @2xl:grid-cols-3">
        <Field label={t("settings.clientForm.primaryResult")}>
          <select name="primaryResult" defaultValue={v?.primaryResult ?? "messages"} className={inputClass}>
            <option value="messages">{t("settings.clientForm.resMessages")}</option>
            <option value="leads">{t("settings.clientForm.resLeads")}</option>
            <option value="purchases">{t("settings.clientForm.resPurchases")}</option>
            <option value="link_clicks">{t("settings.clientForm.resClicks")}</option>
          </select>
        </Field>
        <div>
          <Field label={t("settings.clientForm.targetCpr")}>
            <input name="targetCpr" inputMode="numeric" value={targetCpr} onChange={(e) => setTargetCpr(e.target.value)} className={inputClass} placeholder={v?.autoTargetCpr ? t("settings.clientForm.targetCprAuto", { n: v.autoTargetCpr.toLocaleString("vi-VN") }) : t("settings.clientForm.targetCprExample")} />
          </Field>
          <AutoTargetHint v={v} currency={currency} empty={!targetCpr.trim()} onUse={setTargetCpr} />
        </div>
        <Field label={t("settings.clientForm.targetRoas")}>
          <input name="targetRoas" inputMode="decimal" defaultValue={v?.targetRoas ?? ""} className={inputClass} placeholder={t("settings.clientForm.roasExample")} />
        </Field>
        <Field label={t("settings.clientForm.currency")}>
          <input name="currency" value={currency} onChange={(e) => setCurrency(e.target.value)} className={inputClass} />
        </Field>
        <Field label={t("settings.clientForm.maxBudget")} hint={t("settings.clientForm.maxBudgetHint")}>
          <input name="maxDailyBudget" inputMode="numeric" defaultValue={v?.maxDailyBudget ?? ""} className={inputClass} placeholder={t("settings.clientForm.maxBudgetExample")} />
        </Field>
        <Field label={t("settings.clientForm.maxChange")}>
          <input name="maxBudgetChangePct" type="number" min={1} max={100} defaultValue={v?.maxBudgetChangePct ?? 30} className={inputClass} />
        </Field>
      </fieldset>

      <fieldset className="grid gap-4 @2xl:grid-cols-3">
        <Field label={t("settings.clientForm.analysisDays")} hint={t("settings.clientForm.analysisDaysHint")}>
          <select name="analysisDays" defaultValue={v?.analysisDays ?? 90} className={inputClass}>
            {[30, 60, 90, 180, 365].map((d) => (
              <option key={d} value={d}>{t("settings.clientForm.daysOption", { d })}{d === 90 ? ` ${t("settings.clientForm.recommended")}` : d >= 180 ? ` ${t("settings.clientForm.lowSpend")}` : ""}</option>
            ))}
          </select>
        </Field>
        <Field label={t("settings.clientForm.minResults")} hint={t("settings.clientForm.minResultsHint")}>
          <input name="minResults" type="number" min={1} max={1000} defaultValue={v?.minResults ?? 20} className={inputClass} />
        </Field>
        <Field label={t("settings.clientForm.convLimit")} hint={t("settings.clientForm.convLimitHint")}>
          <select name="conversationLimit" defaultValue={v?.conversationLimit ?? 500} className={inputClass}>
            {[100, 250, 500, 1000].map((n) => (
              <option key={n} value={n}>{t("settings.clientForm.convOption", { n })}{n === 500 ? ` ${t("settings.clientForm.recommended")}` : ""}</option>
            ))}
          </select>
        </Field>
        <Field label={t("settings.clientForm.readImages")} hint={t("settings.clientForm.readImagesHint")}>
          <select name="readImages" defaultValue={v?.readImages ? "on" : "off"} className={inputClass}>
            <option value="off">{t("settings.clientForm.off")}</option>
            <option value="on">{t("settings.clientForm.on")}</option>
          </select>
        </Field>
      </fieldset>

      <fieldset className="space-y-4 rounded-xl border border-slate-200 p-4">
        <legend className="px-1 text-sm font-semibold text-slate-800">{t("settings.clientForm.metaConnect")}</legend>
        <Field label={t("settings.clientForm.dataSource")}>
          <select name="dataSource" value={source} onChange={(e) => setSource(e.target.value)} className={inputClass}>
            <option value="mock">{t("settings.clientForm.sourceMock")}</option>
            <option value="meta">{t("settings.clientForm.sourceMeta")}</option>
          </select>
        </Field>
        {source === "meta" && <MetaConnect clientId={clientId} initial={v} onCurrency={setCurrency} />}
      </fieldset>

      <div className="flex items-center gap-3">
        <Submit label={create ? t("settings.clientForm.addClient") : t("settings.clientForm.saveChanges")} pending={pending} />
        {state?.ok && <span className="text-sm text-emerald-600">{t("settings.clientForm.saved")}</span>}
        {state && !state.ok && <span className="text-sm text-rose-600">{state.error}</span>}
      </div>
    </form>
  );
}

function daysLeft(iso: string) {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);
}

/** Paste a token → the system finds Pages, Instagram and ad accounts to choose from. */
function MetaConnect({ clientId, initial, onCurrency }: { clientId?: string; initial?: ClientFormValues; onCurrency: (c: string) => void }) {
  const t = useT();
  const [token, setToken] = useState("");
  const [adAccount, setAdAccount] = useState(initial?.metaAdAccountId ?? "");
  const [pageId, setPageId] = useState(initial?.metaPageId ?? "");
  const [igId, setIgId] = useState(initial?.metaInstagramId ?? "");
  const [pageName, setPageName] = useState(initial?.metaPageName ?? "");
  const [extra, setExtra] = useState(() => parseExtraPages(initial?.metaExtraPages));
  const [extraInput, setExtraInput] = useState("");
  const [info, setInfo] = useState<TokenInspection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const savedExpiry = initial?.metaTokenExpiresAt ? new Date(initial.metaTokenExpiresAt).toISOString() : null;

  const check = () =>
    start(async () => {
      setError(null);
      const r = await inspectTokenAction(clientId ?? null, token);
      if (!r.ok) {
        setInfo(null);
        return setError(r.error);
      }
      setInfo(r.data);
      // Auto-select when there is only one option.
      if (!pageId && r.data.pages.length === 1) {
        setPageId(r.data.pages[0].id);
        setIgId(r.data.pages[0].instagramId ?? "");
        setPageName(r.data.pages[0].name);
      }
      // Update Page names (main Page + secondary Pages) from the token.
      const nameOf = new Map(r.data.pages.map((p) => [p.id, p]));
      if (pageId && nameOf.get(pageId)) setPageName(nameOf.get(pageId)!.name);
      setExtra((l) => l.map((p) => (nameOf.get(p.id) ? { ...p, name: nameOf.get(p.id)!.name, instagramId: nameOf.get(p.id)!.instagramId } : p)));
      if (!adAccount && r.data.adAccounts.length === 1) {
        setAdAccount(r.data.adAccounts[0].id);
        onCurrency(r.data.adAccounts[0].currency);
      }
    });

  return (
    <div className="space-y-4">
      <Field
        label="Access Token"
        hint={initial?.hasToken ? t("settings.clientForm.tokenHintSaved") : t("settings.clientForm.tokenHintNew")}
      >
        <div className="flex gap-2">
          <input name="metaAccessToken" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} className={inputClass} />
          <button type="button" onClick={check} disabled={pending || (!token && !initial?.hasToken)} className={`${btnClass("secondary")} shrink-0`}>
            {pending && <Spinner />}
            {t("settings.clientForm.checkFind")}
          </button>
        </div>
      </Field>
      <input type="hidden" name="metaTokenExpiresAt" value={info && info.expiresAt !== undefined ? (info.expiresAt ?? "never") : ""} />

      {!info && savedExpiry && (
        <p className={`text-sm ${daysLeft(savedExpiry) <= 7 ? "text-rose-600" : "text-slate-500"}`}>
          {t("settings.clientForm.savedExpiry", { date: dateOnly(savedExpiry), days: daysLeft(savedExpiry) })}
        </p>
      )}
      {error && <p className="rounded-lg bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}

      {info && (
        <div className="space-y-2 rounded-lg bg-slate-50 p-3 text-sm">
          <p className="text-emerald-700">
            {t("settings.clientForm.tokenOf")}<b>{info.userName}</b>
            {info.expiresAt ? <> · {t("settings.clientForm.expires", { date: dateOnly(info.expiresAt), days: daysLeft(info.expiresAt) })}</> : info.expiresAt === null ? ` · ${t("settings.clientForm.neverExpires")}` : ` · ${t("settings.clientForm.expiryUnknown")}`}
          </p>
          {info.missingPermissions.length > 0 ? (
            <p className="text-rose-700">{t("settings.clientForm.missingPerms", { list: info.missingPermissions.join(", ") })}</p>
          ) : (
            <p className="text-emerald-700">{t("settings.clientForm.permsOk")}</p>
          )}
          {!info.pages.length && <p className="text-amber-700">{t("settings.clientForm.noPages")}</p>}
          {!info.adAccounts.length && <p className="text-amber-700">{t("settings.clientForm.noAdAccounts")}</p>}
        </div>
      )}

      <div className="grid gap-4 @xl:grid-cols-2">
        <Field label={t("settings.clientForm.fanpage")}>
          {info?.pages.length ? (
            <Combobox
              value={pageId}
              placeholder={t("settings.clientForm.searchPages", { n: info.pages.length })}
              options={info.pages.map((p) => ({ value: p.id, label: p.name, sub: p.instagramUsername ? `@${p.instagramUsername} · ${p.id}` : p.id }))}
              onChange={(v) => {
                setPageId(v);
                setIgId(info.pages.find((x) => x.id === v)?.instagramId ?? "");
                setPageName(info.pages.find((x) => x.id === v)?.name ?? "");
                setExtra((l) => l.filter((p) => p.id !== v));
              }}
            />
          ) : (
            <input value={pageId} onChange={(e) => setPageId(e.target.value)} className={inputClass} placeholder={t("settings.clientForm.pageIdPlaceholder")} />
          )}
          <input type="hidden" name="metaPageId" value={pageId} />
          <input type="hidden" name="metaPageName" value={pageName} />
        </Field>
        <Field label={t("settings.clientForm.adAccount")}>
          {info?.adAccounts.length ? (
            <Combobox
              value={adAccount}
              placeholder={t("settings.clientForm.searchAccounts", { n: info.adAccounts.length })}
              options={info.adAccounts.map((a) => ({
                value: a.id,
                label: a.name,
                sub: `${a.id.replace("act_", "")} · ${a.currency}${a.active ? "" : ` · ${t("settings.clientForm.inactive")}`}`,
                muted: !a.active,
              }))}
              onChange={(v) => {
                setAdAccount(v);
                const a = info.adAccounts.find((x) => x.id === v);
                if (a) onCurrency(a.currency);
              }}
            />
          ) : (
            <input value={adAccount} onChange={(e) => setAdAccount(e.target.value)} className={inputClass} placeholder={t("settings.clientForm.accountPlaceholder")} />
          )}
          <input type="hidden" name="metaAdAccountId" value={adAccount} />
        </Field>
        <div className="@xl:col-span-2">
          <Field
            label={t("settings.clientForm.extraPages")}
            hint={t("settings.clientForm.extraPagesHint")}
          >
            <div className="space-y-2">
              {extra.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {extra.map((p) => (
                    <span key={p.id} className="inline-flex items-center gap-1 rounded-full bg-slate-100 py-1 pr-1.5 pl-2.5 text-xs text-slate-700">
                      {p.name}
                      {p.name !== p.id && <span className="text-slate-400">· {p.id}</span>}
                      <button type="button" aria-label={t("settings.clientForm.removePage")} className="grid size-4 place-items-center rounded-full text-slate-400 hover:bg-slate-200 hover:text-slate-700" onClick={() => setExtra((l) => l.filter((x) => x.id !== p.id))}>
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
              {info?.pages.length ? (
                <Combobox
                  value=""
                  placeholder={t("settings.clientForm.addPagePlaceholder")}
                  options={info.pages.filter((p) => p.id !== pageId && !extra.some((x) => x.id === p.id)).map((p) => ({ value: p.id, label: p.name, sub: p.id }))}
                  onChange={(v) => {
                    const p = info.pages.find((x) => x.id === v);
                    if (p) setExtra((l) => [...l, { id: p.id, name: p.name, instagramId: p.instagramId }]);
                  }}
                />
              ) : (
                <div className="flex gap-2">
                  <input value={extraInput} onChange={(e) => setExtraInput(e.target.value.replace(/\D/g, ""))} className={inputClass} placeholder={t("settings.clientForm.extraIdPlaceholder")} />
                  <button
                    type="button"
                    className={`${btnClass("secondary")} shrink-0`}
                    disabled={extraInput.length < 5 || extraInput === pageId || extra.some((x) => x.id === extraInput)}
                    onClick={() => {
                      setExtra((l) => [...l, { id: extraInput, name: extraInput, instagramId: null }]);
                      setExtraInput("");
                    }}
                  >
                    {t("settings.clientForm.add")}
                  </button>
                </div>
              )}
            </div>
            <input type="hidden" name="metaExtraPages" value={JSON.stringify(extra)} />
          </Field>
        </div>
        <div className="@xl:col-span-2">
          <Field label="Instagram" hint={t("settings.clientForm.igHint")}>
            <input name="metaInstagramId" value={igId} onChange={(e) => setIgId(e.target.value)} className={inputClass} placeholder={t("settings.clientForm.igPlaceholder")} />
          </Field>
          {info && pageId && (
            <p className="mt-1 text-xs text-slate-500">
              {(() => {
                const p = info.pages.find((x) => x.id === pageId);
                return p?.instagramUsername ? t("settings.clientForm.igLinked", { name: p.instagramUsername }) : p ? t("settings.clientForm.igNotLinked") : "";
              })()}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
