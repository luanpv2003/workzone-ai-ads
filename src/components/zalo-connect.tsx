"use client";
import { BRAND } from "@/lib/brand";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { OaStatus, ZaloTemplate } from "@/lib/zalo";
import { guessVar, reportVarList } from "@/lib/client-report-vars";
import {
  chooseZaloTemplateAction,
  clearZaloTemplateAction,
  saveZaloAppAction,
  saveZaloMapAction,
  zaloAuthorizeAction,
  zaloDisconnectAction,
  zaloRefreshTokenAction,
  zaloTemplatesAction,
} from "@/app/zalo-actions";
import { CopyButton } from "./copy-button";
import { Spinner } from "./action-button";
import { btnClass, inputClass } from "./ui";
import { useT } from "@/i18n/client";

// Zalo OA connection (System settings): Zalo app → authorize the OA → pick the report message template and how to fill each parameter.

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "short" }) : "—");
/** Suggested template content to register on ZBS Account (Zalo approves in 1–2 business days). It is the text Vietnamese customers receive on Zalo, so it stays in Vietnamese. */
const SUGGESTED = `Loại mẫu: Tùy chỉnh · Tag 2 (Chăm sóc khách hàng)
Tên mẫu: Báo cáo quảng cáo định kỳ
Logo: logo ${BRAND.agency}

Tiêu đề: Báo cáo quảng cáo <ky_bao_cao>
Đoạn văn: ${BRAND.agency} gửi <ten_khach> kết quả quảng cáo Facebook từ <tu_ngay> đến <den_ngay>:
Bảng:
  Chi tiêu        | <chi_tieu>
  Kết quả         | <ket_qua>
  Chi phí/kết quả | <gia_ket_qua>
  So với kỳ trước | <so_ky_truoc>
Đoạn văn: Chi tiết từng chiến dịch và nhận xét của ${BRAND.agency} xem tại nút bên dưới.
Nút: Xem báo cáo chi tiết → https://ads.example.com/r/<ma_bao_cao>

Loại tham số gợi ý: ky_bao_cao, ket_qua, so_ky_truoc = Nhãn tùy chỉnh (30) · ten_khach = Tên sản phẩm/Thương hiệu
· tu_ngay, den_ngay = Thời gian · chi_tieu, gia_ket_qua = Số lượng/Số tiền (20) · ma_bao_cao = Mã số (30) hoặc URL`;

