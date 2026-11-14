"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { analyzeContactFileAction, createCustomAudienceAction, createLookalikeAction, createPageAudienceAction } from "@/app/audience-actions";
import type { CustomAudienceRef } from "@/lib/meta/types";
import type { ContactStats, CreatedAudience, PageAudienceEvent, SheetStats } from "@/lib/meta/audiences";
import { Badge, btnClass, Card, Empty, Field, inputClass } from "@/components/ui";
import { useT } from "@/i18n/client";
import type { MessageKey } from "@/i18n/translate";

const SUBTYPE: Record<string, MessageKey> = {
  CUSTOM: "targeting.audienceBuilder.subtype.CUSTOM",
  LOOKALIKE: "targeting.audienceBuilder.subtype.LOOKALIKE",
  WEBSITE: "targeting.audienceBuilder.subtype.WEBSITE",
  ENGAGEMENT: "targeting.audienceBuilder.subtype.ENGAGEMENT",
  VIDEO: "targeting.audienceBuilder.subtype.VIDEO",
  LEAD_AD: "targeting.audienceBuilder.subtype.LEAD_AD",
};
const LAL_PRESETS: [number, number][] = [[0, 1], [1, 2], [0, 3], [0, 5]];
const fmt = (n: number) => n.toLocaleString("vi-VN");
// Display order + short name used in the suggested audience name.
const PAGE_EVENTS: { value: PageAudienceEvent; label: MessageKey; hint: MessageKey; short: MessageKey }[] = [
  { value: "page_messaged", label: "targeting.audienceBuilder.event.messaged.label", hint: "targeting.audienceBuilder.event.messaged.hint", short: "targeting.audienceBuilder.event.messaged.short" },
  { value: "page_engaged", label: "targeting.audienceBuilder.event.engaged.label", hint: "targeting.audienceBuilder.event.engaged.hint", short: "targeting.audienceBuilder.event.engaged.short" },
];
const DAY_PRESETS = [30, 90, 180, 365];
const LAL_PCTS = [1, 2, 3, 5, 10];
/** Abbreviate the client name for the audience name: "Ớt Chuông" → "OC"; a single word is kept as is. */
const abbr = (name: string) => {
  const words = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[đĐ]/g, "D").split(/\s+/).filter(Boolean);
  return words.length > 1 ? words.map((w) => w[0].toUpperCase()).join("") : (words[0] ?? "");
};
const today = () => new Date().toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" });

