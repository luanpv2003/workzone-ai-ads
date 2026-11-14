"use client";

import Link from "next/link";
import { InboxLink } from "@/components/inbox-link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { AlertTriangle, Check, ExternalLink, Loader2, Pause, Play, Send, ShieldCheck, Sparkles, Trash2, Users } from "lucide-react";
import { Badge, btnClass, Card, inputClass, type Tone } from "../ui";
import { CopyButton } from "../copy-button";
import { AutoRefresh } from "../targeting/controls";
import { dateTime, stageLabels } from "@/lib/format";
import { useT } from "@/i18n/client";
import type { MessageKey } from "@/i18n/translate";
import { FLOW_STATUS, MAX_TEXT, messageKey, NURTURE_STAGES, nurtureGate, personalize, SEND_FROM, SEND_STATUS, SEND_TO, type NurturePolicy } from "@/lib/nurture-rules";
import {
  approveFlowAction,
  checkFlowAction,
  deleteFlowAction,
  markManualAction,
  optOutAction,
  pauseFlowAction,
  previewFlowAction,
  retargetAudienceAction,
  runNowAction,
  saveFlowAction,
  testSendAction,
  writeFlowAction,
  type PreviewRow,
} from "@/app/nurture-actions";

type Flow = {
  id: string;
  name: string;
  pageId: string | null;
  status: string;
  stages: string[];
  minScore: number | null;
  waitHours: number;
  cooldownDays: number;
  maxPerRun: number;
  auto: boolean;
  everyHours: number;
  message: string;
  brief: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  runRequested: boolean;
  lastRunAt: string | null;
  lastRunNote: string | null;
};
type Props = {
  clientId: string;
  isMeta: boolean;
  inHours: boolean;
  pages: { id: string; name: string }[];
  flow: Flow;
  policy: NurturePolicy | null;
  suggestions: { message: string; why: string }[];
  job: { kind: string; status: string; error: string | null; finishedAt: string | null } | null;
  buckets: { in24: number; d7: number; older: number; phones: number };
  sends: { id: string; at: string; name: string; text: string; status: string; error: string | null; by: string | null; replied: boolean }[];
};

const VERDICT: Record<string, { labelKey: MessageKey; tone: Tone }> = {
  safe: { labelKey: "customers.nurtureFlow.verdict.safe", tone: "good" },
  fix: { labelKey: "customers.nurtureFlow.verdict.fix", tone: "warn" },
  reject: { labelKey: "customers.nurtureFlow.verdict.reject", tone: "bad" },
};
const SEVERITY: Record<string, string> = { high: "border-rose-200 bg-rose-50", medium: "border-amber-200 bg-amber-50", low: "border-line bg-soft" };

function useAct() {
  const t = useT();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const act = <T extends { ok: boolean; error?: string }>(fn: () => Promise<T>, then?: (r: T) => void) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) return setError(r.error ?? t("customers.nurtureFlow.error"));
      then?.(r);
      router.refresh();
    });
  return { pending, error, act };
}

/** The user-editable part (compared to detect unsaved changes). */
const editable = (x: Flow) => JSON.stringify([x.name, x.pageId, x.stages, x.minScore, x.waitHours, x.cooldownDays, x.maxPerRun, x.auto, x.everyHours, x.message, x.brief]);

// Sample customer name for the preview: DATA (the name parser expects a Vietnamese full name, given name = last word).
const SAMPLE_NAME = "Nguyễn Văn An";

const Err = ({ e }: { e: string | null }) => (e ? <p className="text-sm text-rose-600">{e}</p> : null);

