"use client";

import { useRef, useState, useTransition } from "react";
import { analyzeClientFilesAction, beginClientFilesAction, createClientAction, uploadClientFileChunkAction } from "@/app/actions";
import type { SetupResult } from "@/lib/client-setup";
import { categoryLabel } from "@/lib/knowledge-rules";
import { ClientForm, type ClientFormValues } from "./client-form";
import { btnClass, Card, inputClass } from "./ui";
import { Spinner } from "./action-button";
import { useT } from "@/i18n/client";

const ACCEPT = ".pdf,.docx,.xlsx,.csv,.txt,.md,.html,.htm,.json";
const CHUNK = 8 * 1024 * 1024; // upload in 8MB chunks (matches the server)
const MAX_FILE = 60 * 1024 * 1024;

/** Add a client: from documents (AI pre-fills, you review) or enter manually. */
export function NewClient({ workspaces }: { workspaces: { id: string; name: string }[] }) {
  const t = useT();
  const [mode, setMode] = useState<"ai" | "manual">("ai");
  const [files, setFiles] = useState<File[]>([]);
  const [note, setNote] = useState("");
  const [result, setResult] = useState<SetupResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const input = useRef<HTMLInputElement>(null);

  const add = (list: File[]) => setFiles((cur) => [...cur, ...list.filter((f) => !cur.some((c) => c.name === f.name && c.size === f.size))]);
  const analyze = () =>
    start(async () => {
      setError(null);
      const big = files.find((f) => f.size > MAX_FILE);
      if (big) return setError(t("core.newClient.tooBig", { name: big.name }));
      // 1. Upload files one by one, 8MB at a time
      const stagingId = await beginClientFilesAction();
      for (const [fi, f] of files.entries()) {
        const total = Math.max(1, Math.ceil(f.size / CHUNK));
        const fileKey = `f${fi}-${Date.now().toString(36)}`;
        for (let i = 0; i < total; i++) {
          setProgress(t("core.newClient.uploading", { i: fi + 1, n: files.length, name: f.name }) + (total > 1 ? ` (${Math.round(((i + 1) / total) * 100)}%)` : ""));
          const fd = new FormData();
          fd.set("stagingId", stagingId);
          fd.set("fileKey", fileKey);
          fd.set("fileName", f.name);
          fd.set("index", String(i));
          fd.set("total", String(total));
          fd.set("chunk", f.slice(i * CHUNK, (i + 1) * CHUNK));
          const r = await uploadClientFileChunkAction(fd);
          if (!r.ok) {
            setProgress(null);
            return setError(r.error);
          }
        }
      }
      // 2. AI reads and fills in the profile
      setProgress(t("core.newClient.reading"));
      const r = await analyzeClientFilesAction(stagingId, note);
      setProgress(null);
      if (r.ok) setResult(r.data);
      else setError(r.error);
    });

  const tab = (m: typeof mode, label: string) => (
    <button
      type="button"
      onClick={() => setMode(m)}
      className={`rounded-lg px-4 py-2 text-sm font-medium ${mode === m ? "bg-indigo-600 text-white" : "bg-panel text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"}`}
    >
      {label}
    </button>
  );

  const p = result?.profile;
  const initial: ClientFormValues | undefined = p && {
    name: p.name,
    industry: p.industry,
    brief: p.address && !p.brief.includes(p.address) ? `${p.brief}\n\n${t("core.newClient.address")} ${p.address}` : p.brief,
    currency: /^[A-Z]{3}$/.test(p.currency) ? p.currency : "VND",
    primaryResult: ["messages", "leads", "purchases", "link_clicks"].includes(p.primary_result) ? p.primary_result : "messages",
    targetCpr: p.target_cpr,
    targetRoas: null,
    maxDailyBudget: p.max_daily_budget,
    maxBudgetChangePct: 30,
    dataSource: "mock",
    metaAdAccountId: null,
    metaPageId: null,
    metaInstagramId: null,
    storeLat: null,
    storeLng: null,
    hasToken: false,
    metaTokenExpiresAt: null,
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {tab("ai", t("core.newClient.tabAi"))}
        {tab("manual", t("core.newClient.tabManual"))}
      </div>

      {mode === "manual" && (
        <Card>
          <ClientForm create={createClientAction} workspaces={workspaces} />
        </Card>
      )}

      {mode === "ai" && !result && (
        <Card>
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              {t("core.newClient.intro")}
            </p>
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDrag(true);
              }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDrag(false);
                add([...e.dataTransfer.files]);
              }}
              onClick={() => input.current?.click()}
              className={`cursor-pointer rounded-xl border-2 border-dashed p-8 text-center text-sm ${drag ? "border-indigo-400 bg-indigo-50" : "border-slate-300 hover:bg-slate-50"}`}
            >
              <p className="font-medium text-slate-700">{t("core.newClient.drop")}</p>
              <p className="mt-1 text-xs text-slate-500">{t("core.newClient.formats")}</p>
              <input ref={input} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => add([...(e.target.files ?? [])])} />
            </div>
            {files.length > 0 && (
              <ul className="flex flex-wrap gap-2">
                {files.map((f) => (
                  <li key={f.name + f.size} className="flex items-center gap-2 rounded-full bg-slate-100 py-1 pr-2 pl-3 text-xs text-slate-700">
                    {f.name}
                    <button type="button" className="text-slate-400 hover:text-rose-600" onClick={() => setFiles(files.filter((x) => x !== f))} aria-label={t("core.newClient.removeFile")}>
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              className={inputClass}
              placeholder={t("core.newClient.notePlaceholder")}
            />
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" className={btnClass("primary")} disabled={pending || (!files.length && !note.trim())} onClick={analyze}>
                {pending && <Spinner />}
                {pending ? (progress ?? t("core.newClient.processing")) : t("core.newClient.analyze")}
              </button>
              {error && <span className="text-sm text-rose-600">{error}</span>}
            </div>
          </div>
        </Card>
      )}

      {mode === "ai" && result && initial && (
        <>
          <Card title={t("core.newClient.resultTitle")}>
            <div className="space-y-3 text-sm">
              <ul className="space-y-1">
                {result.files.map((f) => {
                  const d = result.profile.documents.find((x) => x.file_name === f.fileName);
                  return (
                    <li key={f.fileName} className="flex flex-wrap items-baseline gap-2">
                      <span className="text-slate-800">📄 {d?.title ?? f.fileName}</span>
                      {d && <span className="text-xs text-slate-500">{t("core.newClient.toKnowledge", { category: categoryLabel(d.category, t) })}</span>}
                      <span className="text-xs text-slate-400">{t("core.newClient.chars", { n: f.chars.toLocaleString("vi-VN") })}</span>
                      {f.warning && <span className="text-xs text-amber-700">⚠ {f.warning}</span>}
                    </li>
                  );
                })}
              </ul>
              {result.profile.questions.length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900">
                  <p className="font-medium">{t("core.newClient.questions")}</p>
                  <ul className="mt-1 list-disc pl-5">
                    {result.profile.questions.map((q, i) => <li key={i}>{q}</li>)}
                  </ul>
                </div>
              )}
              <button type="button" className={btnClass("ghost")} onClick={() => setResult(null)}>{t("core.newClient.redo")}</button>
            </div>
          </Card>
          <Card>
            <ClientForm
              key={result.stagingId}
              initial={initial}
              create={createClientAction}
              workspaces={workspaces}
              hidden={{ stagingId: result.stagingId, stagingDocs: JSON.stringify(result.profile.documents) }}
            />
          </Card>
        </>
      )}
    </div>
  );
}