export function ZaloConnect({ status, template, callbackUrl, isAdmin, flash }: { status: OaStatus; template: ZaloTemplate | null; callbackUrl: string; isAdmin: boolean; flash: { ok: boolean; text: string } | null }) {
  const router = useRouter();
  const t = useT();
  const vars = reportVarList(t);
  const SAMPLE = Object.fromEntries(vars.map((v) => [v.key, v.sample])) as Record<string, string>;
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState(flash);
  const [appId, setAppId] = useState(status?.appId ?? "");
  const [secret, setSecret] = useState("");
  const [refresh, setRefresh] = useState("");
  const [showManual, setShowManual] = useState(false);
  const [list, setList] = useState<{ id: string; name: string; quality: string | null }[] | null>(null);
  const [pick, setPick] = useState(template?.templateId ?? "");
  const [map, setMap] = useState<Record<string, string>>({});
  const savedMap = (name: string) => template?.map[name] ?? guessVar(name);
  const [showSuggest, setShowSuggest] = useState(!template);

  const act = (fn: () => Promise<{ ok: boolean; error?: string }>, okText: string, then?: () => void) =>
    start(async () => {
      const r = await fn();
      setMsg(r.ok ? { ok: true, text: okText } : { ok: false, text: r.error ?? t("notify.zaloConnect.error") });
      if (r.ok) {
        then?.();
        router.refresh();
      }
    });

  if (!isAdmin) {
    return (
      <p className="text-sm text-slate-600">
        {status?.connected ? t("notify.zaloConnect.viewConnected", { name: status.oaName ?? status.oaId ?? "" }) : t("notify.zaloConnect.viewNotConnected")} {template ? t("notify.zaloConnect.viewTemplate", { name: template.templateName }) : ""} {t("notify.zaloConnect.viewOnly")}
      </p>
    );
  }

  const dirtyMap = template && template.params.some((p) => map[p.name] != null && map[p.name] !== template.map[p.name]);

  return (
    <div className="space-y-5 text-sm">
      <p className="text-slate-600">
        {t("notify.zaloConnect.introA")}<b>{t("notify.zaloConnect.introBold")}</b>{t("notify.zaloConnect.introB")}
      </p>
      {msg && <p className={`rounded-lg px-3 py-2 ${msg.ok ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-700"}`}>{msg.text}</p>}

      {/* 1. App Zalo */}
      <section>
        <h3 className="mb-1 font-medium text-slate-800">{t("notify.zaloConnect.s1")}</h3>
        <p className="mb-2 text-xs text-slate-500">
          {t("notify.zaloConnect.s1HelpA")}<b>{t("notify.zaloConnect.appIdBold")}</b>{t("notify.zaloConnect.and")}<b>{t("notify.zaloConnect.secretBold")}</b>{t("notify.zaloConnect.s1HelpB")}
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="block">
            <span className="mb-1 block text-xs text-slate-600">App ID</span>
            <input className={`${inputClass} w-56`} value={appId} onChange={(e) => setAppId(e.target.value.trim())} placeholder={t("notify.zaloConnect.appIdPlaceholder")} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-slate-600">{t("notify.zaloConnect.secretLabel", { keep: status?.appId ? t("notify.zaloConnect.keepOld") : "" })}</span>
            <input className={`${inputClass} w-64`} type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={status?.appId ? "••••••••" : t("notify.zaloConnect.secretPlaceholder")} />
          </label>
          <button type="button" className={btnClass("secondary")} disabled={pending || !appId || (!secret && !status?.appId)} onClick={() => act(() => saveZaloAppAction(appId, secret), t("notify.zaloConnect.appSaved"), () => setSecret(""))}>
            {t("notify.zaloConnect.saveApp")}
          </button>
        </div>
      </section>

      {/* 2. Authorize OA */}
      {status?.appId && (
        <section>
          <h3 className="mb-1 font-medium text-slate-800">{t("notify.zaloConnect.s2")}</h3>
          {status.connected ? (
            <div className={`rounded-lg border px-3 py-2.5 ${status.lastError ? "border-rose-200 bg-rose-50" : "border-emerald-200 bg-emerald-50"}`}>
              <p className="font-medium text-slate-800">
                {status.lastError ? t("notify.zaloConnect.refreshError") : t("notify.zaloConnect.connectedOk")} {t("notify.zaloConnect.oaWord", { name: status.oaName ?? "" })} {status.oaId && <span className="font-normal text-slate-500">({status.oaId})</span>}
              </p>
              <p className="mt-0.5 text-xs text-slate-600">
                {t("notify.zaloConnect.connectedAt", { time: fmt(status.connectedAt) })}
                {status.connectedBy && t("notify.zaloConnect.connectedBy", { by: status.connectedBy })}{t("notify.zaloConnect.tokenInfo", { a: fmt(status.accessExpiresAt), b: fmt(status.refreshExpiresAt) })}
              </p>
              {status.lastError && <p className="mt-1 text-xs text-rose-700">{status.lastError}{t("notify.zaloConnect.reconnectHint")}</p>}
            </div>
          ) : (
            <p className="mb-2 text-xs text-slate-500">
              {t("notify.zaloConnect.s2HelpA")}<b>{t("notify.zaloConnect.s2Bold1")}</b>{t("notify.zaloConnect.s2HelpB")}<b>{t("notify.zaloConnect.s2Bold2")}</b>{t("notify.zaloConnect.s2HelpC")}<b>{t("notify.zaloConnect.s2Bold3")}</b>{t("notify.zaloConnect.s2HelpD")}
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <span className="text-slate-500">{t("notify.zaloConnect.callback")}</span>
            <code className="rounded bg-slate-100 px-1.5 py-0.5">{callbackUrl}</code>
            <CopyButton text={callbackUrl} />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={btnClass(status.connected ? "secondary" : "primary")}
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await zaloAuthorizeAction();
                  if (r.ok) window.location.href = r.url;
                  else setMsg({ ok: false, text: r.error });
                })
              }
            >
              {pending && <Spinner />} {status.connected ? t("notify.zaloConnect.reconnect") : t("notify.zaloConnect.connect")}
            </button>
            <button type="button" className="text-xs text-indigo-600 hover:underline" onClick={() => setShowManual(!showManual)}>
              {t("notify.zaloConnect.manual")}
            </button>
            {status.connected && (
              <button type="button" className="ml-auto text-xs text-rose-600 hover:underline" disabled={pending} onClick={() => confirm(t("notify.zaloConnect.disconnectConfirm")) && act(zaloDisconnectAction, t("notify.zaloConnect.disconnected"))}>
                {t("notify.zaloConnect.disconnect")}
              </button>
            )}
          </div>
          {showManual && (
            <div className="mt-2 rounded-lg border border-slate-200 p-3">
              <p className="mb-2 text-xs text-slate-500">
                {t("notify.zaloConnect.manualA")}<b>{t("notify.zaloConnect.manualBold1")}</b>{t("notify.zaloConnect.manualB")}<b>{t("notify.zaloConnect.manualBold2")}</b>{t("notify.zaloConnect.manualC")}<b>{t("notify.zaloConnect.manualBold3")}</b>{t("notify.zaloConnect.manualD")}
              </p>
              <div className="flex gap-2">
                <input className={inputClass} type="password" autoComplete="off" value={refresh} onChange={(e) => setRefresh(e.target.value)} placeholder="Refresh Token" />
                <button type="button" className={btnClass("primary")} disabled={pending || !refresh} onClick={() => act(() => zaloRefreshTokenAction(refresh), t("notify.zaloConnect.connectedMsg"), () => setRefresh(""))}>
                  {t("notify.zaloConnect.connectBtn")}
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {/* 3. Message template */}
      {status?.connected && (
        <section>
          <h3 className="mb-1 font-medium text-slate-800">{t("notify.zaloConnect.s3")}</h3>
          <button type="button" className="mb-2 text-xs text-indigo-600 hover:underline" onClick={() => setShowSuggest(!showSuggest)}>
            {t("notify.zaloConnect.suggestedToggle", { v: showSuggest ? t("notify.zaloConnect.hide") : t("notify.zaloConnect.view") })}
          </button>
          {showSuggest && (
            <div className="mb-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
              <p className="mb-2 text-xs text-slate-600">
                {t("notify.zaloConnect.suggestedA")}<b>account.zalo.solutions</b>{t("notify.zaloConnect.suggestedB")}
              </p>
              <pre className="overflow-x-auto text-xs whitespace-pre-wrap text-slate-700">{SUGGESTED}</pre>
              <div className="mt-2">
                <CopyButton text={SUGGESTED} />
              </div>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {list ? (
              <select className={`${inputClass} w-80`} value={pick} onChange={(e) => setPick(e.target.value)}>
                <option value="">{t("notify.zaloConnect.pickOption")}</option>
                {list.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name} ({x.id})
                  </option>
                ))}
              </select>
            ) : (
              <input className={`${inputClass} w-56`} value={pick} onChange={(e) => setPick(e.target.value.trim())} placeholder="Template ID" />
            )}
            <button
              type="button"
              className={btnClass("secondary")}
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await zaloTemplatesAction();
                  if (r.ok) {
                    setList(r.list);
                    setMsg(r.list.length ? null : { ok: false, text: t("notify.zaloConnect.noApproved") });
                  } else setMsg({ ok: false, text: r.error });
                })
              }
            >
              {t("notify.zaloConnect.loadApproved")}
            </button>
            <button type="button" className={btnClass("primary")} disabled={pending || !pick} onClick={() => act(() => chooseZaloTemplateAction(pick), t("notify.zaloConnect.templateChosen"), () => setMap({}))}>
              {t("notify.zaloConnect.useTemplate")}
            </button>
          </div>

          {template && (
            <div className="mt-3 rounded-lg border border-slate-200">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-200 px-3 py-2">
                <span className="font-medium text-slate-800">{template.templateName}</span>
                <span className="text-xs text-slate-500">ID {template.templateId}</span>
                <span className={`text-xs ${template.status === "ENABLE" ? "text-emerald-600" : "text-amber-600"}`}>{template.status}</span>
                {template.price && <span className="text-xs text-slate-500">{t("notify.zaloConnect.pricePer", { v: template.price })}</span>}
                {template.previewUrl && (
                  <a href={template.previewUrl} target="_blank" rel="noreferrer" className="text-xs text-indigo-600 hover:underline">
                    {t("notify.zaloConnect.previewTemplate")}
                  </a>
                )}
                <button type="button" className="ml-auto text-xs text-slate-500 hover:text-rose-600" disabled={pending} onClick={() => confirm(t("notify.zaloConnect.dropConfirm")) && act(clearZaloTemplateAction, t("notify.zaloConnect.dropped"))}>
                  {t("notify.zaloConnect.drop")}
                </button>
              </div>
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-left text-slate-500">
                  <tr>
                    <th className="px-3 py-1.5 font-medium">{t("notify.zaloConnect.thParam")}</th>
                    <th className="px-3 py-1.5 font-medium">{t("notify.zaloConnect.thSource")}</th>
                    <th className="px-3 py-1.5 font-medium">{t("notify.zaloConnect.thExample")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {template.params.map((p) => {
                    const m = map[p.name] ?? savedMap(p.name);
                    const isText = m.startsWith("text:");
                    const sample = isText ? m.slice(5) : (SAMPLE[m.slice(4)] ?? "");
                    const tooLong = p.maxLength > 0 && sample.length > p.maxLength;
                    return (
                      <tr key={p.name}>
                        <td className="px-3 py-1.5 align-top">
                          <code>{p.name}</code>
                          <div className="text-slate-400">
                            {p.type}{t("notify.zaloConnect.maxLen", { n: p.maxLength })}
                            {p.require ? t("notify.zaloConnect.required") : ""}
                          </div>
                        </td>
                        <td className="px-3 py-1.5 align-top">
                          <select className={`${inputClass} py-1 text-xs`} value={isText ? "text:" : m} onChange={(e) => setMap({ ...map, [p.name]: e.target.value })}>
                            {vars.map((v) => (
                              <option key={v.key} value={`var:${v.key}`}>
                                {v.label}
                              </option>
                            ))}
                            <option value="text:">{t("notify.zaloConnect.fixedText")}</option>
                          </select>
                          {isText && <input className={`${inputClass} mt-1 py-1 text-xs`} value={m.slice(5)} onChange={(e) => setMap({ ...map, [p.name]: `text:${e.target.value}` })} placeholder={t("notify.zaloConnect.fixedPlaceholder")} />}
                        </td>
                        <td className={`px-3 py-1.5 align-top ${tooLong ? "text-rose-600" : "text-slate-600"}`}>
                          {sample || <span className="text-slate-400">{t("notify.zaloConnect.empty")}</span>}
                          {tooLong && <div>{t("notify.zaloConnect.tooLong", { n: sample.length, max: p.maxLength })}</div>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="flex items-center gap-2 border-t border-slate-200 px-3 py-2">
                <button type="button" className={btnClass("primary")} disabled={pending || !dirtyMap} onClick={() => act(() => saveZaloMapAction(Object.fromEntries(template.params.map((p) => [p.name, map[p.name] ?? savedMap(p.name)]))), t("notify.zaloConnect.mapSaved"), () => setMap({}))}>
                  {t("notify.zaloConnect.saveMap")}
                </button>
                <span className="text-xs text-slate-500">{t("notify.zaloConnect.mapNote")}</span>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
