"use client";

import { ArrowRight, Zap } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { btnClass } from "./ui";
import { useT } from "@/i18n/client";

export type MetaLine = { label: string; from?: ReactNode; to: ReactNode };
type MetaAsk = { title: string; lines: MetaLine[]; effect?: ReactNode; confirmLabel: string };

/**
 * Confirmation dialog for EVERY action that changes live ads on Meta (design system section 06):
 * object · old value → new · money impact · confirm button that states the action.
 * Esc = Cancel; Enter does not auto-confirm (the Cancel button is focused by default).
 *
 *   const [dialog, ask] = useMetaConfirm();
 *   if (!(await ask({ title, lines, confirmLabel }))) return;
 */
export function useMetaConfirm(): [ReactNode, (a: MetaAsk) => Promise<boolean>] {
  const t = useT();
  const [req, setReq] = useState<MetaAsk | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const close = useCallback((ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setReq(null);
  }, []);
  const ask = useCallback(
    (a: MetaAsk) =>
      new Promise<boolean>((resolve) => {
        resolver.current = resolve;
        setReq(a);
      }),
    [],
  );
  useEffect(() => {
    if (!req) return;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [req, close]);

  const dialog = req ? (
    <div className="fixed inset-0 z-[90] grid place-items-center bg-[var(--overlay)] p-4" onMouseDown={(e) => e.target === e.currentTarget && close(false)}>
      <div role="alertdialog" aria-modal="true" aria-labelledby="meta-confirm-title" className="w-full max-w-md rounded-[14px] border border-line bg-panel p-5 text-left shadow-pop" style={{ animation: "wz-in .15s ease-out" }}>
        <p className="flex items-center gap-1.5 text-xs font-semibold text-orange-700">
          <Zap className="size-3.5" /> {t("core.metaConfirm.heading")}
        </p>
        <h2 id="meta-confirm-title" className="mt-1.5 text-[17px] font-semibold text-ink">
          {req.title}
        </h2>
        <div className="mt-3 space-y-2 rounded-xl border border-orange-200 bg-orange-50 p-3">
          {req.lines.map((l, i) => (
            <div key={i}>
              <p className="text-xs text-mut">{l.label}</p>
              <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink tabular-nums">
                {l.from != null && (
                  <>
                    <span className="text-mut line-through decoration-1">{l.from}</span>
                    <ArrowRight className="size-3.5 text-orange-700" />
                  </>
                )}
                <span>{l.to}</span>
              </p>
            </div>
          ))}
        </div>
        {req.effect && <p className="mt-3 text-sm text-ink2">{req.effect}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button ref={cancelRef} type="button" className={btnClass("secondary")} onClick={() => close(false)}>
            {t("core.metaConfirm.cancel")}
          </button>
          <button type="button" className={btnClass("meta")} onClick={() => close(true)}>
            <Zap /> {req.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  ) : null;
  return [dialog, ask];
}
