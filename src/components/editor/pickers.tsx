"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { searchGeoAction, searchTargetingAction, type GeoHit } from "@/app/actions";
import type { DetailedItem, Location, TargetingItem } from "@/lib/targeting";
import { inputClass } from "../ui";
import { Chip } from "./fields";
import { useT } from "@/i18n/client";
import type { T } from "@/i18n/translate";
import { languageLabel } from "@/lib/languages";

// Shared by 2 search boxes: type → call the server (debounced) → show a dropdown.
function useSearch<T>(fn: (q: string) => Promise<T[]>, minLen = 2) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<T[]>([]);
  const [open, setOpen] = useState(false);
  const seq = useRef(0);
  useEffect(() => {
    if (q.trim().length < minLen) return;
    const n = ++seq.current;
    const t = setTimeout(async () => {
      const r = await fn(q);
      if (n === seq.current) setResults(r);
    }, 200);
    return () => clearTimeout(t);
  }, [q, fn, minLen]);
  return { q, setQ, results: q.trim().length < minLen ? [] : results, open, setOpen };
}

const TYPE_KEYS = {
  interests: "campaigns.pickers.targetType.interests",
  behaviors: "campaigns.pickers.targetType.behaviors",
  life_events: "campaigns.pickers.targetType.life_events",
  family_statuses: "campaigns.pickers.targetType.family_statuses",
  industries: "campaigns.pickers.targetType.industries",
  income: "campaigns.pickers.targetType.income",
  education_statuses: "campaigns.pickers.targetType.education_statuses",
  relationship_statuses: "campaigns.pickers.targetType.relationship_statuses",
  work_positions: "campaigns.pickers.targetType.work_positions",
  work_employers: "campaigns.pickers.targetType.work_employers",
  education_schools: "campaigns.pickers.targetType.education_schools",
  education_majors: "campaigns.pickers.targetType.education_majors",
} as const;
const typeLabel = (t: T, type: string) => (type in TYPE_KEYS ? t(TYPE_KEYS[type as keyof typeof TYPE_KEYS]) : type);

