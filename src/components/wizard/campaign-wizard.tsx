"use client";

import { useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Copy,
  Megaphone,
  MessageCircle,
  MousePointerClick,
  Plus,
  ShoppingCart,
  Smartphone,
  Sparkles,
  X,
  type LucideIcon,
} from "lucide-react";
import type { EditableAd, EditableAdSet, EditablePlan } from "@/lib/ai/schemas";
import { createDraftFromPlanAction, ideateTargetingAction, saveDraftAction, suggestAdCopyAction } from "@/app/actions";
import type { WizardTarget } from "@/lib/wizard-targets";
import { defaultCta, OBJECTIVE_FOR_RESULT, reviewPlan, totalDailyBudget, type ClientLimits } from "@/lib/plan-rules";
import { BID_OPTS, ctasFor, MESSAGE_DESTINATION_OPTS, performanceGoals } from "@/lib/ads-options";
import { LANGUAGES } from "@/lib/languages";
import { defaultDailyBudget, money } from "@/lib/format";
import type { DetailedItem } from "@/lib/targeting";
import type { CopyVariant } from "@/lib/ad-copy";
import { Badge, btnClass, inputClass } from "../ui";
import { Spinner } from "../action-button";
import { Label, MoneyInput, Radio, Section, TextArea, TextInput, Toggle } from "../editor/fields";
import { DetailedTargetingPicker, LanguagePicker, LocationPicker, PinLocationEditor } from "../editor/pickers";
import { CustomAudiencePicker, LeadFormPicker, PositionsPicker, WelcomeEditor, WelcomePreview } from "../editor/ads-fields";
import { PostPicker } from "../editor/post-picker";
import { AdPreview, ctaLabel } from "../editor/ad-preview";
import { AudienceEstimate } from "../editor/audience-estimate";
import { AgeSelect, ImageUpload, normalize } from "../editor/campaign-editor";
import { useT } from "@/i18n/client";
import type { MessageKey, T } from "@/i18n/translate";


type Props = {
  clientId: string;
  clientShort: string;
  initialPlan: EditablePlan;
  client: ClientLimits;
  pages: { id: string; name: string }[];
  isMeta: boolean;
  demographics: { ageMin: number; ageMax: number; genders: "all" | "male" | "female"; note: string } | null;
  claude: WizardTarget[]; // table 1: Claude's proposals (from the persona) with system evidence
  system: WizardTarget[]; // table 2: the system evaluates items Claude didn't pick + winning items in the industry
  hasAnalysis: boolean;
  rankingStage: string | null;
};

type ResultType = EditablePlan["result_type"];
type ObjOpt = { label: MessageKey; short: MessageKey; hint: MessageKey; result?: ResultType; extra?: Partial<EditableAdSet> };
/** Campaign objective per the current Ads Manager objective set (6 objectives) and the conversion location within it. */
const OBJECTIVES: { key: string; label: MessageKey; hint: MessageKey; icon: LucideIcon; opts: ObjOpt[] }[] = [
  {
    key: "awareness",
    label: "campaigns.wizard.obj.t0",
    hint: "campaigns.wizard.obj.t1",
    icon: Megaphone,
    opts: [
      { label: "campaigns.wizard.obj.t2", short: "campaigns.wizard.obj.t3", hint: "campaigns.wizard.obj.t4", result: "reach" },
      { label: "campaigns.wizard.obj.t5", short: "campaigns.wizard.obj.t6", hint: "campaigns.wizard.obj.t7", result: "video_views" },
      { label: "campaigns.wizard.obj.t8", short: "campaigns.wizard.obj.t9", hint: "campaigns.wizard.obj.t10" },
      { label: "campaigns.wizard.obj.t11", short: "campaigns.wizard.obj.t12", hint: "campaigns.wizard.obj.t13" },
    ],
  },
  {
    key: "traffic",
    label: "campaigns.wizard.obj.t14",
    hint: "campaigns.wizard.obj.t15",
    icon: MousePointerClick,
    opts: [
      { label: "campaigns.wizard.obj.t16", short: "campaigns.wizard.obj.t17", hint: "campaigns.wizard.obj.t18", result: "link_clicks" },
      { label: "campaigns.wizard.obj.t19", short: "campaigns.wizard.obj.t20", hint: "campaigns.wizard.obj.t21", result: "profile_visits" },
      { label: "campaigns.wizard.obj.t22", short: "campaigns.wizard.obj.t23", hint: "campaigns.wizard.obj.t24" },
      { label: "campaigns.wizard.obj.t25", short: "campaigns.wizard.obj.t26", hint: "campaigns.wizard.obj.t27" },
      { label: "campaigns.wizard.obj.t28", short: "campaigns.wizard.obj.t28", hint: "campaigns.wizard.obj.t29" },
    ],
  },
  {
    key: "engagement",
    label: "campaigns.wizard.obj.t30",
    hint: "campaigns.wizard.obj.t31",
    icon: MessageCircle,
    opts: [
      { label: "campaigns.wizard.obj.t32", short: "campaigns.wizard.obj.t33", hint: "campaigns.wizard.obj.t34", result: "messages" },
      { label: "campaigns.wizard.obj.t35", short: "campaigns.wizard.obj.t6", hint: "campaigns.wizard.obj.t36", result: "video_views" },
      { label: "campaigns.wizard.obj.t37", short: "campaigns.wizard.obj.t38", hint: "campaigns.wizard.obj.t39", result: "engagement" },
      { label: "campaigns.wizard.obj.t40", short: "campaigns.wizard.obj.t41", hint: "campaigns.wizard.obj.t42", result: "page_likes" },
      { label: "campaigns.wizard.obj.t28", short: "campaigns.wizard.obj.t28", hint: "campaigns.wizard.obj.t29" },
      { label: "campaigns.wizard.obj.t43", short: "campaigns.wizard.obj.t44", hint: "campaigns.wizard.obj.t45" },
      { label: "campaigns.wizard.obj.t46", short: "campaigns.wizard.obj.t46", hint: "campaigns.wizard.obj.t47" },
    ],
  },
  {
    key: "leads",
    label: "campaigns.wizard.obj.t48",
    hint: "campaigns.wizard.obj.t49",
    icon: ClipboardList,
    opts: [
      { label: "campaigns.wizard.obj.t50", short: "campaigns.wizard.obj.t51", hint: "campaigns.wizard.obj.t52", result: "leads", extra: { lead_destination: "form" } },
      { label: "campaigns.wizard.obj.t53", short: "campaigns.wizard.obj.t54", hint: "campaigns.wizard.obj.t55", result: "leads", extra: { lead_destination: "messenger" } },
      { label: "campaigns.wizard.obj.t16", short: "campaigns.wizard.obj.t56", hint: "campaigns.wizard.obj.t57" },
      { label: "campaigns.wizard.obj.t28", short: "campaigns.wizard.obj.t58", hint: "campaigns.wizard.obj.t59" },
      { label: "campaigns.wizard.obj.t22", short: "campaigns.wizard.obj.t60", hint: "campaigns.wizard.obj.t61" },
    ],
  },
  {
    key: "app",
    label: "campaigns.wizard.obj.t62",
    hint: "campaigns.wizard.obj.t63",
    icon: Smartphone,
    opts: [
      { label: "campaigns.wizard.obj.t64", short: "campaigns.wizard.obj.t65", hint: "campaigns.wizard.obj.t66" },
      { label: "campaigns.wizard.obj.t67", short: "campaigns.wizard.obj.t68", hint: "campaigns.wizard.obj.t69" },
    ],
  },
  {
    key: "sales",
    label: "campaigns.wizard.obj.t70",
    hint: "campaigns.wizard.obj.t71",
    icon: ShoppingCart,
    opts: [
      { label: "campaigns.wizard.obj.t16", short: "campaigns.wizard.obj.t72", hint: "campaigns.wizard.obj.t73" },
      { label: "campaigns.wizard.obj.t74", short: "campaigns.wizard.obj.t75", hint: "campaigns.wizard.obj.t76" },
      { label: "campaigns.wizard.obj.t22", short: "campaigns.wizard.obj.t77", hint: "campaigns.wizard.obj.t78" },
      { label: "campaigns.wizard.obj.t28", short: "campaigns.wizard.obj.t79", hint: "campaigns.wizard.obj.t59" },
    ],
  },
];

