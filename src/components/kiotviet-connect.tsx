"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { disconnectKiotAction, requestKiotSyncAction, saveKiotAction } from "@/app/kiotviet-actions";
import { Field, btnClass, inputClass } from "./ui";
import { useT } from "@/i18n/client";

// Client settings → KiotViet: paste the store name + Client ID + Client Secret (the user pastes it; the Secret is never shown again), test then save.

export function KiotvietConnect({
  clientId,
  current,
}: {
  clientId: string;
  current: { retailer: string | null; clientId: string | null; hasSecret: boolean; months: number; syncedAt: string | null; error: string | null; status: string | null };
}) {
  const t = useT();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [form, setForm] = useState({ retailer: current.retailer ?? "", clientId: current.clientId ?? "", secret: "", months: current.months });
  const [editing, setEditing] = useState(!current.hasSecret);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [k]: k === "months" ? Number(e.target.value) : e.target.value });

  const save = () =>
    start(async () => {
      const r = await saveKiotAction(clientId, form);
      if (r.ok) {
        setMsg({
          ok: true,
          text: t("settings.kiotConnect.testOk", { count: r.branches.length, names: r.branches.join(", "), customers: r.customers.toLocaleString("vi-VN"), invoices: r.invoices.toLocaleString("vi-VN") }),
        });
        setForm({ ...form, secret: "" });
        setEditing(false);
        router.refresh();
      } else setMsg({ ok: false, text: r.error });
    });
  const sync = () =>
    start(async () => {
      const r = await requestKiotSyncAction(clientId);
      setMsg(r.ok ? { ok: true, text: t("settings.kiotConnect.syncRequested") } : { ok: false, text: r.error });
      if (r.ok) router.refresh();
    });
  const disconnect = () => {
    if (!window.confirm(t("settings.kiotConnect.confirmDisconnect"))) return;
    start(async () => {
      const r = await disconnectKiotAction(clientId);
      setMsg(r.ok ? { ok: true, text: t("settings.kiotConnect.disconnected") } : { ok: false, text: r.error });
      if (r.ok) {
        setForm({ retailer: "", clientId: "", secret: "", months: 12 });
        setEditing(true);
        router.refresh();
      }
    });
  };

  return (
    <div className="space-y-4 text-sm">
      <p className="text-slate-600">
        {t("settings.kiotConnect.introBefore")}<b>{t("settings.kiotConnect.readOnly")}</b>{t("settings.kiotConnect.introAfter")}
      </p>
      {msg && <p className={`rounded-lg px-3 py-2 ${msg.ok ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-700"}`}>{msg.text}</p>}

      {current.hasSecret && (
        <div className={`rounded-lg border px-3 py-2.5 ${current.error ? "border-rose-200 bg-rose-50" : "border-line"}`}>
          <p className="font-medium text-ink">
            {t("settings.kiotConnect.store")} <span className="font-mono">{current.retailer}</span> <span className="font-normal text-mut">· {t("settings.kiotConnect.history", { months: current.months })}</span>
          </p>
          <p className="mt-0.5 text-xs text-mut">
            {current.status ?? (current.syncedAt ? t("settings.kiotConnect.lastSync", { time: new Date(current.syncedAt).toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "short" }) }) : t("settings.kiotConnect.neverSynced"))} · {t("settings.kiotConnect.autoSync")}
          </p>
          {current.error && <p className="mt-1 text-xs text-rose-700">{current.error}</p>}
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className={btnClass("primary")} disabled={pending} onClick={sync}>
              {t("settings.kiotConnect.syncNow")}
            </button>
            <Link href={`/clients/${clientId}/sales`} className={btnClass("secondary")}>
              {t("settings.kiotConnect.viewSales")}
            </Link>
            {!editing && (
              <button type="button" className={btnClass("ghost")} disabled={pending} onClick={() => setEditing(true)}>
                {t("settings.kiotConnect.edit")}
              </button>
            )}
            <button type="button" className={btnClass("ghost")} disabled={pending} onClick={disconnect}>
              {t("settings.kiotConnect.disconnect")}
            </button>
          </div>
        </div>
      )}

      {editing && (
        <div className="space-y-3 rounded-lg border border-line p-3">
          <p className="text-xs text-slate-600">
            {t("settings.kiotConnect.getIt")}<b>{t("settings.kiotConnect.getItPath")}</b>{t("settings.kiotConnect.getItMid")}<span className="font-mono">.kiotviet.vn</span>{t("settings.kiotConnect.getItEnd")}
          </p>
          <div className="grid gap-3 @xl:grid-cols-2">
            <Field label={t("settings.kiotConnect.fieldRetailer")}>
              <input className={inputClass} value={form.retailer} onChange={set("retailer")} placeholder={t("settings.kiotConnect.retailerPlaceholder")} autoComplete="off" />
            </Field>
            <Field label="Client ID">
              <input className={inputClass} value={form.clientId} onChange={set("clientId")} autoComplete="off" />
            </Field>
            <Field label="Client Secret" hint={current.hasSecret ? t("settings.kiotConnect.secretKeep") : t("settings.kiotConnect.secretEncrypted")}>
              <input className={inputClass} type="password" value={form.secret} onChange={set("secret")} autoComplete="new-password" placeholder={current.hasSecret ? "••••••••" : ""} />
            </Field>
            <Field label={t("settings.kiotConnect.fieldMonths")} hint={t("settings.kiotConnect.monthsHint")}>
              <select className={inputClass} value={form.months} onChange={set("months")}>
                {[3, 6, 12, 24].map((m) => (
                  <option key={m} value={m}>
                    {t("settings.kiotConnect.monthsOption", { count: m })}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="flex gap-2">
            <button type="button" className={btnClass("primary")} disabled={pending || !form.retailer.trim() || !form.clientId.trim()} onClick={save}>
              {pending ? t("settings.kiotConnect.checking") : t("settings.kiotConnect.checkSave")}
            </button>
            {current.hasSecret && (
              <button type="button" className={btnClass("ghost")} disabled={pending} onClick={() => setEditing(false)}>
                {t("settings.kiotConnect.cancel")}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