function size(lo: number | null, hi: number | null) {
  if (hi == null) return "";
  const f = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)} tr` : v >= 1e3 ? `${Math.round(v / 1e3)}k` : String(v));
  return lo != null && lo !== hi ? `${f(lo)} – ${f(hi)}` : f(hi);
}

export function DetailedTargetingPicker({ value, onChange }: { value: DetailedItem[]; onChange: (v: DetailedItem[]) => void }) {
  const t = useT();
  const s = useSearch<TargetingItem>(searchTargetingAction);
  const chosen = new Set(value.map((v) => v.id));
  const groups = value.reduce<Record<string, DetailedItem[]>>((a, v) => ((a[v.type] ??= []).push(v), a), {});

  return (
    <div>
      {value.length > 0 && (
        <div className="mb-2 space-y-2 rounded-lg border border-slate-200 p-3">
          {Object.entries(groups).map(([type, items]) => (
            <div key={type}>
              <div className="mb-1 text-xs font-medium text-slate-500">{typeLabel(t, type)}</div>
              <div className="flex flex-wrap gap-1.5">
                {items.map((i) => (
                  <Chip key={i.id} tone="indigo" onRemove={() => onChange(value.filter((v) => v.id !== i.id))}>
                    {i.name}
                  </Chip>
                ))}
              </div>
            </div>
          ))}
          <p className="text-xs text-slate-400">{t("campaigns.pickers.orRelation")}</p>
        </div>
      )}
      <div className="relative">
        <input
          className={inputClass}
          placeholder={t("campaigns.pickers.addDetailed")}
          value={s.q}
          onChange={(e) => (s.setQ(e.target.value), s.setOpen(true))}
          onFocus={() => s.setOpen(true)}
          onBlur={() => setTimeout(() => s.setOpen(false), 150)}
        />
        {s.open && s.results.length > 0 && (
          <ul className="absolute z-20 mt-1 max-h-80 w-full overflow-y-auto rounded-lg border border-slate-200 bg-panel py-1 shadow-lg">
            {s.results.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  disabled={chosen.has(r.id)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onChange([...value, { id: r.id, name: r.name, type: r.type }])}
                  className="flex w-full items-start justify-between gap-3 px-3 py-2 text-left hover:bg-slate-50 disabled:opacity-40"
                >
                  <span>
                    <span className="block text-sm text-slate-900">{r.name}</span>
                    <span className="block text-xs text-slate-500">{r.path || typeLabel(t, r.type)}</span>
                  </span>
                  <span className="shrink-0 text-right text-xs text-slate-500">
                    <span className="block">{typeLabel(t, r.type)}</span>
                    {r.vnHi != null && <span className="block tabular-nums">VN: {size(r.vnLo, r.vnHi)}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

const GEO_TYPE_KEYS = {
  country: "campaigns.pickers.geo.country",
  region: "campaigns.pickers.geo.region",
  city: "campaigns.pickers.geo.city",
  subcity: "campaigns.pickers.geo.subcity",
  neighborhood: "campaigns.pickers.geo.neighborhood",
} as const;
const GEO_ICON: Record<string, string> = { country: "🇻🇳", region: "📍", city: "🏙️", subcity: "🏘️", neighborhood: "🏠" };

/** Pick locations like the "Vị trí" (Location) field in Ads Manager: search Meta directly (province → district → ward/commune), or pick from the 34 new provinces. */
export function LocationPicker({ value, onChange, allowEmpty }: { value: Location[]; onChange: (v: Location[]) => void; allowEmpty?: boolean }) {
  const t = useT();
  const [live, setLive] = useState(true);
  const fn = useCallback(async (q: string) => {
    const r = await searchGeoAction(q);
    setLive(r.live);
    return r.hits;
  }, []);
  const s = useSearch<GeoHit>(fn, 2);
  const keys = new Set(value.map((v) => v.key));
  const canRemove = value.length > 1 || allowEmpty;
  const add = (items: Location[]) => {
    const fresh = items.filter((l) => !keys.has(l.key));
    onChange([...value.filter((v) => v.type !== "country"), ...fresh]);
    s.setQ("");
  };
  // Items picked from "tỉnh mới" (new provinces) are grouped into 1 chip; every other item gets its own chip.
  const groups = new Map<string, Location[]>();
  const singles: Location[] = [];
  for (const l of value) {
    if (l.group) groups.set(l.group, [...(groups.get(l.group) ?? []), l]);
    else singles.push(l);
  }
  // Meta errors when both a province and a district/ward inside that province are selected.
  const overlap = value.filter((l) => l.parentKey && keys.has(l.parentKey));

  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {[...groups].map(([name, items]) => (
          <Chip key={`g:${name}`} onRemove={canRemove || value.length > items.length ? () => onChange(value.filter((v) => v.group !== name)) : undefined}>
            📍 {name} <span className="text-xs text-mut">({t("campaigns.pickers.newProvince", { parts: items.map((i) => i.name).join(" + ") })})</span>
          </Chip>
        ))}
        {singles.map((l) => (
          <Chip key={l.key} onRemove={canRemove ? () => onChange(value.filter((v) => v.key !== l.key)) : undefined}>
            {GEO_ICON[l.type] ?? "📍"} {l.name}
            {l.parent && <span className="text-xs text-mut">, {l.parent}</span>}
            {l.type === "city" && (
              <select
                className="ml-1 rounded bg-transparent text-xs text-slate-500"
                value={Math.max(17, l.radius_km ?? 17)}
                onChange={(e) => onChange(value.map((v) => (v.key === l.key ? { ...v, radius_km: Number(e.target.value) } : v)))}
              >
                {[17, 25, 40, 60, 80].map((r) => (
                  <option key={r} value={r}>
                    +{r} km
                  </option>
                ))}
              </select>
            )}
          </Chip>
        ))}
      </div>
      {overlap.length > 0 && (
        <p className="mb-2 text-xs text-amber-700">
          {t("campaigns.pickers.overlap", { names: overlap.map((o) => o.name).join(", ") })}
        </p>
      )}
      <div className="relative">
        <input
          className={inputClass}
          placeholder={t("campaigns.pickers.searchPlace")}
          value={s.q}
          onChange={(e) => (s.setQ(e.target.value), s.setOpen(true))}
          onFocus={() => s.setOpen(true)}
          onBlur={() => setTimeout(() => s.setOpen(false), 150)}
        />
        {s.open && (s.results.length > 0 || !keys.has("VN")) && (
          <ul className="absolute z-20 mt-1 max-h-80 w-full overflow-y-auto rounded-lg border border-slate-200 bg-panel py-1 shadow-lg">
            {!keys.has("VN") && (
              <li>
                <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => onChange([{ key: "VN", name: t("campaigns.pickers.vietnam"), type: "country" }])} className="w-full px-3 py-2 text-left text-sm hover:bg-slate-50">
                  {t("campaigns.pickers.allVietnam")}
                </button>
              </li>
            )}
            {s.results.map((h) =>
              h.kind === "group" ? (
                <li key={`g:${h.name}`}>
                  <button
                    type="button"
                    disabled={h.regions.every((r) => keys.has(r.key))}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => add(h.regions)}
                    className="flex w-full justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-slate-50 disabled:opacity-40"
                  >
                    <span>
                      {h.name} <span className="text-slate-400">= {h.regions.map((r) => r.name).join(" + ")}</span>
                    </span>
                    <span className="shrink-0 text-xs text-violet-600">{t("campaigns.pickers.newProvince34")}</span>
                  </button>
                </li>
              ) : (
                <li key={h.loc.key}>
                  <button
                    type="button"
                    disabled={keys.has(h.loc.key)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => add([{ ...h.loc, ...(h.loc.type === "city" && { radius_km: 17 }) }])}
                    className="flex w-full justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-slate-50 disabled:opacity-40"
                  >
                    <span>
                      {h.loc.name}
                      {h.loc.parent && <span className="text-slate-400">, {h.loc.parent}</span>}
                    </span>
                    <span className="shrink-0 text-xs text-slate-400">{t(GEO_TYPE_KEYS[h.loc.type as keyof typeof GEO_TYPE_KEYS])}</span>
                  </button>
                </li>
              ),
            )}
            {!live && s.q.trim().length >= 2 && <li className="px-3 py-2 text-xs text-amber-700">{t("campaigns.pickers.notLive")}</li>}
          </ul>
        )}
      </div>
      <p className="mt-1.5 text-xs text-mut">{t("campaigns.pickers.oldProvincesNote")}</p>
    </div>
  );
}

type PinLocation = { label: string; latitude: number; longitude: number; radius_km: number };

/** Pin coordinates + radius (like "Ghim thả" (Drop pin) on the Ads Manager map). */
export function PinLocationEditor({ value, onChange, store }: { value: PinLocation[]; onChange: (v: PinLocation[]) => void; store: { lat: number; lng: number } | null }) {
  const t = useT();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = () => {
    const m = text.match(/(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)/);
    const lat = m ? Number(m[1]) : NaN;
    const lng = m ? Number(m[2]) : NaN;
    if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) return setError(t("campaigns.pickers.pasteCoords"));
    setError(null);
    setText("");
    onChange([...value, { label: t("campaigns.pickers.pinLabel", { lat: lat.toFixed(4), lng: lng.toFixed(4) }), latitude: lat, longitude: lng, radius_km: 3 }]);
  };
  const hasStore = store && value.some((v) => v.latitude === store.lat && v.longitude === store.lng);

  return (
    <div className="space-y-2">
      {value.map((p, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm">
          <span>📌</span>
          <input
            className="min-w-0 flex-1 bg-transparent text-slate-800 outline-none"
            value={p.label}
            onChange={(e) => onChange(value.map((v, j) => (j === i ? { ...v, label: e.target.value } : v)))}
          />
          <span className="text-xs text-slate-400 tabular-nums">{p.latitude.toFixed(4)}, {p.longitude.toFixed(4)}</span>
          <select
            className="rounded border border-slate-200 px-1 py-0.5 text-xs"
            value={p.radius_km}
            onChange={(e) => onChange(value.map((v, j) => (j === i ? { ...v, radius_km: Number(e.target.value) } : v)))}
          >
            {[1, 2, 3, 4, 5, 7, 10, 15, 20, 40, 80].map((r) => <option key={r} value={r}>+{r} km</option>)}
          </select>
          <button type="button" className="text-slate-400 hover:text-rose-600" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label={t("campaigns.pickers.deletePin")}>×</button>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        {store && !hasStore && (
          <button
            type="button"
            className="rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100"
            onClick={() => onChange([...value, { label: t("campaigns.pickers.aroundStore"), latitude: store.lat, longitude: store.lng, radius_km: 3 }])}
          >
            {t("campaigns.pickers.pinAroundStore")}
          </button>
        )}
        <input className={`${inputClass} max-w-64 py-1.5 text-xs`} placeholder={t("campaigns.pickers.pasteFromMaps")} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), add())} />
        <button type="button" className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50" onClick={add}>
          {t("campaigns.pickers.addPin")}
        </button>
      </div>
      {!store && <p className="text-xs text-slate-400">{t("campaigns.pickers.storeTip")}</p>}
      {error && <p className="text-xs text-rose-600">{error}</p>}
    </div>
  );
}

export function LanguagePicker({ value, onChange, options }: { value: string[]; onChange: (v: string[]) => void; options: readonly { code: string; label: string }[] }) {
  const t = useT();
  const label = new Map(options.map((o) => [o.code, languageLabel(o.code, t)]));
  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((c) => (
            <Chip key={c} tone="indigo" onRemove={() => onChange(value.filter((v) => v !== c))}>
              {label.get(c) ?? c}
            </Chip>
          ))}
        </div>
      )}
      <select className={inputClass} value="" onChange={(e) => e.target.value && onChange([...value, e.target.value])}>
        <option value="">{value.length ? t("campaigns.pickers.addLanguage") : t("campaigns.pickers.allLanguages")}</option>
        {options.filter((o) => !value.includes(o.code)).map((o) => (
          <option key={o.code} value={o.code}>{languageLabel(o.code, t)}</option>
        ))}
      </select>
    </div>
  );
}
