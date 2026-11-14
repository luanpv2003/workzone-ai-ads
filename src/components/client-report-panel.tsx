"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { channelLabels, displayPhone, type Channel, type EmailTo, type Recipient, type TelegramTo } from "@/lib/client-report-vars";
import {
  deleteClientReportAction,
  findTelegramChatsAction,
  revokeClientReportAction,
  saveDailyTodoAction,
  saveReportMessageAction,
  saveReportOverridesAction,
  saveReportSettingsAction,
  sendClientReportAction,
  sendTestReportAction,
} from "@/app/zalo-actions";
import { findNotifyChatsAction, type FoundChat } from "@/app/notify-actions";
import type { DailyOpts } from "@/lib/client-daily-report";
import { CopyButton } from "./copy-button";
import { Spinner } from "./action-button";
import { btnClass, inputClass } from "./ui";
import { useT } from "@/i18n/client";

// Report recipients (ReportSettingsForm, under Notifications & reports → Report schedule) and sending an already-built report (ReportSendPanel, under Send report to client).

type Msg = { ok: boolean; text: string } | null;
function Note({ msg }: { msg: Msg }) {
  if (!msg) return null;
  return <p className={`rounded-lg px-3 py-2 text-sm ${msg.ok ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-700"}`}>{msg.text}</p>;
}

/** Which channels are connected (System settings): null = not yet. */
export type ChannelState = { email: string | null; telegram: string | null; zalobot: string | null; zalo: string | null; zaloNotReady: string | null };

const NotConnected = ({ what }: { what: "email" | "telegram" }) => {
  const t = useT();
  return (
    <p className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
      {t("notify.reportPanel.notConnectedA", { what: what === "email" ? t("notify.reportPanel.whatEmail") : t("notify.reportPanel.whatTelegram") })}{" "}
      <a href="/connections/channels#report-channels" className="font-medium underline">
        {t("notify.reportPanel.notConnectedLink")}
      </a>
      .
    </p>
  );
};

