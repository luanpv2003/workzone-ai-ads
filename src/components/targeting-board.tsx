"use client";

import { useMemo, useState } from "react";
import { norm } from "@/lib/text";
import { useT } from "@/i18n/client";

export type BoardItem = {
  key: string;
  name: string;
  typeLabel: string;
  path: string;
  size: string; // abbreviated VN audience size
  score: number | null;
  fit: number | null;
  perf: number | null;
  confidence: number;
  verified: boolean;
  rank: number | null;
  dead: boolean; // deprecated by Meta or not found in Ads Manager
  copy: string; // text to copy into the Ads Manager search box
  findable: boolean | null; // null = not checked yet
  spend: number;
  reason: string | null;
};
export type BoardCard = { title: string; items: BoardItem[] };
export type BoardSection = {
  id: string;
  num: string;
  title: string;
  meta?: string; // right of the title: item count
  share?: string; // estimated share of the persona
  sub?: string;
  chips?: string[]; // demographics / message as labels
  angles?: string[]; // ad message
  cards: BoardCard[];
  muted?: boolean;
};

/** Chip color by score: green = strong fit, indigo = fit, gray = worth trying; dead items are struck through. */
function chipClass(i: BoardItem, hit: boolean) {
  if (i.dead) return "bg-slate-50 text-slate-400 line-through decoration-rose-400 cursor-not-allowed";
  if (hit) return "bg-amber-100 text-amber-900 ring-1 ring-amber-300 font-medium";
  const s = i.score ?? 0;
  if (s >= 75) return "bg-emerald-50 text-emerald-900 ring-1 ring-emerald-200 hover:ring-emerald-400";
  if (s >= 55) return "bg-indigo-50 text-indigo-900 ring-1 ring-indigo-100 hover:ring-indigo-300";
  return "bg-slate-100 text-slate-700 ring-1 ring-transparent hover:ring-slate-300";
}

