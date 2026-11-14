"use client";
import { BRAND } from "@/lib/brand";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { SmtpStatus, TelegramStatus } from "@/lib/report-channels";
import { clearSmtpAction, clearTelegramBotAction, saveSmtpAction, saveTelegramBotAction } from "@/app/zalo-actions";
import { Spinner } from "./action-button";
import { btnClass, inputClass } from "./ui";
import { useT } from "@/i18n/client";

// System settings → Messaging channels. Passwords / tokens are pasted here (not sent via chat), stored encrypted, never shown again.

const fmt = (iso: string) => new Date(iso).toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "short" });

export function ReportChannelsConnect({ smtp, telegram, isAdmin }: { smtp: SmtpStatus; telegram: TelegramStatus; isAdmin: boolean }) {
  const router = useRouter();
  const t = useT();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [s, setS] = useState({ host: smtp?.host ?? "smtp.gmail.com", port: smtp?.port ?? 465, user: smtp?.user ?? "", pass: "", fromName: smtp?.fromName ?? BRAND.agency });
  const [token, setToken] = useState("");
  const act = (fn: () => Promise<{ ok: boolean; error?: string }>, okText: string, then?: () => void) =>
    start(async () => {
      const r = await fn();
      setMsg(r.ok ? { ok: true, text: okText } : { ok: false, text: r.error ?? t("notify.channelsConnect.error") });
      if (r.ok) {
        then?.();
        router.refresh();
      }
    });

  if (!isAdmin) {
    return (
      <p className="text-sm text-slate-600">
        {t("notify.channelsConnect.viewOnly", { email: smtp ? smtp.user : t("notify.channelsConnect.notSet"), tg: telegram ? `@${telegram.username}` : t("notify.channelsConnect.notSet") })}
      </p>
    );
  }

  return (
    <div className="space-y-6 text-sm">
      <p className="text-slate-600">
        {t("notify.channelsConnect.introA")}<b>{t("notify.channelsConnect.introBold1")}</b>{t("notify.channelsConnect.introB")}<b>{t("notify.channelsConnect.introBold2")}</b>{t("notify.channelsConnect.introC")}
      </p>
      {msg && <p className={`rounded-lg px-3 py-2 ${msg.ok ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-700"}`}>{msg.text}</p>}

      <section>
        <h3 className="mb-1 font-medium text-slate-800">{t("notify.channelsConnect.emailTitle")}</h3>
        {smtp && (
          <p className="mb-2 text-xs text-emerald-700">
            {t("notify.channelsConnect.sendingFrom")}<b>{smtp.user}</b> ({smtp.host}:{smtp.port}) · {smtp.savedBy}, {fmt(smtp.savedAt)}
          </p>
        )}
        <p className="mb-2 text-xs text-slate-500">
          {t("notify.channelsConnect.emailHelpA")}<code>smtp.gmail.com</code>{t("notify.channelsConnect.emailHelpB")}<b>{t("notify.channelsConnect.appPassword")}</b>{t("notify.channelsConnect.emailHelpC")}
        </p>
        <div className="grid gap-2 sm:grid-cols-[14rem_6rem] sm:justify-start">
          <label className="block">
            <span className="mb-1 block text-xs text-slate-600">{t("notify.channelsConnect.host")}</span>
            <input className={inputClass} value={s.host} onChange={(e) => setS({ ...s, host: e.target.value })} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-slate-600">{t("notify.channelsConnect.port")}</span>
            <input className={inputClass} value={s.port} onChange={(e) => setS({ ...s, port: Number(e.target.value.replace(/\D/g, "")) || 0 })} inputMode="numeric" />
          </label>
        </div>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          <label className="block">
            <span className="mb-1 block text-xs text-slate-600">{t("notify.channelsConnect.user")}</span>
            <input className={inputClass} value={s.user} onChange={(e) => setS({ ...s, user: e.target.value.trim() })} placeholder="reports@example.com" inputMode="email" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-slate-600">{t("notify.channelsConnect.password", { keep: smtp ? t("notify.channelsConnect.keepOld") : "" })}</span>
            <input className={inputClass} type="password" autoComplete="off" value={s.pass} onChange={(e) => setS({ ...s, pass: e.target.value })} placeholder={smtp ? "••••••••" : t("notify.channelsConnect.appPasswordPlaceholder")} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-slate-600">{t("notify.channelsConnect.fromName")}</span>
            <input className={inputClass} value={s.fromName} onChange={(e) => setS({ ...s, fromName: e.target.value })} />
          </label>
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" className={btnClass("primary")} disabled={pending || !s.host || !s.user || (!s.pass && !smtp)} onClick={() => act(() => saveSmtpAction(s), t("notify.channelsConnect.smtpSaved"), () => setS({ ...s, pass: "" }))}>
            {pending && <Spinner />} {t("notify.channelsConnect.verifySave")}
          </button>
          {smtp && (
            <button type="button" className={btnClass("secondary")} disabled={pending} onClick={() => confirm(t("notify.channelsConnect.removeEmailConfirm")) && act(clearSmtpAction, t("notify.channelsConnect.emailRemoved"))}>
              {t("notify.channelsConnect.remove")}
            </button>
          )}
        </div>
      </section>

      <section>
        <h3 className="mb-1 font-medium text-slate-800">{t("notify.channelsConnect.tgTitle")}</h3>
        {telegram && (
          <p className="mb-2 text-xs text-emerald-700">
            {t("notify.channelsConnect.tgBotWord")}<b>@{telegram.username}</b> · {telegram.savedBy}, {fmt(telegram.savedAt)}
          </p>
        )}
        <p className="mb-2 text-xs text-slate-500">
          {t("notify.channelsConnect.tgHelpA")}<b>@BotFather</b>{t("notify.channelsConnect.tgHelpB")}<code>/newbot</code>{t("notify.channelsConnect.tgHelpC")}<b>{t("notify.channelsConnect.tgFind")}</b>.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <span className="w-80 max-w-full">
            <input className={inputClass} type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder={telegram ? t("notify.channelsConnect.tokenChange") : "123456789:AA..."} />
          </span>
          <button type="button" className={btnClass("primary")} disabled={pending || !token.trim()} onClick={() => act(() => saveTelegramBotAction(token), t("notify.channelsConnect.tgConnected"), () => setToken(""))}>
            {pending && <Spinner />} {t("notify.channelsConnect.tgConnect")}
          </button>
          {telegram && (
            <button type="button" className={btnClass("secondary")} disabled={pending} onClick={() => confirm(t("notify.channelsConnect.removeTgConfirm")) && act(clearTelegramBotAction, t("notify.channelsConnect.tgRemoved"))}>
              {t("notify.channelsConnect.remove")}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
