"use client";

import { useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { checkDraftPolicyAction, publishAction, saveDraftAction, uploadImageAction } from "@/app/actions";
import type { EditableAd, EditableAdSet, EditablePlan, Positions } from "@/lib/ai/schemas";
import { blankAd, blankAdSet, dailyEquivalent, defaultCta, OBJECTIVE_FOR_RESULT, PUBLISHABLE_RESULTS, reviewPlan, totalDailyBudget, type ClientLimits } from "@/lib/plan-rules";
import { BID_OPTS, ctasFor, DEFAULT_POSITIONS, MESSAGE_DESTINATION_OPTS, performanceGoals, POSITION_OPTS } from "@/lib/ads-options";
import { LANGUAGES, languageLabel } from "@/lib/languages";
import { defaultDailyBudget, money, roundBudget } from "@/lib/format";
import { btnClass, inputClass } from "../ui";
import { Spinner } from "../action-button";
import { ReviseForm } from "../brief-form";
import { AdPreview, ctaLabel } from "./ad-preview";
import { Label, MoneyInput, Radio, Section, TextArea, TextInput, Toggle } from "./fields";
import { DetailedTargetingPicker, LanguagePicker, LocationPicker, PinLocationEditor } from "./pickers";
import { PostPicker } from "./post-picker";
import { CarouselEditor } from "./carousel-editor";
import { CAROUSEL_MAX, CAROUSEL_MIN, carouselBlockReason, isCarousel } from "@/lib/carousel";
import { VideoPicker } from "./video-picker";
import { AudienceEstimate } from "./audience-estimate";
import { VerifyPanel } from "./verify-panel";
import { useMetaConfirm } from "../meta-confirm";
import { CustomAudiencePicker, LeadFormPicker, PositionsPicker, WelcomeEditor, WelcomePreview } from "./ads-fields";
import type { VerifyReport } from "@/lib/meta/types";
import { adContentKey, policyGate, policyGateMessage, type DraftPolicy } from "@/lib/draft-policy-rules";
import { AdPolicyPanel, DraftPolicyPanel, PolicyStatus, type PolicyJob } from "./policy-panel";
import { useT } from "@/i18n/client";
import type { MessageKey } from "@/i18n/translate";

type Sel = { k: "campaign" } | { k: "adset"; i: number } | { k: "ad"; i: number };
type SaveState = "saved" | "dirty" | "saving" | "error";

const OBJECTIVES: { value: EditablePlan["result_type"]; icon: string; label: MessageKey; hint: MessageKey }[] = [
  { value: "reach", icon: "📣", label: "campaigns.editor.objective.reach", hint: "campaigns.editor.objective.reachHint" },
  { value: "link_clicks", icon: "🔗", label: "campaigns.editor.objective.link_clicks", hint: "campaigns.editor.objective.link_clicksHint" },
  { value: "profile_visits", icon: "📸", label: "campaigns.editor.objective.profile_visits", hint: "campaigns.editor.objective.profile_visitsHint" },
  { value: "messages", icon: "💬", label: "campaigns.editor.objective.messages", hint: "campaigns.editor.objective.messagesHint" },
  { value: "engagement", icon: "👍", label: "campaigns.editor.objective.engagement", hint: "campaigns.editor.objective.engagementHint" },
  { value: "page_likes", icon: "⭐", label: "campaigns.editor.objective.page_likes", hint: "campaigns.editor.objective.page_likesHint" },
  { value: "video_views", icon: "🎬", label: "campaigns.editor.objective.video_views", hint: "campaigns.editor.objective.video_viewsHint" },
  { value: "leads", icon: "📝", label: "campaigns.editor.objective.leads", hint: "campaigns.editor.objective.leadsHint" },
  { value: "purchases", icon: "🛒", label: "campaigns.editor.objective.purchases", hint: "campaigns.editor.objective.purchasesHint" },
];

// Where the result happens, for objectives without a conversion location choice.
const RESULT_PLACE_KEYS: Record<EditablePlan["result_type"], MessageKey | null> = {
  engagement: "campaigns.editor.place.engagement",
  page_likes: "campaigns.editor.place.page_likes",
  video_views: "campaigns.editor.place.video_views",
  link_clicks: "campaigns.editor.place.link_clicks",
  profile_visits: "campaigns.editor.place.profile_visits",
  reach: "campaigns.editor.place.reach",
  leads: null,
  messages: null,
  purchases: "campaigns.editor.place.purchases",
};
const GENDER_KEYS = { all: "campaigns.editor.gender.all", male: "campaigns.editor.gender.male", female: "campaigns.editor.gender.female" } as const;
const LOCATION_TYPE_KEYS = { home_recent: "campaigns.editor.locType.home_recent", home: "campaigns.editor.locType.home", recent: "campaigns.editor.locType.recent" } as const;
const SAVE_KEYS = { saved: "campaigns.editor.save.saved", dirty: "campaigns.editor.save.dirty", saving: "campaigns.editor.save.saving", error: "campaigns.editor.save.error" } as const;

type EditorProps = {
  draftId: string;
  clientId: string;
  revision: number;
  initialPlan: EditablePlan;
  client: ClientLimits;
  pageName: string;
  /** The client's Facebook Pages (main Page first); with multiple Pages, choose which Page the ad is published under. */
  pages: { id: string; name: string }[];
  isMeta: boolean;
  published: boolean;
  lastResult: { notes?: string[]; error?: string; verify?: VerifyReport | { error: string } } | null;
  /** Content policy check result (must pass before publishing) + the draft's most recent check. */
  policy: DraftPolicy | null;
  policyJob: PolicyJob;
};

export function CampaignEditor(p: EditorProps) {
  const t = useT();
  const [plan, setPlan] = useState(p.initialPlan);
  const [sel, setSel] = useState<Sel>({ k: "campaign" });
  const [save, setSave] = useState<SaveState>("saved");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [publishing, startPublish] = useTransition();
  const [publishError, setPublishError] = useState<string | null>(null);
  const [revising, setRevising] = useState(false);
  const router = useRouter();
  const [metaDialog, askMeta] = useMetaConfirm();
  const first = useRef(true);
  // Edit counter: a returned save may only be reported as "Saved" if the user made no further edits while it was saving.
  const edits = useRef(0);
  const latest = useRef({ plan, dirty: false });
  const cur = p.client.currency;
  const readOnly = p.published;

  const review = useMemo(() => reviewPlan(plan, p.client, p.isMeta, t), [plan, p.client, p.isMeta, t]);
  const gate = useMemo(() => policyGate(plan, p.policy), [plan, p.policy]);
  const [queuing, setQueuing] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const checking = queuing || refreshing || p.policyJob?.status === "queued" || p.policyJob?.status === "running";
  const policyFailed = p.policyJob?.status === "failed" ? p.policyJob.error : null;
  // Check in progress (background): periodically reload page data to see the result, without touching the content being edited.
  useEffect(() => {
    if (!checking) return;
    const t = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(t);
  }, [checking, router]);
  const total = totalDailyBudget(plan);
  const lifetime = plan.budget_period === "lifetime";
  const per = lifetime ? t("campaigns.editor.perLifetime") : t("campaigns.editor.perDay");

  // Auto-save 1 second after the last edit, like Ads Manager drafts.
  useEffect(() => {
    if (first.current || readOnly) {
      first.current = false;
      return;
    }
    const t = setTimeout(async () => {
      const v = edits.current;
      setSave("saving");
      const res = await saveDraftAction(p.draftId, plan, p.revision);
      if (!res.ok) {
        setSave("error");
        setSaveError(res.error);
        return;
      }
      setSaveError(null);
      if (edits.current === v) {
        latest.current.dirty = false;
        setSave("saved");
      } else setSave("dirty");
    }, 1000);
    return () => clearTimeout(t);
  }, [plan, p.draftId, p.revision, readOnly]);

  // Leaving the page within 1 second of an edit (clicking "← Bản nháp", switching tabs...): save immediately instead of losing it.
  useEffect(() => {
    latest.current.plan = plan;
  }, [plan]);
  useEffect(() => {
    const ref = latest.current;
    return () => {
      if (ref.dirty && !readOnly) void saveDraftAction(p.draftId, ref.plan, p.revision);
    };
  }, [p.draftId, p.revision, readOnly]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (save !== "saved") e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [save]);

  const update = (fn: (p: EditablePlan) => EditablePlan) => {
    if (readOnly || revising) return;
    edits.current++;
    latest.current.dirty = true;
    setPlan((pl) => normalize(fn(pl)));
    setSave("dirty");
  };
  const setAdSet = (i: number, patch: Partial<EditableAdSet>) =>
    update((pl) => ({ ...pl, ad_sets: pl.ad_sets.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));
  const setAd = (i: number, patch: Partial<EditableAd> | ((a: EditableAd) => Partial<EditableAd>)) =>
    update((pl) => ({ ...pl, ads: pl.ads.map((a, j) => (j === i ? { ...a, ...(typeof patch === "function" ? patch(a) : patch) } : a)) }));

  // ---------------------------------------------------------------- Tree operations
  const cta = defaultCta(plan.result_type);
  const addAdSet = () => {
    const i = plan.ad_sets.length;
    update((pl) => ({
      ...pl,
      ad_sets: [...pl.ad_sets, { ...blankAdSet(i, cur, t), daily_budget: pl.budget_mode === "CBO" ? null : defaultDailyBudget(cur) }],
      ads: [...pl.ads, { ...blankAd(i, pl.ads.length + 1, pl.ads[0]?.link_url, t), call_to_action: cta }],
    }));
    setSel({ k: "adset", i });
  };
  const duplicateAdSet = (i: number) => {
    const n = plan.ad_sets.length;
    update((pl) => ({
      ...pl,
      ad_sets: [...pl.ad_sets, { ...structuredClone(pl.ad_sets[i]), name: `${pl.ad_sets[i].name}${t("campaigns.editor.copySuffix")}` }],
      ads: [...pl.ads, ...pl.ads.filter((a) => a.ad_set_index === i).map((a) => ({ ...a, ad_set_index: n, name: `${a.name}${t("campaigns.editor.copySuffix")}` }))],
    }));
    setSel({ k: "adset", i: n });
  };
  const deleteAdSet = (i: number) => {
    if (plan.ad_sets.length <= 1 || !confirm(t("campaigns.editor.confirmDeleteAdSet", { name: plan.ad_sets[i].name }))) return;
    update((pl) => ({
      ...pl,
      ad_sets: pl.ad_sets.filter((_, j) => j !== i),
      ads: pl.ads.filter((a) => a.ad_set_index !== i).map((a) => ({ ...a, ad_set_index: a.ad_set_index > i ? a.ad_set_index - 1 : a.ad_set_index })),
    }));
    setSel({ k: "campaign" });
  };
  const addAd = (setIndex: number) => {
    const i = plan.ads.length;
    const sibling = plan.ads.find((a) => a.ad_set_index === setIndex);
    update((pl) => ({ ...pl, ads: [...pl.ads, { ...blankAd(setIndex, i + 1, sibling?.link_url, t), call_to_action: sibling?.call_to_action ?? cta }] }));
    setSel({ k: "ad", i });
  };
  const duplicateAd = (i: number) => {
    update((pl) => ({ ...pl, ads: [...pl.ads, { ...pl.ads[i], name: `${pl.ads[i].name}${t("campaigns.editor.copySuffix")}` }] }));
    setSel({ k: "ad", i: plan.ads.length });
  };
  const deleteAd = (i: number) => {
    if (!confirm(t("campaigns.editor.confirmDeleteAd", { name: plan.ads[i].name }))) return;
    update((pl) => ({ ...pl, ads: pl.ads.filter((_, j) => j !== i) }));
    setSel({ k: "adset", i: plan.ads[i].ad_set_index });
  };

  const setObjective = (r: EditablePlan["result_type"]) =>
    update((pl) => ({
      ...pl,
      result_type: r,
      objective: OBJECTIVE_FOR_RESULT[r],
      // Meta doesn't allow a Cost goal with conversation optimization.
      ...(r === "messages" && pl.bid_strategy === "cost_cap" && { bid_strategy: "lowest_cost" as const, bid_amount: null }),
      ad_sets: pl.ad_sets.map((s) => ({ ...s, performance_goal: null, message_destination: r === "messages" ? (s.message_destination ?? "messenger") : null })),
    }));

  const setBudgetMode = (cbo: boolean) =>
    update((pl) => {
      if (cbo) return { ...pl, budget_mode: "CBO", campaign_daily_budget: totalDailyBudget(pl) || defaultDailyBudget(cur, 300000), ad_sets: pl.ad_sets.map((s) => ({ ...s, daily_budget: null })) };
      const each = roundBudget((pl.campaign_daily_budget ?? defaultDailyBudget(cur, 300000)) / Math.max(1, pl.ad_sets.length), cur);
      return { ...pl, budget_mode: "ABO", campaign_daily_budget: null, ad_sets: pl.ad_sets.map((s) => ({ ...s, daily_budget: each })) };
    });

  const checkPolicy = async (force = false) => {
    setPublishError(null);
    setQueuing(true);
    // Save the content being edited first so Claude checks the latest version.
    const saved = await saveDraftAction(p.draftId, plan, p.revision);
    if (!saved.ok) {
      setQueuing(false);
      return setPublishError(saved.error);
    }
    latest.current.dirty = false;
    setSave("saved");
    const res = await checkDraftPolicyAction(p.draftId, force);
    setQueuing(false);
    if (!res.ok) setPublishError(res.error);
    startRefresh(() => router.refresh()); // keep the "checking" state until the page receives the job that was just queued
  };
  const applyRewrite = (i: number, rw: { primary_text: string; headline: string }) => {
    const key = adContentKey(plan.ads[i]);
    update((pl) => ({
      ...pl,
      ads: pl.ads.map((a) => (adContentKey(a) === key && a.source !== "existing" ? { ...a, primary_text: rw.primary_text, headline: rw.headline || a.headline } : a)),
    }));
  };

  const publish = async () => {
    const ok = p.isMeta
      ? await askMeta({
          title: t("campaigns.editor.publishTitle", { name: plan.campaign_name }),
          lines: [
            { label: t("campaigns.editor.createsLabel"), to: t("campaigns.editor.createsValue", { adSets: plan.ad_sets.length, ads: plan.ads.length }) },
            { label: t("campaigns.editor.totalBudget"), to: `${money(total, cur)}${per}` },
            { label: t("campaigns.editor.statusLabel"), to: t("campaigns.editor.pausedValue") },
            ...(gate.ok ? [] : [{ label: t("campaigns.editor.policyLabel"), to: t("campaigns.editor.policyValue", { message: policyGateMessage(t, plan, gate) }) }]),
          ],
          confirmLabel: t("campaigns.editor.publishToMeta"),
        })
      : confirm(t("campaigns.editor.confirmCreate", { name: plan.campaign_name, adSets: plan.ad_sets.length, ads: plan.ads.length, total: `${money(total, cur)}${per}` }) + (gate.ok ? "" : `\n${t("campaigns.editor.policyColon", { message: policyGateMessage(t, plan, gate) })}`));
    if (!ok) return;
    setPublishError(null);
    startPublish(async () => {
      const saved = await saveDraftAction(p.draftId, plan, p.revision);
      if (!saved.ok) return setPublishError(saved.error);
      latest.current.dirty = false;
      setSave("saved");
      const res = await publishAction(p.draftId);
      if (!res.ok) setPublishError(res.error);
      else router.refresh();
    });
  };

  const pageName = p.pages.find((x) => x.id === plan.page_id)?.name ?? p.pageName;
  const selAdSet = sel.k === "adset" ? plan.ad_sets[sel.i] : null;
  const selAd = sel.k === "ad" ? plan.ads[sel.i] : null;
  const selAdSetOfAd = selAd ? plan.ad_sets[selAd.ad_set_index] : null;
  const adCtas = ctasFor(plan.result_type, selAdSetOfAd ?? undefined);
  // Ads with a form / that open a chat (for the Instant Form and Message template sections).
  const leadForm = plan.result_type === "leads" && selAdSetOfAd?.lead_destination !== "messenger";
  const chat =
    (plan.result_type === "messages" && selAdSetOfAd?.message_destination !== "whatsapp") || (plan.result_type === "leads" && selAdSetOfAd?.lead_destination === "messenger");

  return (
    <div className="-mx-4 -mt-2 md:-mx-8">
      {metaDialog}
      {/* Top bar */}
      <div className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-panel/95 px-4 py-3 backdrop-blur md:px-8">
        <div className="flex min-w-0 items-center gap-3">
          <Link href={`/clients/${p.clientId}/drafts`} className="text-sm text-slate-500 hover:text-slate-800">{t("campaigns.editor.backToDrafts")}</Link>
          <span className="truncate font-semibold text-slate-900">{plan.campaign_name}</span>
          <span className="text-xs text-slate-400">
            {readOnly ? t("campaigns.editor.published") : t(SAVE_KEYS[save])}
          </span>
          {saveError && <span className="text-xs text-rose-600">{saveError}</span>}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-slate-600">
            {t("campaigns.editor.totalLabel")} <b className="tabular-nums">{money(total, cur)}</b>{per}
          </span>
          {!readOnly && (
            <>
              {review.errors.length > 0 && (
                <button type="button" onClick={() => setSel({ k: "campaign" })} className="text-sm font-medium text-rose-600 hover:underline">
                  {t("campaigns.editor.errorsToFix", { count: review.errors.length })}
                </button>
              )}
              <PolicyStatus gate={gate} checking={checking} failed={policyFailed} onCheck={() => checkPolicy()} onShow={() => setSel({ k: "campaign" })} />
              <button
                type="button"
                className={btnClass("primary")}
                disabled={publishing || review.errors.length > 0 || checking}
                title={!gate.ok ? t("campaigns.editor.policyWarningTitle") : undefined}
                onClick={publish}
              >
                {publishing && <Spinner />}
                {p.isMeta ? t("campaigns.editor.publishPaused") : t("campaigns.editor.publishNeedsMeta")}
              </button>
            </>
          )}
        </div>
      </div>
      {!readOnly && !publishError && p.lastResult?.error && (
        <div className="mx-4 mt-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 md:mx-8">{t("campaigns.editor.prevPublishFailed", { error: p.lastResult.error })}</div>
      )}
      {publishError && <div className="mx-4 mt-3 rounded-lg md:mx-8 border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{publishError}</div>}
      {p.lastResult?.notes && (
        <div className={`mx-4 mt-3 rounded-lg md:mx-8 border p-3 text-sm ${readOnly ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-800"}`}>
          <ul className="list-disc pl-5">{p.lastResult.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
        </div>
      )}

      {readOnly && p.isMeta && (
        <div className="mx-4 mt-3 md:mx-8">
          <VerifyPanel draftId={p.draftId} verify={p.lastResult?.verify} />
        </div>
      )}
      <div className="grid gap-6 px-4 py-6 md:px-8 @2xl:grid-cols-[210px_minmax(0,1fr)] @5xl:grid-cols-[220px_minmax(0,1fr)_300px]">
        {/* Campaign tree */}
        <nav className="space-y-1 self-start rounded-xl border border-slate-200 bg-panel p-2 text-sm @2xl:sticky @2xl:top-20 @2xl:row-span-2 @5xl:row-span-1">
          <TreeRow active={sel.k === "campaign"} icon="📁" label={plan.campaign_name || t("campaigns.editor.campaign")} sub={t("campaigns.editor.campaign")} onClick={() => setSel({ k: "campaign" })} />
          {plan.ad_sets.map((s, i) => (
            <div key={i} className="pl-3">
              <TreeRow
                active={sel.k === "adset" && sel.i === i}
                icon="👥"
                label={s.name || t("campaigns.editor.adSetN", { n: i + 1 })}
                sub={plan.budget_mode === "ABO" ? `${money(s.daily_budget ?? 0, cur)}${per}` : t("campaigns.editor.adSet")}
                onClick={() => setSel({ k: "adset", i })}
                actions={!readOnly && [
                  { label: t("campaigns.editor.duplicate"), onClick: () => duplicateAdSet(i) },
                  ...(plan.ad_sets.length > 1 ? [{ label: t("campaigns.editor.delete"), onClick: () => deleteAdSet(i) }] : []),
                ]}
              />
              <div className="pl-3">
                {plan.ads.map((a, j) =>
                  a.ad_set_index === i ? (
                    <TreeRow
                      key={j}
                      active={sel.k === "ad" && sel.i === j}
                      icon={isCarousel(a) ? "🎠" : a.video_id ? "🎬" : a.image_path ? "🖼" : "▫️"}
                      label={a.name || t("campaigns.editor.ad")}
                      onClick={() => setSel({ k: "ad", i: j })}
                      actions={!readOnly && [
                        { label: t("campaigns.editor.duplicate"), onClick: () => duplicateAd(j) },
                        { label: t("campaigns.editor.delete"), onClick: () => deleteAd(j) },
                      ]}
                    />
                  ) : null,
                )}
                {!readOnly && (
                  <button type="button" onClick={() => addAd(i)} className="w-full rounded-md px-2 py-1 text-left text-xs text-indigo-600 hover:bg-indigo-50">
                    {t("campaigns.editor.addAd")}
                  </button>
                )}
              </div>
            </div>
          ))}
          {!readOnly && (
            <button type="button" onClick={addAdSet} className="w-full rounded-md px-2 py-1.5 text-left text-xs font-medium text-indigo-600 hover:bg-indigo-50">
              {t("campaigns.editor.addAdSet")}
            </button>
          )}
        </nav>

        {/* Edit panel */}
        <fieldset disabled={readOnly || revising} className="@container min-w-0 space-y-4">
          {sel.k === "campaign" && (
            <>
              <Section title={t("campaigns.editor.campaignName")}>
                <TextInput value={plan.campaign_name} onChange={(v) => update((pl) => ({ ...pl, campaign_name: v }))} />
              </Section>
              <Section title={t("campaigns.editor.campaignObjective")} hint={t("campaigns.editor.campaignObjectiveHint")}>
                <div className="grid gap-2 @md:grid-cols-2">
                  {OBJECTIVES.map((o) => (
                    <button
                      type="button"
                      key={o.value}
                      onClick={() => setObjective(o.value)}
                      className={`rounded-lg border p-3 text-left transition ${plan.result_type === o.value ? "border-indigo-500 bg-indigo-50 ring-1 ring-indigo-500" : "border-slate-200 hover:border-slate-300"}`}
                    >
                      <div className="text-sm font-medium text-slate-900">{o.icon} {t(o.label)}</div>
                      <div className="text-xs text-slate-500">{t(o.hint)}</div>
                      {p.isMeta && !PUBLISHABLE_RESULTS.has(o.value) && <div className="mt-1 text-[11px] text-amber-600">{t("campaigns.editor.planOnly")}</div>}
                    </button>
                  ))}
                </div>
              </Section>
              <Section title={t("campaigns.editor.budget")}>
                <Toggle
                  checked={plan.budget_mode === "CBO"}
                  onChange={setBudgetMode}
                  label={t("campaigns.editor.cboLabel")}
                  hint={t("campaigns.editor.cboHint")}
                />
                <div className="grid gap-4 @md:grid-cols-2">
                  <div>
                    <Label>{t("campaigns.editor.budgetType")}</Label>
                    <select className={inputClass} value={plan.budget_period} onChange={(e) => update((pl) => ({ ...pl, budget_period: e.target.value as EditablePlan["budget_period"] }))}>
                      <option value="daily">{t("campaigns.editor.dailyBudget")}</option>
                      <option value="lifetime">{t("campaigns.editor.lifetimeBudget")}</option>
                    </select>
                  </div>
                  {plan.budget_mode === "CBO" && (
                    <div>
                      <Label>{lifetime ? t("campaigns.editor.lifetimeBudget") : t("campaigns.editor.dailyBudget")}</Label>
                      <MoneyInput value={plan.campaign_daily_budget} currency={cur} onChange={(v) => update((pl) => ({ ...pl, campaign_daily_budget: v }))} />
                    </div>
                  )}
                </div>
                {lifetime && <p className="text-xs text-slate-500">{t("campaigns.editor.lifetimeNote")}{dailyEquivalent(plan) !== total && ` ≈ ${t("campaigns.editor.amountPerDay", { amount: money(Math.round(dailyEquivalent(plan)), cur) })}.`}</p>}
                {p.client.maxDailyBudget && <p className="text-xs text-slate-500">{t("campaigns.editor.clientLimit", { amount: money(p.client.maxDailyBudget, cur) })}</p>}
              </Section>
              <Section title={t("campaigns.editor.bidStrategy")} hint={plan.budget_mode === "CBO" ? t("campaigns.editor.appliesCampaign") : t("campaigns.editor.appliesAdSets")}>
                <Radio
                  value={plan.bid_strategy}
                  onChange={(v) => update((pl) => ({ ...pl, bid_strategy: v, bid_amount: v === "lowest_cost" ? null : pl.bid_amount }))}
                  options={BID_OPTS.map((b) => ({
                    value: b.value as EditablePlan["bid_strategy"],
                    label: t(b.label),
                    hint: b.value === "cost_cap" && plan.result_type === "messages" ? t("campaigns.editor.costCapNotAllowed") : b.hint ? t(b.hint) : undefined,
                  }))}
                />
                {plan.bid_strategy !== "lowest_cost" && (
                  <div className="max-w-xs">
                    <Label>{plan.bid_strategy === "cost_cap" ? t("campaigns.editor.targetCost") : t("campaigns.editor.maxBid")}</Label>
                    <MoneyInput value={plan.bid_amount} currency={cur} onChange={(v) => update((pl) => ({ ...pl, bid_amount: v || null }))} />
                  </div>
                )}
                <div className="max-w-xs">
                  <Label hint={t("campaigns.editor.optional")}>{t("campaigns.editor.spendCap")}</Label>
                  <MoneyInput value={plan.spend_cap} currency={cur} onChange={(v) => update((pl) => ({ ...pl, spend_cap: v || null }))} />
                  <p className="mt-1 text-xs text-slate-500">{t("campaigns.editor.spendCapNote")}</p>
                </div>
              </Section>
              {(plan.strategy || plan.testing_plan) && (
                <Section title={t("campaigns.editor.claudeStrategy")}>
                  {plan.strategy && <p className="text-sm whitespace-pre-line text-slate-700">{plan.strategy}</p>}
                  {plan.testing_plan && <p className="text-sm text-slate-700"><b>{t("campaigns.editor.testPlan")}</b> {plan.testing_plan}</p>}
                  {plan.risks.length > 0 && <ul className="list-disc pl-5 text-sm text-slate-600">{plan.risks.map((r, i) => <li key={i}>{r}</li>)}</ul>}
                </Section>
              )}
              {!readOnly && (
                <Section title={t("campaigns.editor.askClaudeEdit")} hint={t("campaigns.editor.askClaudeEditHint")}>
                  <ReviseForm draftId={p.draftId} canStart={save === "saved"} onPendingChange={setRevising} />
                </Section>
              )}
            </>
          )}

          {selAdSet && sel.k === "adset" && (
            <>
              <Section title={t("campaigns.editor.adSetName")}>
                <TextInput value={selAdSet.name} onChange={(v) => setAdSet(sel.i, { name: v })} />
              </Section>
              <Section title={t("campaigns.editor.conversionLocation")} hint={plan.result_type === "messages" ? t("campaigns.editor.whereMessage") : t("campaigns.editor.whereResults")}>
                {plan.result_type === "messages" ? (
                  <Radio
                    value={selAdSet.message_destination ?? "messenger"}
                    onChange={(v) => setAdSet(sel.i, { message_destination: v })}
                    options={MESSAGE_DESTINATION_OPTS.map((o) => ({
                      value: o.value as NonNullable<EditableAdSet["message_destination"]>,
                      label: t(o.label),
                      hint: [o.needsIg && !p.client.metaInstagramId && t("campaigns.editor.needsIgId"), o.needsWa && t("campaigns.editor.needsWa")].filter(Boolean).join(" · ") || undefined,
                    }))}
                  />
                ) : plan.result_type === "leads" ? (
                  <Radio
                    value={selAdSet.lead_destination}
                    onChange={(v) => setAdSet(sel.i, { lead_destination: v, performance_goal: null })}
                    options={[
                      { value: "form", label: t("campaigns.editor.instantForm"), hint: t("campaigns.editor.instantFormHint") },
                      { value: "messenger", label: "Messenger", hint: t("campaigns.editor.messengerLeadHint") },
                    ]}
                  />
                ) : (
                  <p className="text-sm text-slate-700">
                    {RESULT_PLACE_KEYS[plan.result_type] ? t(RESULT_PLACE_KEYS[plan.result_type]!) : ""}
                  </p>
                )}
                <div className="max-w-md">
                  <Label>{t("campaigns.editor.performanceGoal")}</Label>
                  <select
                    className={inputClass}
                    value={selAdSet.performance_goal ?? performanceGoals(plan.result_type, selAdSet)[0].value}
                    onChange={(e) => setAdSet(sel.i, { performance_goal: e.target.value })}
                  >
                    {performanceGoals(plan.result_type, selAdSet).map((g) => (
                      <option key={g.value} value={g.value}>{t(g.label)}</option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-slate-500">{performanceGoals(plan.result_type, selAdSet).find((g) => g.value === (selAdSet.performance_goal ?? performanceGoals(plan.result_type, selAdSet)[0].value))?.hint ? t(performanceGoals(plan.result_type, selAdSet).find((g) => g.value === (selAdSet.performance_goal ?? performanceGoals(plan.result_type, selAdSet)[0].value))!.hint!) : ""}</p>
                </div>
              </Section>
              <Section title={t("campaigns.editor.budgetSchedule")}>
                {plan.budget_mode === "ABO" ? (
                  <div className="max-w-xs">
                    <Label>{lifetime ? t("campaigns.editor.lifetimeBudget") : t("campaigns.editor.dailyBudget")}</Label>
                    <MoneyInput value={selAdSet.daily_budget} currency={cur} onChange={(v) => setAdSet(sel.i, { daily_budget: v })} />
                  </div>
                ) : (
                  <p className="text-sm text-slate-500">{t("campaigns.editor.usingCbo", { amount: `${money(plan.campaign_daily_budget, cur)}${per}` })}</p>
                )}
                <div className="grid gap-4 @md:grid-cols-2">
                  <div>
                    <Label hint={t("campaigns.editor.startHint")}>{t("campaigns.editor.startDate")}</Label>
                    <input type="datetime-local" className={inputClass} value={selAdSet.start_time ?? ""} onChange={(e) => setAdSet(sel.i, { start_time: e.target.value || null })} />
                  </div>
                  <div>
                    <Label hint={lifetime ? t("campaigns.editor.endRequired") : t("campaigns.editor.optional")}>{t("campaigns.editor.endDate")}</Label>
                    <input type="datetime-local" className={inputClass} value={selAdSet.end_time ?? ""} onChange={(e) => setAdSet(sel.i, { end_time: e.target.value || null })} />
                  </div>
                </div>
              </Section>
              <Section title={t("campaigns.editor.audience")} hint={t("campaigns.editor.audienceHint")}>
                <div>
                  <Label hint={t("campaigns.editor.customAudienceHint")}>{t("campaigns.editor.customAudience")}</Label>
                  <CustomAudiencePicker
                    key={sel.i}
                    clientId={p.clientId}
                    include={selAdSet.custom_audiences}
                    exclude={selAdSet.excluded_custom_audiences}
                    onChange={(inc, exc) => setAdSet(sel.i, { custom_audiences: inc, excluded_custom_audiences: exc })}
                  />
                </div>
                <div>
                  <Label>{t("campaigns.editor.location")}</Label>
                  <LocationPicker value={selAdSet.locations} allowEmpty={selAdSet.custom_locations.length > 0} onChange={(v) => setAdSet(sel.i, { locations: v })} />
                </div>
                <div>
                  <Label hint={t("campaigns.editor.pinHint")}>{t("campaigns.editor.pinOnMap")}</Label>
                  <PinLocationEditor
                    value={selAdSet.custom_locations}
                    store={p.client.storeLat != null && p.client.storeLng != null ? { lat: p.client.storeLat, lng: p.client.storeLng } : null}
                    onChange={(v) => setAdSet(sel.i, { custom_locations: v, locations: v.length ? selAdSet.locations.filter((l) => l.type !== "country") : selAdSet.locations })}
                  />
                </div>
                <div>
                  <Label hint={t("campaigns.editor.excludeLocationHint")}>{t("campaigns.editor.excludeLocation")}</Label>
                  <LocationPicker value={selAdSet.excluded_locations} allowEmpty onChange={(v) => setAdSet(sel.i, { excluded_locations: v })} />
                </div>
                <div>
                  <Label>{t("campaigns.editor.targetPeople")}</Label>
                  <Radio
                    value={selAdSet.location_types}
                    onChange={(v) => setAdSet(sel.i, { location_types: v })}
                    options={[
                      { value: "home_recent", label: t("campaigns.editor.homeRecent") },
                      { value: "home", label: t("campaigns.editor.home") },
                      { value: "recent", label: t("campaigns.editor.recent"), hint: t("campaigns.editor.recentHint") },
                    ]}
                  />
                </div>
                <div className="grid gap-4 @md:grid-cols-2">
                  <div>
                    <Label>{t("campaigns.editor.ageRange")}</Label>
                    <div className="flex items-center gap-2">
                      <AgeSelect value={selAdSet.age_min} onChange={(v) => setAdSet(sel.i, { age_min: v, age_max: Math.max(v, selAdSet.age_max) })} />
                      <span className="text-slate-400">–</span>
                      <AgeSelect value={selAdSet.age_max} onChange={(v) => setAdSet(sel.i, { age_max: v, age_min: Math.min(v, selAdSet.age_min) })} plus />
                    </div>
                  </div>
                  <div>
                    <Label>{t("campaigns.editor.genderLabel")}</Label>
                    <div className="flex gap-1 rounded-lg bg-slate-100 p-1">
                      {(["all", "male", "female"] as const).map((g) => (
                        <button
                          type="button"
                          key={g}
                          onClick={() => setAdSet(sel.i, { genders: g })}
                          className={`flex-1 rounded-md py-1 text-sm ${selAdSet.genders === g ? "bg-panel font-medium text-slate-900 shadow-sm" : "text-slate-500"}`}
                        >
                          {t(GENDER_KEYS[g])}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <div>
                  <Label hint={t("campaigns.editor.languageHint")}>{t("campaigns.editor.language")}</Label>
                  {/* Only show the reminder when a language is selected (used to separate foreign customers); regular clients don't need to see it. */}
                  {selAdSet.locales.length > 0 && <p className="mb-1 text-xs text-amber-600">{t("campaigns.editor.languageWarning")}</p>}
                  <LanguagePicker value={selAdSet.locales} options={LANGUAGES} onChange={(v) => setAdSet(sel.i, { locales: v as EditableAdSet["locales"] })} />
                </div>
                <div>
                  <Label hint={t("campaigns.editor.detailedHint")}>{t("campaigns.editor.detailedTargeting")}</Label>
                  <DetailedTargetingPicker value={selAdSet.detailed_targeting} onChange={(v) => setAdSet(sel.i, { detailed_targeting: v })} />
                  <p className="mt-1 text-xs text-slate-500">{t("campaigns.editor.detailedNote")}</p>
                </div>
                {(selAdSet.detailed_targeting.length > 0 || selAdSet.narrow_targeting.length > 0) && (
                  <div>
                    <Label hint={t("campaigns.editor.narrowHint")}>{t("campaigns.editor.narrow")}</Label>
                    <DetailedTargetingPicker value={selAdSet.narrow_targeting} onChange={(v) => setAdSet(sel.i, { narrow_targeting: v })} />
                  </div>
                )}
                <Toggle
                  checked={selAdSet.advantage_audience}
                  onChange={(v) => setAdSet(sel.i, { advantage_audience: v })}
                  label={t("campaigns.editor.advantageAudience")}
                  hint={t("campaigns.editor.advantageAudienceHint")}
                />
              </Section>
              <Section title={t("campaigns.editor.placements")}>
                <Radio
                  value={selAdSet.placements ?? "advantage"}
                  onChange={(v) => setAdSet(sel.i, { placements: v, positions: v === "manual" ? (selAdSet.positions ?? fromPlatforms(selAdSet.platforms)) : selAdSet.positions, devices: v === "manual" ? selAdSet.devices : "all" })}
                  options={[
                    { value: "advantage", label: t("campaigns.editor.placementsAdvantage"), hint: t("campaigns.editor.placementsAdvantageHint") },
                    { value: "manual", label: t("campaigns.editor.placementsManual") },
                  ]}
                />
                {selAdSet.placements === "manual" && (
                  <>
                    <PositionsPicker value={selAdSet.positions ?? fromPlatforms(selAdSet.platforms)} onChange={(v) => setAdSet(sel.i, { positions: v })} />
                    <div className="max-w-xs">
                      <Label>{t("campaigns.editor.devices")}</Label>
                      <select className={inputClass} value={selAdSet.devices} onChange={(e) => setAdSet(sel.i, { devices: e.target.value as EditableAdSet["devices"] })}>
                        <option value="all">{t("campaigns.editor.devicesAll")}</option>
                        <option value="mobile">{t("campaigns.editor.devicesMobile")}</option>
                        <option value="desktop">{t("campaigns.editor.devicesDesktop")}</option>
                      </select>
                    </div>
                  </>
                )}
              </Section>
              <Section title={t("campaigns.editor.hypothesisTitle")}>
                <TextArea rows={2} value={selAdSet.hypothesis} onChange={(v) => setAdSet(sel.i, { hypothesis: v })} placeholder={t("campaigns.editor.hypothesisPh")} />
              </Section>
            </>
          )}

          {selAd && sel.k === "ad" && (
            <>
              <Section title={t("campaigns.editor.adName")}>
                <TextInput value={selAd.name} onChange={(v) => setAd(sel.i, { name: v })} />
              </Section>
              <Section title={t("campaigns.editor.identity")} hint={p.pages.length > 1 ? t("campaigns.editor.appliesAllAds") : undefined}>
                {p.pages.length > 1 ? (
                  <div className="max-w-md">
                    <Label>{t("campaigns.editor.facebookPage")}</Label>
                    <select
                      className={inputClass}
                      value={plan.page_id ?? p.pages[0].id}
                      onChange={(e) => {
                        const v = e.target.value === p.pages[0].id ? null : e.target.value;
                        // Existing posts / forms belonging to the old Page can't be used for the new Page.
                        const used = plan.ads.some((a) => a.post_id || a.lead_form || a.video_id);
                        if (used && !confirm(t("campaigns.editor.confirmChangePage"))) return;
                        update((pl) => ({ ...pl, page_id: v, ads: pl.ads.map((a) => ({ ...a, post_id: null, post_preview: null, lead_form: null, video_id: null, video_preview: null })) }));
                      }}
                    >
                      {p.pages.map((x, i) => (
                        <option key={x.id} value={x.id}>{x.name}{i === 0 ? t("campaigns.editor.mainPage") : ""}</option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <p className="text-sm text-slate-700">{t("campaigns.editor.facebookPageLabel")} <b>{pageName}</b></p>
                )}
              </Section>
              <Section title={t("campaigns.editor.adSetup")}>
                <Radio
                  value={selAd.source}
                  onChange={(v) => setAd(sel.i, { source: v })}
                  options={[
                    { value: "new", label: t("campaigns.editor.createNewAd"), hint: t("campaigns.editor.createNewAdHint") },
                    { value: "existing", label: t("campaigns.editor.useExistingPost"), hint: t("campaigns.editor.useExistingPostHint") },
                  ]}
                />
              </Section>
              {selAd.source === "existing" ? (
                <Section title={t("campaigns.editor.post")} hint={t("campaigns.editor.postHint")}>
                  <PostPicker
                    key={`${sel.i}:${plan.page_id ?? ""}`} // each ad has its own post-picker state; changing the Page reloads it
                    clientId={p.clientId}
                    pageId={plan.page_id}
                    postId={selAd.post_id}
                    preview={selAd.post_preview}
                    onChange={(id, preview) => setAd(sel.i, { post_id: id, post_preview: preview, ...(!selAd.name.trim() || /^(Quảng cáo|Ad) \d+$/.test(selAd.name) ? { name: (preview?.message.split("\n")[0] ?? t("campaigns.editor.existingPost")).slice(0, 60) } : {}) })}
                  />
                </Section>
              ) : (
              <Section title={t("campaigns.editor.adContent")}>
                <Radio
                  value={selAd.format === "carousel" ? "carousel" : selAd.video_id || selAd.video_preview ? "video" : "image"}
                  onChange={(v) =>
                    setAd(sel.i, (a) =>
                      v === "carousel"
                        ? // The existing single image becomes the first card.
                          { format: "carousel", video_id: null, video_preview: null, ...(!a.cards.length && a.image_path && !a.video_id ? { cards: [{ image_path: a.image_path, headline: "", description: "", link_url: null }] } : {}) }
                        : v === "image"
                          ? { format: "single", video_id: null, video_preview: null, ...(!a.image_path && a.cards[0]?.image_path ? { image_path: a.cards[0].image_path } : {}) }
                          : { format: "single", video_preview: a.video_preview ?? { title: "", picture: null, length: null, permalink: "" } },
                    )
                  }
                  options={[
                    { value: "image", label: t("campaigns.editor.oneImage"), hint: t("campaigns.editor.oneImageHint") },
                    {
                      value: "carousel",
                      label: t("campaigns.editor.carousel"),
                      hint: carouselBlockReason(plan.result_type, t) ?? t("campaigns.editor.carouselHint", { min: CAROUSEL_MIN, max: CAROUSEL_MAX }),
                    },
                    { value: "video", label: t("campaigns.editor.existingVideo"), hint: t("campaigns.editor.existingVideoHint") },
                  ]}
                />
                {selAd.format === "carousel" ? (
                  <>
                    {carouselBlockReason(plan.result_type, t) && <p className="rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700">{t("campaigns.editor.carouselBlocked", { reason: carouselBlockReason(plan.result_type, t) ?? "" })}</p>}
                    <CarouselEditor
                      key={`carousel:${sel.i}`}
                      clientId={p.clientId}
                      draftId={p.draftId}
                      pageId={plan.page_id}
                      ad={selAd}
                      needsLink={plan.result_type === "link_clicks" || plan.result_type === "reach"}
                      onChange={(patch) => setAd(sel.i, patch)}
                    />
                  </>
                ) : selAd.video_id || selAd.video_preview ? (
                  <>
                    <div>
                      <Label hint={t("campaigns.editor.videoHint")}>{t("campaigns.editor.video")}</Label>
                      <VideoPicker
                        key={`${sel.i}:${plan.page_id ?? ""}`}
                        clientId={p.clientId}
                        pageId={plan.page_id}
                        videoId={selAd.video_id}
                        preview={selAd.video_id ? selAd.video_preview : null}
                        onChange={(id, preview, desc) =>
                          setAd(sel.i, { video_id: id, video_preview: preview, ...(!selAd.primary_text.trim() && desc ? { primary_text: desc } : {}) })
                        }
                      />
                    </div>
                    <div>
                      <Label hint={t("campaigns.editor.coverHint")}>{t("campaigns.editor.cover")}</Label>
                      <ImageUpload key={`cover:${sel.i}`} draftId={p.draftId} path={selAd.image_path ?? null} onChange={(v) => setAd(sel.i, { image_path: v })} />
                    </div>
                  </>
                ) : (
                  <div>
                    <Label hint={t("campaigns.editor.mediaHint")}>{t("campaigns.editor.mediaFile")}</Label>
                    <ImageUpload key={sel.i} draftId={p.draftId} path={selAd.image_path ?? null} onChange={(v) => setAd(sel.i, { image_path: v })} />
                  </div>
                )}
                <div>
                  <Label hint={t("campaigns.editor.forDesigner")}>{t("campaigns.editor.creativeBrief")}</Label>
                  <TextArea rows={2} value={selAd.creative_brief} onChange={(v) => setAd(sel.i, { creative_brief: v })} />
                </div>
                <div>
                  <Label hint={t("campaigns.editor.chars", { count: selAd.primary_text.length })}>{t("campaigns.editor.primaryText")}</Label>
                  <TextArea rows={6} value={selAd.primary_text} onChange={(v) => setAd(sel.i, { primary_text: v })} placeholder={t("campaigns.editor.primaryTextPh")} />
                </div>
                <div>
                  <Label hint={isCarousel(selAd) ? t("campaigns.editor.headlineCarouselHint") : undefined}>{t("campaigns.editor.headline")}</Label>
                  <TextInput value={selAd.headline} onChange={(v) => setAd(sel.i, { headline: v })} maxHint={40} />
                </div>
                <div>
                  <Label hint={t("campaigns.editor.optional")}>{t("campaigns.editor.description")}</Label>
                  <TextInput value={selAd.description} onChange={(v) => setAd(sel.i, { description: v })} />
                </div>
                {plan.result_type !== "engagement" && plan.result_type !== "video_views" && (
                  <div className="max-w-xs">
                    <Label>{t("campaigns.editor.cta")}</Label>
                    <select
                      className={inputClass}
                      value={selAd.call_to_action}
                      disabled={adCtas.length < 2}
                      onChange={(e) => setAd(sel.i, { call_to_action: e.target.value as EditableAd["call_to_action"] })}
                    >
                      {adCtas.map((c) => (
                        <option key={c} value={c}>{ctaLabel(t, c)}</option>
                      ))}
                    </select>
                  </div>
                )}
              </Section>
              )}
              {leadForm && (
                <Section title={t("campaigns.editor.instantForm")} hint={t("campaigns.editor.instantFormSectionHint")}>
                  <LeadFormPicker key={`${sel.i}:${plan.page_id ?? ""}`} clientId={p.clientId} pageId={plan.page_id} value={selAd.lead_form} onChange={(v) => setAd(sel.i, { lead_form: v })} />
                </Section>
              )}
              {chat && selAd.source === "new" && (
                <Section title={t("campaigns.editor.messageTemplate")} hint={t("campaigns.editor.messageTemplateHint")}>
                  <WelcomeEditor value={selAd.welcome} onChange={(v) => setAd(sel.i, { welcome: v })} />
                </Section>
              )}
              <Section title={t("campaigns.editor.destination")}>
                {plan.result_type === "messages" ? (
                  <p className="text-sm text-slate-700">{t("campaigns.editor.destMessages", { channel: t(MESSAGE_DESTINATION_OPTS.find((o) => o.value === (selAdSetOfAd?.message_destination ?? "messenger"))?.label ?? "campaigns.adsOptions.dest.messenger") })}</p>
                ) : plan.result_type === "leads" ? (
                  <p className="text-sm text-slate-700">{leadForm ? t("campaigns.editor.destLeadForm") : t("campaigns.editor.destLeadMessenger")}</p>
                ) : plan.result_type === "page_likes" ? (
                  <p className="text-sm text-slate-700">{t("campaigns.editor.destPageLikes")}</p>
                ) : plan.result_type === "engagement" ? (
                  <p className="text-sm text-slate-700">{t("campaigns.editor.destEngagement")}</p>
                ) : plan.result_type === "video_views" ? (
                  <p className="text-sm text-slate-700">{t("campaigns.editor.destVideo")}</p>
                ) : selAd.source === "existing" ? (
                  <p className="text-sm text-slate-700">{t("campaigns.editor.destExisting")}</p>
                ) : plan.result_type === "profile_visits" ? (
                  <p className="text-sm text-slate-700">{t("campaigns.editor.destProfile")}</p>
                ) : (
                  <div>
                    <Label>{t("campaigns.editor.websiteUrl")}</Label>
                    <TextInput value={selAd.link_url ?? ""} onChange={(v) => setAd(sel.i, { link_url: v || null })} placeholder="https://" />
                  </div>
                )}
              </Section>
            </>
          )}
        </fieldset>

        {/* Right column: preview / summary / checks */}
        <aside className="min-w-0 space-y-4 self-start @2xl:col-start-2 @5xl:sticky @5xl:top-20 @5xl:col-start-3 @5xl:row-start-1">
          {selAd && <AdPreview ad={selAd} pageName={pageName} isMessages={chat} noCta={plan.result_type === "engagement" || plan.result_type === "video_views"} />}
          {selAd && chat && selAd.welcome && <WelcomePreview value={selAd.welcome} pageName={pageName} />}
          {selAdSet && (
            <AudienceSummary s={selAdSet}>
              <AudienceEstimate
                key={sel.k === "adset" ? sel.i : -1} // switching ad sets hides the previous ad set's estimate
                clientId={p.clientId}
                resultType={plan.result_type}
                adSet={{ ...selAdSet, daily_budget: plan.budget_mode === "CBO" ? Math.round((plan.campaign_daily_budget ?? 0) / Math.max(1, plan.ad_sets.length)) : selAdSet.daily_budget }}
                currency={cur}
              />
            </AudienceSummary>
          )}
          {selAd && !readOnly && (
            <AdPolicyPanel
              ad={selAd}
              entry={p.policy?.results[adContentKey(selAd)]}
              sameCount={plan.ads.filter((a) => adContentKey(a) === adContentKey(selAd)).length}
              checking={checking}
              readOnly={readOnly || revising}
              onApply={(rw) => sel.k === "ad" && applyRewrite(sel.i, rw)}
              onCheck={() => checkPolicy()}
            />
          )}
          {sel.k === "campaign" && <ReviewPanel errors={review.errors} warnings={review.warnings} />}
          {sel.k === "campaign" && !readOnly && (
            <DraftPolicyPanel plan={plan} policy={p.policy} gate={gate} checking={checking} failed={policyFailed} readOnly={revising} onCheck={checkPolicy} onSelect={(i) => setSel({ k: "ad", i })} />
          )}
          {sel.k !== "campaign" && review.errors.length > 0 && (
            <button type="button" onClick={() => setSel({ k: "campaign" })} className="w-full rounded-lg border border-rose-200 bg-rose-50 p-3 text-left text-sm text-rose-700">
              {t("campaigns.editor.errorsBeforePublish", { count: review.errors.length })}
            </button>
          )}
        </aside>
      </div>
    </div>
  );
}

/** Keep the plan valid after each edit: the CTA button and performance goal must be in Meta's allowed list. */
export function normalize(pl: EditablePlan): EditablePlan {
  let changed = false;
  const ad_sets = pl.ad_sets.map((s) => {
    if (s.performance_goal && !performanceGoals(pl.result_type, s).some((g) => g.value === s.performance_goal)) {
      changed = true;
      return { ...s, performance_goal: null };
    }
    return s;
  });
  const ads = pl.ads.map((a) => {
    const allowed = ctasFor(pl.result_type, ad_sets[a.ad_set_index]);
    if (allowed.includes(a.call_to_action)) return a;
    changed = true;
    return { ...a, call_to_action: allowed[0] };
  });
  return changed ? { ...pl, ad_sets, ads } : pl;
}

/** Old drafts only stored platforms: convert to the default detailed placements of those platforms. */
function fromPlatforms(platforms?: string[]): Positions {
  if (!platforms?.length) return DEFAULT_POSITIONS;
  const out = { facebook: [], instagram: [], messenger: [], audience_network: [] } as Positions;
  for (const g of POSITION_OPTS) if (platforms.includes(g.platform)) out[g.platform] = DEFAULT_POSITIONS[g.platform].length ? [...DEFAULT_POSITIONS[g.platform]] : g.items.map((i) => i.value);
  return out;
}

function TreeRow({
  active,
  icon,
  label,
  sub,
  onClick,
  actions,
}: {
  active: boolean;
  icon: string;
  label: string;
  sub?: string;
  onClick: () => void;
  actions?: false | { label: string; onClick: () => void }[];
}) {
  return (
    <div className={`group flex items-center gap-1 rounded-md ${active ? "bg-indigo-50" : "hover:bg-slate-50"}`}>
      <button type="button" onClick={onClick} title={label} className="flex min-w-0 flex-1 items-start gap-2 px-2 py-1.5 text-left">
        <span>{icon}</span>
        <span className="min-w-0">
          <span className={`block truncate ${active ? "font-medium text-indigo-700" : "text-slate-800"}`}>{label}</span>
          {sub && <span className="block truncate text-[11px] text-slate-400">{sub}</span>}
        </span>
      </button>
      {actions && actions.length > 0 && (
        <div className="flex shrink-0 gap-0.5 pr-1 md:hidden md:group-hover:flex">
          {actions.map((a) => (
            <button key={a.label} type="button" onClick={a.onClick} className="rounded px-1.5 py-0.5 text-[11px] text-slate-500 hover:bg-panel hover:text-slate-900">
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function AgeSelect({ value, onChange, plus }: { value: number; onChange: (v: number) => void; plus?: boolean }) {
  return (
    <select className={inputClass} value={value} onChange={(e) => onChange(Number(e.target.value))}>
      {Array.from({ length: 48 }, (_, i) => i + 18).map((a) => (
        <option key={a} value={a}>{a === 65 && plus ? "65+" : a}</option>
      ))}
    </select>
  );
}

export function ImageUpload({ draftId, path, onChange }: { draftId: string; path: string | null; onChange: (v: string | null) => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex items-start gap-3">
      {path ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`/api/uploads/${path}`} alt="" className="size-24 rounded-lg border border-slate-200 object-cover" />
      ) : (
        <div className="grid size-24 place-items-center rounded-lg border border-dashed border-slate-300 text-2xl text-slate-300">🖼</div>
      )}
      <div className="space-y-2">
        <label className={`${btnClass("secondary")} cursor-pointer`}>
          {busy && <Spinner />}
          {path ? t("campaigns.editor.changeImage") : t("campaigns.editor.uploadImage")}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              setBusy(true);
              setError(null);
              const fd = new FormData();
              fd.set("file", file);
              const res = await uploadImageAction(draftId, fd);
              setBusy(false);
              if (res.ok) onChange(res.path);
              else setError(res.error);
              e.target.value = "";
            }}
          />
        </label>
        {path && (
          <button type="button" className="block text-xs text-slate-500 hover:text-rose-600" onClick={() => onChange(null)}>
            {t("campaigns.editor.removeImage")}
          </button>
        )}
        {error && <p className="text-xs text-rose-600">{error}</p>}
      </div>
    </div>
  );
}

function AudienceSummary({ s, children }: { s: EditableAdSet; children?: ReactNode }) {
  const t = useT();
  return (
    <div className="rounded-xl border border-slate-200 bg-panel p-4 text-sm">
      <h4 className="mb-2 font-semibold text-slate-900">{t("campaigns.editor.audienceDefinition")}</h4>
      <dl className="space-y-1.5 text-slate-700">
        <div>
          <dt className="inline text-slate-500">{t("campaigns.editor.sumLocation")} </dt>
          <dd className="inline">
            {[...s.locations.map((l) => l.name + (l.type === "city" ? ` (+${Math.max(17, l.radius_km ?? 17)}km)` : "")), ...s.custom_locations.map((c) => `📌 ${c.label} (+${c.radius_km}km)`)].join(", ")}
          </dd>
        </div>
        <div><dt className="inline text-slate-500">{t("campaigns.editor.sumPeople")} </dt><dd className="inline">{t(LOCATION_TYPE_KEYS[s.location_types])}</dd></div>
        <div><dt className="inline text-slate-500">{t("campaigns.editor.sumLanguage")} </dt><dd className="inline">{s.locales.length ? s.locales.map((c) => languageLabel(c, t)).join(", ") : t("campaigns.editor.gender.all")}</dd></div>
        <div><dt className="inline text-slate-500">{t("campaigns.editor.sumAge")} </dt><dd className="inline">{s.age_min} – {s.age_max === 65 ? "65+" : s.age_max}</dd></div>
        <div><dt className="inline text-slate-500">{t("campaigns.editor.sumGender")} </dt><dd className="inline">{t(GENDER_KEYS[s.genders])}</dd></div>
        <div>
          <dt className="inline text-slate-500">{t("campaigns.editor.sumDetails")} </dt>
          <dd className="inline">{s.detailed_targeting.length ? s.detailed_targeting.map((d) => d.name).join(t("campaigns.editor.or")) : t("campaigns.editor.broad")}</dd>
        </div>
        {s.narrow_targeting.length > 0 && <div><dt className="inline text-slate-500">{t("campaigns.editor.sumAnd")} </dt><dd className="inline">{s.narrow_targeting.map((d) => d.name).join(t("campaigns.editor.or"))}</dd></div>}
        {s.custom_audiences.length > 0 && <div><dt className="inline text-slate-500">{t("campaigns.editor.sumCustom")} </dt><dd className="inline">{s.custom_audiences.map((a) => a.name).join(", ")}</dd></div>}
        {s.excluded_custom_audiences.length > 0 && <div><dt className="inline text-slate-500">{t("campaigns.editor.sumExcludeAudiences")} </dt><dd className="inline">{s.excluded_custom_audiences.map((a) => a.name).join(", ")}</dd></div>}
        {s.excluded_locations.length > 0 && <div><dt className="inline text-slate-500">{t("campaigns.editor.sumExcludeLocations")} </dt><dd className="inline">{s.excluded_locations.map((l) => l.name).join(", ")}</dd></div>}
        <div><dt className="inline text-slate-500">Advantage+: </dt><dd className="inline">{s.advantage_audience ? t("campaigns.editor.on") : t("campaigns.editor.off")}</dd></div>
        <div>
          <dt className="inline text-slate-500">{t("campaigns.editor.sumPlacements")} </dt>
          <dd className="inline">
            {s.placements !== "manual"
              ? "Advantage+"
              : s.positions
                ? POSITION_OPTS.filter((g) => s.positions![g.platform].length).map((g) => `${g.label} (${s.positions![g.platform].length})`).join(", ")
                : (s.platforms ?? []).join(", ")}
            {s.placements === "manual" && s.devices !== "all" && ` · ${s.devices === "mobile" ? t("campaigns.editor.mobileOnlyLower") : t("campaigns.editor.desktopOnlyLower")}`}
          </dd>
        </div>
      </dl>
      {children}
    </div>
  );
}

function ReviewPanel({ errors, warnings }: { errors: string[]; warnings: string[] }) {
  const t = useT();
  return (
    <div className="rounded-xl border border-slate-200 bg-panel p-4 text-sm">
      <h4 className="mb-2 font-semibold text-slate-900">{t("campaigns.editor.reviewTitle")}</h4>
      {!errors.length && !warnings.length && <p className="text-emerald-700">{t("campaigns.editor.reviewReady")}</p>}
      {errors.length > 0 && (
        <ul className="mb-2 space-y-1">
          {errors.map((e, i) => <li key={i} className="text-rose-700">✕ {e}</li>)}
        </ul>
      )}
      {warnings.length > 0 && (
        <ul className="space-y-1">
          {warnings.map((w, i) => <li key={i} className="text-amber-700">! {w}</li>)}
        </ul>
      )}
    </div>
  );
}
