"use client";

import { useRef, useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, BookOpen, Check, ChevronDown, Loader2, MapPin, MessageSquare, Newspaper, RotateCcw, Sparkles, Target, Users, Wallet } from "lucide-react";
import { draftProposalAction, proposeCampaignsAction } from "@/app/actions";
import type { CampaignIdeas } from "@/lib/ai/schemas";
import { money } from "@/lib/format";
import { btnClass, inputClass } from "./ui";
import { Spinner } from "./action-button";
import { AutoRefresh } from "./targeting/controls";
import { useT } from "@/i18n/client";
import type { MessageKey, T } from "@/i18n/translate";

const GOAL_KEYS = {
  messages: "campaigns.proposalsUi.goal.messages",
  engagement: "campaigns.proposalsUi.goal.engagement",
  video_views: "campaigns.proposalsUi.goal.video_views",
  profile_visits: "campaigns.proposalsUi.goal.profile_visits",
  link_clicks: "campaigns.proposalsUi.goal.link_clicks",
  reach: "campaigns.proposalsUi.goal.reach",
  leads: "campaigns.proposalsUi.goal.leads",
  page_likes: "campaigns.proposalsUi.goal.page_likes",
  purchases: "campaigns.proposalsUi.goal.purchases",
} as const;
const goalLabel = (t: T, g: string) => (g in GOAL_KEYS ? t(GOAL_KEYS[g as keyof typeof GOAL_KEYS]) : g);
const GOAL_OPTIONS = ["messages", "leads", "engagement", "link_clicks", "video_views", "profile_visits", "reach", "page_likes"];
const PRIO: Record<string, { label: MessageKey; cls: string }> = {
  high: { label: "campaigns.proposalsUi.prioHigh", cls: "bg-indigo-600 text-white" },
  medium: { label: "campaigns.proposalsUi.prioMedium", cls: "bg-amber-50 text-amber-700" },
  low: { label: "campaigns.proposalsUi.prioLow", cls: "bg-slate-100 text-slate-600" },
};
/** Quick suggestions for the "Muốn chạy gì?" (what do you want to run?) box: click to append a sample sentence, then keep editing in the box. */
const QUICK = [
  { label: "campaigns.proposalsUi.quick.rerunLabel", text: "campaigns.proposalsUi.quick.rerunText" },
  { label: "campaigns.proposalsUi.quick.pushLabel", text: "campaigns.proposalsUi.quick.pushText" },
  { label: "campaigns.proposalsUi.quick.postLabel", text: "campaigns.proposalsUi.quick.postText" },
  { label: "campaigns.proposalsUi.quick.newAudienceLabel", text: "campaigns.proposalsUi.quick.newAudienceText" },
] as const;
const STEP_KEYS = ["campaigns.proposalsUi.step1", "campaigns.proposalsUi.step2", "campaigns.proposalsUi.step3"] as const;

type TestModeInfo = { mode: "new" | "learning" | "proven"; label: string; reason: string };
type Brief = { text: string; dailyBudget: number | null; goal: string | null };
type Proposal = {
  id: string;
  status: string;
  report: CampaignIdeas & { test_mode?: TestModeInfo; brief?: Brief };
  drafts: { id: string; name: string }[];
  createdAt: string;
  model: string;
} | null;
type Data = { audience: boolean; docs: number; posts: number };

/**
 * Ask Claude to plan a campaign: (1) enter a request (optional) → Claude proposes ideas in the background
 * → (2) pick an idea, answer questions → Claude drafts in the background → (3) review the draft, then Publish (PAUSED).
 */
