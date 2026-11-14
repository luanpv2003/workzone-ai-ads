"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { chatCode, chatModes, dutyDays, DUTY_MAX, NOTIFY_CHANNEL_LABEL, RECALL_OPTIONS, REMIND_OPTIONS, type ChatMode, type LeadNotifyConfig, type NotifyTarget } from "@/lib/lead-notify-config";
import { dutyFromGuideAction, findNotifyChatsAction, saveLeadNotifyAction, testLeadNotifyAction, type FoundChat } from "@/app/notify-actions";
import { Spinner } from "./action-button";
import { btnClass, inputClass } from "./ui";
import { useT } from "@/i18n/client";

// Client page → Notifications & reports → Lead notifications: pick the Zalo / Telegram groups that receive messages, which lead types to report, on / off, send a test.
// Zalo doesn't send the group name to the bot: groups are told apart by the name typed after /id ("/id Spa Hoa Mai – Sale") and the group code the bot echoes back when replying.

const fmtSeen = (iso: string) => new Date(iso).toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });

export function LeadNotifyForm({ clientId, initial, bots }: { clientId: string; initial: LeadNotifyConfig; bots: { zalo: string | null; telegram: string | null } }) {
  const router = useRouter();
  const t = useT();
  const modes = chatModes(t);
  const days = dutyDays(t);
  const typeLabel = (k: string) => (k === "Nhóm" ? t("notify.leadForm.chatType.group") : k === "Cá nhân" ? t("notify.leadForm.chatType.personal") : k === "Kênh" ? t("notify.leadForm.chatType.channel") : k);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [v, setV] = useState({ on: initial.on, form: initial.form, chat: initial.chat as ChatMode, targets: initial.targets, confirm: initial.confirm, remindMin: initial.remindMin, showPhone: initial.showPhone, recallMax: initial.recallMax, duty: initial.duty });
  const [found, setFound] = useState<FoundChat[] | null>(null);
  const [q, setQ] = useState("");
  const setT = (i: number, patch: Partial<NotifyTarget>) => setV({ ...v, targets: v.targets.map((x, k) => (k === i ? { ...x, ...patch } : x)) });
  const has = (c: { channel: string; chatId: string }) => v.targets.some((x) => x.channel === c.channel && x.chatId === c.chatId);

  const find = () =>
    start(async () => {
      const r = await findNotifyChatsAction(clientId, q);
      if (!r.ok) return setMsg({ ok: false, text: r.error });
      setFound(r.list);
      setMsg(r.errors.length ? { ok: false, text: r.errors.join("; ") } : r.list.length ? null : { ok: false, text: t("notify.leadForm.noneFound") });
    });
  const fillDuty = () =>
    start(async () => {
      const r = await dutyFromGuideAction(clientId);
      if (!r.ok) return setMsg({ ok: false, text: r.error });
      setV({ ...v, duty: r.duty });
      setMsg({ ok: true, text: t("notify.leadForm.filled") });
    });
  const save = (next = v) =>
    start(async () => {
      const r = await saveLeadNotifyAction(clientId, next);
      setMsg(r.ok ? { ok: true, text: next.on ? t("notify.leadForm.savedOn") : t("notify.leadForm.savedOff") } : { ok: false, text: r.error });
      if (r.ok) router.refresh();
    });
  const test = () =>
    start(async () => {
      const r = await testLeadNotifyAction(clientId, v.targets);
      setMsg(r.ok ? { ok: !r.partial, text: r.note } : { ok: false, text: r.error });
    });

  return (
    <div className="space-y-6 text-sm">
      {msg && <p className={`rounded-lg px-3 py-2 ${msg.ok ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-700"}`}>{msg.text}</p>}

      <section>
        <h3 className="mb-1 font-medium text-slate-800">{t("notify.leadForm.s1")}</h3>
        {!bots.zalo && !bots.telegram ? (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            {t("notify.leadForm.noBotA")}{" "}
            <a href="/connections/channels#zalo-bot" className="font-medium underline">
              {t("notify.leadForm.noBotLink")}
            </a>
            .
          </p>
        ) : (
          <p className="mb-2 text-xs text-slate-500">
            {t("notify.leadForm.guideA")}{[bots.zalo && <b key="z">{bots.zalo}</b>, bots.telegram && <b key="t">@{bots.telegram}</b>].filter(Boolean).reduce<React.ReactNode[]>((a, x, i) => (i ? [...a, " / ", x] : [x]), [])}{t("notify.leadForm.guideB")}<b>{t("notify.leadForm.guideBold1")}</b>{t("notify.leadForm.guideC")}<code>@{bots.zalo ?? t("notify.leadForm.botNameFallback")} /id {t("notify.leadForm.groupNameSample")}</code>{t("notify.leadForm.guideD")}<code>@</code>{t("notify.leadForm.guideE")}<b>{t("notify.leadForm.guideBold2")}</b>{t("notify.leadForm.guideF")}<b>{t("notify.leadForm.guideBold3")}</b>{t("notify.leadForm.guideG")}
          </p>
        )}
        <div className="space-y-2">
          {v.targets.map((x, i) => (
            <div key={`${x.channel}:${x.chatId}`} className="grid items-center gap-2 sm:grid-cols-[7.5rem_16rem_auto] sm:justify-start">
              <span className="text-xs text-slate-500">
                {NOTIFY_CHANNEL_LABEL[x.channel]}
                {x.channel === "zalobot" && t("notify.leadForm.code", { code: chatCode(x.chatId) })}
              </span>
              <input className={inputClass} value={x.title} onChange={(e) => setT(i, { title: e.target.value })} placeholder={t("notify.leadForm.titlePlaceholder")} />
              <button type="button" className="justify-self-start text-xs text-slate-500 hover:text-rose-600" onClick={() => setV({ ...v, targets: v.targets.filter((_, k) => k !== i) })}>
                {t("notify.leadForm.delete")}
              </button>
            </div>
          ))}
          {(bots.zalo || bots.telegram) && (
            <div className="flex flex-wrap items-center gap-2">
              <input className={`${inputClass} max-w-[16rem]`} placeholder={t("notify.leadForm.searchPlaceholder")} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), find())} />
              <button type="button" className={btnClass("secondary")} disabled={pending} onClick={find}>
                {pending && <Spinner />} {t("notify.leadForm.find")}
              </button>
            </div>
          )}
          {found && found.length > 0 && (
            <ul className="space-y-1 rounded-lg border border-slate-200 p-2">
              {found.map((c) => (
                <li key={`${c.channel}:${c.chatId}`} className="flex items-center justify-between gap-3">
                  <span className="min-w-0">
                    <span className="text-xs text-slate-500">
                      {NOTIFY_CHANNEL_LABEL[c.channel]} · {typeLabel(c.type)}
                      {c.code && (
                        <>
                          {" · "}{t("notify.leadForm.codeWord")} <b className="font-mono text-slate-700">{c.code}</b>
                        </>
                      )}
                    </span>{" "}
                    <span className="text-slate-800">{c.title || c.hint || c.chatId}</span>
                    {c.seenAt && <span className="text-xs text-slate-500">{t("notify.leadForm.seen", { time: fmtSeen(c.seenAt) })}</span>}
                  </span>
                  <button
                    type="button"
                    className="shrink-0 text-xs text-indigo-600 hover:underline disabled:text-slate-400 disabled:no-underline"
                    disabled={has(c)}
                    onClick={() => setV({ ...v, targets: [...v.targets, { channel: c.channel, chatId: c.chatId, title: c.title }] })}
                  >
                    {has(c) ? t("notify.leadForm.added") : t("notify.leadForm.add")}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section>
        <h3 className="mb-2 font-medium text-slate-800">{t("notify.leadForm.s2")}</h3>
        <label className="flex items-start gap-2">
          <input type="checkbox" className="mt-0.5" checked={v.form} onChange={(e) => setV({ ...v, form: e.target.checked })} />
          <span>
            <span className="text-slate-800">{t("notify.leadForm.formLabel")}</span>
            <span className="block text-xs text-slate-500">{t("notify.leadForm.formDesc")}</span>
          </span>
        </label>
        <div className="mt-3 space-y-1">
          <p className="text-slate-800">{t("notify.leadForm.chat")}</p>
          {modes.map((m) => (
            <label key={m.key} className="flex items-center gap-2">
              <input type="radio" name="chatMode" checked={v.chat === m.key} onChange={() => setV({ ...v, chat: m.key })} />
              {m.label}
            </label>
          ))}
          <p className="text-xs text-slate-500">{t("notify.leadForm.chatDesc")}</p>
        </div>
      </section>

      <section>
        <h3 className="mb-2 font-medium text-slate-800">{t("notify.leadForm.s3")}</h3>
        <label className="flex items-start gap-2">
          <input type="checkbox" className="mt-0.5" checked={v.confirm} onChange={(e) => setV({ ...v, confirm: e.target.checked })} />
          <span>
            <span className="text-slate-800">{t("notify.leadForm.confirmLabel")}</span>
            <span className="block text-xs text-slate-500">
              {t("notify.leadForm.confirmA")}<b>{t("notify.leadForm.confirmBold")}</b>{t("notify.leadForm.confirmB")}
            </span>
          </span>
        </label>
        {v.confirm && (
          <label className="mt-2 flex flex-wrap items-center gap-2 pl-6">
            <span className="text-slate-800">{t("notify.leadForm.remindA")}</span>
            <select className={`${inputClass} w-auto`} value={v.remindMin} onChange={(e) => setV({ ...v, remindMin: Number(e.target.value) })}>
              {REMIND_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {m ? t("notify.leadForm.minutes", { m }) : t("notify.leadForm.noRemind")}
                </option>
              ))}
            </select>
            <span className="text-xs text-slate-500">{t("notify.leadForm.remindB")}</span>
          </label>
        )}
        {v.confirm && (
          <label className="mt-2 flex flex-wrap items-center gap-2 pl-6">
            <span className="text-slate-800">{t("notify.leadForm.recallA")}</span>
            <select className={`${inputClass} w-auto`} value={v.recallMax} onChange={(e) => setV({ ...v, recallMax: Number(e.target.value) })}>
              {RECALL_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {m ? t("notify.leadForm.upTo", { m }) : t("notify.leadForm.noRemind")}
                </option>
              ))}
            </select>
            <span className="text-xs text-slate-500">{t("notify.leadForm.recallB")}</span>
          </label>
        )}
        {v.confirm && (
          <label className="mt-2 flex items-start gap-2 pl-6">
            <input type="checkbox" className="mt-0.5" checked={v.showPhone} onChange={(e) => setV({ ...v, showPhone: e.target.checked })} />
            <span>
              <span className="text-slate-800">{t("notify.leadForm.showPhone")}</span>
              <span className="block text-xs text-slate-500">
                {t("notify.leadForm.showPhoneA")}<b>09883xxx</b>{t("notify.leadForm.showPhoneB")}
              </span>
            </span>
          </label>
        )}
      </section>

      <section>
        <h3 className="mb-1 font-medium text-slate-800">{t("notify.leadForm.s4")}</h3>
        <p className="mb-2 text-xs text-slate-500">
          {t("notify.leadForm.dutyIntro")}
        </p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {days.map((d) => (
            <label key={d.day} className="block">
              <span className="text-xs text-slate-600">{d.label}</span>
              <input value={v.duty[d.day] ?? ""} maxLength={DUTY_MAX} placeholder={t("notify.leadForm.dutyPlaceholder")} onChange={(e) => setV({ ...v, duty: v.duty.map((x, i) => (i === d.day ? e.target.value : x)) })} className={inputClass} />
            </label>
          ))}
        </div>
        <button type="button" className={`${btnClass("ai")} mt-2`} disabled={pending} onClick={fillDuty}>
          {pending && <Spinner />} {t("notify.leadForm.fillDuty")}
        </button>
      </section>

      <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
        {v.on ? (
          <>
            <button type="button" className={btnClass("primary")} disabled={pending} onClick={() => save()}>
              {pending && <Spinner />} {t("notify.leadForm.save")}
            </button>
            <button type="button" className={btnClass("secondary")} disabled={pending} onClick={() => confirm(t("notify.leadForm.offConfirm")) && (setV({ ...v, on: false }), save({ ...v, on: false }))}>
              {t("notify.leadForm.turnOff")}
            </button>
          </>
        ) : (
          <button type="button" className={btnClass("primary")} disabled={pending || !v.targets.length} onClick={() => (setV({ ...v, on: true }), save({ ...v, on: true }))}>
            {pending && <Spinner />} {t("notify.leadForm.turnOn")}
          </button>
        )}
        <button type="button" className={btnClass("secondary")} disabled={pending || !v.targets.length} onClick={test}>
          {t("notify.leadForm.test")}
        </button>
        <span className="text-xs text-slate-500">{v.on ? t("notify.leadForm.statusOn") : t("notify.leadForm.statusOff")}{t("notify.leadForm.tail")}</span>
      </div>
    </div>
  );
}
