"use client";

import { useState, useTransition } from "react";
import { testAutoNotifyAction } from "@/app/auto-actions";
import { findNotifyChatsAction, type FoundChat } from "@/app/notify-actions";
import { chatCode, NOTIFY_CHANNEL_LABEL, type NotifyTarget } from "@/lib/lead-notify-config";
import { btnClass, inputClass } from "@/components/ui";
import { useT } from "@/i18n/client";

/** Where to report what the automation did (internal group / private chat with the bot, not the client group). */
export function AutoNotifyTargets({
  clientId,
  targets,
  onChange,
  bots,
}: {
  clientId: string;
  targets: NotifyTarget[];
  onChange: (t: NotifyTarget[]) => void;
  bots: { zalo: string | null; telegram: string | null };
}) {
  const t = useT();
  // Chat types arrive as stored Vietnamese words ("Nhóm" / "Cá nhân" / "Kênh").
  const typeLabel = (k: string) => (k === "Nhóm" ? t("notify.leadForm.chatType.group") : k === "Cá nhân" ? t("notify.leadForm.chatType.personal") : k === "Kênh" ? t("notify.leadForm.chatType.channel") : k);
  const [found, setFound] = useState<FoundChat[] | null>(null);
  const [q, setQ] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const has = (c: { channel: string; chatId: string }) => targets.some((x) => x.channel === c.channel && x.chatId === c.chatId);
  const find = () =>
    start(async () => {
      const r = await findNotifyChatsAction(clientId, q);
      if (!r.ok) return setMsg({ ok: false, text: r.error });
      setFound(r.list);
      setMsg(r.errors.length ? { ok: false, text: r.errors.join("; ") } : r.list.length ? null : { ok: false, text: t("workflow.notifyTargets.nonFound") });
    });

  return (
    <div className="space-y-2">
      <p className="text-xs text-mut">
        {t("workflow.notifyTargets.privateChat")} {bots.zalo ? <b>{bots.zalo}</b> : "Zalo"}
        {bots.telegram && (
          <>
            {" "}/ <b>@{bots.telegram}</b>
          </>
        )}{" "}
        {t("workflow.notifyTargets.thenSend")} <code>/id {t("workflow.notifyTargets.yourName")}</code>. {t("workflow.notifyTargets.internalGroup")} <code>/id {t("workflow.notifyTargets.groupName")}</code>. {t("workflow.notifyTargets.thenPress")} <b>{t("workflow.notifyTargets.find")}</b>.
      </p>
      {targets.map((tg, i) => (
        <div key={`${tg.channel}:${tg.chatId}`} className="flex flex-wrap items-center gap-2">
          <span className="w-28 text-xs text-mut">
            {NOTIFY_CHANNEL_LABEL[tg.channel]}
            {tg.channel === "zalobot" && ` · ${t("workflow.notifyTargets.code")} ${chatCode(tg.chatId)}`}
          </span>
          <input className={`${inputClass} !w-64`} value={tg.title} placeholder={t("workflow.notifyTargets.namePlaceholder")} onChange={(e) => onChange(targets.map((x, k) => (k === i ? { ...x, title: e.target.value } : x)))} />
          <button type="button" className="text-xs text-mut hover:text-rose-600" onClick={() => onChange(targets.filter((_, k) => k !== i))}>
            {t("workflow.notifyTargets.remove")}
          </button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <input className={`${inputClass} max-w-[16rem]`} placeholder={t("workflow.notifyTargets.searchPlaceholder")} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), find())} />
        <button type="button" className={btnClass()} disabled={pending} onClick={find}>
          {t("workflow.notifyTargets.find")}
        </button>
        <button
          type="button"
          className={btnClass()}
          disabled={pending || !targets.length}
          onClick={() =>
            start(async () => {
              const r = await testAutoNotifyAction(clientId, targets);
              setMsg(r.ok ? { ok: true, text: r.text ?? t("workflow.notifyTargets.testSent") } : { ok: false, text: r.error });
            })
          }
        >
          {t("workflow.notifyTargets.test")}
        </button>
        {msg && <span className={`text-xs ${msg.ok ? "text-emerald-600" : "text-rose-600"}`}>{msg.text}</span>}
      </div>
      {found && found.length > 0 && (
        <ul className="space-y-1 rounded-lg border border-line p-2">
          {found.map((c) => (
            <li key={`${c.channel}:${c.chatId}`} className="flex items-center justify-between gap-3">
              <span className="min-w-0">
                <span className="text-xs text-mut">
                  {NOTIFY_CHANNEL_LABEL[c.channel]} · {typeLabel(c.type)}
                  {c.code && (
                    <>
                      {" "}· {t("workflow.notifyTargets.code")} <b className="font-mono text-ink2">{c.code}</b>
                    </>
                  )}
                </span>{" "}
                <span className="text-ink">{c.title || c.hint || c.chatId}</span>
              </span>
              <button
                type="button"
                className="shrink-0 text-xs text-indigo-600 hover:underline disabled:text-mut disabled:no-underline"
                disabled={has(c)}
                onClick={() => onChange([...targets, { channel: c.channel, chatId: c.chatId, title: c.title }])}
              >
                {has(c) ? t("workflow.notifyTargets.added") : t("workflow.notifyTargets.add")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