export function CampaignProposals({
  clientId,
  proposal,
  currency,
  defaultGoal,
  maxDailyBudget,
  data,
  proposing,
  drafting,
}: {
  clientId: string;
  proposal: Proposal;
  currency: string;
  defaultGoal: string;
  maxDailyBudget: number | null;
  data: Data;
  /** Background job "Claude proposes campaigns" waiting / running. */
  proposing: boolean;
  /** Background job "Draft campaign from proposal" waiting / running. */
  drafting: boolean;
}) {
  const t = useT();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(!proposal);
  const [chosen, setChosen] = useState<number[]>(() => (proposal ? proposal.report.ideas.flatMap((i, idx) => (i.priority === "high" ? [idx] : [])) : []));
  const [answers, setAnswers] = useState<Record<string, string>>(() => Object.fromEntries((proposal?.report.questions ?? []).map((q) => [q.id, q.suggested])));
  const router = useRouter();

  const propose = (f: FormData) => {
    const brief = {
      text: String(f.get("text") ?? "").trim(),
      dailyBudget: Number(String(f.get("dailyBudget") ?? "").replace(/[.,\s]/g, "")) || null,
      goal: String(f.get("goal") ?? "") || null,
    };
    if (!brief.text && !data.audience) return setError(t("campaigns.proposalsUi.noPersona"));
    start(async () => {
      setError(null);
      const r = await proposeCampaignsAction(clientId, brief);
      if (!r.ok) setError(r.error);
      else {
        setShowForm(false);
        router.refresh();
      }
    });
  };
  const draft = () =>
    start(async () => {
      setError(null);
      const r = await draftProposalAction(proposal!.id, chosen, answers);
      if (!r.ok) setError(r.error);
      else router.refresh();
    });

  const used = !!proposal && proposal.status === "used" && proposal.drafts.length > 0;
  const step = proposing || !proposal || showForm ? 1 : used || drafting ? 3 : 2;
  const busy = proposing || drafting;

  return (
    // Long post links (in the request, summary) must wrap instead of widening the card on mobile.
    <div className="@container min-w-0 space-y-5 [overflow-wrap:anywhere]">
      <AutoRefresh active={busy} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-violet-50 text-violet-700">
            <Sparkles className="size-5" />
          </span>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-ink">{t("campaigns.proposalsUi.title")}</h2>
            <p className="mt-0.5 text-sm text-mut">{t("campaigns.proposalsUi.subtitle")}</p>
          </div>
        </div>
        {proposal && !showForm && !busy && (
          <button type="button" className={btnClass("secondary")} onClick={() => setShowForm(true)}>
            <RotateCcw /> {used ? t("campaigns.proposalsUi.newCampaign") : t("campaigns.proposalsUi.proposeAgain")}
          </button>
        )}
      </div>

      <Stepper step={step} />

      {proposing ? (
        <Working
          title={t("campaigns.proposalsUi.proposingTitle")}
          items={[t("campaigns.proposalsUi.proposingItem1"), t("campaigns.proposalsUi.proposingItem2"), t("campaigns.proposalsUi.proposingItem3")]}
          note={t("campaigns.proposalsUi.proposingNote")}
        />
      ) : (
        showForm && (
          <BriefForm
            clientId={clientId}
            brief={proposal?.report.brief}
            currency={currency}
            defaultGoal={defaultGoal}
            maxDailyBudget={maxDailyBudget}
            data={data}
            pending={pending}
            disabled={pending || busy}
            onSubmit={propose}
            onCancel={proposal ? () => setShowForm(false) : undefined}
          />
        )
      )}

      {proposal && !showForm && !proposing && (
        <ProposalView
          clientId={clientId}
          proposal={proposal}
          currency={currency}
          chosen={chosen}
          setChosen={setChosen}
          answers={answers}
          setAnswers={setAnswers}
          drafting={drafting}
          footer={
            !used && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-line bg-soft px-4 py-3">
                <div className="min-w-0 flex-1 text-sm">
                  {chosen.length ? (
                    <>
                      <span className="font-medium text-ink">{t("campaigns.proposalsUi.chosenCount", { count: chosen.length })}</span>
                      <span className="text-mut"> · {t("campaigns.proposalsUi.totalPerDay", { amount: money(chosen.reduce((a, i) => a + (proposal.report.ideas[i]?.daily_budget ?? 0), 0), currency) })}</span>
                    </>
                  ) : (
                    <span className="text-mut">{t("campaigns.proposalsUi.clickToChoose")}</span>
                  )}
                  <p className="text-xs text-mut2">{t("campaigns.proposalsUi.draftNote")}</p>
                </div>
                <button type="button" className={btnClass("primary")} disabled={pending || busy || !chosen.length} onClick={draft}>
                  {pending ? <Spinner /> : <Sparkles />} {t("campaigns.proposalsUi.draftBtn", { count: chosen.length || "" })}
                </button>
              </div>
            )
          }
        />
      )}
      {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
    </div>
  );
}

