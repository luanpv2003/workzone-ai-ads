"use client";

import { useState, useTransition } from "react";
import { setSheetSinceAction } from "@/app/lead-sheet-actions";
import { btnClass } from "@/components/ui";
import { useT } from "@/i18n/client";

/** Start date for syncing to Google Sheet: only leads from this date (empty = all leads). */
export function SheetSince({ clientId, value, count, total }: { clientId: string; value: string; count: number; total: number }) {
  const t = useT();
  const [day, setDay] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const save = (d: string) =>
    start(async () => {
      setError(null);
      const r = await setSheetSinceAction(clientId, d);
      if (!r.ok) setError(r.error);
    });
  return (
    <div className="rounded-lg border border-line bg-slate-50 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <label htmlFor="sheet-since" className="font-medium text-ink">{t("customers.sheetSince.label")}</label>
        <input id="sheet-since" type="date" value={day} onChange={(e) => setDay(e.target.value)} className="h-8 rounded-lg border border-line bg-panel px-2 text-sm" />
        <button type="button" className={btnClass("secondary")} disabled={pending || day === value} onClick={() => save(day)}>
          {pending ? t("customers.sheetSince.saving") : t("customers.sheetSince.save")}
        </button>
        {value && (
          <button
            type="button"
            className={btnClass("ghost")}
            disabled={pending}
            onClick={() => {
              if (!window.confirm(t("customers.sheetSince.confirmClear"))) return;
              setDay("");
              save("");
            }}
          >
            {t("customers.sheetSince.clear")}
          </button>
        )}
      </div>
      <p className="mt-1 text-xs text-mut">
        {value ? t("customers.sheetSince.limited", { count, total, date: value.split("-").reverse().join("/") }) : t("customers.sheetSince.unlimited", { total })} {t("customers.sheetSince.note")}
      </p>
      {error && <p className="mt-1 text-xs text-rose-600">{error}</p>}
    </div>
  );
}
