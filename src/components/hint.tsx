"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Tooltip on hover (or tap on mobile). The tooltip box uses position: fixed
 * so it isn't clipped inside horizontally scrolling tables.
 */
export function Hint({ tip, children, className = "" }: { tip: ReactNode; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number; up: boolean } | null>(null);
  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const up = r.bottom > window.innerHeight - 220;
    setPos({
      x: Math.max(8, Math.min(r.left, window.innerWidth - 296)),
      y: up ? window.innerHeight - r.top + 6 : r.bottom + 6,
      up,
    });
  };
  const hide = () => setPos(null);
  useEffect(() => {
    if (!pos) return;
    window.addEventListener("scroll", hide, true);
    return () => window.removeEventListener("scroll", hide, true);
  }, [pos]);
  return (
    <span
      ref={ref}
      tabIndex={0}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onClick={() => (pos ? hide() : show())}
      className={`cursor-help underline decoration-slate-300 decoration-dotted underline-offset-4 outline-none ${className}`}
    >
      {children}
      {pos && (
        <span
          role="tooltip"
          style={{
            left: pos.x,
            ...(pos.up ? { bottom: pos.y } : { top: pos.y }),
          }}
          className="fixed z-50 w-72 rounded-lg bg-ink p-3 text-left text-xs leading-relaxed font-normal whitespace-normal text-panel normal-case shadow-lg"
        >
          {tip}
        </span>
      )}
    </span>
  );
}