function Stepper({ step }: { step: number }) {
  const t = useT();
  return (
    <ol className="flex items-center gap-2 text-xs">
      {STEP_KEYS.map((key, i) => {
        const n = i + 1;
        const label = t(key);
        const state = step === n ? "now" : step > n ? "done" : "todo";
        return (
          <li key={label} className={`flex min-w-0 items-center gap-2 ${n < STEP_KEYS.length ? "flex-1" : ""}`}>
            <span
              className={`grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold ${
                state === "now" ? "bg-indigo-600 text-white" : state === "done" ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-mut"
              }`}
            >
              {state === "done" ? <Check className="size-3.5" /> : n}
            </span>
            {/* On mobile only show the label of the current step, to keep it compact */}
            <span className={`truncate ${state === "now" ? "font-semibold text-ink" : "hidden text-mut @xl:inline"}`}>{label}</span>
            {n < STEP_KEYS.length && <span className={`h-px min-w-4 flex-1 ${state === "done" ? "bg-emerald-300" : "bg-line"}`} />}
          </li>
        );
      })}
    </ol>
  );
}

function Working({ title, items, note }: { title: string; items: string[]; note: string }) {
  return (
    <div className="rounded-xl border border-violet-200 bg-violet-50/60 p-4">
      <p className="flex items-center gap-2 text-sm font-medium text-violet-900">
        <Loader2 className="size-4 animate-spin" /> {title}
      </p>
      <ul className="mt-2 space-y-1 pl-6 text-sm text-violet-800">
        {items.map((item) => (
          <li key={item} className="list-disc">
            {item}
          </li>
        ))}
      </ul>
      <p className="mt-2 pl-6 text-xs text-violet-700">{note}</p>
    </div>
  );
}

