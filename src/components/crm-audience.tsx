"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createCrmAudienceAction, previewCrmAudienceAction } from "@/app/highlevel-actions";
import type { CrmAudienceCounts } from "@/lib/crm-audience";
import { btnClass, Card, Field, inputClass } from "@/components/ui";
import { useT } from "@/i18n/client";

// Audiences page → "4. Tệp từ HighLevel CRM" (Audiences from HighLevel CRM): filter contacts by tag / pipeline, merge Meta lead forms, count first, then create the audience + Lookalike.

const fmt = (n: number) => n.toLocaleString("vi-VN");
const LAL_PCTS = [0, 1, 2, 3, 5];

export function CrmAudience({
  clientId,
  shortName,
  location,
  pipelines,
  defaultExclude,
}: {
  clientId: string;
  shortName: string;
  location: string | null;
  pipelines: { id: string; name: string }[];
  defaultExclude: string;
}) {
  const t = useT();
  const router = useRouter();
  const [pending, start] = useTransition();
  const day = new Date().toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" });
  const [f, setF] = useState({ excludeTags: defaultExclude, includeTags: "", pipelineIds: [] as string[], addLeadForms: true });
  const [name, setName] = useState(t("targeting.crmAudience.defaultName", { short: shortName, day }));
  const [pct, setPct] = useState(1);
  const [counts, setCounts] = useState<CrmAudienceCounts | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const change = (patch: Partial<typeof f>) => {
    setF({ ...f, ...patch });
    setCounts(null); // filter changed: recount before creating
  };

  const preview = () =>
    start(async () => {
      setMsg(null);
      const r = await previewCrmAudienceAction(clientId, f);
      if (r.ok) setCounts(r);
      else setMsg({ ok: false, text: r.error });
    });
  const create = () => {
    if (!counts) return;
    if (!window.confirm(t("targeting.crmAudience.confirm", { phones: fmt(counts.phones), emails: fmt(counts.emails), name, lal: pct ? t("targeting.crmAudience.confirmLal", { pct }) : "" }))) return;
    start(async () => {
      const r = await createCrmAudienceAction(clientId, { ...f, name, lookalike: pct ? { name: t("targeting.crmAudience.lalName", { name, pct }), pct } : null });
      if (r.ok) {
        setMsg({
          ok: !r.lookalikeError,
          text: t("targeting.crmAudience.created", {
            name: r.audience.name,
            received: fmt(r.audience.received),
            invalid: r.audience.invalid ? t("targeting.crmAudience.invalid", { n: fmt(r.audience.invalid) }) : "",
            lal: r.lookalike ? t("targeting.crmAudience.lalBuilding", { name: r.lookalike.name }) : r.lookalikeError ? t("targeting.crmAudience.lalFailed", { error: r.lookalikeError }) : "",
          }),
        });
        router.refresh();
      } else setMsg({ ok: false, text: r.error });
    });
  };

  return (
    <Card title={t("targeting.crmAudience.title")}>
      <div className="space-y-3 text-sm">
        <p className="text-slate-600">
          {t("targeting.crmAudience.intro1", { location: location ? ` (${location})` : "" })}{" "}
          <b>{t("targeting.crmAudience.introBold")}</b>{t("targeting.crmAudience.intro2")}
        </p>
        {msg && <p className={`rounded-lg px-3 py-2 ${msg.ok ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-700"}`}>{msg.text}</p>}
        <div className="grid gap-3 @xl:grid-cols-2">
          <Field label={t("targeting.crmAudience.excludeTags")} hint={t("targeting.crmAudience.excludeTagsHint")}>
            <input className={inputClass} value={f.excludeTags} onChange={(e) => change({ excludeTags: e.target.value })} />
          </Field>
          <Field label={t("targeting.crmAudience.includeTags")} hint={t("targeting.crmAudience.includeTagsHint")}>
            <input className={inputClass} value={f.includeTags} onChange={(e) => change({ includeTags: e.target.value })} placeholder={t("targeting.crmAudience.tagPlaceholder")} />
          </Field>
        </div>
        {pipelines.length > 0 && (
          <Field label={t("targeting.crmAudience.pipelines")} hint={t("targeting.crmAudience.pipelinesHint")}>
            <div className="flex flex-wrap gap-x-4 gap-y-1 py-1">
              {pipelines.map((p) => (
                <label key={p.id} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={f.pipelineIds.includes(p.id)}
                    onChange={(e) => change({ pipelineIds: e.target.checked ? [...f.pipelineIds, p.id] : f.pipelineIds.filter((x) => x !== p.id) })}
                  />
                  {p.name}
                </label>
              ))}
            </div>
          </Field>
        )}
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={f.addLeadForms} onChange={(e) => change({ addLeadForms: e.target.checked })} />
          {t("targeting.crmAudience.addLeadForms")}
        </label>
        <button type="button" className={btnClass("secondary")} disabled={pending} onClick={preview}>
          {pending && !counts ? t("targeting.crmAudience.reading") : t("targeting.crmAudience.count")}
        </button>

        {counts && (
          <div className="space-y-3 rounded-lg border border-line p-3">
            <p className="text-ink">
              {t("targeting.crmAudience.summary1", { scanned: fmt(counts.scanned), excluded: fmt(counts.excluded) })}<b>{fmt(counts.kept)}</b>
              {f.addLeadForms ? t("targeting.crmAudience.summaryLeadForms", { n: fmt(counts.leadForms) }) : ""} → <b>{t("targeting.crmAudience.phones", { n: fmt(counts.phones) })}</b>, <b>{t("targeting.crmAudience.emails", { n: fmt(counts.emails) })}</b>
            </p>
            {counts.topTags.length > 0 && (
              <p className="text-xs text-mut">
                {t("targeting.crmAudience.topTags", { tags: counts.topTags.map(([tag, n]) => `${tag} (${fmt(n)})`).join(" · ") })}
              </p>
            )}
            {counts.phones + counts.emails < 300 && <p className="text-xs text-amber-700">{t("targeting.crmAudience.tooFew")}</p>}
            <div className="grid gap-3 @xl:grid-cols-2">
              <Field label={t("targeting.crmAudience.audienceName")}>
                <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field label={t("targeting.crmAudience.withLookalike")}>
                <select className={inputClass} value={pct} onChange={(e) => setPct(Number(e.target.value))}>
                  {LAL_PCTS.map((p) => (
                    <option key={p} value={p}>
                      {p ? t("targeting.crmAudience.pctOption", { p }) : t("targeting.crmAudience.noLookalike")}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <button type="button" className={btnClass("primary")} disabled={pending || !name.trim() || !(counts.phones + counts.emails)} onClick={create}>
              {pending ? t("targeting.crmAudience.creating") : t("targeting.crmAudience.createBtn")}
            </button>
          </div>
        )}
      </div>
    </Card>
  );
}
