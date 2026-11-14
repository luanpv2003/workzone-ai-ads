"use client";

import { ArrowRight, Loader2, Send, Sparkles, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { askClaudeAction } from "@/app/ask-actions";
import type { AskAnswer } from "@/lib/ask";
import { useT } from "@/i18n/client";

type Turn = { q: string; a?: AskAnswer; error?: string };

/** Floating "Ask Claude" button + right slide-over panel. Knows the current client from the path. */
export function AskClaude({ clients }: { clients: Record<string, string> }) {
  const path = usePathname();
  const t = useT();
  const m = path.match(/^\/clients\/([^/]+)/);
  const clientId = m && m[1] !== "new" ? m[1] : null;
  const clientName = clientId ? clients[clientId] : null;
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [pending, start] = useTransition();
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns, pending]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const ask = (question: string) => {
    const text = question.trim();
    if (!text || pending) return;
    setQ("");
    setTurns((prev) => [...prev, { q: text }]);
    start(async () => {
      const r = await askClaudeAction(clientId, text);
      setTurns((prev) => prev.map((x, i) => (i === prev.length - 1 ? (r.ok ? { ...x, a: r.data } : { ...x, error: r.error }) : x)));
    });
  };
  const suggestions = clientId
    ? [t("ai.askPanel.suggestClient1"), t("ai.askPanel.suggestClient2"), t("ai.askPanel.suggestClient3"), t("ai.askPanel.suggestClient4")]
    : [t("ai.askPanel.suggestAll1"), t("ai.askPanel.suggestAll2"), t("ai.askPanel.suggestAll3")];

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed right-5 bottom-20 z-40 inline-flex h-11 items-center gap-2 rounded-full bg-indigo-600 px-5 text-sm font-medium text-white shadow-pop hover:opacity-95 md:bottom-6"
        >
          <Sparkles className="size-4" /> {t("ai.askPanel.button")}
        </button>
      )}
      {open && (
        <div className="fixed inset-0 z-[70] flex justify-end bg-[var(--overlay)]" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
          <aside className="flex h-full w-full max-w-md flex-col border-l border-line bg-panel shadow-pop" style={{ animation: "wz-in .15s ease-out" }}>
            <header className="flex items-center gap-2 border-b border-line px-4 py-3">
              <Sparkles className="size-4 text-violet-600" />
              <p className="flex-1 font-semibold text-ink">{t("ai.askPanel.button")}</p>
              <button type="button" onClick={() => setOpen(false)} className="grid size-8 place-items-center rounded-lg text-mut hover:bg-hover" aria-label={t("ai.askPanel.close")}>
                <X className="size-4" />
              </button>
            </header>
            <div className="border-b border-line px-4 py-2 text-xs text-mut">
              {t("ai.askPanel.askingAbout")} <span className="rounded-full bg-violet-50 px-2 py-0.5 font-medium text-violet-700">{clientName ?? t("ai.askPanel.allClients")}</span> {t("ai.askPanel.scopeNote")}
            </div>
            <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
              {!turns.length && (
                <div className="space-y-2">
                  <p className="text-sm text-mut">{t("ai.askPanel.suggestionsTitle")}</p>
                  {suggestions.map((s) => (
                    <button key={s} type="button" onClick={() => ask(s)} className="block w-full rounded-lg border border-line px-3 py-2 text-left text-sm text-ink hover:bg-hover">
                      {s}
                    </button>
                  ))}
                </div>
              )}
              {turns.map((turn, i) => (
                <div key={i} className="space-y-2">
                  <p className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md bg-indigo-600 px-3 py-2 text-sm text-white">{turn.q}</p>
                  {turn.error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{turn.error}</p>}
                  {turn.a && (
                    <div className="space-y-2 rounded-2xl rounded-bl-md border border-violet-200 bg-violet-50/50 p-3">
                      <p className="text-sm whitespace-pre-line text-ink">{turn.a.answer}</p>
                      {turn.a.table_columns.length > 0 && turn.a.table_rows.length > 0 && (
                        <div className="overflow-x-auto rounded-lg border border-line bg-panel">
                          <table className="w-full text-xs">
                            <thead className="bg-slate-50 text-left text-mut">
                              <tr>
                                {turn.a.table_columns.map((c) => (
                                  <th key={c} className="px-2 py-1.5 font-medium">
                                    {c}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-line">
                              {turn.a.table_rows.map((r, k) => (
                                <tr key={k}>
                                  {r.map((c, j) => (
                                    <td key={j} className={`px-2 py-1.5 tabular-nums ${j ? "text-right" : ""}`}>
                                      {c}
                                    </td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                      {turn.a.links.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {turn.a.links.map((l) => (
                            <Link key={l.href + l.label} href={l.href} onClick={() => setOpen(false)} className="inline-flex h-7 items-center gap-1 rounded-lg border border-line bg-panel px-2.5 text-xs font-medium text-ink hover:bg-hover">
                              {l.label} <ArrowRight className="size-3" />
                            </Link>
                          ))}
                        </div>
                      )}
                      <p className="text-[11px] text-mut2">{turn.a.source}</p>
                    </div>
                  )}
                </div>
              ))}
              {pending && (
                <p className="flex items-center gap-2 text-sm text-violet-700">
                  <Loader2 className="size-4 animate-spin" /> {t("ai.askPanel.thinking")}
                </p>
              )}
              <div ref={endRef} />
            </div>
            <form
              className="flex items-end gap-2 border-t border-line p-3"
              onSubmit={(e) => {
                e.preventDefault();
                ask(q);
              }}
            >
              <textarea
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    ask(q);
                  }
                }}
                rows={2}
                placeholder={t("ai.askPanel.placeholder")}
                className="min-h-10 flex-1 resize-none rounded-lg border border-line bg-panel px-3 py-2 text-sm text-ink outline-none placeholder:text-mut2 focus:border-indigo-400"
              />
              <button type="submit" disabled={pending || !q.trim()} className="grid size-10 place-items-center rounded-lg bg-indigo-600 text-white disabled:opacity-50" aria-label={t("ai.askPanel.send")}>
                <Send className="size-4" />
              </button>
            </form>
          </aside>
        </div>
      )}
    </>
  );
}