const STEP_KEYS = ["campaigns.wizard.step.objective", "campaigns.wizard.step.budget", "campaigns.wizard.step.fanpage", "campaigns.wizard.step.audience", "campaigns.wizard.step.targeting", "campaigns.wizard.step.placements", "campaigns.wizard.step.content", "campaigns.wizard.step.review"] as const;
const GENDER_KEYS = { all: "campaigns.wizard.gender.all", male: "campaigns.wizard.gender.male", female: "campaigns.wizard.gender.female" } as const;
const fmtSize = (t: T, v: number | null) => (v == null ? "" : v >= 1e6 ? t("campaigns.wizard.sizeMillions", { n: (v / 1e6).toFixed(v >= 1e7 ? 0 : 1) }) : v >= 1e3 ? `${Math.round(v / 1e3)}k` : String(v));

export function CampaignWizard(p: Props) {
  const t = useT();
  const router = useRouter();
  const cur = p.client.currency;
  const today = new Date().toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: p.client.timezone });
  const initial = (() => {
    const pl = structuredClone(p.initialPlan);
    if (p.demographics) pl.ad_sets[0] = { ...pl.ad_sets[0], age_min: p.demographics.ageMin, age_max: p.demographics.ageMax, genders: p.demographics.genders };
    const opt = OBJECTIVES.flatMap((o) => o.opts).find((x) => x.result === pl.result_type);
    if (opt) pl.campaign_name = `[${t(opt.short)}] ${p.clientShort} · ${today}`;
    return pl;
  })();
  const [plan, setPlan] = useState<EditablePlan>(initial);
  const [step, setStep] = useState(0);
  const [obj, setObj] = useState<{ key: string; idx: number } | null>(() => {
    for (const o of OBJECTIVES) {
      const i = o.opts.findIndex((x) => x.result === initial.result_type && (!x.extra?.lead_destination || x.extra.lead_destination === initial.ad_sets[0].lead_destination));
      if (i >= 0) return { key: o.key, idx: i };
    }
    return null;
  });
  const [nameTouched, setNameTouched] = useState(false);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [creating, startCreate] = useTransition();
  const s = plan.ad_sets[0];
  const ad = plan.ads[0];
  const lifetime = plan.budget_period === "lifetime";
  const curObj = OBJECTIVES.find((o) => o.key === obj?.key);
  const curOpt = curObj && obj ? curObj.opts[obj.idx] : null;

  const update = (fn: (pl: EditablePlan) => EditablePlan) => setPlan((pl) => normalize(fn(pl)));
  const setAdSet = (patch: Partial<EditableAdSet>) => update((pl) => ({ ...pl, ad_sets: pl.ad_sets.map((x, i) => (i === 0 ? { ...x, ...patch } : x)) }));
  const setAd = (patch: Partial<EditableAd>) => update((pl) => ({ ...pl, ads: pl.ads.map((x, i) => (i === 0 ? { ...x, ...patch } : x)) }));

  // Suggested name: [result type] Client · date - auto-updates with the objective until the user edits it.
  const nameFor = (short?: MessageKey) => `[${short ? t(short) : t("campaigns.wizard.campaign")}] ${p.clientShort} · ${today}`;
  const suggestedName = nameFor(curOpt?.short);

  // Auto-save to the draft (once created) so nothing is lost when leaving the page; image uploads require a draft.
  const latest = useRef(plan);
  useEffect(() => {
    latest.current = plan;
  }, [plan]);
  useEffect(() => {
    if (!draftId) return;
    const timer = setTimeout(async () => {
      setSaveState("saving");
      const r = await saveDraftAction(draftId, plan);
      setSaveState(r.ok ? "saved" : "error");
      if (!r.ok) setError(r.error);
    }, 700);
    return () => clearTimeout(timer);
  }, [plan, draftId]);

  const ensureDraft = () =>
    new Promise<string | null>((resolve) => {
      if (draftId) return resolve(draftId);
      startCreate(async () => {
        const r = await createDraftFromPlanAction(p.clientId, latest.current);
        if (r.ok && r.id) {
          setDraftId(r.id);
          setSaveState("saved");
          resolve(r.id);
        } else {
          setError(r.ok ? t("campaigns.wizard.cannotCreateDraft") : r.error);
          resolve(null);
        }
      });
    });

  const pickObjective = (key: string, idx: number) => {
    const o = OBJECTIVES.find((x) => x.key === key)!.opts[idx];
    if (!o.result) return;
    setObj({ key, idx });
    const result = o.result;
    update((pl) => ({
      ...pl,
      campaign_name: nameTouched ? pl.campaign_name : nameFor(o.short),
      result_type: result,
      objective: OBJECTIVE_FOR_RESULT[result],
      ad_sets: pl.ad_sets.map((x) => ({ ...x, ...o.extra, performance_goal: null, message_destination: result === "messages" ? (x.message_destination ?? "messenger") : null })),
      ads: pl.ads.map((a) => ({ ...a, call_to_action: defaultCta(result) })),
    }));
  };

  const canNext = step === 0 ? !!curOpt?.result && plan.campaign_name.trim().length > 0 : true;
  const next = async () => {
    setError(null);
    if (step === 0 && !(await ensureDraft())) return;
    setStep((x) => Math.min(STEP_KEYS.length - 1, x + 1));
    window.scrollTo({ top: 0 });
  };
  const review = useMemo(() => reviewPlan(plan, p.client, p.isMeta, t), [plan, p.client, p.isMeta, t]);
  const chat = plan.result_type === "messages" || (plan.result_type === "leads" && s.lead_destination === "messenger");
  const leadForm = plan.result_type === "leads" && s.lead_destination === "form";
  const pageName = (plan.page_id ? p.pages.find((x) => x.id === plan.page_id)?.name : p.pages[0]?.name) ?? p.clientShort;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href={`/clients/${p.clientId}/create`} className="inline-flex items-center gap-1 text-sm text-mut hover:text-ink">
            <ChevronLeft className="size-4" /> {t("campaigns.wizard.createCampaign")}
          </Link>
          <h2 className="mt-1 text-xl font-semibold tracking-tight text-ink">{t("campaigns.wizard.title")}</h2>
          <p className="text-sm text-mut">{t("campaigns.wizard.subtitle")}</p>
        </div>
        <span className="text-xs text-mut">{draftId ? (saveState === "saving" ? t("campaigns.wizard.saving") : saveState === "error" ? t("campaigns.wizard.saveError") : t("campaigns.wizard.draftSaved")) : t("campaigns.wizard.notSaved")}</span>
      </div>

      {/* Step bar */}
      <ol className="flex gap-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none] rounded-xl border border-line bg-panel p-1.5">
        {STEP_KEYS.map((labelKey, i) => (
          <li key={labelKey} className="shrink-0">
            <button
              type="button"
              disabled={i > 0 && !draftId}
              onClick={() => setStep(i)}
              className={`flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm whitespace-nowrap disabled:opacity-40 ${i === step ? "bg-ink font-medium text-panel" : i < step ? "text-ink hover:bg-hover" : "text-mut hover:bg-hover"}`}
            >
              <span className={`grid size-5 place-items-center rounded-full text-[11px] font-semibold ${i === step ? "bg-panel text-ink" : i < step ? "bg-emerald-600 text-white" : "bg-slate-200 text-slate-600"}`}>
                {i < step ? <Check className="size-3" /> : i + 1}
              </span>
              {t(labelKey)}
            </button>
          </li>
        ))}
      </ol>

      <div className="grid items-start gap-5 [&>*]:min-w-0 @5xl:grid-cols-[minmax(0,1fr)_320px]">
        <fieldset className="space-y-4" disabled={creating}>
          {step === 0 && (
            <>
              <Section title={t("campaigns.wizard.campaignObjective")} hint={t("campaigns.wizard.campaignObjectiveHint")}>
                <div className="grid gap-2 @2xl:grid-cols-2 @4xl:grid-cols-3">
                  {OBJECTIVES.map((o) => {
                    const on = obj?.key === o.key;
                    const Icon = o.icon;
                    return (
                      <button
                        key={o.key}
                        type="button"
                        onClick={() => {
                          const first = o.opts.findIndex((x) => x.result);
                          if (first >= 0 && obj?.key !== o.key) pickObjective(o.key, first);
                          else if (first < 0) setObj({ key: o.key, idx: 0 });
                        }}
                        className={`flex items-start gap-3 rounded-xl border p-3 text-left ${on ? "border-indigo-500 bg-indigo-50" : "border-line hover:bg-hover"}`}
                      >
                        <Icon className={`mt-0.5 size-5 shrink-0 ${on ? "text-indigo-600" : "text-mut"}`} />
                        <span>
                          <span className="block text-sm font-medium text-ink">{t(o.label)}</span>
                          <span className="block text-xs text-mut">{t(o.hint)}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </Section>
              {curObj && (
                <Section title={t("campaigns.wizard.conversionLocation", { objective: t(curObj.label) })} hint={t("campaigns.wizard.whereResults")}>
                  <div className="space-y-1.5">
                    {curObj.opts.map((o, i) => {
                      const on = obj?.idx === i && !!o.result;
                      return (
                        <button
                          key={o.label}
                          type="button"
                          disabled={!o.result}
                          onClick={() => pickObjective(curObj.key, i)}
                          className={`flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left disabled:cursor-not-allowed ${on ? "border-indigo-500 bg-indigo-50" : o.result ? "border-line hover:bg-hover" : "border-dashed border-line opacity-70"}`}
                        >
                          <span className={`mt-1 size-3.5 shrink-0 rounded-full border-2 ${on ? "border-indigo-600 bg-indigo-600" : "border-slate-300"}`} />
                          <span className="min-w-0">
                            <span className="block text-sm font-medium text-ink">{t(o.label)}</span>
                            <span className="block text-xs text-mut">{t(o.hint)}</span>
                          </span>
                          {!o.result && <Badge tone="mut">{t("campaigns.wizard.buildInAdsManager")}</Badge>}
                        </button>
                      );
                    })}
                  </div>
                  {plan.result_type === "messages" && curOpt?.result === "messages" && (
                    <div>
                      <Label>{t("campaigns.wizard.messageVia")}</Label>
                      <Radio
                        value={s.message_destination ?? "messenger"}
                        onChange={(v) => setAdSet({ message_destination: v })}
                        options={MESSAGE_DESTINATION_OPTS.map((o) => ({
                          value: o.value as NonNullable<EditableAdSet["message_destination"]>,
                          label: t(o.label),
                          hint: [o.needsIg && !p.client.metaInstagramId && t("campaigns.wizard.needsIgId"), o.needsWa && t("campaigns.wizard.needsWa")].filter(Boolean).join(" · ") || undefined,
                        }))}
                      />
                    </div>
                  )}
                  {curOpt?.result && (
                    <div className="max-w-md">
                      <Label>{t("campaigns.wizard.performanceGoal")}</Label>
                      <select className={inputClass} value={s.performance_goal ?? performanceGoals(plan.result_type, s)[0].value} onChange={(e) => setAdSet({ performance_goal: e.target.value })}>
                        {performanceGoals(plan.result_type, s).map((g) => (
                          <option key={g.value} value={g.value}>
                            {t(g.label)}
                          </option>
                        ))}
                      </select>
                      <p className="mt-1 text-xs text-mut">{performanceGoals(plan.result_type, s).find((g) => g.value === (s.performance_goal ?? performanceGoals(plan.result_type, s)[0].value))?.hint ? t(performanceGoals(plan.result_type, s).find((g) => g.value === (s.performance_goal ?? performanceGoals(plan.result_type, s)[0].value))!.hint!) : ""}</p>
                    </div>
                  )}
                </Section>
              )}
              <Section title={t("campaigns.wizard.campaignName")} hint={t("campaigns.wizard.campaignNameHint")}>
                <TextInput
                  value={plan.campaign_name}
                  onChange={(v) => {
                    setNameTouched(true);
                    update((pl) => ({ ...pl, campaign_name: v }));
                  }}
                />
                {nameTouched && plan.campaign_name !== suggestedName && (
                  <button
                    type="button"
                    className="text-xs text-indigo-600 hover:underline"
                    onClick={() => {
                      setNameTouched(false);
                      update((pl) => ({ ...pl, campaign_name: suggestedName }));
                    }}
                  >
                    {t("campaigns.wizard.useSuggestedName", { name: suggestedName })}
                  </button>
                )}
              </Section>
            </>
          )}

          {step === 1 && (
            <>
              <Section title={t("campaigns.wizard.budget")}>
                <Radio
                  value={plan.budget_mode}
                  onChange={(v) =>
                    update((pl) =>
                      v === "CBO"
                        ? { ...pl, budget_mode: "CBO", campaign_daily_budget: totalDailyBudget(pl) || defaultDailyBudget(cur, 300000), ad_sets: pl.ad_sets.map((x) => ({ ...x, daily_budget: null })) }
                        : { ...pl, budget_mode: "ABO", ad_sets: pl.ad_sets.map((x) => ({ ...x, daily_budget: pl.campaign_daily_budget ?? defaultDailyBudget(cur) })), campaign_daily_budget: null },
                    )
                  }
                  options={[
                    { value: "ABO", label: t("campaigns.wizard.aboLabel"), hint: t("campaigns.wizard.aboHint") },
                    { value: "CBO", label: t("campaigns.wizard.cboLabel"), hint: t("campaigns.wizard.cboHint") },
                  ]}
                />
                <div className="grid gap-4 @md:grid-cols-2">
                  <div>
                    <Label>{t("campaigns.wizard.budgetType")}</Label>
                    <select className={inputClass} value={plan.budget_period} onChange={(e) => update((pl) => ({ ...pl, budget_period: e.target.value as EditablePlan["budget_period"] }))}>
                      <option value="daily">{t("campaigns.wizard.dailyBudget")}</option>
                      <option value="lifetime">{t("campaigns.wizard.lifetimeBudget")}</option>
                    </select>
                  </div>
                  <div>
                    <Label>{lifetime ? t("campaigns.wizard.totalBudget") : t("campaigns.wizard.budgetPerDay")}</Label>
                    <MoneyInput
                      value={plan.budget_mode === "CBO" ? plan.campaign_daily_budget : s.daily_budget}
                      currency={cur}
                      onChange={(v) => (plan.budget_mode === "CBO" ? update((pl) => ({ ...pl, campaign_daily_budget: v })) : setAdSet({ daily_budget: v }))}
                    />
                  </div>
                </div>
                {(() => {
                  const target = p.client.targetCpr ?? p.client.autoTargetCpr;
                  const b = plan.budget_mode === "CBO" ? plan.campaign_daily_budget : s.daily_budget;
                  return target && b && !lifetime ? (
                    <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-mut">
                      {t("campaigns.wizard.atTargetCost", { cost: money(target, cur), auto: p.client.targetCpr ? "" : t("campaigns.wizard.autoSuggested") })} <b className="text-ink">{t("campaigns.wizard.resultsPerDay", { count: Math.floor(b / target) })}</b>.
                      {p.client.maxDailyBudget && b > p.client.maxDailyBudget && <span className="text-rose-700"> {t("campaigns.wizard.overLimit", { limit: money(p.client.maxDailyBudget, cur) })}</span>}
                    </p>
                  ) : null;
                })()}
              </Section>
              <Section title={t("campaigns.wizard.schedule")}>
                <div className="grid gap-4 @md:grid-cols-2">
                  <div>
                    <Label hint={t("campaigns.wizard.startHint")}>{t("campaigns.wizard.start")}</Label>
                    <input type="datetime-local" className={inputClass} value={s.start_time ?? ""} onChange={(e) => setAdSet({ start_time: e.target.value || null })} />
                  </div>
                  <div>
                    <Label hint={lifetime ? t("campaigns.wizard.endRequired") : t("campaigns.wizard.optional")}>{t("campaigns.wizard.end")}</Label>
                    <input type="datetime-local" className={inputClass} value={s.end_time ?? ""} onChange={(e) => setAdSet({ end_time: e.target.value || null })} />
                  </div>
                </div>
              </Section>
              <details className="rounded-xl border border-line bg-panel p-4">
                <summary className="cursor-pointer text-sm font-medium text-ink">{t("campaigns.wizard.advanced")}</summary>
                <div className="mt-3 space-y-3">
                  <Radio value={plan.bid_strategy} onChange={(v) => update((pl) => ({ ...pl, bid_strategy: v as EditablePlan["bid_strategy"] }))} options={BID_OPTS.map((o) => ({ value: o.value as EditablePlan["bid_strategy"], label: t(o.label), hint: o.hint ? t(o.hint) : undefined }))} />
                  {plan.bid_strategy !== "lowest_cost" && (
                    <div className="max-w-xs">
                      <Label>{plan.bid_strategy === "cost_cap" ? t("campaigns.wizard.targetCost") : t("campaigns.wizard.maxBid")}</Label>
                      <MoneyInput value={plan.bid_amount} currency={cur} onChange={(v) => update((pl) => ({ ...pl, bid_amount: v || null }))} />
                    </div>
                  )}
                  <div className="max-w-xs">
                    <Label hint={t("campaigns.wizard.optional")}>{t("campaigns.wizard.spendCap")}</Label>
                    <MoneyInput value={plan.spend_cap} currency={cur} onChange={(v) => update((pl) => ({ ...pl, spend_cap: v || null }))} />
                  </div>
                </div>
              </details>
            </>
          )}

          {step === 2 && (
            <Section title={t("campaigns.wizard.fanpageTitle")} hint={t("campaigns.wizard.fanpageHint")}>
              {p.pages.length ? (
                <div className="space-y-1.5">
                  {p.pages.map((x, i) => {
                    const on = (plan.page_id ?? p.pages[0].id) === x.id;
                    return (
                      <button
                        key={x.id}
                        type="button"
                        onClick={() => update((pl) => ({ ...pl, page_id: i === 0 ? null : x.id, ads: pl.ads.map((a) => ({ ...a, post_id: null, post_preview: null, lead_form: null })) }))}
                        className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left ${on ? "border-indigo-500 bg-indigo-50" : "border-line hover:bg-hover"}`}
                      >
                        <span className={`size-3.5 shrink-0 rounded-full border-2 ${on ? "border-indigo-600 bg-indigo-600" : "border-slate-300"}`} />
                        <span className="text-sm font-medium text-ink">{x.name}</span>
                        {i === 0 && <Badge tone="mut">{t("campaigns.wizard.mainPage")}</Badge>}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="text-sm text-amber-700">{t("campaigns.wizard.noFanpage")}</p>
              )}
              <p className="text-xs text-mut">Instagram: {p.client.metaInstagramId ? t("campaigns.wizard.igLinked") : t("campaigns.wizard.igNotLinked")}.</p>
            </Section>
          )}

          {step === 3 && (
            <>
              <Section title={t("campaigns.wizard.area")} hint={t("campaigns.wizard.areaHint")}>
                <div>
                  <Label>{t("campaigns.wizard.location")}</Label>
                  <LocationPicker value={s.locations} allowEmpty={s.custom_locations.length > 0} onChange={(v) => setAdSet({ locations: v })} />
                </div>
                <div>
                  <Label hint={t("campaigns.wizard.pinHint")}>{t("campaigns.wizard.pinOnMap")}</Label>
                  <PinLocationEditor
                    value={s.custom_locations}
                    store={p.client.storeLat != null && p.client.storeLng != null ? { lat: p.client.storeLat, lng: p.client.storeLng } : null}
                    onChange={(v) => setAdSet({ custom_locations: v, locations: v.length ? s.locations.filter((l) => l.type !== "country") : s.locations })}
                  />
                </div>
                <div>
                  <Label hint={t("campaigns.wizard.excludeLocationHint")}>{t("campaigns.wizard.excludeLocation")}</Label>
                  <LocationPicker value={s.excluded_locations} allowEmpty onChange={(v) => setAdSet({ excluded_locations: v })} />
                </div>
                <div>
                  <Label>{t("campaigns.wizard.targetPeople")}</Label>
                  <Radio
                    value={s.location_types}
                    onChange={(v) => setAdSet({ location_types: v })}
                    options={[
                      { value: "home_recent", label: t("campaigns.wizard.homeRecent") },
                      { value: "home", label: t("campaigns.wizard.home") },
                      { value: "recent", label: t("campaigns.wizard.recent"), hint: t("campaigns.wizard.recentHint") },
                    ]}
                  />
                </div>
              </Section>
              <Section title={t("campaigns.wizard.demographics")} hint={p.demographics ? t("campaigns.wizard.demographicsFilled", { note: p.demographics.note }) : t("campaigns.wizard.demographicsDefault")}>
                <div className="grid gap-4 @md:grid-cols-2">
                  <div>
                    <Label>{t("campaigns.wizard.age")}</Label>
                    <div className="flex items-center gap-2">
                      <AgeSelect value={s.age_min} onChange={(v) => setAdSet({ age_min: v, age_max: Math.max(v, s.age_max) })} />
                      <span className="text-mut2">–</span>
                      <AgeSelect value={s.age_max} onChange={(v) => setAdSet({ age_max: v, age_min: Math.min(v, s.age_min) })} plus />
                    </div>
                  </div>
                  <div>
                    <Label>{t("campaigns.wizard.genderLabel")}</Label>
                    <div className="flex gap-1 rounded-lg bg-slate-100 p-1">
                      {(["all", "male", "female"] as const).map((g) => (
                        <button type="button" key={g} onClick={() => setAdSet({ genders: g })} className={`flex-1 rounded-md py-1 text-sm ${s.genders === g ? "bg-panel font-medium text-ink shadow-sm" : "text-mut"}`}>
                          {t(GENDER_KEYS[g])}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <div>
                  <Label hint={t("campaigns.wizard.languageHint")}>{t("campaigns.wizard.language")}</Label>
                  <LanguagePicker value={s.locales} options={LANGUAGES} onChange={(v) => setAdSet({ locales: v as EditableAdSet["locales"] })} />
                </div>
              </Section>
              <Section title={t("campaigns.wizard.customAudience")} hint={t("campaigns.wizard.customAudienceHint")}>
                <CustomAudiencePicker clientId={p.clientId} include={s.custom_audiences} exclude={s.excluded_custom_audiences} onChange={(inc, exc) => setAdSet({ custom_audiences: inc, excluded_custom_audiences: exc })} />
              </Section>
            </>
          )}

          {step === 4 && <TargetingStep p={p} plan={plan} s={s} setAdSet={setAdSet} />}

          {step === 5 && (
            <Section title={t("campaigns.wizard.platformsPlacements")}>
              <Radio
                value={s.placements ?? "advantage"}
                onChange={(v) => setAdSet({ placements: v, positions: v === "manual" ? (s.positions ?? { facebook: ["feed"], instagram: ["stream"], messenger: [], audience_network: [] }) : s.positions, devices: v === "manual" ? s.devices : "all" })}
                options={[
                  { value: "advantage", label: t("campaigns.wizard.placementsAdvantage"), hint: t("campaigns.wizard.placementsAdvantageHint") },
                  { value: "manual", label: t("campaigns.wizard.placementsManual") },
                ]}
              />
              {s.placements === "manual" && (
                <>
                  <PositionsPicker value={s.positions ?? { facebook: [], instagram: [], messenger: [], audience_network: [] }} onChange={(v) => setAdSet({ positions: v })} />
                  <div className="max-w-xs">
                    <Label>{t("campaigns.wizard.devices")}</Label>
                    <select className={inputClass} value={s.devices} onChange={(e) => setAdSet({ devices: e.target.value as EditableAdSet["devices"] })}>
                      <option value="all">{t("campaigns.wizard.devicesAll")}</option>
                      <option value="mobile">{t("campaigns.wizard.devicesMobile")}</option>
                      <option value="desktop">{t("campaigns.wizard.devicesDesktop")}</option>
                    </select>
                  </div>
                </>
              )}
              {plan.result_type === "profile_visits" && <p className="text-xs text-amber-700">{t("campaigns.wizard.igProfileOnly")}</p>}
            </Section>
          )}

          {step === 6 && (
            <ContentStep
              p={p}
              plan={plan}
              ad={ad}
              s={s}
              draftId={draftId}
              setAd={setAd}
              chat={chat}
              leadForm={leadForm}
            />
          )}

          {step === 7 && (
            <Section title={t("campaigns.wizard.reviewTitle")}>
              <dl className="grid gap-x-6 gap-y-2 text-sm @md:grid-cols-2">
                {[
                  [t("campaigns.wizard.rvName"), plan.campaign_name],
                  [t("campaigns.wizard.rvObjective"), `${curObj ? t(curObj.label) : ""} · ${curOpt ? t(curOpt.label) : ""}`],
                  [t("campaigns.wizard.rvBudget"), `${money(plan.budget_mode === "CBO" ? plan.campaign_daily_budget : s.daily_budget, cur)}${lifetime ? t("campaigns.wizard.perLifetime") : t("campaigns.wizard.perDay")} · ${plan.budget_mode === "CBO" ? t("campaigns.wizard.campaignBudget") : t("campaigns.wizard.adSetBudget")}`],
                  [t("campaigns.wizard.rvSchedule"), `${s.start_time ? s.start_time.replace("T", " ") : t("campaigns.wizard.runsImmediately")}${s.end_time ? ` → ${s.end_time.replace("T", " ")}` : ""}`],
                  ["Fanpage", pageName],
                  [t("campaigns.wizard.area"), [...s.locations.map((l) => l.name), ...s.custom_locations.map((c) => `${c.label} (${c.radius_km}km)`)].join(", ") || "—"],
                  [t("campaigns.wizard.rvAgeGender"), `${s.age_min}–${s.age_max === 65 ? "65+" : s.age_max} · ${t(GENDER_KEYS[s.genders])}`],
                  [t("campaigns.wizard.rvDetailed"), s.detailed_targeting.map((d) => d.name).join(", ") || t("campaigns.wizard.broadTargeting")],
                  [t("campaigns.wizard.rvNarrow"), s.narrow_targeting.map((d) => d.name).join(", ") || "—"],
                  [t("campaigns.wizard.customAudience"), [...s.custom_audiences.map((a) => a.name), ...s.excluded_custom_audiences.map((a) => t("campaigns.wizard.excluded", { name: a.name }))].join(", ") || "—"],
                  [t("campaigns.wizard.step.placements"), s.placements === "manual" ? t("campaigns.wizard.manual") : "Advantage+"],
                  [t("campaigns.wizard.step.content"), ad.source === "existing" ? `${t("campaigns.wizard.existingPost")}${ad.post_preview ? `: ${ad.post_preview.message.slice(0, 60)}` : ""}` : ad.primary_text ? ad.primary_text.slice(0, 80) : t("campaigns.wizard.notWritten")],
                ].map(([k, v]) => (
                  <div key={k} className="min-w-0">
                    <dt className="text-xs text-mut">{k}</dt>
                    <dd className="truncate text-ink">{v}</dd>
                  </div>
                ))}
              </dl>
              {review.errors.length > 0 && (
                <ul className="space-y-1 rounded-lg bg-rose-50 p-3 text-sm text-rose-700">
                  {review.errors.map((e) => (
                    <li key={e}>✕ {e}</li>
                  ))}
                </ul>
              )}
              {review.warnings.length > 0 && (
                <ul className="space-y-1 rounded-lg bg-amber-50 p-3 text-sm text-amber-700">
                  {review.warnings.map((e) => (
                    <li key={e}>! {e}</li>
                  ))}
                </ul>
              )}
              <p className="text-xs text-mut">{t("campaigns.wizard.openEditorNote")}</p>
              {draftId && (
                <button type="button" className={btnClass("primary")} onClick={() => router.push(`/clients/${p.clientId}/drafts/${draftId}`)}>
                  {t("campaigns.wizard.openEditor")} <ChevronRight />
                </button>
              )}
            </Section>
          )}

          {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
          <div className="flex items-center justify-between gap-2">
            <button type="button" className={btnClass("secondary")} disabled={step === 0} onClick={() => setStep((x) => Math.max(0, x - 1))}>
              <ChevronLeft /> {t("campaigns.wizard.back")}
            </button>
            {step < STEP_KEYS.length - 1 && (
              <button type="button" className={btnClass("primary")} disabled={!canNext || creating} onClick={next}>
                {creating && <Spinner />} {t("campaigns.wizard.next", { step: t(STEP_KEYS[step + 1]) })} <ChevronRight />
              </button>
            )}
          </div>
        </fieldset>

        {/* Right column: summary + estimate */}
        <aside className="space-y-4 self-start @5xl:sticky @5xl:top-16">
          <div className="rounded-xl border border-line bg-panel p-4 text-sm">
            <p className="font-semibold text-ink">{t("campaigns.wizard.summary")}</p>
            <ul className="mt-2 space-y-1 text-mut">
              <li>
                <b className="text-ink">{curOpt ? t(curOpt.short) : t("campaigns.wizard.noObjective")}</b>
              </li>
              <li>
                {money(plan.budget_mode === "CBO" ? plan.campaign_daily_budget : s.daily_budget, cur)}
                {lifetime ? t("campaigns.wizard.perLifetime") : t("campaigns.wizard.perDay")}
              </li>
              <li>{pageName}</li>
              <li>
                {s.age_min}–{s.age_max === 65 ? "65+" : s.age_max} · {s.genders === "all" ? t("campaigns.wizard.maleAndFemale") : t(GENDER_KEYS[s.genders])} · {s.locations.map((l) => l.name).join(", ") || t("campaigns.wizard.pinsCount", { count: s.custom_locations.length })}
              </li>
              <li>
                {t("campaigns.wizard.targetItems", { count: s.detailed_targeting.length })}{s.narrow_targeting.length ? ` · ${t("campaigns.wizard.narrowItems", { count: s.narrow_targeting.length })}` : ""}
                {s.advantage_audience ? " · Advantage+" : ""}
              </li>
            </ul>
          </div>
          {(step === 3 || step === 4) && (
            <div className="rounded-xl border border-line bg-panel p-4">
              <AudienceEstimate clientId={p.clientId} resultType={plan.result_type} adSet={{ ...s, daily_budget: plan.budget_mode === "CBO" ? plan.campaign_daily_budget : s.daily_budget }} currency={cur} />
            </div>
          )}
          {step === 6 && <AdPreview ad={ad} pageName={pageName} isMessages={chat} noCta={plan.result_type === "engagement" || plan.result_type === "video_views"} />}
          {step === 6 && chat && ad.welcome && <WelcomePreview value={ad.welcome} pageName={pageName} />}
        </aside>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ Targeting step: 2 tables + 2 selection areas

function TargetingStep({ p, plan, s, setAdSet }: { p: Props; plan: EditablePlan; s: EditableAdSet; setAdSet: (patch: Partial<EditableAdSet>) => void }) {
  const t = useT();
  const inTarget = new Set(s.detailed_targeting.map((d) => d.id));
  const inNarrow = new Set(s.narrow_targeting.map((d) => d.id));
  const item = (t: WizardTarget): DetailedItem => ({ id: t.id, name: t.name, type: t.type });
  const add = (t: WizardTarget, where: "target" | "narrow") => {
    const d = item(t);
    if (where === "target") setAdSet({ detailed_targeting: [...s.detailed_targeting.filter((x) => x.id !== d.id), d], narrow_targeting: s.narrow_targeting.filter((x) => x.id !== d.id) });
    else setAdSet({ narrow_targeting: [...s.narrow_targeting.filter((x) => x.id !== d.id), d], detailed_targeting: s.detailed_targeting.filter((x) => x.id !== d.id) });
  };
  // ✦ Claude proposes specifically for the campaign being created (based on the objective, audience, region, content chosen in earlier steps).
  const [ideas, setIdeas] = useState<{ summary: string; targets: WizardTarget[]; missing: string[] } | null>(null);
  const [ideaError, setIdeaError] = useState<string | null>(null);
  const [thinking, startThinking] = useTransition();
  const ideate = () =>
    startThinking(async () => {
      setIdeaError(null);
      const r = await ideateTargetingAction(p.clientId, {
        resultType: plan.result_type,
        ageMin: s.age_min,
        ageMax: s.age_max,
        genders: s.genders,
        locations: [...s.locations.map((l) => l.name), ...s.custom_locations.map((c) => c.label)],
        adText: plan.ads.map((a) => a.primary_text).filter(Boolean).join("\n---\n"),
        notes: [plan.campaign_name, s.hypothesis].filter(Boolean).join(" · "),
        selected: [...s.detailed_targeting, ...s.narrow_targeting].map((d) => d.name),
      });
      if (!r.ok) return setIdeaError(r.error);
      setIdeas({ summary: r.summary, targets: r.targets, missing: r.missing });
    });
  const addCore = () => {
    if (!ideas) return;
    const core = ideas.targets.filter((t) => t.role === "core").map(item);
    const narrow = ideas.targets.filter((t) => t.role === "narrow").map(item);
    setAdSet({
      detailed_targeting: [...s.detailed_targeting, ...core.filter((d) => !inTarget.has(d.id))],
      narrow_targeting: [...s.narrow_targeting, ...narrow.filter((d) => !inNarrow.has(d.id))],
      ...(!s.hypothesis && { hypothesis: ideas.summary }),
    });
  };
  return (
    <>
      <Section title={t("campaigns.wizard.selected")} hint={t("campaigns.wizard.selectedHint")}>
        <SelectedList title={t("campaigns.wizard.detailedTargeting")} hint={t("campaigns.wizard.or")} list={s.detailed_targeting} onRemove={(id) => setAdSet({ detailed_targeting: s.detailed_targeting.filter((x) => x.id !== id) })} />
        <SelectedList title={t("campaigns.wizard.narrowTitle")} hint={t("campaigns.wizard.and")} list={s.narrow_targeting} onRemove={(id) => setAdSet({ narrow_targeting: s.narrow_targeting.filter((x) => x.id !== id) })} />
        <div>
          <Label hint={t("campaigns.wizard.searchHint")}>{t("campaigns.wizard.searchMore")}</Label>
          {/* Search only: picked items are added to "Nhắm mục tiêu chi tiết" (Detailed targeting) above. */}
          <DetailedTargetingPicker
            value={[]}
            onChange={(v) => setAdSet({ detailed_targeting: [...s.detailed_targeting, ...v.filter((d) => !s.detailed_targeting.some((x) => x.id === d.id))], narrow_targeting: s.narrow_targeting.filter((x) => !v.some((d) => d.id === x.id)) })}
          />
        </div>
        <Toggle
          checked={s.advantage_audience}
          onChange={(v) => setAdSet({ advantage_audience: v })}
          label={t("campaigns.wizard.advantageAudience")}
          hint={t("campaigns.wizard.advantageAudienceHint")}
        />
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-mut">
          <b className="text-ink">{t("campaigns.wizard.excludeBold")}</b> {t("campaigns.wizard.excludeNote1")} <b>{t("campaigns.wizard.excludeNote2")}</b> {t("campaigns.wizard.excludeNote3")} <b>{t("campaigns.wizard.excludeNote4")}</b> {t("campaigns.wizard.excludeNote5")}
        </p>
      </Section>

      <Section
        title={t("campaigns.wizard.table1")}
        hint={t("campaigns.wizard.table1Hint")}
      >
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <button type="button" className={btnClass("ai")} disabled={thinking} onClick={ideate}>
            <Sparkles className="size-4" /> {thinking ? t("campaigns.wizard.thinking") : ideas ? t("campaigns.wizard.proposeAgain") : t("campaigns.wizard.proposeForThis")}
          </button>
          {ideas && ideas.targets.some((t) => t.role === "core" || t.role === "narrow") && (
            <button type="button" className={btnClass("secondary")} onClick={addCore}>
              {t("campaigns.wizard.addCore", { count: ideas.targets.filter((x) => x.role === "core").length })}{ideas.targets.some((x) => x.role === "narrow") ? t("campaigns.wizard.addCoreNarrow", { count: ideas.targets.filter((x) => x.role === "narrow").length }) : ""})
            </button>
          )}
          <span className="text-xs text-mut">{t("campaigns.wizard.basedOn")}</span>
        </div>
        {ideaError && <p className="mb-3 text-sm text-rose-700">{ideaError}</p>}
        {ideas && (
          <div className="mb-4 space-y-2">
            <p className="rounded-lg bg-violet-50 px-3 py-2 text-sm text-violet-900">{ideas.summary}</p>
            {ideas.targets.length > 0 && <TargetTable rows={ideas.targets} kind="claude" inTarget={inTarget} inNarrow={inNarrow} add={add} currency={p.client.currency} />}
            {ideas.missing.length > 0 && <p className="text-xs text-mut">{t("campaigns.wizard.notFound", { items: ideas.missing.join(", ") })}</p>}
          </div>
        )}
        {p.claude.length ? (
          <>
            {ideas && <p className="mb-2 text-xs font-semibold tracking-wide text-mut uppercase">{t("campaigns.wizard.fromPersona")}</p>}
            <TargetTable rows={p.claude} kind="claude" inTarget={inTarget} inNarrow={inNarrow} add={add} currency={p.client.currency} />
          </>
        ) : (
          !ideas && <p className="text-sm text-mut">{p.hasAnalysis ? t("campaigns.wizard.noItems") : t("campaigns.wizard.noAnalysis")}</p>
        )}
      </Section>

      <Section title={t("campaigns.wizard.table2")} hint={p.rankingStage === "with_ads" ? t("campaigns.wizard.table2HintAds") : t("campaigns.wizard.table2HintNoAds")}>
        {p.system.length ? <TargetTable rows={p.system} kind="system" inTarget={inTarget} inNarrow={inNarrow} add={add} currency={p.client.currency} /> : <p className="text-sm text-mut">{t("campaigns.wizard.none")}</p>}
      </Section>
    </>
  );
}

const ROLE_KEYS = { core: "campaigns.wizard.role.core", explore: "campaigns.wizard.role.explore", narrow: "campaigns.wizard.role.narrow" } as const;

function TargetTable({ rows, kind, inTarget, inNarrow, add, currency }: { rows: WizardTarget[]; kind: "claude" | "system"; inTarget: Set<string>; inNarrow: Set<string>; add: (t: WizardTarget, where: "target" | "narrow") => void; currency: string }) {
  const tr = useT();
  return (
    <div className="-mx-5 overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-left text-xs text-mut">
          <tr>
            <th className="min-w-56 px-5 py-2 font-medium">{tr("campaigns.wizard.colTarget")}</th>
            <th className="px-2 py-2 text-right font-medium" title={kind === "claude" ? tr("campaigns.wizard.claudeScoreTitle") : tr("campaigns.wizard.systemScoreTitle")}>
              {kind === "claude" ? tr("campaigns.wizard.claudeScore") : tr("campaigns.wizard.systemScore")}
            </th>
            <th className="px-2 py-2 font-medium" title={tr("campaigns.wizard.evidenceTitle")}>
              {tr("campaigns.wizard.evidence")}
            </th>
            <th className="px-5 py-2 text-right font-medium">{tr("campaigns.wizard.addTo")}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((t) => (
            <tr key={t.id} className={`align-top ${inTarget.has(t.id) || inNarrow.has(t.id) ? "bg-indigo-50/50" : ""}`}>
              <td className="px-5 py-2">
                <p className="flex flex-wrap items-center gap-1.5 font-medium text-ink">
                  {t.name}
                  {t.role && <Badge tone={t.role === "explore" ? "ai" : t.role === "narrow" ? "info" : "pri"}>{t.role in ROLE_KEYS ? tr(ROLE_KEYS[t.role as keyof typeof ROLE_KEYS]) : t.role}</Badge>}
                  {!t.role && t.explore && <Badge tone="ai">{tr("campaigns.wizard.expandDirection")}</Badge>}
                  {t.free && <Badge tone="ai">{tr("campaigns.wizard.claudeFound")}</Badge>}
                </p>
                <p className="flex flex-wrap items-center gap-1.5 text-[11px] text-mut">
                  {t.size != null && <span>{tr("campaigns.wizard.vnPeople", { size: fmtSize(tr, t.size) })}</span>}
                  <span>· {tr("campaigns.wizard.copyLabel")}</span>
                  <code className="rounded bg-slate-100 px-1 text-ink2">{t.copy}</code>
                  <CopyMini text={t.copy} />
                  {t.checked && <span className="text-emerald-700">{tr("campaigns.wizard.foundInAdsManager")}</span>}
                </p>
                {(t.persona || t.reason) && (
                  <p className="mt-0.5 line-clamp-2 text-xs text-mut" title={t.reason ?? undefined}>
                    {t.persona && <span className="font-medium text-violet-700">{t.persona}: </span>}
                    {t.reason}
                  </p>
                )}
                {t.hypothesis && <p className="mt-0.5 text-xs text-ink2">{tr("campaigns.wizard.hypothesis", { text: t.hypothesis })}</p>}
              </td>
              <td className="px-2 py-2 text-right tabular-nums">{t.score ?? "—"}</td>
              <td className="px-2 py-2 text-xs whitespace-nowrap text-mut">
                <Badge tone={t.status === tr("core.wizardTargets.verified") ? "good" : t.status === tr("core.wizardTargets.verifying") ? "warn" : t.source === "industry" ? "info" : "mut"}>{t.status}</Badge>
                {t.spend ? (
                  <span className="mt-1 block tabular-nums">
                    {money(t.spend, currency)} · {tr("campaigns.wizard.resultsAbbr", { count: t.results ?? 0 })}{t.cpr != null && ` · ${money(t.cpr, currency)}`}
                  </span>
                ) : null}
                {kind === "claude" && t.systemScore != null && <span className="mt-0.5 block">{tr("campaigns.wizard.systemScoreN", { score: t.systemScore })}</span>}
              </td>
              <td className="px-5 py-2 text-right whitespace-nowrap">
                <div className="inline-flex gap-1">
                  <button type="button" onClick={() => add(t, "target")} disabled={inTarget.has(t.id)} className="rounded-md border border-line px-2 py-1 text-xs text-ink hover:bg-hover disabled:bg-indigo-600 disabled:text-white">
                    {inTarget.has(t.id) ? tr("campaigns.wizard.targeted") : tr("campaigns.wizard.target")}
                  </button>
                  <button type="button" onClick={() => add(t, "narrow")} disabled={inNarrow.has(t.id)} className="rounded-md border border-line px-2 py-1 text-xs text-ink hover:bg-hover disabled:bg-indigo-600 disabled:text-white">
                    {inNarrow.has(t.id) ? tr("campaigns.wizard.narrowed") : tr("campaigns.wizard.narrow")}
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SelectedList({ title, hint, list, onRemove }: { title: string; hint: string; list: DetailedItem[]; onRemove: (id: string) => void }) {
  const t = useT();
  return (
    <div>
      <Label hint={hint}>{title}</Label>
      {list.length ? (
        <div className="flex flex-wrap gap-1.5">
          {list.map((d) => (
            <span key={d.id} className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-700">
              {d.name}
              <button type="button" onClick={() => onRemove(d.id)} aria-label={t("campaigns.wizard.remove", { name: d.name })}>
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className="text-xs text-mut2">{t("campaigns.wizard.notSelected")}</p>
      )}
    </div>
  );
}

function CopyMini({ text }: { text: string }) {
  const t = useT();
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="inline-flex items-center gap-0.5 text-indigo-600 hover:underline"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch {}
      }}
    >
      <Copy className="size-3" />
      {done ? t("campaigns.wizard.copied") : t("campaigns.wizard.copy")}
    </button>
  );
}

// ------------------------------------------------------------ Content step

function ContentStep({
  p,
  plan,
  ad,
  s,
  draftId,
  setAd,
  chat,
  leadForm,
}: {
  p: Props;
  plan: EditablePlan;
  ad: EditableAd;
  s: EditableAdSet;
  draftId: string | null;
  setAd: (patch: Partial<EditableAd>) => void;
  chat: boolean;
  leadForm: boolean;
}) {
  const t = useT();
  const [variants, setVariants] = useState<CopyVariant[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const ctas = ctasFor(plan.result_type, s);
  const suggest = () =>
    start(async () => {
      setErr(null);
      const note = `age ${s.age_min}-${s.age_max}, ${s.genders}, ${s.locations.map((l) => l.name).join(", ")}; targeting: ${s.detailed_targeting.map((d) => d.name).join(", ") || "broad"}`; // prompt data for Claude, not UI text
      const r = await suggestAdCopyAction(p.clientId, { resultType: plan.result_type, campaignName: plan.campaign_name, audienceNote: note });
      if (r.ok) setVariants(r.variants);
      else setErr(r.error);
    });
  const field = (children: ReactNode) => <div>{children}</div>;
  return (
    <>
      <Section title={t("campaigns.wizard.adSetup")}>
        <Radio
          value={ad.source}
          onChange={(v) => setAd({ source: v })}
          options={[
            { value: "new", label: t("campaigns.wizard.createNewAd"), hint: t("campaigns.wizard.createNewAdHint") },
            { value: "existing", label: t("campaigns.wizard.useExistingPost"), hint: t("campaigns.wizard.useExistingPostHint") },
          ]}
        />
      </Section>
      {ad.source === "existing" ? (
        <Section title={t("campaigns.wizard.post")} hint={t("campaigns.wizard.postHint")}>
          <PostPicker key={plan.page_id ?? ""} clientId={p.clientId} pageId={plan.page_id} postId={ad.post_id} preview={ad.post_preview} onChange={(id, preview) => setAd({ post_id: id, post_preview: preview })} />
        </Section>
      ) : (
        <Section
          title={t("campaigns.wizard.adContent")}
          right={
            <button type="button" className={btnClass("ai")} onClick={suggest} disabled={pending}>
              {pending ? <Spinner /> : <Sparkles />} {pending ? t("campaigns.wizard.writing") : t("campaigns.wizard.suggestContent")}
            </button>
          }
        >
          {err && <p className="text-sm text-rose-700">{err}</p>}
          {variants && (
            <div className="grid gap-2 @3xl:grid-cols-3">
              {variants.map((v, i) => (
                <div key={i} className="flex flex-col gap-1.5 rounded-lg border border-violet-200 bg-violet-50/50 p-3 text-sm">
                  <p className="text-xs font-semibold text-violet-700">{v.angle}</p>
                  <p className="line-clamp-6 whitespace-pre-line text-ink">{v.primary_text}</p>
                  <p className="text-xs font-medium text-ink">{v.headline}</p>
                  <button type="button" className={`${btnClass("secondary")} mt-auto`} onClick={() => setAd({ primary_text: v.primary_text, headline: v.headline.slice(0, 40), description: v.description })}>
                    <Plus /> {t("campaigns.wizard.useThis")}
                  </button>
                </div>
              ))}
            </div>
          )}
          {field(
            <>
              <Label hint={t("campaigns.wizard.imageHint")}>{t("campaigns.wizard.image")}</Label>
              {draftId ? <ImageUpload draftId={draftId} path={ad.image_path ?? null} onChange={(v) => setAd({ image_path: v })} /> : <p className="text-xs text-mut">{t("campaigns.wizard.creatingDraft")}</p>}
            </>,
          )}
          {field(
            <>
              <Label hint={t("campaigns.wizard.chars", { count: ad.primary_text.length })}>{t("campaigns.wizard.primaryText")}</Label>
              <TextArea rows={6} value={ad.primary_text} onChange={(v) => setAd({ primary_text: v })} placeholder={t("campaigns.wizard.primaryTextPh")} />
            </>,
          )}
          {field(
            <>
              <Label>{t("campaigns.wizard.headline")}</Label>
              <TextInput value={ad.headline} onChange={(v) => setAd({ headline: v })} maxHint={40} />
            </>,
          )}
          {field(
            <>
              <Label hint={t("campaigns.wizard.optional")}>{t("campaigns.wizard.description")}</Label>
              <TextInput value={ad.description} onChange={(v) => setAd({ description: v })} />
            </>,
          )}
          {plan.result_type !== "engagement" && plan.result_type !== "video_views" && (
            <div className="max-w-xs">
              <Label>{t("campaigns.wizard.cta")}</Label>
              <select className={inputClass} value={ad.call_to_action} disabled={ctas.length < 2} onChange={(e) => setAd({ call_to_action: e.target.value as EditableAd["call_to_action"] })}>
                {ctas.map((c) => (
                  <option key={c} value={c}>
                    {ctaLabel(t, c)}
                  </option>
                ))}
              </select>
            </div>
          )}
          {plan.result_type === "link_clicks" && (
            <div>
              <Label>{t("campaigns.wizard.websiteUrl")}</Label>
              <TextInput value={ad.link_url ?? ""} onChange={(v) => setAd({ link_url: v || null })} placeholder="https://" />
            </div>
          )}
        </Section>
      )}
      {leadForm && (
        <Section title={t("campaigns.wizard.instantForm")} hint={t("campaigns.wizard.instantFormHint")}>
          <LeadFormPicker key={plan.page_id ?? ""} clientId={p.clientId} pageId={plan.page_id} value={ad.lead_form} onChange={(v) => setAd({ lead_form: v })} />
        </Section>
      )}
      {chat && ad.source === "new" && (
        <Section title={t("campaigns.wizard.messageTemplate")} hint={t("campaigns.wizard.messageTemplateHint")}>
          <WelcomeEditor value={ad.welcome} onChange={(v) => setAd({ welcome: v })} />
        </Section>
      )}
    </>
  );
}
