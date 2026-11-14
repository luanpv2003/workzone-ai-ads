"use client";

import type { Lane, LaneColor } from "@/lib/automation-plan";

const DOT: Record<LaneColor, string> = { slate: "bg-slate-400", sky: "bg-sky-500", violet: "bg-violet-500", emerald: "bg-emerald-500", orange: "bg-orange-500" };
const BAND: Record<LaneColor, string> = { slate: "bg-slate-300", sky: "bg-sky-200", violet: "bg-violet-200", emerald: "bg-emerald-200", orange: "bg-orange-200" };
const pct = (h: number) => `${(Math.min(24, Math.max(0, h)) / 24) * 100}%`;

/** A day of the client: one row per automated task; dot = runs once, band = runs continuously / hourly; red line = now. */
export function DayTimeline({ lanes, now }: { lanes: Lane[]; now: number | null }) {
  return (
    <div className="text-xs">
      <div className="grid grid-cols-[minmax(0,9.5rem)_minmax(0,1fr)] gap-x-3 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)]">
        <span />
        <div className="relative mb-1 h-4 text-mut">
          {[0, 6, 12, 18, 24].map((h) => (
            <span key={h} className={`absolute -translate-x-1/2 tabular-nums first:translate-x-0 last:-translate-x-full ${h % 12 ? "max-sm:hidden" : ""}`} style={{ left: pct(h) }}>
              {h}h
            </span>
          ))}
        </div>
        {lanes.map((l) => (
          <div key={l.key} className="contents">
            <div className="min-w-0 py-1.5">
              <div className="truncate font-medium text-ink2">{l.label}</div>
              <div className="truncate text-mut" title={l.note}>
                {l.note}
              </div>
            </div>
            <div className="relative my-auto h-6 rounded-md bg-soft">
              {[6, 12, 18].map((h) => (
                <span key={h} className="absolute inset-y-0 w-px bg-line" style={{ left: pct(h) }} />
              ))}
              {l.bands.map((b, i) => (
                <span key={i} title={b.title} className={`absolute inset-y-1.5 rounded-sm ${BAND[l.color]}`} style={{ left: pct(b.from), width: `calc(${pct(b.to)} - ${pct(b.from)})` }} />
              ))}
              {l.dots.map((d, i) => (
                <span key={i} title={d.title} className={`absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-panel ${DOT[l.color]}`} style={{ left: pct(d.at) }} />
              ))}
              {now != null && <span className="absolute -inset-y-1 w-0.5 bg-rose-500" style={{ left: pct(now) }} />}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
