"use client";

import { useState, useTransition } from "react";
import { checkTokenAction, replaceTokenAction } from "@/app/actions";
import { btnClass, inputClass } from "./ui";
import { Spinner } from "./action-button";
import { useT } from "@/i18n/client";

/** Buttons on each row of the Meta Token page (System settings): re-check, paste a new token. */
export function TokenRowActions({ clientId, hasToken, owner, sharedCount }: { clientId: string; hasToken: boolean; owner: string | null; sharedCount: number }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [applyAll, setApplyAll] = useState(sharedCount > 1);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [checking, startCheck] = useTransition();
  const [saving, startSave] = useTransition();

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap justify-end gap-2">
        {hasToken && (
          <button
            type="button"
            className={btnClass("ghost")}
            disabled={checking}
            onClick={() =>
              startCheck(async () => {
                const r = await checkTokenAction(clientId);
                setMsg(r.ok ? { ok: true, text: t("settings.tokenRow.checked") } : { ok: false, text: r.error });
              })
            }
          >
            {checking && <Spinner />}{t("settings.tokenRow.recheck")}
          </button>
        )}
        <button type="button" className={btnClass(open ? "secondary" : "primary")} onClick={() => setOpen(!open)}>
          {open ? t("settings.tokenRow.close") : hasToken ? t("settings.tokenRow.pasteNew") : t("settings.tokenRow.add")}
        </button>
      </div>
      {open && (
        <div className="space-y-2 rounded-lg border border-slate-200 bg-panel p-3 text-left">
          <input type="password" autoComplete="off" placeholder={t("settings.tokenRow.placeholder")} value={token} onChange={(e) => setToken(e.target.value)} className={inputClass} />
          {owner && sharedCount > 1 && (
            <label className="flex items-center gap-2 text-xs text-slate-600">
              <input type="checkbox" className="accent-indigo-600" checked={applyAll} onChange={(e) => setApplyAll(e.target.checked)} />
              {t("settings.tokenRow.applyAll", { count: sharedCount, owner })}
            </label>
          )}
          <button
            type="button"
            className={btnClass("primary")}
            disabled={saving || !token.trim()}
            onClick={() =>
              startSave(async () => {
                const r = await replaceTokenAction(clientId, token, applyAll);
                if (r.ok) {
                  setToken("");
                  setOpen(false);
                  setMsg({ ok: true, text: t("settings.tokenRow.updated", { list: r.updated.join(", ") }) });
                } else setMsg({ ok: false, text: r.error });
              })
            }
          >
            {saving && <Spinner />}{t("settings.tokenRow.checkSave")}
          </button>
          <p className="text-xs text-slate-400">{t("settings.tokenRow.note")}</p>
        </div>
      )}
      {msg && <p className={`text-right text-xs ${msg.ok ? "text-emerald-600" : "text-rose-600"}`}>{msg.text}</p>}
    </div>
  );
}