export function TargetingBoard({ sections }: { sections: BoardSection[] }) {
  const t = useT();
  const [q, setQ] = useState("");
  const [showSize, setShowSize] = useState(true);
  const [strongOnly, setStrongOnly] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const k = norm(q.trim());
  const total = sections.reduce((a, s) => a + s.cards.reduce((b, c) => b + c.items.length, 0), 0);
  const hits = useMemo(
    () => (k ? sections.reduce((a, s) => a + s.cards.reduce((b, c) => b + c.items.filter((i) => norm(i.name).includes(k)).length, 0), 0) : 0),
    [sections, k],
  );

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setToast(t("targeting.boardUi.copied", { label }));
    } catch {
      setToast(t("targeting.boardUi.copyBlocked"));
    }
    setTimeout(() => setToast(null), 1800);
  };

  return (
    <div className="space-y-2">
      {/* Toolbar */}
      <div className="sticky top-0 z-10 -mx-1 flex flex-wrap items-center gap-2 bg-panel/90 px-1 py-2 backdrop-blur">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("targeting.boardUi.search")}
          className="w-full max-w-xs rounded-lg border border-slate-300 bg-panel px-3 py-1.5 text-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 focus:outline-none"
        />
        <label className="flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-700">
          <input type="checkbox" className="accent-indigo-600" checked={showSize} onChange={(e) => setShowSize(e.target.checked)} />
          {t("targeting.boardUi.size")}
        </label>
        <label className="flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-700">
          <input type="checkbox" className="accent-indigo-600" checked={strongOnly} onChange={(e) => setStrongOnly(e.target.checked)} />
          {t("targeting.boardUi.strongOnly")}
        </label>
        <span className="ml-auto flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
          <span className="flex items-center gap-1"><i className="size-2.5 rounded-sm bg-emerald-300" />{t("targeting.boardUi.legendStrong")}</span>
          <span className="flex items-center gap-1"><i className="size-2.5 rounded-sm bg-indigo-200" />{t("targeting.boardUi.legendFit")}</span>
          <span className="flex items-center gap-1"><i className="size-2.5 rounded-sm bg-slate-300" />{t("targeting.boardUi.legendTry")}</span>
          <span>{t("targeting.boardUi.legendVerified")}</span>
          <span className="font-mono tabular-nums">{t("targeting.boardUi.itemsTotal", { count: k ? `${hits}/${total}` : total })}</span>
        </span>
      </div>

      {sections.map((s) => {
        const cards = s.cards
          .map((c) => ({ ...c, items: c.items.filter((i) => !strongOnly || (i.score ?? 0) >= 60) }))
          .filter((c) => c.items.length);
        if (!cards.length && !s.chips?.length && !s.angles?.length) return null;
        return (
          <section key={s.id} className="pt-6">
            <header className="flex flex-wrap items-baseline gap-3 border-b-2 border-slate-900 pb-2">
              <span className={`rounded px-1.5 py-0.5 font-mono text-[11px] tracking-wider text-white ${s.muted ? "bg-slate-400" : "bg-indigo-600"}`}>{s.num}</span>
              <h3 className="text-lg font-semibold tracking-tight text-slate-900">{s.title}</h3>
              {s.meta && <span className="ml-auto font-mono text-xs text-slate-500 tabular-nums">{s.meta}</span>}
            </header>
            {s.share && <p className="mt-2 text-xs font-medium text-indigo-700">{s.share}</p>}
            {s.sub && <p className="mt-1.5 max-w-4xl text-sm text-slate-600">{s.sub}</p>}
            {s.chips && s.chips.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {s.chips.map((c, i) => (
                  <span key={i} className="rounded-full bg-violet-50 px-2.5 py-1 text-xs font-medium text-violet-800 ring-1 ring-violet-100">{c}</span>
                ))}
              </div>
            )}
            {s.angles && s.angles.length > 0 && (
              <div className="mt-3 rounded-lg border-l-2 border-indigo-400 bg-indigo-50/50 px-3 py-2 text-sm text-slate-700">
                <p className="text-[11px] font-semibold tracking-wide text-indigo-700 uppercase">{t("targeting.boardUi.angles")}</p>
                <ul className="mt-1 space-y-0.5">{s.angles.map((a, i) => <li key={i}>· {a}</li>)}</ul>
              </div>
            )}
            {cards.length > 0 && (
              <div className="mt-3 grid gap-3 @3xl:grid-cols-2 @6xl:grid-cols-3">
                {cards.map((c) => (
                  <div key={c.title} className="rounded-xl border border-slate-200 bg-panel p-3.5 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
                    <div className="mb-2.5 flex items-baseline gap-2">
                      <b className="flex-1 text-[13.5px] font-semibold text-slate-900">{c.title}</b>
                      <i className="font-mono text-[11px] text-slate-400 not-italic">{c.items.length}</i>
                      <button
                        type="button"
                        onClick={() => copy(c.items.filter((i) => !i.dead).map((i) => i.copy).join("\n"), t("targeting.boardUi.copyGroup", { n: c.items.filter((i) => !i.dead).length, title: c.title }))}
                        className="text-[11px] text-slate-400 hover:text-indigo-600"
                        title={t("targeting.boardUi.copyAllTitle")}
                      >
                        {t("targeting.boardUi.copyAll")}
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {c.items.map((i) => {
                        const hit = !!k && norm(i.name).includes(k);
                        return (
                          <button
                            key={i.key}
                            type="button"
                            disabled={i.dead}
                            onClick={() => copy(i.copy, i.copy)}
                            title={[
                              i.path,
                              i.dead ? (i.findable === false ? t("targeting.boardUi.notFound") : t("targeting.boardUi.retired")) : null,
                              !i.dead ? t("targeting.boardUi.copyTip", { copy: i.copy, status: i.findable ? t("targeting.boardUi.tipFound") : t("targeting.boardUi.tipUnchecked") }) : null,
                              i.score != null ? t("targeting.boardUi.tipScore", { score: i.score, fit: i.fit != null ? t("targeting.boardUi.tipFitPart", { fit: i.fit }) : "", perf: i.perf != null ? t("targeting.boardUi.tipPerfPart", { perf: i.perf, conf: Math.round(i.confidence * 100) }) : "" }) : null,
                              i.rank ? t("targeting.boardUi.tipRank", { rank: i.rank }) : null,
                              i.reason,
                              t("targeting.boardUi.tipClick"),
                            ]
                              .filter(Boolean)
                              .join("\n")}
                            className={`rounded-md px-2 py-1 text-left text-[12.5px] leading-tight transition ${chipClass(i, hit)}`}
                          >
                            {i.rank && i.rank <= 20 && <span className="mr-1 font-mono text-[10px] text-slate-400">#{i.rank}</span>}
                            {i.name}
                            {i.verified && <span className="ml-1 text-emerald-600">✓</span>}
                            {i.spend > 0 && !i.verified && <span className="ml-1 text-amber-600" title={t("targeting.boardUi.notEnough")}>◔</span>}
                            {showSize && i.size && <em className="ml-1.5 font-mono text-[10.5px] text-slate-400 not-italic tabular-nums">{i.size}</em>}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        );
      })}

      {toast && (
        <div className="pointer-events-none sticky bottom-4 z-20 flex justify-center">
          <span className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-panel shadow-lg">{toast}</span>
        </div>
      )}
    </div>
  );
}