function BriefForm({
  clientId,
  brief,
  currency,
  defaultGoal,
  maxDailyBudget,
  data,
  pending,
  disabled,
  onSubmit,
  onCancel,
}: {
  clientId: string;
  brief?: Brief;
  currency: string;
  defaultGoal: string;
  maxDailyBudget: number | null;
  data: Data;
  pending: boolean;
  disabled: boolean;
  onSubmit: (f: FormData) => void;
  onCancel?: () => void;
}) {
  const t = useT();
  const [text, setText] = useState(brief?.text ?? "");
  const ref = useRef<HTMLTextAreaElement>(null);
  const addQuick = (snippet: string) => {
    const next = text.trim() ? `${text.trim()}\n${snippet}` : snippet;
    setText(next);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(next.length, next.length);
    });
  };
  const unit = currency === "VND" ? t("campaigns.proposalsUi.dong") : currency;
  const sources: { icon: ReactNode; label: string; ok: boolean; href?: string; fix?: string }[] = [
    { icon: <Users />, label: data.audience ? t("campaigns.proposalsUi.srcPersona") : t("campaigns.proposalsUi.srcNoPersona"), ok: data.audience, href: `/clients/${clientId}/audience`, fix: t("campaigns.proposalsUi.srcAnalyse") },
    { icon: <BookOpen />, label: data.docs ? t("campaigns.proposalsUi.srcDocs", { count: data.docs }) : t("campaigns.proposalsUi.srcNoDocs"), ok: !!data.docs, href: `/clients/${clientId}/knowledge`, fix: t("campaigns.proposalsUi.srcAddDocs") },
    { icon: <Newspaper />, label: data.posts ? t("campaigns.proposalsUi.srcPosts", { count: data.posts }) : t("campaigns.proposalsUi.srcNoPosts"), ok: !!data.posts },
    { icon: <MessageSquare />, label: t("campaigns.proposalsUi.srcMessages"), ok: true },
  ];

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(new FormData(e.currentTarget));
      }}
    >
      <div className="rounded-xl border border-line bg-panel focus-within:border-indigo-500 focus-within:ring-2 focus-within:ring-indigo-100">
        <label htmlFor="brief-text" className="block px-4 pt-3 text-sm font-medium text-ink">
          {t("campaigns.proposalsUi.whatToRun")} <span className="font-normal text-mut">{t("campaigns.proposalsUi.optional")}</span>
        </label>
        <textarea
          ref={ref}
          id="brief-text"
          name="text"
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="block w-full resize-y bg-transparent px-4 py-2 text-sm text-ink placeholder:text-mut2 focus:outline-none"
          placeholder={t("campaigns.proposalsUi.briefPlaceholder")}
        />
        <div className="flex flex-wrap gap-1.5 border-t border-line px-3 py-2">
          {QUICK.map((q) => (
            <button
              key={q.label}
              type="button"
              onClick={() => addQuick(t(q.text))}
              className="rounded-full border border-line bg-soft px-2.5 py-1 text-xs text-ink2 transition hover:border-indigo-300 hover:text-indigo-700"
            >
              + {t(q.label)}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-3 @lg:grid-cols-2">
        <label className="block">
          <span className="mb-1 flex items-center gap-1.5 text-sm font-medium text-ink2">
            <Wallet className="size-4 text-mut" /> {t("campaigns.proposalsUi.budgetPerDay")}
          </span>
          <div className="relative">
            <input
              name="dailyBudget"
              inputMode="numeric"
              defaultValue={brief?.dailyBudget ?? ""}
              className={`${inputClass} pr-16`}
              placeholder={t("campaigns.proposalsUi.budgetPlaceholder")}
            />
            <span className="pointer-events-none absolute inset-y-0 right-3 grid place-items-center text-xs text-mut">{t("campaigns.proposalsUi.unitPerDay", { unit })}</span>
          </div>
          {maxDailyBudget ? <span className="mt-1 block text-xs text-mut">{t("campaigns.proposalsUi.clientCap", { amount: money(maxDailyBudget, currency) })}</span> : null}
        </label>
        <label className="block">
          <span className="mb-1 flex items-center gap-1.5 text-sm font-medium text-ink2">
            <Target className="size-4 text-mut" /> {t("campaigns.proposalsUi.objective")}
          </span>
          <select name="goal" defaultValue={brief?.goal ?? ""} className={inputClass}>
            <option value="">{t("campaigns.proposalsUi.claudeChooses", { goal: goalLabel(t, defaultGoal) })}</option>
            {GOAL_OPTIONS.map((g) => (
              <option key={g} value={g}>
                {goalLabel(t, g)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div>
        <p className="mb-1.5 text-xs font-medium text-mut">{t("campaigns.proposalsUi.willRead")}</p>
        <ul className="flex flex-wrap gap-1.5">
          {sources.map((s) => (
            <li
              key={s.label}
              className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs [&_svg]:size-3.5 ${s.ok ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"}`}
            >
              {s.icon}
              {s.label}
              {!s.ok && s.href && (
                <Link href={s.href} className="font-medium underline">
                  {s.fix}
                </Link>
              )}
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button className={`${btnClass("primary")} h-9 px-4`} disabled={disabled}>
          {pending ? <Spinner /> : <Sparkles />} {t("campaigns.proposalsUi.proposeBtn")}
        </button>
        <span className="text-xs text-mut">{t("campaigns.proposalsUi.runsInBackground")}</span>
        {onCancel && (
          <button type="button" className={`${btnClass("ghost")} ml-auto`} onClick={onCancel}>
            {t("campaigns.proposalsUi.viewOld")}
          </button>
        )}
      </div>
    </form>
  );
}

function ProposalView({
  clientId,
  proposal,
  currency,
  chosen,
  setChosen,
  answers,
  setAnswers,
  drafting,
  footer,
}: {
  clientId: string;
  proposal: NonNullable<Proposal>;
  currency: string;
  chosen: number[];
  setChosen: (v: number[]) => void;
  answers: Record<string, string>;
  setAnswers: (v: Record<string, string>) => void;
  drafting: boolean;
  footer: ReactNode;
}) {
  const t = useT();
  const { report } = proposal;
  const used = proposal.status === "used" && proposal.drafts.length > 0;
  const draftsDeleted = proposal.status === "used" && !proposal.drafts.length;
  const locked = used || drafting;
  const toggle = (i: number) => !locked && setChosen(chosen.includes(i) ? chosen.filter((x) => x !== i) : [...chosen, i]);

  const body = (
    <div className="space-y-4">
      <div className="rounded-xl bg-soft p-4">
        {report.brief?.text && (
          <p className="mb-2 border-l-2 border-indigo-300 pl-2 text-xs text-mut">
            {t("campaigns.proposalsUi.youAsked")} <span className="text-ink2">{report.brief.text}</span>
          </p>
        )}
        <p className="flex items-center gap-1.5 text-xs font-medium text-violet-700">
          <Sparkles className="size-3.5" /> {t("campaigns.proposalsUi.claudeComments")}
        </p>
        <p className="mt-1 text-sm leading-relaxed text-ink2">{report.summary}</p>
        {report.test_mode && <TestMode info={report.test_mode} />}
      </div>

      <div>
        {!locked && <p className="mb-2 text-sm font-medium text-ink">{t("campaigns.proposalsUi.chooseDirection")}</p>}
        <div className="grid gap-3 @3xl:grid-cols-2 @6xl:grid-cols-3">
          {report.ideas.map((idea, i) => (
            <IdeaCard key={i} idea={idea} currency={currency} on={chosen.includes(i)} locked={locked} onToggle={() => toggle(i)} />
          ))}
        </div>
      </div>

      {report.questions.length > 0 && !used && <Questions questions={report.questions} answers={answers} setAnswers={setAnswers} disabled={drafting} />}
      {footer}
    </div>
  );

  return (
    <>
      {used && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
          <p className="flex items-center gap-2 font-medium text-emerald-900">
            <Check className="size-4" /> {t("campaigns.proposalsUi.draftsDone", { count: proposal.drafts.length })}
          </p>
          <p className="mt-0.5 text-sm text-emerald-800">{t("campaigns.proposalsUi.draftsDoneHint")}</p>
          <ul className="mt-3 space-y-2">
            {proposal.drafts.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-200 bg-panel px-3 py-2">
                <span className="min-w-0 text-sm font-medium text-ink">{d.name}</span>
                <Link href={`/clients/${clientId}/drafts/${d.id}`} className={btnClass("primary")}>
                  {t("campaigns.proposalsUi.openReview")} <ArrowRight />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      {draftsDeleted && !drafting && (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{t("campaigns.proposalsUi.draftsDeleted")}</p>
      )}
      {drafting && (
        <Working
          title={t("campaigns.proposalsUi.draftingTitle")}
          items={[t("campaigns.proposalsUi.draftingItem1"), t("campaigns.proposalsUi.draftingItem2"), t("campaigns.proposalsUi.draftingItem3")]}
          note={t("campaigns.proposalsUi.draftingNote")}
        />
      )}
      {used ? (
        <details className="group rounded-xl border border-line">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-sm font-medium text-ink2 [&::-webkit-details-marker]:hidden">
            {t("campaigns.proposalsUi.reviewProposal", { count: report.ideas.length })}
            <ChevronDown className="size-4 text-mut transition group-open:rotate-180" />
          </summary>
          <div className="border-t border-line p-4">{body}</div>
        </details>
      ) : (
        body
      )}
    </>
  );
}

function TestMode({ info }: { info: TestModeInfo }) {
  const t = useT();
  const proven = info.mode === "proven";
  return (
    <details className="group mt-3 text-sm">
      <summary
        className={`inline-flex cursor-pointer list-none items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium [&::-webkit-details-marker]:hidden ${
          proven ? "bg-emerald-50 text-emerald-800" : "bg-violet-50 text-violet-800"
        }`}
      >
        {proven ? "✓" : "🧪"} {proven ? info.label : t("campaigns.proposalsUi.testDirection", { label: info.label })}
        <ChevronDown className="size-3.5 transition group-open:rotate-180" />
      </summary>
      <div className="mt-2 space-y-1 text-xs text-mut">
        <p>{info.reason}</p>
        {!proven && (
          <p>
            {t("campaigns.proposalsUi.testExplain")}
          </p>
        )}
      </div>
    </details>
  );
}

type Idea = CampaignIdeas["ideas"][number];

function IdeaCard({ idea, currency, on, locked, onToggle }: { idea: Idea; currency: string; on: boolean; locked: boolean; onToggle: () => void }) {
  const t = useT();
  const prio = PRIO[idea.priority] ?? PRIO.low;
  return (
    <div
      role="checkbox"
      aria-checked={on}
      aria-disabled={locked}
      tabIndex={locked ? -1 : 0}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          onToggle();
        }
      }}
      className={`flex flex-col rounded-xl border text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300 ${
        on ? "border-indigo-500 bg-indigo-50/40 ring-1 ring-indigo-500" : "border-line bg-panel"
      } ${locked ? "cursor-default" : "cursor-pointer hover:border-indigo-300"}`}
    >
      <div className="flex items-start gap-3 p-4 pb-3">
        <span className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded-md border ${on ? "border-indigo-600 bg-indigo-600 text-white" : "border-slate-300 bg-panel"}`}>
          {on && <Check className="size-3.5" />}
        </span>
        <div className="min-w-0 flex-1">
          <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${prio.cls}`}>{t(prio.label)}</span>
          <p className="mt-1.5 font-semibold leading-snug text-ink">{idea.title}</p>
        </div>
      </div>

      <div className="mx-4 grid grid-cols-3 divide-x divide-line rounded-lg bg-soft text-center">
        <Fact label={t("campaigns.proposalsUi.objective")} value={goalLabel(t, idea.result_type)} />
        <Fact label={t("campaigns.proposalsUi.budgetPerDay")} value={idea.daily_budget ? money(idea.daily_budget, currency) : t("campaigns.proposalsUi.needsAsking")} />
        <Fact label={t("campaigns.proposalsUi.age")} value={`${idea.age_min}–${idea.age_max}`} />
      </div>

      <div className="space-y-2.5 p-4 pt-3 text-[13px] text-ink2">
        <p className="flex gap-1.5 text-xs text-mut">
          <Users className="mt-px size-3.5 shrink-0" /> {idea.personas.join(", ") || "—"}
        </p>
        <p className="flex gap-1.5 text-xs text-mut">
          <MapPin className="mt-px size-3.5 shrink-0" /> {idea.locations}
        </p>
        <Para label={t("campaigns.proposalsUi.whatToPush")}>{idea.offer}</Para>
        <details className="group" onClick={(e) => e.stopPropagation()}>
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-indigo-600 hover:underline [&::-webkit-details-marker]:hidden">
            {t("campaigns.proposalsUi.seeDetails")} <ChevronDown className="size-3.5 transition group-open:rotate-180" />
          </summary>
          <div className="mt-2 space-y-2.5">
            <Para label={t("campaigns.proposalsUi.content")}>{idea.creative}</Para>
            <Para label={t("campaigns.proposalsUi.targetingDirection")}>{idea.structure}</Para>
            <Para label={t("campaigns.proposalsUi.why")}>{idea.why}</Para>
          </div>
        </details>
      </div>

      <p className="mt-auto rounded-b-xl border-t border-emerald-100 bg-emerald-50/70 px-4 py-2 text-xs text-emerald-800">
        <span className="font-medium">{t("campaigns.proposalsUi.successWhen")}</span> {idea.success}
      </p>
    </div>
  );
}

const Fact = ({ label, value }: { label: string; value: string }) => (
  <div className="min-w-0 px-2 py-2">
    <p className="text-[11px] text-mut">{label}</p>
    <p className="truncate text-[13px] font-semibold text-ink">{value}</p>
  </div>
);

const Para = ({ label, children }: { label: string; children: ReactNode }) => (
  <div>
    <p className="text-[11px] font-semibold tracking-wide text-mut uppercase">{label}</p>
    <p className="mt-0.5 leading-relaxed">{children}</p>
  </div>
);

function Questions({
  questions,
  answers,
  setAnswers,
  disabled,
}: {
  questions: CampaignIdeas["questions"];
  answers: Record<string, string>;
  setAnswers: (v: Record<string, string>) => void;
  disabled: boolean;
}) {
  const t = useT();
  // The free-text input only opens when "Khác…" (Other…) is clicked or the current answer is not among the options.
  const [custom, setCustom] = useState<Record<string, boolean>>({});
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/40 p-4">
      <p className="font-medium text-amber-900">{t("campaigns.proposalsUi.asksMore", { count: questions.length })}</p>
      <p className="text-xs text-amber-800">{t("campaigns.proposalsUi.prefilled")}</p>
      <ol className="mt-3 space-y-4">
        {questions.map((q, n) => {
          const val = answers[q.id] ?? "";
          const open = custom[q.id] || (!!val && !q.options.includes(val));
          return (
            <li key={q.id} className="flex gap-3">
              <span className="grid size-5 shrink-0 place-items-center rounded-full bg-amber-100 text-[11px] font-semibold text-amber-800">{n + 1}</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-ink">{q.question}</p>
                <p className="text-xs text-mut">{q.why}</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {q.options.map((o) => (
                    <button
                      key={o}
                      type="button"
                      disabled={disabled}
                      onClick={() => {
                        setAnswers({ ...answers, [q.id]: o });
                        setCustom({ ...custom, [q.id]: false });
                      }}
                      className={`rounded-full px-3 py-1 text-xs ring-1 transition ${val === o && !open ? "bg-amber-600 text-white ring-amber-600" : "bg-panel text-ink2 ring-line hover:ring-amber-400"}`}
                    >
                      {o}
                    </button>
                  ))}
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => setCustom({ ...custom, [q.id]: true })}
                    className={`rounded-full px-3 py-1 text-xs ring-1 transition ${open ? "bg-amber-600 text-white ring-amber-600" : "bg-panel text-ink2 ring-line hover:ring-amber-400"}`}
                  >
                    {t("campaigns.proposalsUi.other")}
                  </button>
                </div>
                {open && (
                  <input
                    autoFocus={custom[q.id]}
                    value={val}
                    onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
                    disabled={disabled}
                    placeholder={t("campaigns.proposalsUi.yourAnswer")}
                    className={`${inputClass} mt-2`}
                  />
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
