"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { pickTemplate, renderTemplate, templateDefs, TEMPLATE_MAX, unknownVars, varLabels, type TemplateDef, type TemplateKey, type Templates } from "@/lib/notify-templates";
import { saveNotifyTemplatesAction, suggestNotifyTemplateAction } from "@/app/notify-actions";
import { Spinner } from "./action-button";
import { btnClass, inputClass } from "./ui";
import { useT } from "@/i18n/client";

// Zalo / Telegram bot message templates. Two levels: the shared template (System settings, clientId = null, admin-only) and a client-specific template
// (Lead notifications) that overrides the shared one. Leaving the editor empty or identical to the shared template in use = no client template saved.
// Manual: edit directly, click a variable to insert it. Automatic: Claude suggests a template → the user reviews, edits, then Saves.

type Props = {
  clientId: string | null;
  clientName: string; // name substituted into {khach_hang} in the preview
  own: Templates; // template saved at this level
  global: Templates; // shared template (client level: used when the client template is empty)
  canEdit: boolean;
};

export function NotifyTemplatesEditor({ clientId, clientName, own, global, canEdit }: Props) {
  const router = useRouter();
  const t = useT();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const defs = templateDefs(t).filter((d) => !clientId || d.scope === "client");
  // Template in effect if this level has no template of its own: client → shared → default; shared → default.
  const fallback = (k: TemplateKey) => (clientId ? pickTemplate(k, undefined, global, t) : pickTemplate(k, undefined, undefined, t));
  const initial = Object.fromEntries(defs.map((d) => [d.key, own[d.key] ?? fallback(d.key)])) as Record<TemplateKey, string>;
  const [v, setV] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const dirty = defs.some((d) => v[d.key] !== saved[d.key]);

  const save = () =>
    start(async () => {
      const out: Templates = {};
      for (const d of defs) {
        const text = v[d.key].trim();
        if (text && text !== fallback(d.key)) out[d.key] = text;
      }
      const r = await saveNotifyTemplatesAction(clientId, out);
      setMsg(r.ok ? { ok: true, text: clientId ? t("notify.templatesEditor.savedClient") : t("notify.templatesEditor.savedGlobal") } : { ok: false, text: r.error });
      if (r.ok) {
        const next = Object.fromEntries(defs.map((d) => [d.key, v[d.key].trim() || fallback(d.key)])) as Record<TemplateKey, string>;
        setV(next);
        setSaved(next);
        router.refresh();
      }
    });

  return (
    <div className="space-y-3 text-sm">
      <p className="text-xs text-slate-500">
        {clientId ? (
          <>
            {t("notify.templatesEditor.introClientA")}{" "}
            <a href="/connections/templates" className="underline">
              {t("notify.templatesEditor.introLink")}
            </a>
            {t("notify.templatesEditor.introClientB")}
          </>
        ) : (
          t("notify.templatesEditor.introGlobal")
        )}{" "}
        {t("notify.templatesEditor.introTail")}
      </p>
      {defs.map((d) => (
        <TemplateBox key={d.key} def={d} clientId={clientId} clientName={clientName} value={v[d.key]} fallback={fallback(d.key)} canEdit={canEdit} onChange={(text) => setV((x) => ({ ...x, [d.key]: text }))} />
      ))}
      {msg && <p className={`rounded-lg px-3 py-2 ${msg.ok ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-700"}`}>{msg.text}</p>}
      {canEdit ? (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={btnClass("primary")} disabled={pending || !dirty} onClick={save}>
            {pending && <Spinner />} {t("notify.templatesEditor.save")}
          </button>
          {dirty && (
            <button type="button" className={btnClass("ghost")} disabled={pending} onClick={() => setV(saved)}>
              {t("notify.templatesEditor.discard")}
            </button>
          )}
          <span className="text-xs text-slate-500">{dirty ? t("notify.templatesEditor.unsaved") : t("notify.templatesEditor.upToDate")}</span>
        </div>
      ) : (
        <p className="text-xs text-slate-500">{t("notify.templatesEditor.adminOnly")}</p>
      )}
    </div>
  );
}