export function ReportSettingsForm({
  clientId,
  initial,
  channels,
  leadGroups,
}: {
  clientId: string;
  initial: { emails: EmailTo[]; telegram: TelegramTo[]; zalobot: TelegramTo[]; recipients: Recipient[]; daily: DailyOpts };
  channels: ChannelState;
  /** Zalo groups currently receiving this client's lead notifications: quick-add suggestions. */
  leadGroups?: TelegramTo[];
}) {
  const router = useRouter();
  const t = useT();
  const [v, setV] = useState({ ...initial, recipients: initial.recipients.map((r) => ({ ...r, phone: displayPhone(r.phone) })) });
  const [msg, setMsg] = useState<Msg>(null);
  const [found, setFound] = useState<{ chatId: string; title: string; type: string }[] | null>(null);
  const [zFound, setZFound] = useState<FoundChat[] | null>(null);
  const [zq, setZq] = useState("");
  const [tq, setTq] = useState("");
  const [pending, start] = useTransition();
  const setE = (i: number, patch: Partial<EmailTo>) => setV({ ...v, emails: v.emails.map((r, k) => (k === i ? { ...r, ...patch } : r)) });
  const setR = (i: number, patch: Partial<Recipient>) => setV({ ...v, recipients: v.recipients.map((r, k) => (k === i ? { ...r, ...patch } : r)) });
  const save = () =>
    start(async () => {
      const r = await saveReportSettingsAction(clientId, v);
      setMsg(r.ok ? { ok: true, text: t("notify.reportPanel.saved") } : { ok: false, text: r.error });
      if (r.ok) router.refresh();
    });
  const findChats = () =>
    start(async () => {
      const r = await findTelegramChatsAction(clientId, tq);
      if (!r.ok) return setMsg({ ok: false, text: r.error });
      setFound(r.list);
      setMsg(r.list.length ? null : { ok: false, text: t("notify.reportPanel.noGroupTg") });
    });
  const findZalo = () =>
    start(async () => {
      const r = await findNotifyChatsAction(clientId, zq);
      if (!r.ok) return setMsg({ ok: false, text: r.error });
      const list = r.list.filter((c) => c.channel === "zalobot");
      setZFound(list);
      setMsg(list.length ? null : { ok: false, text: t("notify.reportPanel.noGroupZalo", { extra: r.errors.length ? ` (${r.errors.join("; ")})` : "" }) });
    });
  const addZalo = (g: TelegramTo) => !v.zalobot.some((x) => x.chatId === g.chatId) && setV({ ...v, zalobot: [...v.zalobot, g] });
  const removeBtn = (onClick: () => void) => (
    <button type="button" className="justify-self-start text-xs text-slate-500 hover:text-rose-600" onClick={onClick}>
      {t("notify.reportPanel.remove")}
    </button>
  );

  const leadSuggest = (leadGroups ?? []).filter((g) => !v.zalobot.some((x) => x.chatId === g.chatId));
  return (
    <div className="space-y-6 text-sm">
      <fieldset>
        <legend className="mb-1 font-medium text-slate-700">{t("notify.reportPanel.zaloLegend")}</legend>
        {!channels.zalobot ? (
          <p className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            {t("notify.reportPanel.noZaloBot")}{" "}
            <a href="/connections/channels#zalo-bot" className="font-medium underline">
              {t("notify.reportPanel.notConnectedLink")}
            </a>
            .
          </p>
        ) : (
          <p className="mb-2 text-xs text-slate-500">
            {t("notify.reportPanel.zaloHelpA")}<b>{channels.zalobot}</b>{t("notify.reportPanel.zaloHelpB")}<b>/id</b>{t("notify.reportPanel.zaloHelpC", { bot: channels.zalobot })}<b>{t("notify.reportPanel.find")}</b>.
          </p>
        )}
        <div className="space-y-2">
          {v.zalobot.map((r, i) => (
            <div key={r.chatId} className="flex flex-wrap items-center gap-3">
              <span className="text-slate-800">{r.title || t("notify.reportPanel.unnamed")}</span>
              <code className="text-xs text-slate-400">{r.chatId.slice(-8)}</code>
              {removeBtn(() => setV({ ...v, zalobot: v.zalobot.filter((_, k) => k !== i) }))}
            </div>
          ))}
          {channels.zalobot && leadSuggest.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
              {t("notify.reportPanel.leadGroups")}
              {leadSuggest.map((g) => (
                <button key={g.chatId} type="button" className="text-indigo-600 hover:underline" onClick={() => addZalo(g)}>
                  + {g.title || g.chatId.slice(-8)}
                </button>
              ))}
            </div>
          )}
          {channels.zalobot && (
            <div className="flex flex-wrap items-center gap-2">
              <input className={`${inputClass} max-w-[16rem]`} placeholder={t("notify.reportPanel.searchPlaceholder")} value={zq} onChange={(e) => setZq(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), findZalo())} />
              <button type="button" className={btnClass("secondary")} disabled={pending} onClick={findZalo}>
                {pending && <Spinner />} {t("notify.reportPanel.find")}
              </button>
            </div>
          )}
          {zFound && zFound.length > 0 && (
            <ul className="space-y-1 rounded-lg border border-slate-200 p-2">
              {zFound.map((c) => {
                const added = v.zalobot.some((x) => x.chatId === c.chatId);
                return (
                  <li key={c.chatId} className="flex items-center justify-between gap-3">
                    <span>
                      {c.title || t("notify.reportPanel.unnamedCode", { code: c.code })} <span className="text-xs text-slate-400">· {c.type}{c.hint && ` · ${c.hint}`}</span>
                    </span>
                    <button type="button" className="text-xs text-indigo-600 hover:underline disabled:text-slate-400 disabled:no-underline" disabled={added} onClick={() => addZalo({ title: c.title, chatId: c.chatId })}>
                      {added ? t("notify.reportPanel.added") : t("notify.reportPanel.add")}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-1 font-medium text-slate-700">{t("notify.reportPanel.emailLegend")}</legend>
        {!channels.email && <NotConnected what="email" />}
        <div className="space-y-2">
          {v.emails.map((r, i) => (
            <div key={i} className="grid items-center gap-2 sm:grid-cols-[12rem_16rem_auto] sm:justify-start">
              <input className={inputClass} value={r.name} onChange={(e) => setE(i, { name: e.target.value })} placeholder={t("notify.reportPanel.namePlaceholder")} />
              <input className={inputClass} value={r.email} onChange={(e) => setE(i, { email: e.target.value })} placeholder="ten@congty.vn" inputMode="email" />
              {removeBtn(() => setV({ ...v, emails: v.emails.filter((_, k) => k !== i) }))}
            </div>
          ))}
          {v.emails.length < 10 && (
            <button type="button" className="text-xs text-indigo-600 hover:underline" onClick={() => setV({ ...v, emails: [...v.emails, { name: "", email: "" }] })}>
              {t("notify.reportPanel.addEmail")}
            </button>
          )}
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-1 font-medium text-slate-700">{t("notify.reportPanel.tgLegend")}</legend>
        {!channels.telegram ? (
          <NotConnected what="telegram" />
        ) : (
          <p className="mb-2 text-xs text-slate-500">
            {t("notify.reportPanel.tgHelpA")}<b>@{channels.telegram}</b>{t("notify.reportPanel.tgHelpB")}<b>{t("notify.reportPanel.find")}</b>{t("notify.reportPanel.tgHelpC")}
          </p>
        )}
        <div className="space-y-2">
          {v.telegram.map((r, i) => (
            <div key={r.chatId} className="flex flex-wrap items-center gap-3">
              <span className="text-slate-800">{r.title || t("notify.reportPanel.noName")}</span>
              <code className="text-xs text-slate-400">{r.chatId}</code>
              {removeBtn(() => setV({ ...v, telegram: v.telegram.filter((_, k) => k !== i) }))}
            </div>
          ))}
          {channels.telegram && (
            <div className="flex flex-wrap items-center gap-2">
              <input className={`${inputClass} max-w-[16rem]`} placeholder={t("notify.reportPanel.tgPlaceholder")} value={tq} onChange={(e) => setTq(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), findChats())} />
              <button type="button" className={btnClass("secondary")} disabled={pending} onClick={findChats}>
                {pending && <Spinner />} {t("notify.reportPanel.find")}
              </button>
            </div>
          )}
          {found && found.length > 0 && (
            <ul className="space-y-1 rounded-lg border border-slate-200 p-2">
              {found.map((c) => {
                const added = v.telegram.some((x) => x.chatId === c.chatId);
                return (
                  <li key={c.chatId} className="flex items-center justify-between gap-3">
                    <span>
                      {c.title} <span className="text-xs text-slate-400">· {c.type}</span>
                    </span>
                    <button type="button" className="text-xs text-indigo-600 hover:underline disabled:text-slate-400 disabled:no-underline" disabled={added} onClick={() => setV({ ...v, telegram: [...v.telegram, { title: c.title, chatId: c.chatId }] })}>
                      {added ? t("notify.reportPanel.added") : t("notify.reportPanel.add")}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </fieldset>

      <details className="rounded-lg border border-slate-200 px-3 py-2" open={v.recipients.length > 0}>
        <summary className="cursor-pointer font-medium text-slate-700">{t("notify.reportPanel.oaSummary")}</summary>
        <p className="mt-2 mb-2 text-xs text-slate-500">
          {t("notify.reportPanel.oaHelpA")}<b>{t("notify.reportPanel.copyBold")}</b>{t("notify.reportPanel.oaHelpB")}
          {channels.zaloNotReady && <b className="text-amber-700"> {channels.zaloNotReady}</b>}
        </p>
        <div className="space-y-2">
          {v.recipients.map((r, i) => (
            <div key={i} className="grid items-center gap-2 sm:grid-cols-[12rem_11rem_auto] sm:justify-start">
              <input className={inputClass} value={r.name} onChange={(e) => setR(i, { name: e.target.value })} placeholder={t("notify.reportPanel.namePlaceholder")} />
              <input className={inputClass} value={r.phone} onChange={(e) => setR(i, { phone: e.target.value })} placeholder="0987 654 321" inputMode="tel" />
              {removeBtn(() => setV({ ...v, recipients: v.recipients.filter((_, k) => k !== i) }))}
            </div>
          ))}
          {v.recipients.length < 10 && (
            <button type="button" className="text-xs text-indigo-600 hover:underline" onClick={() => setV({ ...v, recipients: [...v.recipients, { name: "", phone: "" }] })}>
              {t("notify.reportPanel.addPhone")}
            </button>
          )}
        </div>
      </details>

      <fieldset>
        <legend className="mb-1 font-medium text-slate-700">{t("notify.reportPanel.dailyLegend")}</legend>
        <p className="mb-2 text-xs text-slate-500">
          {t("notify.reportPanel.dailyIntro")}
        </p>
        <div className="space-y-2">
          {(
            [
              ["link", t("notify.reportPanel.optLink"), t("notify.reportPanel.optLinkHint")],
              ["quality", t("notify.reportPanel.optQuality"), t("notify.reportPanel.optQualityHint")],
              ["remind", t("notify.reportPanel.optRemind"), t("notify.reportPanel.optRemindHint")],
            ] as const
          ).map(([k, label, hint]) => (
            <label key={k} className="flex items-start gap-2">
              <input type="checkbox" className="mt-0.5" checked={v.daily[k]} onChange={(e) => setV({ ...v, daily: { ...v.daily, [k]: e.target.checked } })} />
              <span>
                <span className="font-medium text-slate-800">{label}</span>
                <span className="block text-xs text-slate-500">{hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={btnClass("primary")} disabled={pending} onClick={save}>
          {pending ? t("notify.reportPanel.saving") : t("notify.reportPanel.save")}
        </button>
        <Note msg={msg} />
      </div>
    </div>
  );
}

/** Daily report: the "Hôm nay {operator} làm gì" (what the platform did today) line (shown in the message and the client-facing page). */
export function DailyTodoForm({ reportId, initial, edited }: { reportId: string; initial: string; edited: boolean }) {
  const router = useRouter();
  const t = useT();
  const [todo, setTodo] = useState(initial);
  const [msg, setMsg] = useState<Msg>(null);
  const [pending, start] = useTransition();
  const save = () =>
    start(async () => {
      const r = await saveDailyTodoAction(reportId, todo);
      setMsg(r.ok ? { ok: true, text: edited ? t("notify.reportPanel.todoSavedEdited") : t("notify.reportPanel.todoSaved") } : { ok: false, text: r.error });
      if (r.ok) router.refresh();
    });
  return (
    <div className="mb-4 space-y-2 rounded-lg border border-slate-200 p-3 text-sm">
      <label className="block font-medium text-slate-700" htmlFor={`todo-${reportId}`}>
        {t("notify.reportPanel.todoTitle")} <span className="font-normal text-slate-400">{t("notify.reportPanel.todoOptional")}</span>
      </label>
      <textarea
        id={`todo-${reportId}`}
        className={`${inputClass} min-h-16 w-full`}
        value={todo}
        maxLength={500}
        onChange={(e) => setTodo(e.target.value)}
        placeholder={t("notify.reportPanel.todoPlaceholder")}
      />
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={btnClass("secondary")} disabled={pending || todo === initial} onClick={save}>
          {pending ? t("notify.reportPanel.saving") : t("notify.reportPanel.save")}
        </button>
        <Note msg={msg} />
      </div>
    </div>
  );
}

export type ParamRow = { name: string; type: string; maxLength: number; require: boolean; auto: string; value: string; override: boolean; error: string | null };
type SendRow = { channel: Channel; name: string; to: string; ok: boolean; error?: string; at: string };
export type Target = { channel: Channel; to: string; label: string; sub: string };

export function ReportSendPanel({
  reportId,
  link,
  status,
  sent,
  message,
  autoMessage,
  edited,
  targets,
  params,
  templateName,
  price,
  sends,
  emptyHint,
}: {
  reportId: string;
  link: string | null;
  status: string;
  sent: boolean;
  message: string;
  autoMessage: string; // auto-drafted version from the data
  edited: boolean; // manually edited content
  targets: Target[]; // recipients on the connected channels
  params: ParamRow[]; // Zalo OA template parameters (empty if the OA isn't ready)
  templateName: string | null;
  price: string | null;
  sends: SendRow[];
  emptyHint: string; // why there is no one to send to automatically
}) {
  const router = useRouter();
  const t = useT();
  const channelName = channelLabels(t);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<Msg>(null);
  const [text, setText] = useState(message);
  const [vals, setVals] = useState<Record<string, string>>(Object.fromEntries(params.filter((p) => p.override).map((p) => [p.name, p.value])));
  const [pick, setPick] = useState<string[]>(targets.map((x) => `${x.channel}:${x.to}`));
  const [testPhone, setTestPhone] = useState("");
  const textDirty = text !== message;
  const paramsDirty = params.some((p) => (vals[p.name] ?? "") !== (p.override ? p.value : ""));
  const revoked = status === "revoked";
  const chosen = targets.filter((x) => pick.includes(`${x.channel}:${x.to}`));
  const zaloCount = chosen.filter((x) => x.channel === "zalo").length;

  const act = (fn: () => Promise<{ ok: boolean; error?: string }>, okText: string) =>
    start(async () => {
      const r = await fn();
      setMsg(r.ok ? { ok: true, text: okText } : { ok: false, text: r.error ?? t("notify.reportPanel.error") });
      if (r.ok) router.refresh();
    });
  const send = () => {
    const who = chosen.map((x) => x.label).join(", ");
    if (!confirm(t("notify.reportPanel.confirmSend", { n: chosen.length, who, zalo: zaloCount && price ? t("notify.reportPanel.zaloCost", { v: Number(price) * zaloCount }) : "", again: sent ? t("notify.reportPanel.again") : "" }))) return;
    start(async () => {
      if (textDirty) {
        const s = await saveReportMessageAction(reportId, text);
        if (!s.ok) return setMsg({ ok: false, text: s.error });
      }
      const targetsBy: Partial<Record<Channel, string[]>> = {};
      for (const x of chosen) (targetsBy[x.channel] ??= []).push(x.to);
      const r = await sendClientReportAction(reportId, targetsBy);
      setMsg(r.ok ? { ok: !r.partial, text: r.note } : { ok: false, text: r.error });
      router.refresh();
    });
  };

  return (
    <div className="space-y-5 text-sm">
      <Note msg={msg} />
      {link && !revoked && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 px-3 py-2">
          <span className="text-slate-500">{t("notify.reportPanel.reportLink")}</span>
          <a href={link} target="_blank" rel="noreferrer" className="font-mono text-xs break-all text-indigo-600 hover:underline">
            {link}
          </a>
          <CopyButton text={link} />
        </div>
      )}
      {revoked && <p className="rounded-lg bg-slate-100 px-3 py-2 text-slate-600">{t("notify.reportPanel.revokedNote")}</p>}

      <section>
        <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="font-medium text-slate-800">{t("notify.reportPanel.content")}</h3>
          <span className="text-xs text-slate-400">{text !== autoMessage ? t("notify.reportPanel.editedByHand") : t("notify.reportPanel.autoDrafted")}{t("notify.reportPanel.usedFor")}</span>
        </div>
        <textarea className={`${inputClass} h-44 text-[13px] leading-relaxed`} value={text} onChange={(e) => setText(e.target.value)} disabled={revoked} />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <CopyForZalo text={text} />
          {textDirty && (
            <button type="button" className={btnClass("secondary")} disabled={pending} onClick={() => act(() => saveReportMessageAction(reportId, text), t("notify.reportPanel.contentSaved"))}>
              {t("notify.reportPanel.saveContent")}
            </button>
          )}
          {(edited || text !== autoMessage) && (
            <button
              type="button"
              className="text-xs text-slate-500 hover:text-indigo-600"
              disabled={pending}
              onClick={() => {
                if (!confirm(t("notify.reportPanel.resetConfirm"))) return;
                setText(autoMessage);
                act(() => saveReportMessageAction(reportId, ""), t("notify.reportPanel.resetDone"));
              }}
            >
              {t("notify.reportPanel.reset")}
            </button>
          )}
        </div>
        <p className="mt-1 text-xs text-slate-500">{t("notify.reportPanel.zaloHint")}</p>
      </section>

      <section>
        <h3 className="mb-1 font-medium text-slate-800">{t("notify.reportPanel.sendTo")}</h3>
        {targets.length ? (
          <div className="space-y-1">
            {targets.map((x) => {
              const k = `${x.channel}:${x.to}`;
              return (
                <label key={k} className="flex items-center gap-2">
                  <input type="checkbox" checked={pick.includes(k)} onChange={(e) => setPick(e.target.checked ? [...pick, k] : pick.filter((x) => x !== k))} />
                  <span className="w-20 shrink-0 text-xs text-slate-500">{channelName[x.channel]}</span>
                  <span className="text-slate-800">{x.label}</span>
                  {x.sub && <span className="text-xs text-slate-400">{x.sub}</span>}
                </label>
              );
            })}
          </div>
        ) : (
          <p className="text-xs text-amber-700">{emptyHint}</p>
        )}
        <button type="button" className={`${btnClass("primary")} mt-3`} disabled={pending || !chosen.length || revoked || paramsDirty} title={paramsDirty ? t("notify.reportPanel.saveParamsFirst") : undefined} onClick={send}>
          {pending && <Spinner />} {t("notify.reportPanel.sendBtn", { again: sent ? t("notify.reportPanel.sendAgain") : "", count: chosen.length ? `(${chosen.length})` : "" })}
        </button>
      </section>

      {params.length > 0 && (
        <details className="rounded-lg border border-slate-200 px-3 py-2">
          <summary className="cursor-pointer font-medium text-slate-700">
            {t("notify.reportPanel.paramsSummary")} {templateName && <span className="font-normal text-slate-500">· “{templateName}”{price && t("notify.reportPanel.pricePer", { v: price })}</span>}
          </summary>
          <table className="mt-2 w-full text-xs">
            <tbody className="divide-y divide-slate-100">
              {params.map((p) => {
                const cur = vals[p.name] ?? "";
                const shown = cur || p.auto;
                const err = cur ? (p.maxLength && cur.length > p.maxLength ? t("notify.reportPanel.tooLong", { a: cur.length, b: p.maxLength }) : null) : p.error;
                return (
                  <tr key={p.name}>
                    <td className="py-1.5 pr-3 align-top">
                      <code>{p.name}</code>
                      <div className="text-slate-400">{t("notify.reportPanel.maxN", { n: p.maxLength })}</div>
                    </td>
                    <td className="py-1.5 align-top">
                      <input className={`${inputClass} py-1 text-xs ${err ? "border-rose-400" : ""}`} value={cur} placeholder={p.auto || t("notify.reportPanel.empty")} onChange={(e) => setVals({ ...vals, [p.name]: e.target.value })} disabled={revoked} />
                      <div className={`mt-0.5 ${err ? "text-rose-600" : "text-slate-400"}`}>{err ?? `${t("notify.reportPanel.chars", { n: shown.length })}${cur ? t("notify.reportPanel.manualEdit") : t("notify.reportPanel.autoFilled")}`}</div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {paramsDirty && (
              <button type="button" className={btnClass("secondary")} disabled={pending} onClick={() => act(() => saveReportOverridesAction(reportId, Object.fromEntries(Object.entries(vals).filter(([, v]) => v.trim()))), t("notify.reportPanel.valuesSaved"))}>
                {t("notify.reportPanel.saveValues")}
              </button>
            )}
            <span className="text-xs text-slate-500">{t("notify.reportPanel.test")}</span>
            <span className="w-36">
              <input className={`${inputClass} py-1 text-xs`} value={testPhone} onChange={(e) => setTestPhone(e.target.value)} placeholder={t("notify.reportPanel.phonePlaceholder")} inputMode="tel" />
            </span>
            <button type="button" className={btnClass("secondary")} disabled={pending || !testPhone || paramsDirty || revoked} onClick={() => act(() => sendTestReportAction(reportId, testPhone), t("notify.reportPanel.testSent", { phone: testPhone }))}>
              {t("notify.reportPanel.testBtn")}
            </button>
          </div>
        </details>
      )}

      {sends.length > 0 && (
        <section>
          <h3 className="mb-1 font-medium text-slate-800">{t("notify.reportPanel.sentTitle")}</h3>
          <ul className="space-y-0.5 text-xs">
            {sends.map((s, i) => (
              <li key={i} className={s.ok ? "text-emerald-700" : "text-rose-600"}>
                {s.ok ? "✓" : "✗"} {new Date(s.at).toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "short" })} · {channelName[s.channel] ?? s.channel} · {s.name || s.to}
                {s.channel === "email" && s.name && ` <${s.to}>`}
                {s.error && ` · ${s.error}`}
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="flex flex-wrap gap-3 border-t border-slate-100 pt-3 text-xs">
        {!revoked && (
          <button type="button" className="text-slate-500 hover:text-rose-600" disabled={pending} onClick={() => confirm(t("notify.reportPanel.revokeConfirm")) && act(() => revokeClientReportAction(reportId), t("notify.reportPanel.revokedDone"))}>
            {t("notify.reportPanel.revoke")}
          </button>
        )}
        {!sent && (
          <button type="button" className="text-slate-500 hover:text-rose-600" disabled={pending} onClick={() => confirm(t("notify.reportPanel.deleteConfirm")) && act(() => deleteClientReportAction(reportId), t("notify.reportPanel.deleted"))}>
            {t("notify.reportPanel.deleteBtn")}
          </button>
        )}
      </div>
    </div>
  );
}

function CopyForZalo({ text }: { text: string }) {
  const t = useT();
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={btnClass("primary")}
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 2000);
      }}
    >
      {done ? t("notify.reportPanel.copied") : t("notify.reportPanel.copy")}
    </button>
  );
}
