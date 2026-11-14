"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { addKnowledgeTextAction, deleteKnowledgeAction, updateKnowledgeAction, uploadKnowledgeAction } from "@/app/actions";
import { CATEGORY_ICON, KNOWLEDGE_CATEGORIES, categoryHint, categoryLabel } from "@/lib/knowledge-rules";
import { useT } from "@/i18n/client";
import { dateTime } from "@/lib/format";
import { norm } from "@/lib/text";
import { btnClass, Card, Empty, inputClass } from "./ui";
import { Spinner } from "./action-button";

export type KnowledgeRow = {
  id: string;
  title: string;
  category: string;
  useForAi: boolean;
  fileName: string | null;
  fileSize: number | null;
  chars: number;
  preview: string;
  search: string;
  issue: "empty" | "garbled" | null;
  updatedAt: string;
};

type Usage = { used: number; total: number; chars: number; budget: number; truncated: string[] };

const ACCEPT = ".pdf,.docx,.xlsx,.csv,.txt,.md,.html,.htm,.json";

export function fileSizeLabel(n: number | null) {
  if (n == null) return "";
  return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function KnowledgeBoard({ clientId, rows, usage }: { clientId: string; rows: KnowledgeRow[]; usage: Usage }) {
  const t = useT();
  const [cat, setCat] = useState<string>("all");
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState<null | "file" | "text">(rows.length ? null : "file");
  const shown = useMemo(() => {
    const k = norm(q.trim());
    return rows.filter((r) => (cat === "all" || r.category === cat) && (!k || r.search.includes(k)));
  }, [rows, cat, q]);
  const count = (c: string) => (c === "all" ? rows.length : rows.filter((r) => r.category === c).length);
  const pct = Math.min(100, Math.round((usage.chars / usage.budget) * 100));

  return (
    <div className="space-y-4">
      {/* Overview: how many documents Claude is using */}
      <div className="flex flex-wrap items-start justify-between gap-4 rounded-xl border border-indigo-100 bg-indigo-50/50 p-4">
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="text-sm font-medium text-slate-800">
            {t("settings.knowledgeBoard.usingBefore")}<b>{usage.used}</b>/{rows.length}{t("settings.knowledgeBoard.usingAfter")}
          </p>
          <div className="h-1.5 max-w-md overflow-hidden rounded-full bg-panel">
            <div className={`h-full rounded-full ${pct >= 100 ? "bg-amber-500" : "bg-indigo-500"}`} style={{ width: `${pct}%` }} />
          </div>
          <p className="text-xs text-slate-500">
            {t("settings.knowledgeBoard.chars", { used: usage.chars.toLocaleString("vi-VN"), budget: usage.budget.toLocaleString("vi-VN") })}
            {usage.truncated.length > 0 && (
              <span className="text-amber-700"> {t("settings.knowledgeBoard.truncated", { list: usage.truncated.join(", ") })}</span>
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <button type="button" className={btnClass(adding === "file" ? "primary" : "secondary")} onClick={() => setAdding(adding === "file" ? null : "file")}>
            {t("settings.knowledgeBoard.uploadBtn")}
          </button>
          <button type="button" className={btnClass(adding === "text" ? "primary" : "secondary")} onClick={() => setAdding(adding === "text" ? null : "text")}>
            {t("settings.knowledgeBoard.typeBtn")}
          </button>
        </div>
      </div>

      {adding === "file" && <UploadPanel clientId={clientId} onDone={() => setAdding(null)} />}
      {adding === "text" && <TextPanel clientId={clientId} onDone={() => setAdding(null)} />}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        {[{ key: "all", icon: "" }, ...KNOWLEDGE_CATEGORIES].map((c) =>
          c.key === "all" || count(c.key) > 0 ? (
            <button
              key={c.key}
              type="button"
              onClick={() => setCat(c.key)}
              className={`rounded-full px-3 py-1 text-xs font-medium ${cat === c.key ? "bg-ink text-panel" : "bg-panel text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"}`}
            >
              {c.icon && `${c.icon} `}
              {c.key === "all" ? t("settings.knowledgeBoard.all") : categoryLabel(c.key, t)} <span className="opacity-60">{count(c.key)}</span>
            </button>
          ) : null,
        )}
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("settings.knowledgeBoard.searchPlaceholder")} className={`${inputClass} ml-auto max-w-xs`} />
      </div>

      {!rows.length ? (
        <Empty>
          {t("settings.knowledgeBoard.empty")}
        </Empty>
      ) : !shown.length ? (
        <Empty>{t("settings.knowledgeBoard.noMatch")}</Empty>
      ) : (
        <div className="grid gap-3 @3xl:grid-cols-2">
          {shown.map((r) => (
            <DocCard key={r.id} clientId={clientId} r={r} />
          ))}
        </div>
      )}
    </div>
  );
}

function DocCard({ clientId, r }: { clientId: string; r: KnowledgeRow }) {
  const t = useT();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const act = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      const res = await fn();
      if (!res.ok) setError(res.error ?? t("settings.knowledgeBoard.error"));
      else router.refresh();
    });

  return (
    <div className={`flex flex-col gap-2 rounded-xl border bg-panel p-4 ${r.useForAi ? "border-slate-200" : "border-dashed border-slate-300 opacity-80"}`}>
      <div className="flex items-start justify-between gap-3">
        <Link href={`/clients/${clientId}/knowledge/${r.id}`} className="min-w-0 group">
          <p className="truncate font-medium text-slate-900 group-hover:text-indigo-700">
            {CATEGORY_ICON[r.category]} {r.title}
          </p>
          <p className="mt-0.5 text-xs text-slate-500">
            {categoryLabel(r.category, t)} · {r.fileName ? `${r.fileName} (${fileSizeLabel(r.fileSize)})` : t("settings.knowledgeBoard.manual")} · {t("settings.knowledgeBoard.charCount", { count: r.chars.toLocaleString("vi-VN") })} · {dateTime(r.updatedAt)}
          </p>
        </Link>
        <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-slate-600" title={t("settings.knowledgeBoard.useTitle")}>
          <input
            type="checkbox"
            checked={r.useForAi}
            disabled={pending}
            onChange={(e) => act(() => updateKnowledgeAction(r.id, { useForAi: e.target.checked }))}
            className="h-4 w-4 accent-indigo-600"
          />
          {t("settings.knowledgeBoard.use")}
        </label>
      </div>
      {r.issue && (
        <p className="rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800">
          {r.issue === "empty" ? t("settings.knowledgeBoard.issueEmpty") : t("settings.knowledgeBoard.issueGarbled")}{" "}
          <Link href={`/clients/${clientId}/knowledge/${r.id}`} className="font-medium underline">
            {r.fileName?.toLowerCase().endsWith(".pdf") ? t("settings.knowledgeBoard.openReread") : t("settings.knowledgeBoard.openEdit")}
          </Link>
        </p>
      )}
      <p className="line-clamp-2 text-sm text-slate-600">{r.preview || <i className="text-slate-400">{t("settings.knowledgeBoard.blank")}</i>}</p>
      <div className="flex items-center gap-1">
        <Link href={`/clients/${clientId}/knowledge/${r.id}`} className={btnClass("secondary")}>{t("settings.knowledgeBoard.open")}</Link>
        {r.fileName && (
          <a href={`/api/knowledge/${r.id}`} target="_blank" rel="noreferrer" className={btnClass("ghost")}>{t("settings.knowledgeBoard.original")}</a>
        )}
        <button
          type="button"
          className={`${btnClass("ghost")} ml-auto text-rose-600`}
          disabled={pending}
          onClick={() => confirm(`${t("settings.knowledgeBoard.confirmDelete", { title: r.title })}${r.fileName ? ` ${t("settings.knowledgeBoard.confirmDeleteFile")}` : ""}`) && act(() => deleteKnowledgeAction(r.id))}
        >
          {pending ? <Spinner /> : t("settings.knowledgeBoard.delete")}
        </button>
      </div>
      {error && <p className="text-xs text-rose-600">{error}</p>}
    </div>
  );
}

