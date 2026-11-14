"use client";

import { useState, useSyncExternalStore, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ackLeadAction, reportLeadResultAction } from "@/app/lead-confirm-actions";
import type { Feedback } from "@/lib/lead-sheet";
import { feedbackOptionLabel } from "@/lib/highlevel-map";
import { useT } from "@/i18n/client";

// Page /l/<code>: tap Take lead, after the call pick an outcome → saved to the sales rating, the bot reports back to the group.
// "Bỏ lead" (Drop lead) button (contact never reachable): save Outcome = Drop lead so the bot stops reminding; tap Restore to resume reminders.
// The tapper's name is stored in the browser (the salesperson's phone) so they don't have to retype it next time.

const NAME_KEY = "wz.leadName";
const readName = () => {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
};
const noSubscribe = () => () => {};
const DROPPED = "Bỏ lead"; // = DROPPED in lib/lead-sheet.ts (that file runs server-side)
type Field = { field: keyof Feedback; label: string; options: string[] };

export function LeadConfirm({ code, ack, feedback, feedbackBy, fields }: { code: string; ack: { by: string; at: string } | null; feedback: Feedback; feedbackBy: { by: string; at: string } | null; fields: Field[] }) {
  const router = useRouter();
  const t = useT();
  const [pending, start] = useTransition();
  const stored = useSyncExternalStore(noSubscribe, readName, () => "");
  const [typed, setName] = useState<string | null>(null);
  const name = typed ?? stored;
  const [fb, setFb] = useState(feedback);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const remember = (n: string) => {
    try {
      localStorage.setItem(NAME_KEY, n.trim());
    } catch {}
  };

  const doAck = () =>
    start(async () => {
      setMsg(null);
      remember(name);
      const r = await ackLeadAction(code, name);
      if (!r.ok) return setMsg({ ok: false, text: r.error });
      setMsg(r.already ? { ok: false, text: t("customers.leadConfirm.alreadyTaken", { by: r.by }) } : { ok: true, text: r.posted ? t("customers.leadConfirm.takenPosted") : t("customers.leadConfirm.taken") });
      router.refresh();
    });
  const save = (next = fb, done = t("customers.leadConfirm.saved")) =>
    start(async () => {
      setMsg(null);
      remember(name);
      const r = await reportLeadResultAction(code, name, next);
      if (!r.ok) return setMsg({ ok: false, text: r.error });
      setFb(next);
      setMsg({ ok: true, text: !r.changed ? t("customers.leadConfirm.nothingChanged") : r.posted ? t("customers.leadConfirm.savedPosted", { done }) : done });
      router.refresh();
    });
  const drop = () => {
    if (confirm(t("customers.leadConfirm.confirmDrop"))) save({ ...fb, outcome: DROPPED }, t("customers.leadConfirm.dropDone"));
  };
  const dropped = feedback.outcome === DROPPED;

  const pill = (on: boolean) => `h-10 rounded-xl px-3 text-sm ${on ? "bg-ink font-medium text-panel" : "border border-slate-300 bg-panel text-slate-700"}`;
  const changed = fields.some((f) => fb[f.field] !== feedback[f.field]);

  return (
    <>
      <section className="space-y-3 rounded-2xl bg-panel p-4 shadow-sm">
        <label className="block text-sm">
          <span className="text-slate-600">{t("customers.leadConfirm.yourName")}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder={t("customers.leadConfirm.namePlaceholder")} className="mt-1 h-11 w-full rounded-xl border border-slate-300 bg-panel px-3 text-base focus:border-indigo-500 focus:outline-none" />
        </label>
        {ack ? (
          <p className="rounded-xl bg-emerald-50 px-3 py-2.5 text-sm text-emerald-800">
            ✅ <b>{ack.by}</b> {t("customers.leadConfirm.takenAt", { at: ack.at })}
          </p>
        ) : (
          <button type="button" disabled={pending || !name.trim()} onClick={doAck} className="h-12 w-full rounded-xl bg-indigo-600 text-base font-semibold text-white disabled:bg-slate-300">
            {pending ? t("customers.leadConfirm.saving") : t("customers.leadConfirm.take")}
          </button>
        )}
      </section>

      <section className="space-y-3 rounded-2xl bg-panel p-4 shadow-sm">
        <h2 className="font-semibold">{t("customers.leadConfirm.reportTitle")}</h2>
        {fields
          .filter((f) => f.options.length)
          .map((f) => (
            <div key={f.field}>
              <p className="mb-1 text-sm text-slate-600">{t(`customers.feedback.fields.${f.field}`)}</p>
              <div className="flex flex-wrap gap-2">
                {f.options
                  .filter((o) => o !== DROPPED) // has its own button below
                  .map((o) => (
                  <button key={o} type="button" className={pill(fb[f.field] === o)} onClick={() => setFb({ ...fb, [f.field]: fb[f.field] === o ? "" : o })}>
                    {feedbackOptionLabel(t, o)}
                  </button>
                ))}
              </div>
            </div>
          ))}
        <label className="block text-sm">
          <span className="text-slate-600">{t("customers.leadConfirm.note")}</span>
          <textarea value={fb.note} onChange={(e) => setFb({ ...fb, note: e.target.value })} rows={2} maxLength={1000} placeholder={t("customers.leadConfirm.notePlaceholder")} className="mt-1 w-full rounded-xl border border-slate-300 bg-panel px-3 py-2 text-base focus:border-indigo-500 focus:outline-none" />
        </label>
        <button type="button" disabled={pending || !changed || !name.trim()} onClick={() => save()} className="h-12 w-full rounded-xl bg-ink text-base font-semibold text-panel disabled:bg-slate-300 disabled:text-white">
          {pending ? t("customers.leadConfirm.saving") : t("customers.leadConfirm.saveResult")}
        </button>
        {dropped ? (
          <div className="flex items-center justify-between gap-2 rounded-xl bg-rose-50 px-3 py-2.5 text-sm text-rose-800">
            <span>🚫 {t("customers.leadConfirm.droppedInfo")}</span>
            <button type="button" disabled={pending || !name.trim()} onClick={() => save({ ...fb, outcome: "" }, t("customers.leadConfirm.restoreDone"))} className="shrink-0 font-medium underline disabled:opacity-50">
              {t("customers.leadConfirm.restore")}
            </button>
          </div>
        ) : (
          <button type="button" disabled={pending || !name.trim()} onClick={drop} className="h-11 w-full rounded-xl border border-rose-300 bg-panel text-sm font-medium text-rose-700 disabled:border-slate-200 disabled:text-slate-400">
            {t("customers.leadConfirm.dropButton")}
          </button>
        )}
        {!name.trim() && <p className="text-xs text-slate-500">{t("customers.leadConfirm.needName")}</p>}
        {feedbackBy && (
          <p className="text-xs text-slate-500">
            {t("customers.leadConfirm.lastUpdate", { by: feedbackBy.by || "?", at: feedbackBy.at })}
          </p>
        )}
      </section>

      {msg && <p className={`rounded-xl px-3 py-2.5 text-sm ${msg.ok ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"}`}>{msg.text}</p>}
    </>
  );
}
