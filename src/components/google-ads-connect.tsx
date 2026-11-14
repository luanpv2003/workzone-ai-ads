"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { GoogleAdsStatus } from "@/lib/google-ads";
import { googleAuthorizeAction, googleDisconnectAction, saveGoogleAdsAppAction } from "@/app/google-ads-actions";
import { CopyButton } from "./copy-button";
import { btnClass, inputClass } from "./ui";
import { useT } from "@/i18n/client";
import { BRAND } from "@/lib/brand";

// Google Ads connection (System settings): OAuth client + developer token + MCC → authorize with the MCC manager email.

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "short" }) : "—");
const mcc = (d: string) => (d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : d);

export function GoogleAdsConnect({ status, callbackUrl, isAdmin, flash }: { status: GoogleAdsStatus; callbackUrl: string; isAdmin: boolean; flash: { ok: boolean; text: string } | null }) {
  const t = useT();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState(flash);
  const [clientId, setClientId] = useState(status?.clientId ?? "");
  const [secret, setSecret] = useState("");
  const [devToken, setDevToken] = useState("");
  const [mccId, setMccId] = useState(status?.mccId ? mcc(status.mccId) : "");

  if (!isAdmin) {
    return <p className="text-sm text-slate-600">{status?.connected ? t("settings.googleConnect.connectedInfo", { mcc: mcc(status.mccId), email: status.email ?? "" }) : t("settings.googleConnect.notConnected")} {t("settings.googleConnect.adminOnly")}</p>;
  }

  const save = () =>
    start(async () => {
      const r = await saveGoogleAdsAppAction({ clientId, clientSecret: secret, developerToken: devToken, mccId });
      setMsg(r.ok ? { ok: true, text: t("settings.googleConnect.savedHint") } : { ok: false, text: r.error });
      if (r.ok) {
        setSecret("");
        setDevToken("");
        router.refresh();
      }
    });
  const authorize = () =>
    start(async () => {
      const r = await googleAuthorizeAction();
      if (r.ok) window.location.href = r.url;
      else setMsg({ ok: false, text: r.error });
    });
  const disconnect = () => {
    if (!window.confirm(t("settings.googleConnect.confirmDisconnect"))) return;
    start(async () => {
      const r = await googleDisconnectAction();
      setMsg(r.ok ? { ok: true, text: t("settings.googleConnect.disconnected") } : { ok: false, text: r.error });
      router.refresh();
    });
  };

  return (
    <div className="space-y-5 text-sm">
      <p className="text-slate-600">
        {t("settings.googleConnect.intro1")}<b>{t("settings.googleConnect.introMcc")}</b>{t("settings.googleConnect.intro2")}<b>{t("settings.googleConnect.introPath")}</b>{t("settings.googleConnect.intro3")}<b>{t("settings.googleConnect.introRead")}</b>{" "}
        {t("settings.googleConnect.intro4")}
      </p>
      {msg && <p className={`rounded-lg px-3 py-2 ${msg.ok ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-700"}`}>{msg.text}</p>}

      <section>
        <h3 className="mb-1 font-medium text-slate-800">{t("settings.googleConnect.step1")}</h3>
        <p className="mb-2 text-xs text-slate-500">
          <b>Client ID / Client secret</b>{t("settings.googleConnect.secretsHelp")}<b>Developer token</b>{t("settings.googleConnect.tokenHelp")}
          {t("settings.googleConnect.pasteHere")} <code className="rounded bg-slate-100 px-1">{callbackUrl}</code> <CopyButton text={callbackUrl} />
        </p>
        <div className="grid gap-2 @2xl:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs text-slate-600">Client ID</span>
            <input className={inputClass} value={clientId} onChange={(e) => setClientId(e.target.value.trim())} placeholder="….apps.googleusercontent.com" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-slate-600">Client secret {status && t("settings.googleConnect.keepOld")}</span>
            <input className={inputClass} type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={status ? "••••••••" : "GOCSPX-…"} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-slate-600">Developer token {status?.hasDeveloperToken && t("settings.googleConnect.keepOld")}</span>
            <input className={inputClass} type="password" autoComplete="off" value={devToken} onChange={(e) => setDevToken(e.target.value)} placeholder={status?.hasDeveloperToken ? "••••••••" : t("settings.googleConnect.chars22")} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-slate-600">{t("settings.googleConnect.mccCode")}</span>
            <input className={inputClass} value={mccId} onChange={(e) => setMccId(e.target.value)} placeholder="123-456-7890" />
          </label>
        </div>
        <button type="button" className={`${btnClass("secondary")} mt-2`} disabled={pending || !clientId || !mccId || (!status && (!secret || !devToken))} onClick={save}>
          {t("settings.googleConnect.save")}
        </button>
      </section>

      {status && (
        <section>
          <h3 className="mb-1 font-medium text-slate-800">{t("settings.googleConnect.step2")}</h3>
          {status.connected ? (
            <div className={`rounded-lg border px-3 py-2.5 ${status.lastError ? "border-rose-200 bg-rose-50" : "border-emerald-200 bg-emerald-50"}`}>
              <p className="font-medium text-slate-800">
                {status.lastError ? t("settings.googleConnect.connError") : t("settings.googleConnect.connOk")} {status.email} · MCC {mcc(status.mccId)}
              </p>
              <p className="mt-0.5 text-xs text-slate-600">
                {t("settings.googleConnect.connectedAt", { when: fmt(status.connectedAt) })}
                {status.connectedBy && ` ${t("settings.googleConnect.by", { name: status.connectedBy })}`}. {t("settings.googleConnect.noExpiry")}
              </p>
              {status.lastError && <p className="mt-1 text-xs text-rose-700">{status.lastError}</p>}
              <div className="mt-2 flex gap-2">
                <button type="button" className={btnClass("secondary")} disabled={pending} onClick={authorize}>
                  {t("settings.googleConnect.reconnect")}
                </button>
                <button type="button" className={btnClass("ghost")} disabled={pending} onClick={disconnect}>
                  {t("settings.googleConnect.disconnect")}
                </button>
              </div>
            </div>
          ) : (
            <>
              <p className="mb-2 text-xs text-slate-500">
                {t("settings.googleConnect.signIn1")}<b>{t("settings.googleConnect.signInEmail")}</b>{t("settings.googleConnect.signIn2")}<i>{t("settings.googleConnect.advanced", { app: BRAND.app })}</i>{t("settings.googleConnect.signIn3")}
              </p>
              <button type="button" className={btnClass("primary")} disabled={pending} onClick={authorize}>
                {t("settings.googleConnect.connect")}
              </button>
            </>
          )}
        </section>
      )}
    </div>
  );
}