type Item = { name: string; state: "wait" | "up" | "ok" | "warn" | "err"; note?: string };

function UploadPanel({ clientId, onDone }: { clientId: string; onDone: () => void }) {
  const t = useT();
  const [category, setCategory] = useState("auto");
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const upload = async (files: File[]) => {
    if (!files.length || busy) return;
    setBusy(true);
    const list: Item[] = files.map((f) => ({ name: f.name, state: "wait" }));
    setItems(list);
    const set = (i: number, patch: Partial<Item>) => setItems((cur) => cur.map((x, j) => (j === i ? { ...x, ...patch } : x)));
    // One file at a time: each request is small, progress can be shown, and 1 failed file doesn't break the whole batch.
    for (const [i, f] of files.entries()) {
      set(i, { state: "up" });
      const fd = new FormData();
      fd.set("file", f);
      fd.set("category", category);
      const res = await uploadKnowledgeAction(clientId, fd);
      if (!res.ok) set(i, { state: "err", note: res.error });
      else set(i, res.warning ? { state: "warn", note: res.warning } : { state: "ok" });
    }
    setBusy(false);
    router.refresh();
  };

  return (
    <Card title={t("settings.knowledgeBoard.uploadTitle")} action={<button type="button" className={btnClass("ghost")} onClick={onDone}>{t("settings.knowledgeBoard.close")}</button>}>
      <div className="space-y-3">
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            upload([...e.dataTransfer.files]);
          }}
          onClick={() => input.current?.click()}
          className={`cursor-pointer rounded-xl border-2 border-dashed p-6 text-center text-sm ${drag ? "border-indigo-400 bg-indigo-50" : "border-slate-300 hover:bg-slate-50"}`}
        >
          <p className="font-medium text-slate-700">{t("settings.knowledgeBoard.dropHere")}</p>
          <p className="mt-1 text-xs text-slate-500">{t("settings.knowledgeBoard.formats")}</p>
          <input ref={input} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => upload([...(e.target.files ?? [])])} />
        </div>
        <label className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
          {t("settings.knowledgeBoard.groupLabel")}
          <select value={category} onChange={(e) => setCategory(e.target.value)} className={`${inputClass} w-auto`}>
            <option value="auto">{t("settings.knowledgeBoard.autoDetect")}</option>
            {KNOWLEDGE_CATEGORIES.map((c) => (
              <option key={c.key} value={c.key}>{c.icon} {categoryLabel(c.key, t)}</option>
            ))}
          </select>
        </label>
        {items.length > 0 && (
          <ul className="space-y-1 text-sm">
            {items.map((it, i) => (
              <li key={i} className="flex gap-2">
                <span className="w-5 shrink-0 text-center">{{ wait: "·", up: "", ok: "✓", warn: "⚠", err: "✕" }[it.state] || <Spinner />}</span>
                <span className="min-w-0">
                  <span className={it.state === "err" ? "text-rose-700" : "text-slate-800"}>{it.name}</span>
                  {it.note && <span className={`block text-xs ${it.state === "err" ? "text-rose-600" : "text-amber-700"}`}>{it.note}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-slate-500">
          {t("settings.knowledgeBoard.uploadNote")}
        </p>
      </div>
    </Card>
  );
}

function TextPanel({ clientId, onDone }: { clientId: string; onDone: () => void }) {
  const t = useT();
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("product");
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  return (
    <Card title={t("settings.knowledgeBoard.textTitle")} action={<button type="button" className={btnClass("ghost")} onClick={onDone}>{t("settings.knowledgeBoard.close")}</button>}>
      <div className="space-y-3">
        <div className="grid gap-3 @2xl:grid-cols-[1fr_16rem]">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("settings.knowledgeBoard.titlePlaceholder")} className={inputClass} />
          <select value={category} onChange={(e) => setCategory(e.target.value)} className={inputClass}>
            {KNOWLEDGE_CATEGORIES.map((c) => (
              <option key={c.key} value={c.key}>{c.icon} {categoryLabel(c.key, t)}</option>
            ))}
          </select>
        </div>
        <p className="text-xs text-slate-500">{categoryHint(category, t)}</p>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={10}
          className={inputClass}
          placeholder={t("settings.knowledgeBoard.contentPlaceholder")}
        />
        <div className="flex items-center gap-3">
          <button
            type="button"
            className={btnClass("primary")}
            disabled={pending || !title.trim() || !content.trim()}
            onClick={() =>
              start(async () => {
                setError(null);
                const res = await addKnowledgeTextAction(clientId, { title, category, content });
                if (!res.ok) return setError(res.error);
                setTitle("");
                setContent("");
                router.refresh();
                onDone();
              })
            }
          >
            {pending && <Spinner />}{t("settings.knowledgeBoard.saveToKb")}
          </button>
          {error && <span className="text-sm text-rose-600">{error}</span>}
        </div>
      </div>
    </Card>
  );
}
