"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { deleteWebhookAppAction, saveWebhookAppAction, subscribeWebhookAction } from "@/app/actions";
import { btnClass, inputClass } from "./ui";
import { Spinner } from "./action-button";
import { useT } from "@/i18n/client";
import { BRAND } from "@/lib/brand";

type App = { appId: string; name: string; lastEventAt: string | null; referrals7d: number };
type ClientRow = { id: string; name: string; appHint: string; fromAds: number };

function Copy({ text }: { text: string }) {
  const t = useT();
  const [ok, setOk] = useState(false);
  return (
    <button type="button" className="text-xs font-medium text-indigo-600 hover:underline" onClick={() => navigator.clipboard.writeText(text).then(() => (setOk(true), setTimeout(() => setOk(false), 1500)))}>
      {ok ? t("core.webhook.copied") : t("core.webhook.copy")}
    </button>
  );
}

/** Messaging webhook: URL + verify token to configure in the Meta app, App Secret, and enabling it per client Page. */
export function WebhookPanel({ callbackUrl, verifyToken, apps, clients, isAdmin }: { callbackUrl: string; verifyToken: string; apps: App[]; clients: ClientRow[]; isAdmin: boolean }) {
  const t = useT();
  const [form, setForm] = useState({ appId: "", name: "", secret: "" });
  const [msg, setMsg] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const router = useRouter();
  const say = (k: string, ok: boolean, text: string) => setMsg((m) => ({ ...m, [k]: { ok, text } }));

  return (
    <div className="space-y-5 text-sm">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-slate-200 p-3">
          <p className="text-xs text-slate-500">Callback URL</p>
          <p className="mt-0.5 flex items-center gap-2 font-mono text-xs break-all text-slate-800">
            {callbackUrl} <Copy text={callbackUrl} />
          </p>
        </div>
        <div className="rounded-lg border border-slate-200 p-3">
          <p className="text-xs text-slate-500">Verify token</p>
          <p className="mt-0.5 flex items-center gap-2 font-mono text-xs break-all text-slate-800">
            {verifyToken} <Copy text={verifyToken} />
          </p>
        </div>
      </div>

      <div>
        <p className="mb-1 font-medium text-slate-700">{t("core.webhook.apps", { n: apps.length })}</p>
        {apps.length ? (
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
            {apps.map((a) => (
              <li key={a.appId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span>
                  <b>{a.name || a.appId}</b> <span className="text-xs text-slate-400">· {a.appId}</span>
                  <span className="block text-xs text-slate-500">
                    {a.lastEventAt ? t("core.webhook.lastEvent", { at: new Date(a.lastEventAt).toLocaleString("vi-VN") }) : t("core.webhook.noEvent")} · {t("core.webhook.referrals", { n: a.referrals7d })}
                  </span>
                </span>
                {isAdmin && (
                  <button
                    type="button"
                    className="text-xs text-slate-400 hover:text-rose-600"
                    onClick={() => confirm(t("core.webhook.confirmDelete", { name: a.name || a.appId })) && start(async () => void (await deleteWebhookAppAction(a.appId), router.refresh()))}
                  >
                    {t("core.webhook.delete")}
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-slate-500">{t("core.webhook.noApps")}</p>
        )}
        {isAdmin && (
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <input className={`${inputClass} w-44`} placeholder="App ID" value={form.appId} onChange={(e) => setForm({ ...form, appId: e.target.value })} />
            <input className={`${inputClass} w-44`} placeholder={t("core.webhook.namePlaceholder", { app: BRAND.app })} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <input className={`${inputClass} w-72`} type="password" autoComplete="off" placeholder="App Secret" value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })} />
            <button
              type="button"
              className={btnClass("secondary")}
              disabled={pending || !form.appId || !form.secret}
              onClick={() =>
                start(async () => {
                  const r = await saveWebhookAppAction(form.appId, form.name, form.secret);
                  if (r.ok) {
                    setForm({ appId: "", name: "", secret: "" });
                    say("app", true, t("core.webhook.savedEncrypted"));
                    router.refresh();
                  } else say("app", false, r.error);
                })
              }
            >
              {pending && <Spinner />}{t("core.webhook.saveApp")}
            </button>
            {msg.app && <span className={`text-xs ${msg.app.ok ? "text-emerald-600" : "text-rose-600"}`}>{msg.app.text}</span>}
          </div>
        )}
      </div>

      <div>
        <p className="mb-1 font-medium text-slate-700">{t("core.webhook.enableTitle")}</p>
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {clients.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <span>
                <b>{c.name}</b>
                <span className="block text-xs text-slate-500">
                  {c.appHint} · {t("core.webhook.fromAds", { n: c.fromAds })}
                </span>
                {msg[c.id] && <span className={`block text-xs ${msg[c.id].ok ? "text-emerald-600" : "text-rose-600"}`}>{msg[c.id].text}</span>}
              </span>
              <button
                type="button"
                className={btnClass("secondary")}
                disabled={busy === c.id}
                onClick={() => {
                  setBusy(c.id);
                  start(async () => {
                    const r = await subscribeWebhookAction(c.id);
                    setBusy(null);
                    say(c.id, r.ok, r.ok ? r.lines.join(" · ") : r.error);
                  });
                }}
              >
                {busy === c.id && <Spinner />}{t("core.webhook.enablePage")}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
