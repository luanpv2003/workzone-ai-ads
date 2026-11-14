"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { previewManualNoticeAction, sendManualNoticeAction } from "@/app/notify-actions";
import { Spinner } from "./action-button";
import { btnClass } from "./ui";
import { useT } from "@/i18n/client";

// Client list → "Báo nhóm" (Notify group): manually report 1 lead to the Zalo / Telegram group (leads that came in before the bot was set up or before notifications were enabled).
// Click → preview exactly the message that will be sent (per the bot message template) → Send.

const fmt = (iso: string) => new Date(iso).toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });

export function ManualNotifyButton({ clientId, rowKey, sentAt, ack }: { clientId: string; rowKey: string; sentAt: string | null; ack: { by: string; at: string } | null }) {
  const router = useRouter();
  const t = useT();
  const [pending, start] = useTransition();
  const [preview, setPreview] = useState<{ text: string; targets: string[] } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const open = () =>
    start(async () => {
      setMsg(null);
      const r = await previewManualNoticeAction(clientId, rowKey);
      if (!r.ok) return setMsg({ ok: false, text: r.error });
      setPreview({ text: r.text, targets: r.targets });
    });
  const send = () =>
    start(async () => {
      const r = await sendManualNoticeAction(clientId, rowKey);
      setMsg(r.ok ? { ok: !r.partial, text: r.note } : { ok: false, text: r.error });
      if (r.ok) {
        setPreview(null);
        router.refresh();
      }
    });

  return (
    <div className="mt-1">
      {!preview && (
        <button type="button" className="text-[11px] text-indigo-600 hover:underline disabled:text-slate-400" disabled={pending} onClick={open} title={t("notify.manualNotify.tooltip")}>
          {pending ? t("notify.manualNotify.opening") : sentAt ? t("notify.manualNotify.notified", { time: fmt(sentAt) }) : t("notify.manualNotify.notify")}
        </button>
      )}
      {preview && (
        <div className="mt-1 w-72 rounded-lg border border-line bg-panel p-2 text-xs shadow-sm">
          <p className="mb-1 text-slate-500">{t("notify.manualNotify.sendTo", { list: preview.targets.join(", ") || t("notify.manualNotify.noTargets") })}</p>
          <p className="max-h-48 overflow-y-auto rounded bg-slate-50 px-2 py-1.5 whitespace-pre-line text-slate-800">{preview.text}</p>
          <div className="mt-2 flex items-center gap-2">
            <button type="button" className={btnClass("primary")} disabled={pending || !preview.targets.length} onClick={send}>
              {pending && <Spinner />} {t("notify.manualNotify.send")}
            </button>
            <button type="button" className={btnClass("ghost")} disabled={pending} onClick={() => setPreview(null)}>
              {t("notify.manualNotify.cancel")}
            </button>
          </div>
        </div>
      )}
      {ack && (
        <p className="mt-0.5 text-[11px] text-emerald-700" title={t("notify.manualNotify.ackTitle")}>
          {t("notify.manualNotify.ack", { by: ack.by || "?", time: fmt(ack.at) })}
        </p>
      )}
      {msg && <p className={`mt-0.5 text-[11px] ${msg.ok ? "text-emerald-700" : "text-rose-600"}`}>{msg.text}</p>}
    </div>
  );
}
