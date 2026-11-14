"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { GoogleAccount } from "@/lib/google-ads";
import { googleAccountsAction, setClientGoogleAccountAction, syncGoogleAdsAction } from "@/app/google-ads-actions";
import { btnClass, inputClass } from "./ui";
import { useT } from "@/i18n/client";

// Client settings → Google Ads: pick an account under the MCC (automatic) or type the account ID (manual), then sync.

const fmtId = (d: string) => (d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : d);

export function GoogleAdsClient({
  clientId,
  current,
  connected,
}: {
  clientId: string;
  current: { id: string | null; name: string | null; syncedAt: string | null; error: string | null };
  connected: boolean;
}) {
  const t = useT();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [list, setList] = useState<GoogleAccount[] | null>(null);
  const [manual, setManual] = useState(current.id ? fmtId(current.id) : "");

  if (!connected) {
    return (
      <p className="text-sm text-slate-600">
        {t("settings.googleClient.notConnected")}{" "}
        <Link href="/connections/google" className="text-indigo-600 hover:underline">
          {t("settings.googleClient.systemSettings")}
        </Link>{" "}
        {t("settings.googleClient.first")}
      </p>
    );
  }

  const done = (r: { ok: boolean; error?: string }, ok: string) => {
    setMsg(r.ok ? { ok: true, text: ok } : { ok: false, text: r.error ?? t("settings.googleClient.error") });
    if (r.ok) router.refresh();
  };
  const load = () =>
    start(async () => {
      const r = await googleAccountsAction(clientId);
      if (r.ok) {
        setList(r.list);
        if (!r.list.length) setMsg({ ok: false, text: t("settings.googleClient.mccEmpty") });
      } else setMsg({ ok: false, text: r.error });
    });
  const pick = (id: string, name: string | null) => start(async () => done(await setClientGoogleAccountAction(clientId, id, name), id ? t("settings.googleClient.linked") : t("settings.googleClient.unlinked")));
  const sync = () => start(async () => done(await syncGoogleAdsAction(clientId), t("settings.googleClient.synced")));

  return (
    <div className="space-y-4 text-sm">
      {msg && <p className={`rounded-lg px-3 py-2 ${msg.ok ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-700"}`}>{msg.text}</p>}

      {current.id ? (
        <div className={`rounded-lg border px-3 py-2.5 ${current.error ? "border-rose-200 bg-rose-50" : "border-line"}`}>
          <p className="font-medium text-ink">
            {current.name ?? t("settings.googleClient.account")} <span className="font-normal text-mut">({fmtId(current.id)})</span>
          </p>
          <p className="mt-0.5 text-xs text-mut">
            {current.syncedAt ? t("settings.googleClient.lastSync", { time: new Date(current.syncedAt).toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "short" }) }) : t("settings.googleClient.neverSynced")} · {t("settings.googleClient.autoSync")}
          </p>
          {current.error && <p className="mt-1 text-xs text-rose-700">{current.error}</p>}
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className={btnClass("primary")} disabled={pending} onClick={sync}>
              {pending ? t("settings.googleClient.running") : t("settings.googleClient.syncGoogle")}
            </button>
            <Link href={`/clients/${clientId}/google-ads`} className={btnClass("secondary")}>
              {t("settings.googleClient.viewData")}
            </Link>
            <button type="button" className={btnClass("ghost")} disabled={pending} onClick={() => window.confirm(t("settings.googleClient.confirmUnlink")) && pick("", null)}>
              {t("settings.googleClient.unlink")}
            </button>
          </div>
        </div>
      ) : (
        <p className="text-mut">{t("settings.googleClient.noAccount")}</p>
      )}

      <div>
        <p className="mb-1 text-xs text-slate-600">
          <b>{t("settings.googleClient.autoLabel")}</b> {t("settings.googleClient.autoDesc")}
        </p>
        {list ? (
          <select className={`${inputClass} max-w-md`} defaultValue="" disabled={pending} onChange={(e) => e.target.value && pick(e.target.value, list.find((a) => a.id === e.target.value)?.name ?? null)}>
            <option value="">{t("settings.googleClient.pickAccount", { n: list.length })}</option>
            {list.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} · {fmtId(a.id)} · {a.currency}
                {a.status && a.status !== "ENABLED" ? ` · ${a.status}` : ""}
              </option>
            ))}
          </select>
        ) : (
          <button type="button" className={btnClass("secondary")} disabled={pending} onClick={load}>
            {t("settings.googleClient.loadList")}
          </button>
        )}
      </div>
      <div>
        <p className="mb-1 text-xs text-slate-600">
          <b>{t("settings.googleClient.manualLabel")}</b> {t("settings.googleClient.manualDesc")}
        </p>
        <div className="flex gap-2">
          <input className={`${inputClass} w-44`} value={manual} onChange={(e) => setManual(e.target.value)} placeholder="123-456-7890" />
          <button type="button" className={btnClass("secondary")} disabled={pending || !manual.trim()} onClick={() => pick(manual, null)}>
            {t("settings.googleClient.saveId")}
          </button>
        </div>
      </div>
    </div>
  );
}
