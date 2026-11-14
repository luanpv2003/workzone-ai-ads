"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { disconnectGhlAction, requestGhlSyncAction, rotateGhlHookAction, saveGhlAction, saveGhlSettingsAction } from "@/app/highlevel-actions";
import type { GhlPipeline } from "@/lib/highlevel";
import { suggestReverse, type ReverseMap, type StageFeedback, type StageMap } from "@/lib/highlevel-map";
import { Field, btnClass, inputClass } from "./ui";
import { useLocale, useT } from "@/i18n/client";
import { feedbackOptionLabel } from "@/lib/highlevel-map";

// Client settings → HighLevel CRM: paste Location ID + Private Integration token (the user pastes it; the token is never shown again),
// test then save; pick the pipeline that receives leads, the stage for new leads, and map stages → sales rating (the system suggests, the user edits);
// reverse-map ratings edited in the system → HighLevel stages, contract pipeline, webhook link so HighLevel reports changes instantly.

export function HighlevelConnect({
  clientId,
  fields,
  current,
}: {
  clientId: string;
  fields: { field: keyof StageFeedback; label: string; options: readonly string[] }[]; // Contact / Quality / Outcome (FEEDBACK_FIELDS)
  current: {
    locationId: string | null;
    hasToken: boolean;
    location: string | null;
    pipelines: GhlPipeline[];
    pipelineId: string | null;
    stageId: string | null;
    stageMap: StageMap;
    push: boolean;
    since: string;
    syncedAt: string | null;
    error: string | null;
    requested: boolean;
    linked: number;
    withStage: number;
    reverseMap: ReverseMap;
    dealPipelineId: string | null;
    hookUrl: string | null; // full webhook link (null = not created yet)
  };
}) {
  const router = useRouter();
  const t = useT();
  const locale = useLocale();
  const loc = locale === "en" ? "en-US" : "vi-VN";
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [creds, setCreds] = useState({ locationId: current.locationId ?? "", token: "" });
  const [editing, setEditing] = useState(!current.hasToken);
  const [cfg, setCfg] = useState({
    pipelineId: current.pipelineId ?? "",
    stageId: current.stageId ?? "",
    stageMap: current.stageMap,
    push: current.push,
    since: current.since,
    // No reverse-mapping table yet (client connected before this feature existed): pre-suggest from the selected pipeline; the user reviews, then Saves.
    reverseMap: Object.keys(current.reverseMap).length
      ? current.reverseMap
      : suggestReverse(
          current.pipelines.find((p) => p.id === current.pipelineId),
          current.stageMap,
          Object.fromEntries(fields.map((x) => [x.field, x.options])),
        ),
    dealPipelineId: current.dealPipelineId ?? "",
  });
  const [hookUrl, setHookUrl] = useState(current.hookUrl);
  const pipe = current.pipelines.find((p) => p.id === cfg.pipelineId);

  const save = () =>
    start(async () => {
      const r = await saveGhlAction(clientId, creds);
      if (r.ok) {
        setMsg({ ok: true, text: t("customers.highlevelConnect.connectedMsg", { location: r.location, n: r.pipelines.length }) });
        setCreds({ ...creds, token: "" });
        setCfg({ ...cfg, pipelineId: r.pipelineId ?? "", stageId: r.stageId ?? "", stageMap: r.stageMap, reverseMap: r.reverseMap });
        setEditing(false);
        router.refresh();
      } else setMsg({ ok: false, text: r.error });
    });
  const saveCfg = () =>
    start(async () => {
      const r = await saveGhlSettingsAction(clientId, cfg);
      setMsg(r.ok ? { ok: true, text: t("customers.highlevelConnect.settingsSaved") } : { ok: false, text: r.error });
      if (r.ok) router.refresh();
    });
  const sync = () =>
    start(async () => {
      const r = await requestGhlSyncAction(clientId);
      setMsg(r.ok ? { ok: true, text: t("customers.highlevelConnect.syncRequested") } : { ok: false, text: r.error });
      if (r.ok) router.refresh();
    });
  const disconnect = () => {
    if (!window.confirm(t("customers.highlevelConnect.confirmDisconnect"))) return;
    start(async () => {
      const r = await disconnectGhlAction(clientId);
      setMsg(r.ok ? { ok: true, text: t("customers.highlevelConnect.disconnected") } : { ok: false, text: r.error });
      if (r.ok) {
        setCreds({ locationId: "", token: "" });
        setEditing(true);
        router.refresh();
      }
    });
  };
  const rotateHook = () => {
    if (hookUrl && !window.confirm(t("customers.highlevelConnect.confirmRotate"))) return;
    start(async () => {
      const r = await rotateGhlHookAction(clientId);
      if (r.ok) {
        setHookUrl(`${window.location.origin}/api/ghl/${r.key}`);
        setMsg({ ok: true, text: t("customers.highlevelConnect.hookCreated") });
      } else setMsg({ ok: false, text: r.error });
    });
  };
  const setStage = (stageId: string, field: keyof StageFeedback, value: string) =>
    setCfg({ ...cfg, stageMap: { ...cfg.stageMap, [stageId]: { ...(cfg.stageMap[stageId] ?? {}), [field]: value } } });

  return (
    <div className="space-y-4 text-sm">
      <p className="text-slate-600">
        {t("customers.highlevelConnect.intro1")}<b>{t("customers.highlevelConnect.introList")}</b>{t("customers.highlevelConnect.intro2")}
      </p>
      {msg && <p className={`rounded-lg px-3 py-2 ${msg.ok ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-700"}`}>{msg.text}</p>}

      {current.hasToken && (
        <div className={`rounded-lg border px-3 py-2.5 ${current.error ? "border-rose-200 bg-rose-50" : "border-line"}`}>
          <p className="font-medium text-ink">
            {t("customers.highlevelConnect.subAccount")} <span className="font-mono">{current.location ?? current.locationId}</span>
            <span className="font-normal text-mut">
              {" "}
              {t("customers.highlevelConnect.counts", { linked: current.linked.toLocaleString(loc), staged: current.withStage.toLocaleString(loc) })}
            </span>
          </p>
          <p className="mt-0.5 text-xs text-mut">
            {current.requested
              ? t("customers.highlevelConnect.waiting")
              : current.syncedAt
                ? t("customers.highlevelConnect.lastSync", { time: new Date(current.syncedAt).toLocaleString(loc, { dateStyle: "short", timeStyle: "short" }) })
                : t("customers.highlevelConnect.neverSynced")}{" "}
            {t("customers.highlevelConnect.autoEvery")}
          </p>
          {current.error && <p className="mt-1 text-xs text-rose-700">{current.error}</p>}
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className={btnClass("primary")} disabled={pending || !current.pipelineId} onClick={sync}>
              {t("customers.highlevelConnect.syncNow")}
            </button>
            {!editing && (
              <button type="button" className={btnClass("ghost")} disabled={pending} onClick={() => setEditing(true)}>
                {t("customers.highlevelConnect.editConnection")}
              </button>
            )}
            <button type="button" className={btnClass("ghost")} disabled={pending} onClick={disconnect}>
              {t("customers.highlevelConnect.disconnect")}
            </button>
          </div>
        </div>
      )}

      {editing && (
        <div className="space-y-3 rounded-lg border border-line p-3">
          <p className="text-xs text-slate-600">
            {t("customers.highlevelConnect.get1")}<b>{t("customers.highlevelConnect.getPath")}</b>{t("customers.highlevelConnect.get2")}<b>Contacts</b>, <b>Opportunities</b>, <b>Locations</b>{t("customers.highlevelConnect.get3")}<b>{t("customers.highlevelConnect.getLoc")}</b>.
          </p>
          <div className="grid gap-3 @xl:grid-cols-2">
            <Field label="Location ID">
              <input className={inputClass} value={creds.locationId} onChange={(e) => setCreds({ ...creds, locationId: e.target.value })} autoComplete="off" />
            </Field>
            <Field label="Private Integration token" hint={current.hasToken ? t("customers.highlevelConnect.tokenHintKeep") : t("customers.highlevelConnect.tokenHintNew")}>
              <input
                className={inputClass}
                type="password"
                value={creds.token}
                onChange={(e) => setCreds({ ...creds, token: e.target.value })}
                autoComplete="new-password"
                placeholder={current.hasToken ? "••••••••" : ""}
              />
            </Field>
          </div>
          <div className="flex gap-2">
            <button type="button" className={btnClass("primary")} disabled={pending || !creds.locationId.trim() || (!current.hasToken && !creds.token.trim())} onClick={save}>
              {pending ? t("customers.highlevelConnect.checking") : t("customers.highlevelConnect.checkSave")}
            </button>
            {current.hasToken && (
              <button type="button" className={btnClass("ghost")} disabled={pending} onClick={() => setEditing(false)}>
                {t("customers.highlevelConnect.cancel")}
              </button>
            )}
          </div>
        </div>
      )}

      {current.hasToken && current.pipelines.length > 0 && (
        <div className="space-y-3 rounded-lg border border-line p-3">
          <div className="grid gap-3 @xl:grid-cols-2">
            <Field label={t("customers.highlevelConnect.pipelineLabel")}>
              <select
                className={inputClass}
                value={cfg.pipelineId}
                onChange={(e) => {
                  const p = current.pipelines.find((x) => x.id === e.target.value);
                  // Pipeline changed: re-suggest the reverse-mapping table from the new pipeline's stages.
                  const options = Object.fromEntries(fields.map((x) => [x.field, x.options]));
                  setCfg({ ...cfg, pipelineId: e.target.value, stageId: p?.stages[0]?.id ?? "", reverseMap: suggestReverse(p, cfg.stageMap, options), dealPipelineId: cfg.dealPipelineId === e.target.value ? "" : cfg.dealPipelineId });
                }}
              >
                {current.pipelines.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t("customers.highlevelConnect.stageLabel")}>
              <select className={inputClass} value={cfg.stageId} onChange={(e) => setCfg({ ...cfg, stageId: e.target.value })}>
                {pipe?.stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t("customers.highlevelConnect.sinceLabel")} hint={t("customers.highlevelConnect.sinceHint")}>
              <input className={inputClass} type="date" value={cfg.since} onChange={(e) => setCfg({ ...cfg, since: e.target.value })} />
            </Field>
            <Field label={t("customers.highlevelConnect.howLabel")}>
              <label className="flex items-center gap-2 py-2">
                <input type="checkbox" checked={cfg.push} onChange={(e) => setCfg({ ...cfg, push: e.target.checked })} />
                {t("customers.highlevelConnect.autoPush")}
              </label>
            </Field>
          </div>
          {pipe && (
            <div className="overflow-x-auto">
              <p className="mb-1 text-xs text-slate-600">{t("customers.highlevelConnect.mapIntro")}</p>
              <table className="w-full min-w-[560px] text-xs">
                <thead>
                  <tr className="text-left text-mut">
                    <th className="py-1 pr-2 font-medium">{t("customers.highlevelConnect.colStage")}</th>
                    {fields.map((f) => (
                      <th key={f.field} className="py-1 pr-2 font-medium">
                        {t(`customers.feedback.fields.${f.field}`)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pipe.stages.map((s) => (
                    <tr key={s.id} className="border-t border-line">
                      <td className="py-1 pr-2 text-ink">{s.name}</td>
                      {fields.map((f) => (
                        <td key={f.field} className="py-1 pr-2">
                          <select className={inputClass} value={cfg.stageMap[s.id]?.[f.field] ?? ""} onChange={(e) => setStage(s.id, f.field, e.target.value)}>
                            <option value="">—</option>
                            {f.options.map((o) => (
                              <option key={o} value={o}>
                                {feedbackOptionLabel(t, o)}
                              </option>
                            ))}
                          </select>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {pipe && (
            <div className="overflow-x-auto">
              <p className="mb-1 text-xs text-slate-600">
                {t("customers.highlevelConnect.reverseIntro")}
              </p>
              <table className="w-full min-w-[480px] text-xs">
                <tbody>
                  {[...fields].reverse().flatMap((f) =>
                    f.options.map((o) => {
                      const k = `${f.field}:${o}`;
                      return (
                        <tr key={k} className="border-t border-line">
                          <td className="py-1 pr-2 text-mut">{t(`customers.feedback.fields.${f.field}`)}</td>
                          <td className="py-1 pr-2 text-ink">{feedbackOptionLabel(t, o)}</td>
                          <td className="py-1 pr-2">
                            <select className={inputClass} value={cfg.reverseMap[k] ?? ""} onChange={(e) => setCfg({ ...cfg, reverseMap: { ...cfg.reverseMap, [k]: e.target.value } })}>
                              <option value="">{t("customers.highlevelConnect.noChange")}</option>
                              {pipe.stages.map((s) => (
                                <option key={s.id} value={s.id}>
                                  → {s.name}
                                </option>
                              ))}
                              <option value="won">{t("customers.highlevelConnect.markWon")}</option>
                              <option value="lost">{t("customers.highlevelConnect.markLost")}</option>
                            </select>
                          </td>
                        </tr>
                      );
                    }),
                  )}
                </tbody>
              </table>
            </div>
          )}
          <Field label={t("customers.highlevelConnect.dealLabel")} hint={t("customers.highlevelConnect.dealHint")}>
            <select className={inputClass} value={cfg.dealPipelineId} onChange={(e) => setCfg({ ...cfg, dealPipelineId: e.target.value })}>
              <option value="">{t("customers.highlevelConnect.dealNone")}</option>
              {current.pipelines
                .filter((p) => p.id !== cfg.pipelineId)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </Field>
          <button type="button" className={btnClass("primary")} disabled={pending || !cfg.pipelineId || !cfg.stageId} onClick={saveCfg}>
            {t("customers.highlevelConnect.saveSettings")}
          </button>
        </div>
      )}
      {current.hasToken && (
        <div className="space-y-2 rounded-lg border border-line p-3">
          <p className="font-medium text-ink">{t("customers.highlevelConnect.hookTitle")}</p>
          <p className="text-xs text-slate-600">
            {t("customers.highlevelConnect.hookIntro")}
          </p>
          {hookUrl ? (
            <div className="flex flex-wrap items-center gap-2">
              <input className={`${inputClass} font-mono text-xs`} readOnly value={hookUrl} onFocus={(e) => e.target.select()} />
              <button type="button" className={btnClass("secondary")} onClick={() => navigator.clipboard.writeText(hookUrl)}>
                {t("customers.highlevelConnect.copyLink")}
              </button>
              <button type="button" className={btnClass("ghost")} disabled={pending} onClick={rotateHook}>
                {t("customers.highlevelConnect.changeLink")}
              </button>
            </div>
          ) : (
            <button type="button" className={btnClass("secondary")} disabled={pending} onClick={rotateHook}>
              {t("customers.highlevelConnect.createHook")}
            </button>
          )}
          <ol className="list-decimal space-y-0.5 pl-5 text-xs text-slate-600">
            <li>{t("customers.highlevelConnect.step1a")}<b>{t("customers.highlevelConnect.step1b")}</b>.</li>
            <li>
              {t("customers.highlevelConnect.step2a")}<b>Pipeline Stage Changed</b>{t("customers.highlevelConnect.step2c")}{cfg.dealPipelineId ? t("customers.highlevelConnect.step2d") : ""}{t("customers.highlevelConnect.step2e")}<b>Opportunity Status Changed</b>.
            </li>
            <li>
              {t("customers.highlevelConnect.step3a")}<b>Webhook</b>, Method <b>POST</b>{t("customers.highlevelConnect.step3b")}
            </li>
            <li>
              {t("customers.highlevelConnect.step4a")}<b>Publish</b>{t("customers.highlevelConnect.step4b")}
            </li>
          </ol>
        </div>
      )}
    </div>
  );
}
