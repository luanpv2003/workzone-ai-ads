"use client";

import { useState, useTransition } from "react";
import { revealContactAction, revealLeadAction } from "@/app/actions";
import { useT } from "@/i18n/client";

/** Phone / email are masked by default; click "Hiện" (Show) to see them in full (the server logs who viewed). */
export function RevealContact({ id, phone, email, more, kind = "conversation" }: { id: string; phone: string | null; email: string | null; more: number; kind?: "conversation" | "lead" }) {
  const t = useT();
  const [full, setFull] = useState<{ phones: string[]; email: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (!phone && !email) return <span className="text-slate-300">—</span>;
  if (full) {
    return (
      <div className="space-y-0.5 text-xs tabular-nums">
        {full.phones.map((p) => (
          <div key={p}>
            <a href={`tel:${p}`} className="text-slate-800 hover:underline">{p}</a>
          </div>
        ))}
        {full.email && (
          <div>
            <a href={`mailto:${full.email}`} className="text-slate-800 hover:underline">{full.email}</a>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="space-y-0.5 text-xs tabular-nums text-slate-600">
      {phone && <div>{phone}{more > 0 && <span className="text-slate-400"> +{more}</span>}</div>}
      {email && <div>{email}</div>}
      <button
        type="button"
        disabled={pending}
        className="text-[11px] font-medium text-indigo-600 hover:underline"
        onClick={() =>
          start(async () => {
            const r = kind === "lead" ? await revealLeadAction(id) : await revealContactAction(id);
            if (r.ok) setFull(r);
            else setError(r.error);
          })
        }
      >
        {pending ? t("core.reveal.opening") : t("core.reveal.show")}
      </button>
      {error && <div className="text-rose-600">{error}</div>}
    </div>
  );
}
