"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { approveAction, rejectAction } from "@/app/actions";
import { undoRecommendationAction } from "@/app/auto-actions";
import { money } from "@/lib/format";
import { Badge, btnClass, inputClass, priorityLabels, priorityTone } from "./ui";
import { useT } from "@/i18n/client";
import type { T } from "@/i18n/translate";
import { Spinner } from "./action-button";
import { Zap } from "lucide-react";
import { rulesFor } from "@/lib/playbook";
import { useMetaConfirm, type MetaLine } from "./meta-confirm";
import { RecGuidePanel } from "./rec-guide";
import type { RecGuide } from "@/lib/ai/schemas";
import { actorLabel } from "@/lib/stored-labels";

type Variant = { primary_text: string; headline: string; description: string };
type Detailed = { id: string; name: string; type: string; note?: string; untested?: boolean };
type Side = { spendPerDay: number; results: number; resultsPerDay: number; cpr: number | null };
type Evaluation = Record<string, { days: number; campaign: { before: Side; after: Side; verdict: string }; target: { before: Side | null; after: Side } | null }>;

export type RecView = {
  id: string;
  title: string;
  rationale: string;
  priority: string;
  expectedImpact: string;
  actionType: string;
  targetLevel: string | null;
  targetName: string | null;
  newDailyBudget: number | null;
  status: string;
  result: string | null;
  decidedBy: string | null;
  source: string | null; // account | conversations | optimize
  campaignName?: string | null;
  campaignId?: string | null;
  clientId?: string;
  rule?: string | null;
  params?: Record<string, unknown>;
  evidence?: Record<string, unknown>;
  evaluation?: Evaluation | null;
  executedAt?: string | null;
  guide?: RecGuide | null;
  guideDone?: number[];
  auto?: string | null; // on: the system does it automatically | dryrun: dry run
  undone?: boolean;
  canUndo?: boolean;
};

const ACTIONS = ["pause", "resume", "update_budget", "duplicate_adset", "add_ad", "update_targeting", "new_draft", "manual"];
const SOURCES = ["conversations", "account", "optimize"];
const LEVELS = ["campaign", "adset", "ad"];
const STATUS: Record<string, { tone: "green" | "gray" | "red" | "blue" }> = {
  executing: { tone: "blue" },
  executed: { tone: "green" },
  done: { tone: "green" },
  rejected: { tone: "gray" },
  failed: { tone: "red" },
  expired: { tone: "gray" },
};
// Evaluation verdicts are stored as Vietnamese data by lib/optimize.ts; only the display is translated.
const VERDICT_TONE: Record<string, "green" | "red" | "gray"> = { "tốt hơn": "green", "kém hơn": "red" };
const VERDICT_KEY: Record<string, string> = { "tốt hơn": "better", "kém hơn": "worse", "như cũ": "same", "chưa đủ dữ liệu": "noData", "chưa so được": "unknown" };
const verdictText = (t: T, v: string) => (VERDICT_KEY[v] ? t(`workflow.card.verdict.${VERDICT_KEY[v]}` as "workflow.card.verdict.better") : v);