export function AudienceBuilder({
  clientId,
  clientName,
  connected,
  pages,
  audiences,
  listError,
}: {
  clientId: string;
  clientName: string;
  connected: boolean;
  pages: { id: string; name: string }[];
  audiences: CustomAudienceRef[];
  listError: string | null;
}) {
  const t = useT();
  const shortName = clientName.split(/[–-]/)[0].trim();
  return (
    <div className="space-y-6">
      {!connected && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          {t("targeting.audienceBuilder.notConnected", { link: "\u0001" }).split("\u0001").flatMap((part, i) => (i ? [<a key="l" href={`/clients/${clientId}/settings`} className="font-medium underline">{t("targeting.audienceBuilder.settings")}</a>, part] : [part]))}
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-2">
        <CustomerListForm clientId={clientId} shortName={shortName} connected={connected} />
        <PageAudienceForm clientId={clientId} shortName={shortName} connected={connected} pages={pages} />
        <LookalikeForm clientId={clientId} shortName={shortName} connected={connected} audiences={audiences} />
      </div>
      <Card title={t("targeting.audienceBuilder.existingTitle", { n: audiences.length })}>
        {listError ? (
          <p className="text-sm text-rose-600">{listError}</p>
        ) : audiences.length === 0 ? (
          <Empty>{connected ? t("targeting.audienceBuilder.none") : t("targeting.audienceBuilder.connectToSee")}</Empty>
        ) : (
          <div className="-mx-5 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-slate-500">
                <tr>
                  <th className="min-w-56 px-5 py-1.5 font-medium">{t("targeting.audienceBuilder.colName")}</th>
                  <th className="px-3 py-1.5 font-medium whitespace-nowrap">{t("targeting.audienceBuilder.colType")}</th>
                  <th className="px-3 py-1.5 text-right font-medium whitespace-nowrap">{t("targeting.audienceBuilder.colSize")}</th>
                  <th className="px-5 py-1.5 text-right font-medium whitespace-nowrap">{t("targeting.audienceBuilder.colStatus")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {audiences.map((a) => {
                  const ready = a.status === "ready";
                  // Meta returns the status as a long sentence: show a short label in the status column and the full sentence under the audience name.
                  const short = ready ? t("targeting.audienceBuilder.ready") : /hết hạn|expired/i.test(a.status) ? t("targeting.audienceBuilder.expired") : t("targeting.audienceBuilder.notUsable");
                  return (
                    <tr key={a.id} className="align-top">
                      <td className="px-5 py-2 text-slate-800">
                        {a.name}
                        {!ready && <p className="mt-0.5 text-xs text-amber-700">{a.status}</p>}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-slate-500">{SUBTYPE[a.subtype] ? t(SUBTYPE[a.subtype]) : a.subtype}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap text-slate-600 tabular-nums">{a.size ? fmt(a.size) : "—"}</td>
                      <td className="px-5 py-2 text-right">
                        <Badge tone={ready ? "green" : "amber"}>{short}</Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-slate-500">{t("targeting.audienceBuilder.useHint")}</p>
      </Card>
    </div>
  );
}

function CustomerListForm({ clientId, shortName, connected }: { clientId: string; shortName: string; connected: boolean }) {
  const t = useT();
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [stats, setStats] = useState<{ sheets: SheetStats[]; unique: ContactStats } | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [usePhones, setUsePhones] = useState(true);
  const [useEmails, setUseEmails] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<CreatedAudience | null>(null);
  const [pending, start] = useTransition();

  const analyze = (f: File) =>
    start(async () => {
      setError(null);
      setDone(null);
      setStats(null);
      setFile(f);
      const fd = new FormData();
      fd.set("file", f);
      const r = await analyzeContactFileAction(fd);
      if (!r.ok) return setError(r.error);
      setStats(r);
      // Pre-select sheets that have contacts; the user unchecks unwanted sheets (e.g. a partner's student list).
      setPicked(r.sheets.filter((s) => s.phones + s.emails > 0).map((s) => s.name));
      setName(`${shortName} – ${f.name.replace(/\.[^.]+$/, "").slice(0, 40)} – ${today()}`);
    });

  const create = () =>
    start(async () => {
      if (!file) return;
      setError(null);
      const fd = new FormData();
      fd.set("file", file);
      fd.set("name", name);
      fd.set("description", description);
      fd.set("usePhones", usePhones ? "1" : "0");
      fd.set("useEmails", useEmails ? "1" : "0");
      for (const s of picked) fd.append("sheets", s);
      const r = await createCustomAudienceAction(clientId, fd);
      if (!r.ok) return setError(r.error);
      setDone(r.audience);
      router.refresh();
    });

  const sel = stats?.sheets.filter((s) => picked.includes(s.name)) ?? [];
  // Per-sheet totals may overlap across sheets; the real (deduplicated) count is recomputed on the server at creation.
  const approx = { phones: sel.reduce((a, s) => a + s.phones, 0), emails: sel.reduce((a, s) => a + s.emails, 0) };

  return (
    <Card title={t("targeting.audienceBuilder.list.title")}>
      <div className="space-y-4 text-sm">
        <p className="text-slate-600">
          {t("targeting.audienceBuilder.list.intro")} <b>{t("targeting.audienceBuilder.list.notStored")}</b>
        </p>
        <div className="flex items-center gap-2">
          <input ref={fileRef} type="file" accept=".xlsx,.csv,.tsv,.txt" className="hidden" onChange={(e) => e.target.files?.[0] && analyze(e.target.files[0])} />
          <button type="button" className={btnClass()} disabled={pending} onClick={() => fileRef.current?.click()}>
            {pending && !stats ? t("targeting.audienceBuilder.list.reading") : file ? t("targeting.audienceBuilder.list.otherFile") : t("targeting.audienceBuilder.list.chooseFile")}
          </button>
          {file && <span className="truncate text-slate-500">{file.name}</span>}
        </div>

        {stats && (
          <>
            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="font-medium text-slate-700">{t("targeting.audienceBuilder.list.pickSheets")}</span>
                <span className="text-xs text-slate-500">
                  {t("targeting.audienceBuilder.list.wholeFile", { phones: fmt(stats.unique.phones), emails: fmt(stats.unique.emails) })}
                </span>
              </div>
              <div className="max-h-64 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
                {stats.sheets.map((s) => (
                  <label key={s.name} className={`flex items-center gap-2 px-3 py-1.5 ${s.phones + s.emails ? "" : "opacity-50"}`}>
                    <input
                      type="checkbox"
                      checked={picked.includes(s.name)}
                      disabled={!(s.phones + s.emails)}
                      onChange={(e) => setPicked(e.target.checked ? [...picked, s.name] : picked.filter((p) => p !== s.name))}
                    />
                    <span className="flex-1 truncate text-slate-800">{s.name}</span>
                    <span className="tabular-nums text-xs text-slate-500">
                      {t("targeting.audienceBuilder.list.sheetCounts", { phones: fmt(s.phones), emails: fmt(s.emails) })}
                    </span>
                  </label>
                ))}
              </div>
            </div>
            <div className="flex gap-4">
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={usePhones} onChange={(e) => setUsePhones(e.target.checked)} /> {t("targeting.audienceBuilder.list.sendPhones")}
              </label>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={useEmails} onChange={(e) => setUseEmails(e.target.checked)} /> {t("targeting.audienceBuilder.list.sendEmails")}
              </label>
            </div>
            <Field label={t("targeting.audienceBuilder.list.nameOnMeta")}>
              <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label={t("targeting.audienceBuilder.list.description")} hint={t("targeting.audienceBuilder.list.descriptionHint")}>
              <input className={inputClass} value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                className={btnClass("primary")}
                disabled={pending || !connected || !picked.length || !(usePhones || useEmails)}
                onClick={create}
              >
                {pending ? t("targeting.audienceBuilder.list.creating") : t("targeting.audienceBuilder.list.create")}
              </button>
              <span className="text-xs text-slate-500">
                {t("targeting.audienceBuilder.list.approx", { phones: fmt(usePhones ? approx.phones : 0), emails: fmt(useEmails ? approx.emails : 0) })}
              </span>
            </div>
            <p className="text-xs text-slate-500">{t("targeting.audienceBuilder.list.consent")}</p>
          </>
        )}
        {error && <p className="text-rose-600">{error}</p>}
        {done && (
          <p className="rounded-lg bg-emerald-50 p-3 text-emerald-700">
            {t("targeting.audienceBuilder.list.done", { name: done.name, phones: fmt(done.phones), emails: fmt(done.emails), received: fmt(done.received), invalid: done.invalid ? t("targeting.audienceBuilder.list.invalid", { n: fmt(done.invalid) }) : "" })}
          </p>
        )}
      </div>
    </Card>
  );
}

function LookalikeForm({ clientId, shortName, connected, audiences }: { clientId: string; shortName: string; connected: boolean; audiences: CustomAudienceRef[] }) {
  const t = useT();
  const router = useRouter();
  const sources = audiences.filter((a) => a.subtype !== "LOOKALIKE");
  const [originId, setOriginId] = useState("");
  const [country, setCountry] = useState("VN");
  const [range, setRange] = useState<[number, number]>([0, 1]);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const suggest = (id: string, r: [number, number], c: string) => {
    const src = sources.find((a) => a.id === id);
    setName(src ? `${shortName} – LAL ${r[0] ? `${r[0]}–` : ""}${r[1]}% ${c} – ${src.name}`.slice(0, 100) : "");
  };
  const source = sources.find((a) => a.id === originId);
  const small = source && source.size != null && source.size < 100;

  const create = () =>
    start(async () => {
      setError(null);
      setDone(null);
      const r = await createLookalikeAction(clientId, { name, originId, country, startPct: range[0], endPct: range[1] });
      if (!r.ok) return setError(r.error);
      setDone(name);
      router.refresh();
    });

  return (
    <Card title={t("targeting.audienceBuilder.lal.title")}>
      <div className="space-y-4 text-sm">
        <p className="text-slate-600">{t("targeting.audienceBuilder.lal.intro")}</p>
        <Field label={t("targeting.audienceBuilder.lal.source")}>
          <select
            className={inputClass}
            value={originId}
            disabled={!sources.length}
            onChange={(e) => {
              setOriginId(e.target.value);
              suggest(e.target.value, range, country);
            }}
          >
            <option value="">{sources.length ? t("targeting.audienceBuilder.lal.choose") : t("targeting.audienceBuilder.lal.noSource")}</option>
            {sources.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} {a.size ? `(${fmt(a.size)})` : ""}
              </option>
            ))}
          </select>
        </Field>
        {small && <p className="text-amber-700">{t("targeting.audienceBuilder.lal.small")}</p>}
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t("targeting.audienceBuilder.lal.ratio")}>
            <div className="flex gap-1">
              {LAL_PRESETS.map((p) => (
                <button
                  key={p.join("-")}
                  type="button"
                  className={btnClass(range[0] === p[0] && range[1] === p[1] ? "primary" : "secondary")}
                  onClick={() => {
                    setRange(p);
                    suggest(originId, p, country);
                  }}
                >
                  {p[0] ? `${p[0]}–${p[1]}%` : `${p[1]}%`}
                </button>
              ))}
            </div>
          </Field>
          <Field label={t("targeting.audienceBuilder.lal.country")}>
            <input
              className={`${inputClass} w-20 uppercase`}
              value={country}
              maxLength={2}
              onChange={(e) => {
                setCountry(e.target.value.toUpperCase());
                suggest(originId, range, e.target.value.toUpperCase());
              }}
            />
          </Field>
        </div>
        <Field label={t("targeting.audienceBuilder.list.nameOnMeta")}>
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <button type="button" className={btnClass("primary")} disabled={pending || !connected || !originId || !name.trim() || !!small} onClick={create}>
          {pending ? t("targeting.audienceBuilder.list.creating") : t("targeting.audienceBuilder.lal.create")}
        </button>
        {error && <p className="text-rose-600">{error}</p>}
        {done && <p className="rounded-lg bg-emerald-50 p-3 text-emerald-700">{t("targeting.audienceBuilder.lal.done", { name: done })}</p>}
      </div>
    </Card>
  );
}

function PageAudienceForm({ clientId, shortName, connected, pages }: { clientId: string; shortName: string; connected: boolean; pages: { id: string; name: string }[] }) {
  const t = useT();
  const router = useRouter();
  const [pageIds, setPageIds] = useState(pages.map((p) => p.id));
  const [events, setEvents] = useState<PageAudienceEvent[]>(["page_messaged"]);
  const [days, setDays] = useState(365);
  const [withLal, setWithLal] = useState(true);
  const [pct, setPct] = useState(3);
  // Auto-suggest the name from the selection until the user edits it.
  const [name, setName] = useState<string | null>(null);
  const [lalName, setLalName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ audience: string; lookalike: string | null; lookalikeError: string | null } | null>(null);
  const [pending, start] = useTransition();

  const code = abbr(shortName);
  const what = PAGE_EVENTS.filter((e) => events.includes(e.value)).map((e) => t(e.short)).join(" + ");
  const autoName = `${code} | ${what || "?"} Page ${days}${t("targeting.audienceBuilder.page.dayUnit")}`;
  const finalName = name ?? autoName;
  const finalLal = lalName ?? `${code} | LAL ${pct}% VN | ${what || "?"} Page ${days}${t("targeting.audienceBuilder.page.dayUnit")}`;
  const validDays = Number.isInteger(days) && days >= 1 && days <= 730;

  const create = () =>
    start(async () => {
      setError(null);
      setDone(null);
      const r = await createPageAudienceAction(clientId, { name: finalName, pageIds, events, days, lookalike: withLal ? { name: finalLal, pct } : null });
      if (!r.ok) return setError(r.error);
      setDone({ audience: r.audience.name, lookalike: r.lookalike?.name ?? null, lookalikeError: r.lookalikeError });
      router.refresh();
    });

  return (
    <Card title={t("targeting.audienceBuilder.page.title")}>
      <div className="space-y-4 text-sm">
        <p className="text-slate-600">
          {t("targeting.audienceBuilder.page.intro")}
        </p>
        {pages.length === 0 ? (
          <p className="text-amber-700">
            {t("targeting.audienceBuilder.page.noPage", { link: "\u0001" }).split("\u0001").flatMap((part, i) => (i ? [<a key="l" href={`/clients/${clientId}/settings`} className="font-medium underline">{t("targeting.audienceBuilder.settings")}</a>, part] : [part]))}
          </p>
        ) : (
          pages.length > 1 && (
            <Field label={t("targeting.audienceBuilder.page.pageLabel")}>
              <div className="space-y-1">
                {pages.map((p) => (
                  <label key={p.id} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={pageIds.includes(p.id)}
                      onChange={(e) => setPageIds(e.target.checked ? [...pageIds, p.id] : pageIds.filter((x) => x !== p.id))}
                    />
                    <span className="text-slate-800">{p.name}</span>
                  </label>
                ))}
              </div>
            </Field>
          )
        )}
        {pages.length === 1 && <p className="text-slate-500">{t("targeting.audienceBuilder.page.pageOne", { name: pages[0].name })}</p>}
        <Field label={t("targeting.audienceBuilder.page.events")}>
          <div className="space-y-1.5">
            {PAGE_EVENTS.map((e) => (
              <label key={e.value} className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={events.includes(e.value)}
                  onChange={(ev) => setEvents(ev.target.checked ? [...events, e.value] : events.filter((x) => x !== e.value))}
                />
                <span>
                  <span className="text-slate-800">{t(e.label)}</span>
                  <span className="block text-xs text-slate-500">{t(e.hint)}</span>
                </span>
              </label>
            ))}
          </div>
        </Field>
        <Field label={t("targeting.audienceBuilder.page.days")} hint={t("targeting.audienceBuilder.page.daysHint")}>
          <div className="flex flex-wrap gap-1">
            {DAY_PRESETS.map((d) => (
              <button key={d} type="button" className={btnClass(days === d ? "primary" : "secondary")} onClick={() => setDays(d)}>
                {d}
              </button>
            ))}
            <input
              type="number"
              min={1}
              max={730}
              className={`${inputClass} w-24`}
              value={Number.isFinite(days) ? days : ""}
              onChange={(e) => setDays(Number(e.target.value))}
            />
          </div>
        </Field>
        <Field label={t("targeting.audienceBuilder.list.nameOnMeta")}>
          <input className={inputClass} value={finalName} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="space-y-2 rounded-lg border border-slate-200 p-3">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={withLal} onChange={(e) => setWithLal(e.target.checked)} />
            <span className="font-medium text-slate-700">{t("targeting.audienceBuilder.page.withLal")}</span>
          </label>
          {withLal && (
            <>
              <div className="flex flex-wrap gap-1">
                {LAL_PCTS.map((p) => (
                  <button key={p} type="button" className={btnClass(pct === p ? "primary" : "secondary")} onClick={() => setPct(p)}>
                    {p}%
                  </button>
                ))}
              </div>
              <input className={inputClass} value={finalLal} onChange={(e) => setLalName(e.target.value)} />
              <p className="text-xs text-slate-500">{t("targeting.audienceBuilder.page.lalHint")}</p>
            </>
          )}
        </div>
        <button
          type="button"
          className={btnClass("primary")}
          disabled={pending || !connected || !pageIds.length || !events.length || !validDays || !finalName.trim() || (withLal && !finalLal.trim())}
          onClick={create}
        >
          {pending ? t("targeting.audienceBuilder.list.creating") : withLal ? t("targeting.audienceBuilder.page.createBoth") : t("targeting.audienceBuilder.list.create")}
        </button>
        {error && <p className="text-rose-600">{error}</p>}
        {done && (
          <div className="space-y-1 rounded-lg bg-emerald-50 p-3 text-emerald-700">
            <p>{t("targeting.audienceBuilder.page.created", { name: done.audience })}</p>
            {done.lookalike && <p>{t("targeting.audienceBuilder.page.createdLal", { name: done.lookalike })}</p>}
            {done.lookalikeError && <p className="text-amber-700">{t("targeting.audienceBuilder.page.lalFailed", { error: done.lookalikeError })}</p>}
          </div>
        )}
      </div>
    </Card>
  );
}