export function NurtureFlowView(p: Props) {
  const t = useT();
  const { flow } = p;
  const router = useRouter();
  const [f, setF] = useState(flow);
  const set = <K extends keyof Flow>(k: K, v: Flow[K]) => setF((x) => ({ ...x, [k]: v }));
  // The server changed the flow (Claude filled in content, saved): take the new version if the user hasn't edited anything.
  const [prev, setPrev] = useState(flow);
  if (editable(prev) !== editable(flow)) {
    setPrev(flow);
    if (editable(f) === editable(prev)) setF(flow);
  }
  const save = useAct();
  const ctl = useAct();
  const [notice, setNotice] = useState<string | null>(null);
  const dirty = editable(f) !== editable(flow);
  const jobActive = p.job?.status === "queued" || p.job?.status === "running";
  const gate = nurtureGate(flow.message, p.policy, t);
  const st = FLOW_STATUS[flow.status] ?? FLOW_STATUS.draft;

  const doSave = () =>
    save.act(
      () =>
        saveFlowAction(flow.id, {
          name: f.name,
          pageId: f.pageId,
          stages: f.stages,
          minScore: f.minScore,
          waitHours: f.waitHours,
          cooldownDays: f.cooldownDays,
          maxPerRun: f.maxPerRun,
          auto: f.auto,
          everyHours: f.everyHours,
          message: f.message,
          brief: f.brief,
        }),
      (r) => {
        const x = r as { reapprove?: boolean; checking?: boolean };
        // Short notice that auto-hides; the policy check status is shown in section 2 (updates itself when done).
        setNotice([t("customers.nurtureFlow.saved"), x.reapprove && t("customers.nurtureFlow.reapprove"), x.checking && t("customers.nurtureFlow.checking")].filter(Boolean).join(" "));
        setTimeout(() => setNotice(null), 6000);
      },
    );

  return (
    <div className="space-y-6">
      <AutoRefresh active={jobActive || flow.runRequested} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <Link href={`/clients/${p.clientId}/nurture`} className="text-xs text-mut hover:text-ink">
            {t("customers.nurtureFlow.back")}
          </Link>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <input className={`${inputClass} w-80 max-w-full font-semibold`} value={f.name} onChange={(e) => set("name", e.target.value)} />
            <Badge tone={st.tone}>{t(st.labelKey)}</Badge>
            {flow.status === "active" && flow.approvedBy && <span className="text-xs text-mut">{t("customers.nurtureFlow.approvedBy", { by: flow.approvedBy, at: dateTime(flow.approvedAt) })}</span>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={btnClass("primary")} disabled={!dirty || save.pending} onClick={doSave}>
            {save.pending ? <Loader2 className="animate-spin" /> : <Check />} {t("customers.nurtureFlow.save")}
          </button>
          <button
            type="button"
            className={btnClass("ghost")}
            onClick={() => confirm(t("customers.nurtureFlow.confirmDelete")) && ctl.act(() => deleteFlowAction(flow.id), () => router.push(`/clients/${p.clientId}/nurture`))}
          >
            <Trash2 /> {t("customers.nurtureFlow.delete")}
          </button>
        </div>
      </div>
      {notice && !save.error && <p className="text-sm text-emerald-700">{notice}</p>}
      <Err e={save.error} />

      {/* 1. Customer group */}
      <Card title={t("customers.nurtureFlow.s1.title")}>
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-3">
            {p.pages.length > 1 && (
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-ink2">{t("customers.nurtureFlow.s1.page")}</span>
                <select className={inputClass} value={f.pageId ?? ""} onChange={(e) => set("pageId", e.target.value || null)}>
                  {p.pages.map((pg) => (
                    <option key={pg.id} value={pg.id}>
                      {pg.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div>
              <span className="mb-1 block text-sm font-medium text-ink2">{t("customers.nurtureFlow.s1.stages")}</span>
              <div className="flex flex-wrap gap-2">
                {NURTURE_STAGES.map((s) => {
                  const on = f.stages.includes(s.key);
                  return (
                    <button
                      key={s.key}
                      type="button"
                      onClick={() => set("stages", on ? f.stages.filter((x) => x !== s.key) : [...f.stages, s.key])}
                      className={`rounded-full border px-3 py-1 text-xs ${on ? "border-indigo-600 bg-indigo-600 text-white" : "border-line bg-panel text-ink2 hover:bg-hover"}`}
                    >
                      {t(s.labelKey)}
                    </button>
                  );
                })}
              </div>
              <p className="mt-1 text-xs text-mut">{t("customers.nurtureFlow.s1.noSpam")}</p>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Num label={t("customers.nurtureFlow.s1.minScore")} value={f.minScore} empty={t("customers.nurtureFlow.s1.noFilter")} onChange={(v) => set("minScore", v)} min={0} max={100} />
              <Num label={t("customers.nurtureFlow.s1.waitHours")} value={f.waitHours} onChange={(v) => set("waitHours", v ?? 3)} min={1} max={20} />
              <Num label={t("customers.nurtureFlow.s1.cooldown")} value={f.cooldownDays} onChange={(v) => set("cooldownDays", v ?? 7)} min={1} max={90} />
            </div>
          </div>
          <div className="rounded-lg border border-line bg-soft p-4 text-sm">
            <p className="font-medium text-ink">{t("customers.nurtureFlow.s1.estimate")}</p>
            <ul className="mt-2 space-y-1.5 text-ink2">
              <li>
                <b className="tabular-nums">{p.buckets.in24}</b>{t("customers.nurtureFlow.s1.in24a")}
              </li>
              <li>
                <b className="tabular-nums">{p.buckets.d7}</b>{t("customers.nurtureFlow.s1.d7a")}<b className="tabular-nums">{p.buckets.older}</b>{t("customers.nurtureFlow.s1.d7b")}
              </li>
            </ul>
            <p className="mt-3 text-xs text-mut">
              {t("customers.nurtureFlow.s1.rules", { hours: 23, wait: f.waitHours })}
            </p>
          </div>
        </div>
      </Card>

      {/* 2. Content */}
      <Content p={p} f={f} set={set} dirty={dirty} jobActive={jobActive} />

      {/* 3. Schedule */}
      <Card title={t("customers.nurtureFlow.s3.title")}>
        <div className="space-y-3 text-sm">
          <label className="flex items-start gap-2">
            <input type="radio" className="mt-1" checked={!f.auto} onChange={() => set("auto", false)} />
            <span>
              <b className="text-ink">{t("customers.nurtureFlow.s3.manualB")}</b>{t("customers.nurtureFlow.s3.manualRest")}
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input type="radio" className="mt-1" checked={f.auto} onChange={() => set("auto", true)} />
            <span>
              <b className="text-ink">{t("customers.nurtureFlow.s3.autoB")}</b>{t("customers.nurtureFlow.s3.autoA")}{" "}
              <select className="rounded border border-line bg-panel px-1 py-0.5" value={f.everyHours} onChange={(e) => set("everyHours", Number(e.target.value))}>
                {[1, 2, 3, 4, 6].map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </select>{" "}
              {t("customers.nurtureFlow.s3.autoB2", { from: SEND_FROM, to: SEND_TO })}
            </span>
          </label>
          <div className="w-56">
            <Num label={t("customers.nurtureFlow.s3.maxPerRun")} value={f.maxPerRun} onChange={(v) => set("maxPerRun", v ?? 30)} min={1} max={200} />
          </div>
        </div>
      </Card>

      {/* 4. Review & send */}
      <Card title={t("customers.nurtureFlow.s4.title")}>
        <div className="space-y-3">
          {dirty && <p className="text-sm text-amber-700">{t("customers.nurtureFlow.s4.unsaved")}</p>}
          {!gate.ok ? (
            <p className="flex items-center gap-2 text-sm text-amber-700">
              <AlertTriangle className="size-4" /> {gate.reason}
            </p>
          ) : gate.warn ? (
            <p className="text-sm text-amber-700">{t("customers.nurtureFlow.s4.warn")}</p>
          ) : null}
          {!p.isMeta && <p className="text-sm text-amber-700">{t("customers.nurtureFlow.s4.sample")}</p>}
          <div className="flex flex-wrap items-center gap-2">
            {flow.status !== "active" ? (
              <button type="button" className={btnClass("meta")} disabled={!gate.ok || dirty || ctl.pending || !p.isMeta} onClick={() => confirm(t("customers.nurtureFlow.s4.confirmApprove", { name: flow.name, auto: flow.auto ? t("customers.nurtureFlow.s4.confirmApproveAuto", { hours: flow.everyHours }) : "" })) && ctl.act(() => approveFlowAction(flow.id))}>
                <ShieldCheck /> {t("customers.nurtureFlow.s4.approve")}{flow.auto ? t("customers.nurtureFlow.s4.approveAuto") : ""}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className={btnClass("meta")}
                  disabled={ctl.pending || flow.runRequested}
                  onClick={() => confirm(t("customers.nurtureFlow.s4.confirmRun", { n: flow.maxPerRun })) && ctl.act(() => runNowAction(flow.id))}
                >
                  <Send /> {flow.runRequested ? (p.inHours ? t("customers.nurtureFlow.s4.sending") : t("customers.nurtureFlow.s4.waitFrom", { from: SEND_FROM })) : t("customers.nurtureFlow.s4.sendNow")}
                </button>
                <button type="button" className={btnClass("secondary")} disabled={ctl.pending} onClick={() => ctl.act(() => pauseFlowAction(flow.id))}>
                  <Pause /> {t("customers.nurtureFlow.s4.pause")}
                </button>
              </>
            )}
          </div>
          {flow.lastRunNote && (
            <p className="text-sm text-ink2">
              {t("customers.nurtureFlow.s4.lastRun", { at: dateTime(flow.lastRunAt), note: flow.lastRunNote })}
            </p>
          )}
          <Err e={ctl.error} />
          <Preview p={p} gateOk={gate.ok && !dirty} />
        </div>
      </Card>

      {/* 5. Past 24 hours */}
      <Retarget p={p} />

      {dirty && (
        <div className="sticky bottom-4 z-10 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 shadow-sm">
          <span className="text-sm text-amber-800">{t("customers.nurtureFlow.unsavedBar", { note: flow.status === "active" ? t("customers.nurtureFlow.unsavedBarNote") : "" })}</span>
          <button type="button" className={btnClass("primary")} disabled={save.pending} onClick={doSave}>
            {save.pending ? <Loader2 className="animate-spin" /> : <Check />} {t("customers.nurtureFlow.save")}
          </button>
        </div>
      )}

      {/* History */}
      {p.sends.length > 0 && (
        <Card title={t("customers.nurtureFlow.history.title")}>
          <ul className="divide-y divide-line text-sm">
            {p.sends.map((s) => (
              <li key={s.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
                <span className="min-w-0">
                  <span className="font-medium text-ink">{s.name}</span>
                  <span className="text-xs text-mut">
                    {" "}
                    · {dateTime(s.at)}
                    {s.by ? ` · ${s.by}` : ""}
                  </span>
                  <span className="block truncate text-xs text-mut">{s.text}</span>
                  {s.error && <span className="block text-xs text-rose-600">{s.error}</span>}
                </span>
                <span className="flex gap-1">
                  <Badge tone={SEND_STATUS[s.status]?.tone}>{SEND_STATUS[s.status] ? t(SEND_STATUS[s.status].labelKey) : s.status}</Badge>
                  {s.replied && <Badge tone="good">{t("customers.nurtureFlow.history.replied")}</Badge>}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function Num({ label, value, onChange, min, max, empty }: { label: string; value: number | null; onChange: (v: number | null) => void; min: number; max: number; empty?: string }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-xs font-medium text-ink2">{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        placeholder={empty}
        className={inputClass}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? (empty ? null : min) : Math.min(max, Math.max(min, Math.round(Number(e.target.value)))))}
      />
    </label>
  );
}

function Content({ p, f, set, dirty, jobActive }: { p: Props; f: Flow; set: <K extends keyof Flow>(k: K, v: Flow[K]) => void; dirty: boolean; jobActive: boolean }) {
  const t = useT();
  const ai = useAct();
  const pol = p.policy;
  const checkedNow = !!pol && !dirty && pol.key === messageKey(p.flow.message);
  const v = pol ? VERDICT[pol.verdict] : null;
  return (
    <Card title={t("customers.nurtureFlow.s2.title")}>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2">
          <textarea className={`${inputClass} h-40 py-2`} maxLength={MAX_TEXT} placeholder={t("customers.nurtureFlow.s2.placeholder")} value={f.message} onChange={(e) => set("message", e.target.value)} />
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-mut">
            <span>
              {"{ten}"}{t("customers.nurtureFlow.s2.tenHelp")}
            </span>
            <span className="tabular-nums">
              {f.message.length}/{MAX_TEXT}
            </span>
          </div>
          {f.message.trim() && (
            <div className="rounded-lg border border-line bg-soft p-3 text-sm whitespace-pre-wrap text-ink2">
              <span className="mb-1 block text-xs text-mut">{t("customers.nurtureFlow.s2.preview", { name: SAMPLE_NAME })}</span>
              {personalize(f.message, SAMPLE_NAME)}
            </div>
          )}
          <div className="space-y-2 rounded-lg border border-violet-200 bg-violet-50/40 p-3">
            <textarea className={`${inputClass} h-16 py-2`} placeholder={t("customers.nurtureFlow.s2.briefPlaceholder")} value={f.brief ?? ""} onChange={(e) => set("brief", e.target.value || null)} />
            <div className="flex flex-wrap gap-2">
              <button type="button" className={btnClass("ai")} disabled={ai.pending || jobActive} onClick={() => ai.act(() => writeFlowAction(p.flow.id, f.brief ?? ""))}>
                <Sparkles /> {t("customers.nurtureFlow.s2.write")}
              </button>
              <button type="button" className={btnClass("secondary")} disabled={ai.pending || jobActive || dirty || !p.flow.message.trim()} onClick={() => ai.act(() => checkFlowAction(p.flow.id))}>
                <ShieldCheck /> {t("customers.nurtureFlow.s2.check")}
              </button>
            </div>
            {jobActive && (
              <p className="flex items-center gap-2 text-xs text-violet-700">
                <Loader2 className="size-3.5 animate-spin" /> {p.job?.kind === "nurture_write" ? t("customers.nurtureFlow.s2.writing") : t("customers.nurtureFlow.s2.checkingJob")} {t("customers.nurtureFlow.s2.canLeave")}
              </p>
            )}
            {p.job?.status === "failed" && <p className="text-xs text-rose-600">{t("customers.nurtureFlow.s2.jobFailed", { error: p.job.error ?? "" })}</p>}
            <Err e={ai.error} />
          </div>
          {p.suggestions.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-ink2">{t("customers.nurtureFlow.s2.suggested")}</p>
              {p.suggestions.map((s, i) => (
                <div key={i} className="rounded-lg border border-line p-3 text-sm">
                  <p className="whitespace-pre-wrap text-ink2">{s.message}</p>
                  <p className="mt-1 text-xs text-mut">{s.why}</p>
                  <button type="button" className={`${btnClass("ghost")} mt-1`} onClick={() => set("message", s.message)}>
                    {t("customers.nurtureFlow.s2.useThis")}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        <div>
          {!pol ? (
            <p className="text-sm text-mut">{t("customers.nurtureFlow.s2.notChecked")}</p>
          ) : (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-ink">{t("customers.nurtureFlow.s2.policy")}</span>
                {v && <Badge tone={v.tone}>{t(v.labelKey)}</Badge>}
                {!checkedNow && <Badge tone="warn">{t("customers.nurtureFlow.s2.oldResult")}</Badge>}
                <span className="text-xs text-mut">{dateTime(pol.at)}</span>
              </div>
              <p className="text-sm text-ink2">{pol.summary}</p>
              {pol.issues.map((x, i) => (
                <div key={i} className={`rounded-lg border p-2.5 text-sm ${SEVERITY[x.severity]}`}>
                  <p className="font-medium text-ink">&quot;{x.quote}&quot;</p>
                  <p className="text-xs text-mut">{x.policy}</p>
                  <p className="mt-1 text-ink2">{x.explain}</p>
                  <p className="mt-1 text-ink2">
                    <b>{t("customers.nurtureFlow.s2.fix")}</b> {x.fix}
                  </p>
                </div>
              ))}
              {pol.rewrite && (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 p-3 text-sm">
                  <p className="mb-1 text-xs font-medium text-emerald-800">{t("customers.nurtureFlow.s2.rewritten")}</p>
                  <p className="whitespace-pre-wrap text-ink2">{pol.rewrite}</p>
                  <button type="button" className={`${btnClass("ghost")} mt-1`} onClick={() => set("message", pol.rewrite!)}>
                    {t("customers.nurtureFlow.s2.useRewrite")}
                  </button>
                </div>
              )}
              <p className="text-xs text-mut">{t("customers.nurtureFlow.s2.disclaimer")}</p>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

function Preview({ p, gateOk }: { p: Props; gateOk: boolean }) {
  const t = useT();
  const stageLabel = stageLabels(t);
  const [rows, setRows] = useState<PreviewRow[] | null>(null);
  const [showSkip, setShowSkip] = useState(false);
  const [loading, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const row = useAct();
  const [done, setDone] = useState<Record<string, string>>({});
  const load = () =>
    start(async () => {
      setError(null);
      const r = await previewFlowAction(p.flow.id);
      if (!r.ok) return setError(r.error);
      setRows(r.rows);
    });
  const ready = rows?.filter((r) => !r.skip) ?? [];
  const skipped = rows?.filter((r) => r.skip) ?? [];
  const list = showSkip ? [...ready, ...skipped] : ready;
  return (
    <div className="space-y-2 border-t border-line pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={btnClass("secondary")} disabled={loading || !p.isMeta} onClick={load}>
          {loading ? <Loader2 className="animate-spin" /> : <Users />} {rows ? t("customers.nurtureFlow.preview.reload") : t("customers.nurtureFlow.preview.load")}
        </button>
        <span className="text-xs text-mut">{t("customers.nurtureFlow.preview.help")}</span>
      </div>
      {error && <p className="text-sm text-rose-600">{error}</p>}
      <Err e={row.error} />
      {rows && (
        <>
          <p className="text-sm text-ink2">
            <b>{ready.length}</b>{t("customers.nurtureFlow.preview.counts", { skipped: skipped.length })}{" "}
            {skipped.length > 0 && (
              <button type="button" className="text-indigo-600 hover:underline" onClick={() => setShowSkip(!showSkip)}>
                ({showSkip ? t("customers.nurtureFlow.preview.hide") : t("customers.nurtureFlow.preview.why")})
              </button>
            )}
          </p>
          {!p.inHours && <p className="text-xs text-amber-700">{t("customers.nurtureFlow.preview.outsideHours", { from: SEND_FROM, to: SEND_TO })}</p>}
          <ul className="max-h-[32rem] divide-y divide-line overflow-y-auto rounded-lg border border-line">
            {list.map((r) => (
              <li key={r.conversationId} className={`space-y-1 p-3 text-sm ${r.skip ? "bg-soft/60" : ""}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0">
                    <span className="font-medium text-ink">{r.name}</span>
                    <span className="text-xs text-mut">
                      {" "}
                      · {r.stage ? (stageLabel[r.stage] ?? r.stage) : t("customers.nurtureRules.stages._none")}
                      {r.leadScore != null ? ` · ${t("customers.nurtureFlow.preview.points", { n: r.leadScore })}` : ""} · {t("customers.nurtureFlow.preview.customerAt", { at: dateTime(r.lastCustomerAt) })}
                    </span>
                  </span>
                  {done[r.conversationId] ? (
                    <Badge tone="good">{done[r.conversationId]}</Badge>
                  ) : r.skip ? (
                    <span className="text-xs text-amber-700">{r.skip}</span>
                  ) : (
                    <Badge tone="good">{t("customers.nurtureFlow.preview.eligible")}</Badge>
                  )}
                </div>
                {r.intent && <p className="text-xs text-mut">{t("customers.nurtureFlow.preview.need", { intent: r.intent })}</p>}
                <p className="text-xs text-mut">{t("customers.nurtureFlow.preview.lastText", { text: r.lastText })}</p>
                {!done[r.conversationId] && (
                  <div className="flex flex-wrap items-center gap-1.5 pt-1">
                    {r.link && (
                      <InboxLink href={r.link} name={r.name} className={btnClass("ghost")}>
                        <ExternalLink /> {t("customers.nurtureFlow.preview.openInbox")}
                      </InboxLink>
                    )}
                    <CopyButton text={r.text} />
                    <button
                      type="button"
                      className={btnClass("ghost")}
                      disabled={row.pending}
                      onClick={() => row.act(() => markManualAction(p.flow.id, { conversationId: r.conversationId, psid: r.psid, name: r.name, text: r.text }), () => setDone((d) => ({ ...d, [r.conversationId]: t("customers.nurtureFlow.preview.markManual") })))}
                    >
                      <Check /> {t("customers.nurtureFlow.preview.markManual")}
                    </button>
                    <button
                      type="button"
                      className={btnClass("ghost")}
                      disabled={row.pending || !gateOk}
                      title={gateOk ? "" : t("customers.nurtureFlow.preview.needGate")}
                      onClick={() =>
                        confirm(t("customers.nurtureFlow.preview.confirmSend", { name: r.name, text: r.text })) &&
                        row.act(() => testSendAction(p.flow.id, { conversationId: r.conversationId, psid: r.psid, name: r.name }), () => setDone((d) => ({ ...d, [r.conversationId]: t("customers.nurtureFlow.preview.doneSent") })))
                      }
                    >
                      <Play /> {t("customers.nurtureFlow.preview.sendOne")}
                    </button>
                    <button
                      type="button"
                      className={btnClass("ghost")}
                      disabled={row.pending}
                      onClick={() =>
                        confirm(t("customers.nurtureFlow.preview.confirmBlock", { name: r.name })) &&
                        row.act(() => optOutAction(p.clientId, p.flow.pageId ?? p.pages[0]?.id ?? "", r.psid, r.name, true), () => setDone((d) => ({ ...d, [r.conversationId]: t("customers.nurtureFlow.preview.doneBlocked") })))
                      }
                    >
                      {t("customers.nurtureFlow.preview.block")}
                    </button>
                  </div>
                )}
              </li>
            ))}
            {!list.length && <li className="p-3 text-sm text-mut">{t("customers.nurtureFlow.preview.none")}</li>}
          </ul>
        </>
      )}
    </div>
  );
}

function Retarget({ p }: { p: Props }) {
  const t = useT();
  const a = useAct();
  const [made, setMade] = useState<string | null>(null);
  const n = p.buckets.d7 + p.buckets.older;
  return (
    <Card title={t("customers.nurtureFlow.s5.title")}>
      <div className="space-y-2 text-sm text-ink2">
        <p>
          {n}{t("customers.nurtureFlow.s5.intro1")}<b>{p.buckets.phones}</b>{t("customers.nurtureFlow.s5.intro2")}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={btnClass("meta")}
            disabled={a.pending || p.buckets.phones < 20 || !p.isMeta}
            onClick={() => confirm(t("customers.nurtureFlow.s5.confirm", { n: p.buckets.phones })) && a.act(() => retargetAudienceAction(p.flow.id), (r) => setMade((r as { name?: string }).name ?? t("customers.nurtureFlow.s5.created")))}
          >
            <Users /> {a.pending ? t("customers.nurtureFlow.s5.creating") : t("customers.nurtureFlow.s5.make", { n: p.buckets.phones })}
          </button>
          <Link href={`/clients/${p.clientId}/audiences`} className={btnClass("ghost")}>
            {t("customers.nurtureFlow.s5.audiences")}
          </Link>
          <Link href={`/clients/${p.clientId}/create`} className={btnClass("ghost")}>
            {t("customers.nurtureFlow.s5.createCampaign")}
          </Link>
        </div>
        {p.buckets.phones < 20 && <p className="text-xs text-mut">{t("customers.nurtureFlow.s5.need20")}</p>}
        {made && <p className="text-sm text-emerald-700">{t("customers.nurtureFlow.s5.madeMsg", { name: made })}</p>}
        <Err e={a.error} />
      </div>
    </Card>
  );
}
