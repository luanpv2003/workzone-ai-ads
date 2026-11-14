"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { resolveBotNoteAction, saveBotSettingsAction, testBotAnswerAction } from "@/app/bot-actions";
import { Spinner } from "./action-button";
import { btnClass, inputClass } from "./ui";
import { useT } from "@/i18n/client";

// Bot replies in groups: enable Claude + bot instructions (per client, or shared when clientId is null), plus a test-question box.

export function BotSettingsForm({ clientId, initial, maxLen }: { clientId: string | null; initial: { ai: boolean; guide: string }; maxLen: number }) {
  const t = useT();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [v, setV] = useState(initial);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const changed = v.ai !== initial.ai || v.guide !== initial.guide;
  const save = () =>
    start(async () => {
      const r = await saveBotSettingsAction(clientId, v);
      setMsg(r.ok ? { ok: true, text: t("core.botSettings.saved") } : { ok: false, text: r.error });
      if (r.ok) router.refresh();
    });
  return (
    <div className="space-y-3 text-sm">
      {clientId && (
        <label className="flex items-start gap-2">
          <input type="checkbox" className="mt-0.5" checked={v.ai} onChange={(e) => setV({ ...v, ai: e.target.checked })} />
          <span>
            <span className="text-ink">{t("core.botSettings.aiLabel")}</span>
            <span className="block text-xs text-mut">
              {t("core.botSettings.aiOn")}
              {t("core.botSettings.aiOff")}
            </span>
          </span>
        </label>
      )}
      <label className="block">
        <span className="mb-1 block font-medium text-ink2">{clientId ? t("core.botSettings.guideOwn") : t("core.botSettings.guideShared")}</span>
        <textarea value={v.guide} onChange={(e) => setV({ ...v, guide: e.target.value })} rows={7} maxLength={maxLen} placeholder={t("core.botSettings.guideHint")} className={inputClass} />
        <span className="mt-1 block text-xs text-mut">
          {t("core.botSettings.guideHelp")} {v.guide.length}/{maxLen}
        </span>
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={btnClass("primary")} disabled={pending || !changed} onClick={save}>
          {pending && <Spinner />} {t("core.botSettings.save")}
        </button>
        {msg && <span className={msg.ok ? "text-emerald-700" : "text-rose-600"}>{msg.text}</span>}
      </div>
    </div>
  );
}

export function BotTester({ clientId }: { clientId: string }) {
  const t = useT();
  const MODE_LABEL: Record<string, string> = { ai: t("core.botSettings.modeAi"), report: t("core.botSettings.modeReport"), fallback: t("core.botSettings.modeFallback") };
  const [pending, start] = useTransition();
  const [q, setQ] = useState("");
  const [res, setRes] = useState<Awaited<ReturnType<typeof testBotAnswerAction>> | null>(null);
  const ask = () =>
    start(async () => {
      setRes(null);
      setRes(await testBotAnswerAction(clientId, q));
    });
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && q.trim() && !pending && ask()}
          maxLength={1000}
          placeholder={t("core.botSettings.testPlaceholder")}
          className={`${inputClass} min-w-0 flex-1`}
        />
        <button type="button" className={btnClass("ai")} disabled={pending || !q.trim()} onClick={ask}>
          {pending && <Spinner />} {t("core.botSettings.testAsk")}
        </button>
      </div>
      <p className="text-xs text-mut">{t("core.botSettings.testNote")}</p>
      {res &&
        (res.ok ? (
          <div className="rounded-lg border border-line bg-slate-50 p-3">
            <p className="mb-2 text-xs text-mut">
              {MODE_LABEL[res.mode] ?? res.mode} · {t("core.botSettings.seconds", { s: (res.ms / 1000).toFixed(1) })}{!res.answered && t("core.botSettings.missingInfo")}
              {res.error && <span className="text-rose-600"> · {res.error}</span>}
            </p>
            <p className="whitespace-pre-line break-words text-ink">{res.answer}</p>
            {res.note && <p className="mt-2 whitespace-pre-line rounded-md bg-amber-50 p-2 text-xs text-amber-800">{t("core.botSettings.memorySuggestion", { note: res.note })}</p>}
          </div>
        ) : (
          <p className="text-rose-600">{res.error}</p>
        ))}
    </div>
  );
}

/** A memory suggestion from the group: edit if needed → Add to instructions / Dismiss. */
export function BotNoteItem({ clientId, id, note }: { clientId: string; id: string; note: string }) {
  const t = useT();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [text, setText] = useState(note);
  const [error, setError] = useState<string | null>(null);
  const act = (action: "add" | "dismiss") =>
    start(async () => {
      const r = await resolveBotNoteAction(clientId, id, action, text);
      if (!r.ok) return setError(r.error);
      router.refresh();
    });
  return (
    <div className="space-y-2">
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={Math.min(6, text.split("\n").length + 1)} maxLength={1000} className={inputClass} />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={btnClass("primary")} disabled={pending || !text.trim()} onClick={() => act("add")}>
          {pending && <Spinner />} {t("core.botSettings.addToGuide")}
        </button>
        <button type="button" className={btnClass("ghost")} disabled={pending} onClick={() => act("dismiss")}>
          {t("core.botSettings.dismiss")}
        </button>
        {error && <span className="text-sm text-rose-600">{error}</span>}
      </div>
    </div>
  );
}