export function RecommendationCard({ rec, currency, currentBudget, client }: { rec: RecView; currency: string; currentBudget?: number | null; client?: { id: string; name: string } }) {
  const t = useT();
  const levelLabel = (l: string | null) => (LEVELS.includes(l ?? "") ? t(`workflow.card.level.${l}` as "workflow.card.level.campaign") : "");
  const p = rec.params ?? {};
  const [budget, setBudget] = useState(rec.newDailyBudget ?? 0);
  // Edit before executing (duplicate ad set / add ad / new campaign)
  const [name, setName] = useState(String(p.name ?? ""));
  const [dupBudget, setDupBudget] = useState<number | null>((p.dailyBudget as number | null) ?? null);
  const candidates = (p.candidates as Detailed[] | undefined) ?? [];
  const [picked, setPicked] = useState<Detailed[]>(((p.detailedTargeting as Detailed[] | null) ?? []).slice());
  const [advantage, setAdvantage] = useState<boolean>(Boolean(p.advantageAudience));
  // Broad targeting: drop all interests from the original ad set (detailedTargeting = []), unlike "keep the old audience" (null).
  const [broad, setBroad] = useState<boolean>(Array.isArray(p.detailedTargeting) && !(p.detailedTargeting as unknown[]).length);
  const [variants, setVariants] = useState<Variant[]>(((p.variants as Variant[] | undefined) ?? []).map((v) => ({ ...v })));
  const [brief, setBrief] = useState(String(p.brief ?? ""));
  const needsText = rec.actionType === "add_ad" && !variants.some((v) => v.primary_text.trim());
  const [editing, setEditing] = useState(rec.rule === "manual" || needsText);

  const [error, setError] = useState<string | null>(rec.status === "pending" && /^(Lỗi|Error)/.test(rec.result ?? "") ? rec.result : null);
  const [pending, start] = useTransition();
  const [which, setWhich] = useState<"approve" | "reject" | null>(null);
  const [asking, setAsking] = useState(false); // ask why it was dismissed (optimization proposal) so it isn't proposed again
  const [dialog, ask] = useMetaConfirm();
  /** Action that changes live ads on Meta (vs. manual work, drafting). */
  const metaChange = ["pause", "resume", "update_budget", "duplicate_adset", "add_ad", "update_targeting"].includes(rec.actionType);

  /** Confirmation dialog: states the object, old → new, money impact. */
  const confirmMeta = () => {
    const target = `${levelLabel(rec.targetLevel) || t("workflow.card.object")} · ${rec.targetName ?? ""}`;
    let lines: MetaLine[] = [];
    let effect: string | undefined;
    let confirmLabel = t("workflow.card.confirmMeta");
    if (rec.actionType === "update_budget") {
      lines = [{ label: `${t("workflow.card.dailyBudget")} · ${target}`, from: currentBudget != null ? money(currentBudget, currency) : undefined, to: money(budget, currency) }];
      if (currentBudget != null) effect = t(budget >= currentBudget ? "workflow.card.spendUp" : "workflow.card.spendDown", { value: money(Math.abs(budget - currentBudget), currency) });
      confirmLabel = t("workflow.card.confirmChange");
    } else if (rec.actionType === "pause" || rec.actionType === "resume") {
      lines = [{ label: `${t("workflow.card.status")} · ${target}`, from: rec.actionType === "pause" ? t("workflow.card.running") : t("workflow.card.paused"), to: rec.actionType === "pause" ? t("workflow.card.paused") : t("workflow.card.running") }];
      effect = rec.actionType === "pause" ? t("workflow.card.pauseEffect") : t("workflow.card.resumeEffect");
      confirmLabel = rec.actionType === "pause" ? t("workflow.card.pauseOnMeta") : t("workflow.card.resumeOnMeta");
    } else if (rec.actionType === "duplicate_adset") {
      lines = [
        { label: t("workflow.card.newGroup", { source: rec.targetName ?? t("workflow.card.sourceGroup") }), to: name || "—" },
        { label: t("workflow.card.dailyBudget"), to: dupBudget != null ? money(dupBudget, currency) : t("workflow.card.sameAsSource") },
        { label: t("workflow.card.audience"), to: picked.length ? picked.map((x) => x.name).join(", ") : broad ? t("workflow.card.broad") : t("workflow.card.keepAudience") },
        ...(p.targetingNote ? [{ label: t("workflow.card.changeVsSource"), to: String(p.targetingNote) }] : []),
        { label: t("workflow.card.status"), to: t("workflow.card.pausedYouEnable") },
      ];
      confirmLabel = t("workflow.card.createOnMeta");
    } else if (rec.actionType === "update_targeting") {
      const b = p.before as { locales: string; age: string } | undefined;
      const a = p.after as { locales: string; age: string } | undefined;
      lines = [
        { label: `${t("workflow.card.language")} · ${target}`, from: b?.locales, to: a?.locales ?? "—" },
        { label: t("workflow.card.age"), from: b?.age, to: a?.age ?? "—" },
      ];
      effect = t("workflow.card.targetingEffect");
      confirmLabel = t("workflow.card.editOnMeta");
    } else if (rec.actionType === "add_ad") {
      const n = variants.filter((v) => v.primary_text.trim()).length;
      lines = [
        { label: `${t("workflow.card.addTo")} · ${target}`, to: t("workflow.card.newAds", { count: n }) },
        { label: t("workflow.card.status"), to: t("workflow.card.pausedYouEnable") },
      ];
      confirmLabel = t("workflow.card.createOnMeta");
    }
    return ask({ title: rec.title, lines, effect, confirmLabel });
  };
  const approve = async () => {
    if (metaChange && !(await confirmMeta())) return;
    act("approve");
  };

  const edits =
    rec.actionType === "duplicate_adset"
      ? {
          name,
          dailyBudget: dupBudget,
          detailedTargeting: picked.length ? picked.map(({ id, name, type }) => ({ id, name, type })) : broad ? [] : null,
          advantageAudience: picked.length ? false : broad ? true : advantage || null,
        }
      : rec.actionType === "add_ad"
        ? { variants }
        : rec.actionType === "new_draft"
          ? { brief }
          : undefined;

  const act = (kind: "approve" | "reject", reason?: string) => {
    setWhich(kind);
    setError(null);
    start(async () => {
      const res = kind === "approve" ? await approveAction(rec.id, rec.actionType === "update_budget" ? budget : undefined, edits) : await rejectAction(rec.id, reason);
      if (!res.ok) setError(res.error);
    });
  };

  const isApi = rec.actionType !== "manual";
  const st = STATUS[rec.status];
  const priority = priorityLabels(t);
  const editable = ["duplicate_adset", "add_ad", "new_draft"].includes(rec.actionType);
  const m7 = (rec.evidence?.m7 ?? null) as { spend: string; results: number; cpr: string; freq: number; ctr: string } | null;
  const m3 = (rec.evidence?.m3 ?? null) as { results: number; cpr: string; ctr: string } | null;
  // Meta optimization playbook section A: adding a new ad (including cards created via "+ Quảng cáo") always puts the ad set back into learning.
  const learningReset =
    typeof rec.evidence?.learningReset === "string"
      ? rec.evidence.learningReset
      : rec.actionType === "add_ad"
        ? t("workflow.card.learningReset")
        : null;
  const setVariant = (i: number, patch: Partial<Variant>) => setVariants((l) => l.map((v, j) => (j === i ? { ...v, ...patch } : v)));

  return (
    <article className="rounded-xl border border-line bg-panel p-4">
      {dialog}
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={priorityTone(rec.priority)}>{t("workflow.card.priority", { value: priority[rec.priority] ?? rec.priority })}</Badge>
        <Badge tone={isApi ? "violet" : "gray"}>{ACTIONS.includes(rec.actionType) ? t(`workflow.card.action.${rec.actionType}` as "workflow.card.action.pause") : rec.actionType}</Badge>
        {rec.source && <Badge tone="blue">{SOURCES.includes(rec.source) ? t(`workflow.card.source.${rec.source}` as "workflow.card.source.account") : rec.source}</Badge>}
        {rec.rule === "manual" && <Badge>{t("workflow.card.manualBadge")}</Badge>}
        {rulesFor(rec.rule).length > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700">
            {t(rulesFor(rec.rule).length === 1 ? "playbook.badgeOne" : "playbook.badgeGroup")}
            {rulesFor(rec.rule).map((n) => (
              <Link key={n} href={`/playbook#r${n}`} title={t(`playbook.rules.r${n}.rule` as "playbook.rules.r1.rule")} className="font-mono font-semibold hover:underline">
                #{n}
              </Link>
            ))}
          </span>
        )}
        {rec.auto === "on" && <Badge tone="violet">{t("workflow.card.autoBadge")}</Badge>}
        {rec.auto === "dryrun" && rec.status === "pending" && <Badge tone="amber">{t("workflow.card.dryRunBadge")}</Badge>}
        {rec.undone && <Badge tone="gray">{t("workflow.card.undoneBadge")}</Badge>}
        {learningReset && <Badge tone="amber">{t("workflow.card.learningBadge")}</Badge>}
        {client && (
          <Link href={`/clients/${client.id}`} className="text-xs font-medium text-indigo-600 hover:underline">
            {client.name}
          </Link>
        )}
        {st && <Badge tone={st.tone}>{t(`workflow.card.statusLabel.${rec.status}` as "workflow.card.statusLabel.done")}</Badge>}
      </div>
      <h3 className="mt-2 font-semibold text-slate-900">{rec.title}</h3>
      {(rec.campaignName || rec.targetName) && (
        <p className="mt-0.5 text-xs text-slate-500">
          {rec.campaignName && (
            <>
              {t("workflow.card.campaign")}: <span className="font-medium text-slate-700">{rec.campaignName}</span>
              {rec.campaignId && rec.clientId && (
                <Link href={`/clients/${rec.clientId}/campaigns/${rec.campaignId}`} className="ml-2 font-medium text-indigo-600 hover:underline">
                  {t("workflow.card.viewReview")} →
                </Link>
              )}
            </>
          )}
          {rec.campaignName && rec.targetName && rec.targetLevel !== "campaign" && " · "}
          {rec.targetName && rec.targetLevel !== "campaign" && (
            <>
              {levelLabel(rec.targetLevel)}: <span className="font-medium text-slate-700">{rec.targetName}</span>
            </>
          )}
        </p>
      )}
      <p className="mt-2 text-sm whitespace-pre-line text-slate-700">{rec.rationale}</p>
      {rec.actionType === "update_targeting" && p.before && p.after ? <TargetingDiff before={p.before as TargetingSide} after={p.after as TargetingSide} t={t} /> : null}
      {rec.actionType === "duplicate_adset" && p.targetingNote ? <p className="mt-2 rounded-lg bg-indigo-50 px-3 py-1.5 text-xs text-indigo-900">{t("workflow.card.newGroupNote", { note: String(p.targetingNote) })}</p> : null}
      {learningReset && <p className="mt-2 rounded-lg bg-amber-50 px-3 py-1.5 text-xs text-amber-900">⚠ {learningReset}</p>}
      {m7 && (
        <p className="mt-2 rounded-lg bg-slate-50 px-3 py-1.5 text-xs text-slate-600 tabular-nums">
          {t("workflow.card.m7", { spend: m7.spend, results: m7.results, cpr: m7.cpr, freq: m7.freq, ctr: m7.ctr })}
          {m3 && (
            <>
              {" "}
              · {t("workflow.card.m3", { results: m3.results, cpr: m3.cpr, ctr: m3.ctr })}
            </>
          )}
        </p>
      )}
      {rec.expectedImpact && <p className="mt-2 text-sm text-emerald-700">↗ {rec.expectedImpact}</p>}
      {rec.result && rec.status !== "pending" && (
        <p className="mt-2 text-xs text-slate-500">
          {rec.result}
          {rec.decidedBy && (
            <>
              {" "}
              · {t("workflow.card.by")} <b>{actorLabel(rec.decidedBy, t)}</b>
            </>
          )}
        </p>
      )}
      {rec.canUndo && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={btnClass()}
            disabled={pending}
            onClick={async () => {
              const pause = rec.actionType === "pause";
              const ok = await ask({
                title: t("workflow.card.undoTitle", { title: rec.title }),
                lines: [
                  pause
                    ? { label: `${t("workflow.card.status")} · ${rec.targetName ?? ""}`, from: t("workflow.card.paused"), to: t("workflow.card.running") }
                    : { label: `${t("workflow.card.dailyBudget")} · ${rec.targetName ?? ""}`, to: money(Number(p.prevBudget), currency) },
                ],
                effect: t("workflow.card.undoEffect"),
                confirmLabel: pause ? t("workflow.card.resumeOnMeta") : t("workflow.card.restoreBudget"),
              });
              if (!ok) return;
              setError(null);
              start(async () => {
                const r = await undoRecommendationAction(rec.id);
                if (!r.ok) setError(r.error);
              });
            }}
          >
            ↶ {t("workflow.card.undo")}
          </button>
        </div>
      )}
      {rec.evaluation && <EvaluationView evaluation={rec.evaluation} currency={currency} t={t} />}
      {rec.status === "executed" && rec.executedAt && !rec.evaluation && rec.source === "optimize" && ["pause", "update_budget", "duplicate_adset", "add_ad", "update_targeting"].includes(rec.actionType) && (
        <p className="mt-2 text-xs text-slate-400">{t("workflow.card.remeasure")}</p>
      )}

      {rec.status === "pending" && editable && (
        <div className="mt-3">
          <button type="button" className="text-xs font-medium text-indigo-600 hover:underline" onClick={() => setEditing((x) => !x)}>
            {editing ? t("workflow.card.hideEdit") : t("workflow.card.showEdit")}
          </button>
          {editing && (
            <div className="mt-2 space-y-3 rounded-lg border border-slate-200 bg-slate-50/60 p-3 text-sm">
              {rec.actionType === "duplicate_adset" && (
                <>
                  <label className="block">
                    <span className="text-xs text-slate-600">{t("workflow.card.newGroupName")}</span>
                    <input className={`${inputClass} mt-1`} value={name} onChange={(e) => setName(e.target.value)} />
                  </label>
                  <label className="block max-w-xs">
                    <span className="text-xs text-slate-600">{t("workflow.card.budgetBlank")}</span>
                    <input type="number" className={`${inputClass} mt-1`} value={dupBudget ?? ""} onChange={(e) => setDupBudget(e.target.value ? Number(e.target.value) : null)} />
                  </label>
                  <div>
                    <p className="text-xs text-slate-600">{t("workflow.card.detailedAudience")}</p>
                    {candidates.length ? (
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {candidates.map((c) => {
                          const on = picked.some((x) => x.id === c.id);
                          return (
                            <button
                              key={c.id}
                              type="button"
                              title={c.note}
                              onClick={() => setPicked((l) => (on ? l.filter((x) => x.id !== c.id) : l.length >= 3 ? l : [...l, c]))}
                              className={`rounded-full border px-2.5 py-1 text-xs ${on ? "border-indigo-500 bg-indigo-600 text-white" : "border-slate-200 bg-panel text-slate-700 hover:border-slate-300"}`}
                            >
                              {on ? "✓ " : "+ "}
                              {c.name}
                              {c.untested && <span className={on ? "text-indigo-200" : "text-amber-600"}> · {t("workflow.card.untested")}</span>}
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="mt-1 text-xs text-slate-500">{t("workflow.card.keepSourceAudience")}</p>
                    )}
                    {!picked.length && (
                      <label className="mt-2 flex items-center gap-2 text-xs text-slate-700">
                        <input type="checkbox" className="accent-indigo-600" checked={broad} onChange={(e) => setBroad(e.target.checked)} /> {t("workflow.card.broadCheck")}
                      </label>
                    )}
                    {!picked.length && !broad && (
                      <label className="mt-2 flex items-center gap-2 text-xs text-slate-700">
                        <input type="checkbox" className="accent-indigo-600" checked={advantage} onChange={(e) => setAdvantage(e.target.checked)} /> {t("workflow.card.advantageCheck")}
                      </label>
                    )}
                  </div>
                </>
              )}
              {rec.actionType === "add_ad" && (
                <>
                  <p className="text-xs text-slate-600">{t("workflow.card.templateNote", { name: String(p.templateName ?? "") })}</p>
                  {variants.map((v, i) => (
                    <div key={i} className="space-y-1.5 rounded-md border border-slate-200 bg-panel p-2">
                      <div className="flex items-center justify-between text-xs text-slate-500">
                        <span>{t("workflow.card.variant", { n: i + 1 })}</span>
                        {variants.length > 1 && (
                          <button type="button" className="hover:text-rose-600" onClick={() => setVariants((l) => l.filter((_, j) => j !== i))}>
                            {t("workflow.card.removeVariant")}
                          </button>
                        )}
                      </div>
                      <textarea className={inputClass} rows={3} placeholder={t("workflow.card.primaryText")} value={v.primary_text} onChange={(e) => setVariant(i, { primary_text: e.target.value })} />
                      <input className={inputClass} placeholder={t("workflow.card.headline")} value={v.headline} onChange={(e) => setVariant(i, { headline: e.target.value })} />
                      <input className={inputClass} placeholder={t("workflow.card.descriptionOptional")} value={v.description} onChange={(e) => setVariant(i, { description: e.target.value })} />
                    </div>
                  ))}
                  {variants.length < 3 && (
                    <button
                      type="button"
                      className="text-xs font-medium text-indigo-600 hover:underline"
                      onClick={() => setVariants((l) => [...l, { primary_text: "", headline: "", description: "" }])}
                    >
                      {t("workflow.card.addVariant")}
                    </button>
                  )}
                </>
              )}
              {rec.actionType === "new_draft" && (
                <label className="block">
                  <span className="text-xs text-slate-600">{t("workflow.card.briefLabel")}</span>
                  <textarea className={`${inputClass} mt-1`} rows={4} value={brief} onChange={(e) => setBrief(e.target.value)} />
                </label>
              )}
            </div>
          )}
        </div>
      )}

      {rec.actionType === "manual" && (rec.status === "pending" || rec.guide) && <RecGuidePanel recId={rec.id} clientId={rec.clientId ?? client?.id} initial={rec.guide ?? null} initialDone={rec.guideDone ?? []} />}

      {rec.status === "pending" && (
        <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-slate-100 pt-3">
          {rec.actionType === "update_budget" && (
            <label className="text-xs text-slate-600">
              {t("workflow.card.newDailyBudget")} {currentBudget != null && <>({t("workflow.card.current", { value: money(currentBudget, currency) })})</>}
              <input type="number" className={`${inputClass} mt-1 w-44`} value={budget} onChange={(e) => setBudget(Number(e.target.value))} />
            </label>
          )}
          {(rec.actionType === "duplicate_adset" || rec.actionType === "add_ad") && <p className="text-xs text-slate-500">{t("workflow.card.createdPaused")}</p>}
          <div className="ml-auto flex gap-2">
            <button data-skip className={btnClass("ghost")} disabled={pending} onClick={() => (rec.source === "optimize" && rec.actionType !== "manual" ? setAsking((x) => !x) : act("reject"))}>
              {pending && which === "reject" && <Spinner />}{t("workflow.card.skip")}
            </button>
            <button
              className={btnClass(metaChange ? "meta" : "primary")}
              disabled={pending || (rec.actionType === "add_ad" && !variants.some((v) => v.primary_text.trim()))}
              onClick={approve}
              data-approve
            >
              {pending && which === "approve" ? <Spinner /> : metaChange ? <Zap /> : null}
              {pending && which === "approve" && metaChange
                ? t("workflow.card.working")
                : isApi
                  ? rec.source === "optimize"
                    ? t("workflow.card.approveDo")
                    : t("workflow.card.approveExecute")
                  : rec.rule?.endsWith("_warn")
                    ? t("workflow.card.seen")
                    : t("workflow.card.markDone")}
              {metaChange && !(pending && which === "approve") && <span className="rounded bg-white/20 px-1 text-[10px] font-semibold">Meta</span>}
            </button>
          </div>
        </div>
      )}
      {asking && rec.status === "pending" && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-slate-500">{t("workflow.card.whySkip")}</span>
          {(["disagree", "otherPlan", "clientNo", "later"] as const).map((k) => [k, t(`workflow.card.skipReasons.${k}`)] as const).map(([k, r]) => (
            <button
              key={k}
              type="button"
              disabled={pending}
              onClick={() => act("reject", r)}
              className="rounded-full border border-slate-200 px-2.5 py-1 text-slate-700 hover:border-slate-300 hover:bg-slate-50"
            >
              {r}
            </button>
          ))}
        </div>
      )}
      {error && <p className="mt-2 text-sm text-rose-600">{error}</p>}
    </article>
  );
}

/** Result after execution: compare the campaign (and audience) before / after, by day. */
type TargetingSide = { locales: string; age: string };
/** Ad set audience edit: show before → after clearly right on the card. */
function TargetingDiff({ before, after, t }: { before: TargetingSide; after: TargetingSide; t: T }) {
  const rows: [string, string, string][] = [
    [t("workflow.card.language"), before.locales, after.locales],
    [t("workflow.card.age"), before.age, after.age],
  ];
  return (
    <table className="mt-2 w-full text-xs">
      <tbody>
        {rows.map(([label, from, to]) => (
          <tr key={label} className="align-top">
            <td className="w-20 py-0.5 pr-2 text-slate-500">{label}</td>
            <td className="py-0.5 pr-2 text-rose-700 line-through decoration-rose-300">{from}</td>
            <td className="py-0.5 font-medium text-emerald-700">→ {to}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function EvaluationView({ evaluation, currency, t }: { evaluation: Evaluation; currency: string; t: T }) {
  const rows = (["d3", "d7"] as const).filter((k) => evaluation[k]);
  if (!rows.length) return null;
  const fmt = (s: Side) => t("workflow.card.evalSide", { cpr: s.cpr != null ? money(s.cpr, currency) : "—", perDay: s.resultsPerDay.toFixed(1) });
  return (
    <div className="mt-3 space-y-1 rounded-lg border border-slate-200 p-2.5 text-xs">
      {rows.map((k) => {
        const e = evaluation[k];
        return (
          <p key={k} className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-slate-700">{t("workflow.card.after", { days: k === "d3" ? "3" : "7" })}</span>
            <span className="text-slate-600">
              {t("workflow.card.campaign")} {fmt(e.campaign.before)} → {fmt(e.campaign.after)}
            </span>
            <Badge tone={VERDICT_TONE[e.campaign.verdict] ?? "gray"}>{verdictText(t, e.campaign.verdict)}</Badge>
            {e.target && (
              <span className="text-slate-500">
                · {t("workflow.card.object")}: {e.target.before ? `${fmt(e.target.before)} → ` : ""}
                {fmt(e.target.after)}
              </span>
            )}
          </p>
        );
      })}
    </div>
  );
}
