"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ZaloBotStatus } from "@/lib/zalo-bot";
import { clearZaloBotAction, saveZaloBotAction } from "@/app/notify-actions";
import { Spinner } from "./action-button";
import { btnClass, inputClass } from "./ui";
import { useT } from "@/i18n/client";
import { BRAND } from "@/lib/brand";

// System settings → Messaging channels: paste the bot token (not via chat), stored encrypted, never shown again.

const fmt = (iso: string) => new Date(iso).toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "short" });

export function ZaloBotConnect({ status, isAdmin }: { status: ZaloBotStatus; isAdmin: boolean }) {
  const t = useT();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [token, setToken] = useState("");
  const act = (fn: () => Promise<{ ok: boolean; error?: string }>, okText: string) =>
    start(async () => {
      const r = await fn();
      setMsg(r.ok ? { ok: true, text: okText } : { ok: false, text: r.error ?? t("core.zaloBot.error") });
      if (r.ok) {
        setToken("");
        router.refresh();
      }
    });

  return (
    <div className="space-y-3 text-sm">
      <p className="text-slate-600">
        {t("core.zaloBot.intro1", { app: BRAND.app })} <b>{t("core.zaloBot.introTab")}</b>{t("core.zaloBot.intro2")}
      </p>
      {msg && <p className={`rounded-lg px-3 py-2 ${msg.ok ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-700"}`}>{msg.text}</p>}
      {status && (
        <div className="text-xs">
          <p className="text-emerald-700">
            ✓ Bot <b>{status.name}</b> · {status.savedBy}, {fmt(status.savedAt)} · {status.webhook ? t("core.zaloBot.webhookMode") : t("core.zaloBot.pollMode")}
          </p>
          {status.canJoinGroups === false && (
            <p className="mt-1 text-amber-700">{t("core.zaloBot.cannotJoin")}</p>
          )}
        </div>
      )}
      {isAdmin ? (
        <>
          <p className="text-xs text-slate-500">
            {t("core.zaloBot.create1")} <b>Zalo Bot Manager</b> → {t("core.zaloBot.create2")} <b>{t("core.zaloBot.create3")}</b> → {t("core.zaloBot.create4")} <b>Bot Token</b> {t("core.zaloBot.create5")}
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <span className="w-80 max-w-full">
              <input className={inputClass} type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder={status ? t("core.zaloBot.pasteNew") : "Bot Token"} />
            </span>
            <button type="button" className={btnClass("primary")} disabled={pending || !token.trim()} onClick={() => act(() => saveZaloBotAction(token), t("core.zaloBot.connected"))}>
              {pending && <Spinner />} {t("core.zaloBot.connect")}
            </button>
            {status && (
              <button type="button" className={btnClass("secondary")} disabled={pending} onClick={() => confirm(t("core.zaloBot.confirmRemove")) && act(clearZaloBotAction, t("core.zaloBot.removed"))}>
                {t("core.zaloBot.remove")}
              </button>
            )}
          </div>
        </>
      ) : (
        <p className="text-xs text-slate-500">{status ? "" : `${t("core.zaloBot.notConnected")} `}{t("core.zaloBot.adminOnly")}</p>
      )}
    </div>
  );
}
