"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { deleteKnowledgeAction, transcribeKnowledgeAction, updateKnowledgeAction } from "@/app/actions";
import { KNOWLEDGE_CATEGORIES, categoryLabel } from "@/lib/knowledge-rules";
import { useT } from "@/i18n/client";
import { dateTime } from "@/lib/format";
import { btnClass, Card, Field, inputClass } from "./ui";
import { Spinner } from "./action-button";
import { fileSizeLabel } from "./knowledge-board";

type Doc = {
  id: string;
  title: string;
  category: string;
  content: string;
  useForAi: boolean;
  fileName: string | null;
  fileSize: number | null;
  createdAt: string;
  updatedAt: string;
};

export function KnowledgeEditor({ clientId, doc, issue, provider }: { clientId: string; doc: Doc; issue: "empty" | "garbled" | null; provider: "api" | "cli" }) {
  const t = useT();
  const [title, setTitle] = useState(doc.title);
  const [category, setCategory] = useState(doc.category);
  const [content, setContent] = useState(doc.content);
  const [useForAi, setUseForAi] = useState(doc.useForAi);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, startSave] = useTransition();
  const [reading, startRead] = useTransition();
  const router = useRouter();
  const back = `/clients/${clientId}/knowledge`;
  const dirty = title !== doc.title || category !== doc.category || content !== doc.content || useForAi !== doc.useForAi;
  const isPdf = !!doc.fileName?.toLowerCase().endsWith(".pdf");

  const save = () =>
    startSave(async () => {
      const res = await updateKnowledgeAction(doc.id, { title, category, content, useForAi });
      setMsg(res.ok ? { ok: true, text: t("settings.knowledgeEditor.saved") } : { ok: false, text: res.error });
      if (res.ok) router.refresh();
    });

  const transcribe = () => {
    if (dirty && !confirm(t("settings.knowledgeEditor.confirmUnsaved"))) return;
    if (!dirty && !confirm(t("settings.knowledgeEditor.confirmTranscribe", { file: doc.fileName ?? "", quota: provider === "cli" ? t("settings.knowledgeEditor.quota") : "" }))) return;
    setMsg(null);
    startRead(async () => {
      const res = await transcribeKnowledgeAction(doc.id);
      if (!res.ok) setMsg({ ok: false, text: res.error });
      else router.refresh();
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href={back} className="text-sm text-slate-500 hover:text-slate-800">{t("settings.knowledgeEditor.back")}</Link>
        <div className="flex flex-wrap items-center gap-2">
          {doc.fileName && (
            <a href={`/api/knowledge/${doc.id}`} target="_blank" rel="noreferrer" className={btnClass("secondary")}>
              ⬇ {doc.fileName} ({fileSizeLabel(doc.fileSize)})
            </a>
          )}
          {isPdf && (
            <button type="button" className={btnClass(issue ? "primary" : "secondary")} disabled={reading || saving} onClick={transcribe}>
              {reading && <Spinner />}
              {reading ? t("settings.knowledgeEditor.reading") : t("settings.knowledgeEditor.reread")}
            </button>
          )}
          <button
            type="button"
            className={`${btnClass("ghost")} text-rose-600`}
            disabled={reading || saving}
            onClick={() =>
              confirm(t("settings.knowledgeEditor.confirmDelete", { title: doc.title })) &&
              startSave(async () => {
                const res = await deleteKnowledgeAction(doc.id);
                if (res.ok) router.push(back);
                else setMsg({ ok: false, text: res.error });
              })
            }
          >
            {t("settings.knowledgeEditor.delete")}
          </button>
        </div>
      </div>

      {issue && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          {issue === "empty"
            ? t("settings.knowledgeEditor.issueEmpty")
            : t("settings.knowledgeEditor.issueGarbled")}{" "}
          {isPdf ? t("settings.knowledgeEditor.fixPdf") : t("settings.knowledgeEditor.fixPaste")}
          {!useForAi && ` ${t("settings.knowledgeEditor.disabledUntilFixed")}`}
        </div>
      )}

      <Card>
        <fieldset disabled={reading} className="space-y-4">
          <div className="grid gap-4 @2xl:grid-cols-[1fr_16rem]">
            <Field label={t("settings.knowledgeEditor.fieldTitle")}>
              <input value={title} onChange={(e) => setTitle(e.target.value)} className={inputClass} />
            </Field>
            <Field label={t("settings.knowledgeEditor.fieldGroup")}>
              <select value={category} onChange={(e) => setCategory(e.target.value)} className={inputClass}>
                {KNOWLEDGE_CATEGORIES.map((c) => (
                  <option key={c.key} value={c.key}>{c.icon} {categoryLabel(c.key, t)}</option>
                ))}
              </select>
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={useForAi} onChange={(e) => setUseForAi(e.target.checked)} className="h-4 w-4 accent-indigo-600" />
            {t("settings.knowledgeEditor.useForAi")}
          </label>
          <Field label={t("settings.knowledgeEditor.fieldContent", { count: content.length.toLocaleString("vi-VN") })} hint={t("settings.knowledgeEditor.contentHint")}>
            <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={24} className={`${inputClass} font-mono text-[13px] leading-relaxed`} />
          </Field>
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className={btnClass("primary")} disabled={!dirty || saving} onClick={save}>
              {saving && <Spinner />}{t("settings.knowledgeEditor.saveChanges")}
            </button>
            {dirty && <span className="text-xs text-amber-700">{t("settings.knowledgeEditor.unsaved")}</span>}
            {msg && <span className={`text-sm ${msg.ok ? "text-emerald-600" : "text-rose-600"}`}>{msg.text}</span>}
            <span className="ml-auto text-xs text-slate-400">{t("settings.knowledgeEditor.createdUpdated", { created: dateTime(doc.createdAt), updated: dateTime(doc.updatedAt) })}</span>
          </div>
        </fieldset>
      </Card>
    </div>
  );
}
