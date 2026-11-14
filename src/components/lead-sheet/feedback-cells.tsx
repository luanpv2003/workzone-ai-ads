"use client";

import { useState, useTransition } from "react";
import { saveFeedbackAction } from "@/app/lead-sheet-actions";
import type { Feedback } from "@/lib/lead-sheet";
import { feedbackOptionLabel } from "@/lib/highlevel-map";
import { useT } from "@/i18n/client";
import type { MessageKey } from "@/i18n/translate";

type FieldDef = { field: keyof Feedback; label: string; labelKey?: MessageKey; options: readonly string[] };

const TONE: Record<string, string> = {
  Tốt: "text-emerald-700",
  "Trung bình": "text-sky-700",
  Kém: "text-amber-700",
  "Sai tệp": "text-rose-700",
  "Sai số": "text-rose-700",
  "Hẹn gọi lại": "text-sky-700",
  "Đã chốt": "text-emerald-700 font-semibold",
};

/** Sales rating cells on a row: selects save immediately, notes save on blur. */
export function FeedbackCells({ clientId, rowKey, fb, fields }: { clientId: string; rowKey: string; fb: Feedback; fields: readonly FieldDef[] }) {
  const t = useT();
  const [val, setVal] = useState(fb);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const save = (field: keyof Feedback, v: string) => {
    if (v === val[field]) return;
    setVal((x) => ({ ...x, [field]: v }));
    setError(null);
    start(async () => {
      const r = await saveFeedbackAction(clientId, rowKey, { [field]: v });
      if (!r.ok) setError(r.error);
    });
  };
  const cls = "w-full rounded-md border border-line bg-panel px-1.5 py-1 text-xs focus:border-indigo-500 focus:outline-none";
  return (
    <>
      {fields.map((f) => (
        <td key={f.field} className="px-1.5 py-2 align-top">
          {f.options.length ? (
            <select aria-label={f.labelKey ? t(f.labelKey) : f.label} value={val[f.field]} disabled={pending} onChange={(e) => save(f.field, e.target.value)} className={`${cls} min-w-24 ${TONE[val[f.field]] ?? ""}`}>
              <option value="">—</option>
              {f.options.map((o) => (
                <option key={o} value={o}>{feedbackOptionLabel(t, o)}</option>
              ))}
            </select>
          ) : (
            <input
              aria-label={f.labelKey ? t(f.labelKey) : f.label}
              defaultValue={val[f.field]}
              disabled={pending}
              onBlur={(e) => save(f.field, e.target.value.trim())}
              className={`${cls} min-w-40`}
              placeholder={t("customers.feedbackCells.notePlaceholder")}
            />
          )}
          {f.field === "note" && error && <div className="mt-0.5 text-[11px] text-rose-600">{error}</div>}
        </td>
      ))}
    </>
  );
}