function TemplateBox({ def: d, clientId, clientName, value, fallback, canEdit, onChange }: { def: TemplateDef; clientId: string | null; clientName: string; value: string; fallback: string; canEdit: boolean; onChange: (t: string) => void }) {
  const t = useT();
  const labels = varLabels(t);
  const ref = useRef<HTMLTextAreaElement>(null);
  const [pending, start] = useTransition();
  const [ask, setAsk] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const changed = value.trim() !== fallback;
  const [open, setOpen] = useState(changed);
  const label = clientId ? (changed ? t("notify.templatesEditor.own") : fallback !== d.default ? t("notify.templatesEditor.sharedEdited") : t("notify.templatesEditor.shared")) : changed ? t("notify.templatesEditor.edited") : t("notify.templatesEditor.default");
  const preview = renderTemplate(value.trim() || fallback, { khach_hang: clientName, ...d.sample }, d.vars);
  const bad = unknownVars(d.key, value);

  const insert = (name: string) => {
    const el = ref.current;
    const tag = `{${name}}`;
    if (!el) return onChange(value + tag);
    const a = el.selectionStart ?? value.length;
    const b = el.selectionEnd ?? value.length;
    onChange(value.slice(0, a) + tag + value.slice(b));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(a + tag.length, a + tag.length);
    });
  };
  const suggest = () =>
    start(async () => {
      setNote(null);
      const r = await suggestNotifyTemplateAction(clientId, d.key, value, ask);
      if (!r.ok) return setNote({ ok: false, text: r.error });
      onChange(r.text);
      setNote({ ok: true, text: t("notify.templatesEditor.claudeNote", { why: r.why }) });
    });

  return (
    <details className="rounded-lg border border-slate-200 px-3 py-2" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="cursor-pointer select-none">
        <span className="font-medium text-slate-800">{d.label}</span> <span className={`text-xs ${changed ? "text-indigo-600" : "text-slate-400"}`}>· {label}</span>
      </summary>
      <p className="mt-1 text-xs text-slate-500">{d.hint}</p>
      <div className="mt-2 grid gap-3 lg:grid-cols-2">
        <div className="space-y-2">
          <textarea ref={ref} className={`${inputClass} font-mono text-xs`} rows={Math.min(10, Math.max(4, value.split("\n").length + 1))} value={value} disabled={!canEdit} maxLength={TEMPLATE_MAX} placeholder={fallback} onChange={(e) => onChange(e.target.value)} />
          <div className="flex flex-wrap gap-1">
            {d.vars.map((n) => (
              <button key={n} type="button" title={labels[n]} disabled={!canEdit} className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[11px] text-slate-600 hover:border-indigo-300 hover:text-indigo-700 disabled:opacity-60" onClick={() => insert(n)}>
                {`{${n}}`}
              </button>
            ))}
          </div>
          <ul className="space-y-0.5 text-[11px] text-slate-500">
            {d.vars.map((n) => (
              <li key={n}>
                <code>{`{${n}}`}</code>: {labels[n]}
              </li>
            ))}
          </ul>
          {bad.length > 0 && <p className="text-xs text-amber-700">{t("notify.templatesEditor.unknown", { list: bad.map((b) => `{${b}}`).join(", ") })}</p>}
          {canEdit && (
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className={btnClass("ghost")} disabled={!changed} onClick={() => onChange(fallback)} title={clientId ? t("notify.templatesEditor.useSharedTitle") : t("notify.templatesEditor.restoreTitle")}>
                {clientId ? t("notify.templatesEditor.useShared") : t("notify.templatesEditor.restore")}
              </button>
              {clientId && fallback !== d.default && (
                <button type="button" className={btnClass("ghost")} disabled={value.trim() === d.default} onClick={() => onChange(d.default)}>
                  {t("notify.templatesEditor.restore")}
                </button>
              )}
            </div>
          )}
          {canEdit && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-48 flex-1">
                <input className={inputClass} value={ask} onChange={(e) => setAsk(e.target.value)} placeholder={t("notify.templatesEditor.askPlaceholder")} />
              </span>
              <button type="button" className={btnClass("ai")} disabled={pending} onClick={suggest}>
                {pending && <Spinner />} {t("notify.templatesEditor.suggest")}
              </button>
            </div>
          )}
          {note && <p className={`text-xs ${note.ok ? "text-emerald-700" : "text-rose-600"}`}>{note.text}</p>}
        </div>
        <div>
          <p className="mb-1 text-xs text-slate-500">{t("notify.templatesEditor.preview")}</p>
          <div className="rounded-lg border border-slate-200 bg-panel px-3 py-2 text-[13px] whitespace-pre-line text-slate-800 shadow-sm">{preview || <span className="text-slate-400">{t("notify.templatesEditor.empty")}</span>}</div>
          <p className="mt-1 text-right text-[11px] text-slate-400">{t("notify.templatesEditor.chars", { n: value.length, max: TEMPLATE_MAX })}</p>
        </div>
      </div>
    </details>
  );
}
