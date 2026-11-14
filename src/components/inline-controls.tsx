"use client";

import { useState, useTransition } from "react";
import { setBudgetAction, setStatusAction } from "@/app/actions";
import { money } from "@/lib/format";
import { Spinner } from "./action-button";
import { useMetaConfirm } from "./meta-confirm";
import { useT } from "@/i18n/client";
import type { MessageKey, T } from "@/i18n/translate";

const levelLabel = (t: T, level: string) => (["campaign", "adset", "ad"].includes(level) ? t(`core.inline.level.${level}` as MessageKey) : "");

/** On/off toggle like the first column in Ads Manager. */
export function StatusSwitch({ clientId, level, id, status, name }: { clientId: string; level: string; id: string; status: string; name: string }) {
  const t = useT();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [dialog, ask] = useMetaConfirm();
  const on = status === "ACTIVE";
  return (
    <span className="inline-flex items-center gap-1.5" title={error ?? (on ? t("core.inline.isOn") : t("core.inline.isOff"))}>
      {dialog}
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={t("core.inline.toggle", { name })}
        disabled={pending}
        onClick={async () => {
          const ok = await ask({
            title: t(on ? "core.inline.pauseTitle" : "core.inline.enableTitle", { level: levelLabel(t, level).toLowerCase(), name }),
            lines: [{ label: t("core.inline.statusLine", { level: levelLabel(t, level) || level }), from: on ? t("core.inline.running") : t("core.inline.paused"), to: on ? t("core.inline.paused") : t("core.inline.running") }],
            effect: on ? t("core.inline.stopEffect") : t("core.inline.startEffect"),
            confirmLabel: on ? t("core.inline.pauseOnMeta") : t("core.inline.enableOnMeta"),
          });
          if (!ok) return;
          start(async () => {
            const r = await setStatusAction(clientId, level, id, on ? "PAUSED" : "ACTIVE");
            setError(r.ok ? null : r.error);
            if (!r.ok) alert(r.error);
          });
        }}
        className={`relative h-5 w-9 shrink-0 rounded-full transition hover:ring-2 hover:ring-orange-300 disabled:opacity-60 ${on ? "bg-emerald-600" : "bg-slate-300"}`}
      >
        <span className={`absolute top-0.5 size-4 rounded-full bg-white shadow transition ${on ? "left-4.5" : "left-0.5"}`} />
      </button>
      {pending && <Spinner />}
    </span>
  );
}

/** Click-to-edit budget field. */
export function BudgetCell({ clientId, level, id, value, currency }: { clientId: string; level: string; id: string; value: number; currency: string }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(String(value));
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [dialog, ask] = useMetaConfirm();

  if (!editing) {
    return (
      <button type="button" onClick={() => (setText(String(value)), setEditing(true))} className="rounded border border-transparent px-1 tabular-nums hover:border-orange-300 hover:bg-orange-50" title={t("core.inline.clickToEdit")}>
        {money(value, currency)}
      </button>
    );
  }
  const submit = async () => {
    const amount = Number(text.replace(/\D/g, ""));
    if (amount === value) return setEditing(false);
    const diff = amount - value;
    const ok = await ask({
      title: t("core.inline.budgetTitle", { level: levelLabel(t, level).toLowerCase() }),
      lines: [{ label: t("core.inline.budgetLine", { level: levelLabel(t, level) || level }), from: money(value, currency), to: money(amount, currency) }],
      effect: t(diff >= 0 ? "core.inline.spendUp" : "core.inline.spendDown", { amount: money(Math.abs(diff), currency) }),
      confirmLabel: t("core.inline.confirmChange"),
    });
    if (!ok) return;
    start(async () => {
      const r = await setBudgetAction(clientId, level, id, amount);
      if (r.ok) setEditing(false);
      setError(r.ok ? null : r.error);
    });
  };
  return (
    <span className="inline-flex flex-col items-end gap-1">
      {dialog}
      <span className="inline-flex items-center gap-1">
        <input
          autoFocus
          className="w-28 rounded border border-orange-300 bg-panel px-1.5 py-0.5 text-right text-sm text-ink tabular-nums"
          value={text ? new Intl.NumberFormat("vi-VN").format(Number(text.replace(/\D/g, "")) || 0) : ""}
          onChange={(e) => setText(e.target.value.replace(/\D/g, ""))}
          onKeyDown={(e) => (e.key === "Enter" ? submit() : e.key === "Escape" && setEditing(false))}
        />
        <button type="button" onClick={submit} disabled={pending} className="rounded bg-orange-600 px-1.5 py-0.5 text-xs text-white">
          {pending ? <Spinner /> : t("core.inline.save")}
        </button>
        <button type="button" onClick={() => setEditing(false)} className="text-xs text-slate-400">✕</button>
      </span>
      {error && <span className="max-w-48 text-xs text-rose-600">{error}</span>}
    </span>
  );
}
