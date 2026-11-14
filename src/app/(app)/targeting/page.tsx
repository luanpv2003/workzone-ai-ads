import Link from "next/link";
import { connection } from "next/server";
import { db } from "@/lib/db";
import { bootstrapLibrary, usageById } from "@/lib/targeting-store";
import { runLabel } from "@/lib/targeting-crawl";
import { getT } from "@/i18n/server";
import type { MessageKey } from "@/i18n/translate";
import { copyTextOf, formatSize, matchScore, typeLabel } from "@/lib/targeting";
import { dateOnly, dateTime, num, resultLabels } from "@/lib/format";
import { industryLabels } from "@/lib/industries";
import { actorLabel } from "@/lib/stored-labels";
import { BROAD_KEY, confidenceLabel, indexLabel, industryStats, perfByKey } from "@/lib/industry-stats";
import { Badge, Card, Empty, inputClass, btnClass, PageHeader, Stat } from "@/components/ui";
import { AutoRefresh, CancelRun, CopyText, FilterSelect, MetaSearch, ScanApi, SeedSetEditor, StartRun, TargetingSettings } from "@/components/targeting/controls";
import { Search } from "lucide-react";
import { requirePageUser } from "@/lib/auth";
import { isPlatformStaff } from "@/lib/access";
import { Hint } from "@/components/hint";

const TABS = [
  { key: "browse", label: "targeting.page.tab.browse" },
  { key: "industry", label: "targeting.page.tab.industry" },
  { key: "runs", label: "targeting.page.tab.runs" },
] as const satisfies readonly { key: string; label: MessageKey }[];
// Sub-pages of "Data maintenance" (Bảo trì dữ liệu) (keep the old keys in links so old links still open correctly).
const MAINT = [
  { key: "runs", label: "targeting.page.maint.runs" },
  { key: "changes", label: "targeting.page.maint.changes" },
  { key: "seeds", label: "targeting.page.maint.seeds" },
  { key: "settings", label: "targeting.page.maint.settings" },
] as const satisfies readonly { key: string; label: MessageKey }[];

const CHANGE: Record<string, { label: MessageKey; tone: "green" | "red" | "amber" | "blue" | "gray" }> = {
  added: { label: "targeting.page.change.added", tone: "green" },
  dead: { label: "targeting.page.change.dead", tone: "red" },
  revived: { label: "targeting.page.change.revived", tone: "blue" },
  renamed: { label: "targeting.page.change.renamed", tone: "gray" },
  size_up: { label: "targeting.page.change.size_up", tone: "blue" },
  size_down: { label: "targeting.page.change.size_down", tone: "amber" },
};
const STATUS: Record<string, { label: MessageKey; tone: "green" | "red" | "amber" | "blue" | "gray" }> = {
  queued: { label: "targeting.page.status.queued", tone: "gray" },
  running: { label: "targeting.page.status.running", tone: "blue" },
  done: { label: "targeting.page.status.done", tone: "green" },
  failed: { label: "targeting.page.status.failed", tone: "red" },
  cancelled: { label: "targeting.page.status.cancelled", tone: "amber" },
};
const SOURCE: Record<string, MessageKey> = {
  browse: "targeting.page.source.browse",
  category: "targeting.page.source.category",
  search: "targeting.page.source.search",
  snowball: "targeting.page.source.snowball",
  import: "targeting.page.source.import",
  claude: "targeting.page.source.claude",
  manual: "targeting.page.source.manual",
};
const EXPAND_PREFIX = "Hướng mở rộng · ";
const PAGE = 40;
const DAY = 86400000;
/** Timestamp for computing "new / how long ago" (the page renders dynamically on each visit). */
const nowMs = () => Date.now();
const daysAgo = (days: number) => new Date(nowMs() - days * DAY);

type SP = { ind?: string; rt?: string; tab?: string; q?: string; type?: string; status?: string; industry?: string; sort?: string; page?: string; change?: string; run?: string; show?: string };
type QS = (p: Partial<SP>) => string;

export default async function TargetingPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requirePageUser(); // check the session right on the page: the layout may not re-run on client-side navigation
  await connection();
  await bootstrapLibrary();
  const t = await getT();
  const sp = await searchParams;
  // Data maintenance (scans, scan token, changes with the names of clients using them): only members of the platform workspace.
  const staff = await isPlatformStaff(user);
  const tab = sp.tab === "industry" || (staff && MAINT.some((m) => m.key === sp.tab)) ? sp.tab! : "browse";
  const maint = MAINT.some((m) => m.key === tab);

  const [lastCatalog, heartbeat, runningCount, usedDead] = await Promise.all([
    db.targetingRun.findFirst({ where: { kind: "catalog", status: "done" }, orderBy: { finishedAt: { sort: "desc", nulls: "last" } } }),
    db.setting.findUnique({ where: { key: "targeting.workerHeartbeat" } }),
    db.targetingRun.count({ where: { status: { in: ["queued", "running"] } } }),
    db.targetingChange.count({ where: { change: "dead", usedIn: { not: null }, createdAt: { gt: daysAgo(90) } } }),
  ]);
  const workerAlive = !!heartbeat && nowMs() - new Date(heartbeat.value).getTime() < 3 * 60_000;
  const catalogDays = lastCatalog?.finishedAt ? Math.round((nowMs() - lastCatalog.finishedAt.getTime()) / DAY) : null;
  const healthy = workerAlive && catalogDays != null && catalogDays <= 35;
  const qs: QS = (patch) => {
    const p = new URLSearchParams(Object.entries({ ...sp, ...patch }).filter(([, v]) => v) as [string, string][]);
    return `?${p}`;
  };

  return (
    <>
      <PageHeader
        title={t("targeting.page.title")}
        subtitle={t("targeting.page.subtitle")}
        actions={
          staff && (
            <Link href="?tab=runs" className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs ${healthy ? "border-line text-mut hover:text-ink" : "border-amber-300 bg-amber-50 text-amber-800"}`}>
              <span className={`size-2 rounded-full ${healthy ? "bg-emerald-500" : "bg-amber-500"}`} />
              {!workerAlive ? t("targeting.page.workerDown") : catalogDays == null ? t("targeting.page.noCatalogScan") : t("targeting.page.dataUpdated", { when: catalogDays ? t("targeting.page.daysAgo", { n: catalogDays }) : t("targeting.page.today") })}
              {runningCount > 0 && <span className="text-sky-600">{t("targeting.page.runsRunning", { n: runningCount })}</span>}
            </Link>
          )
        }
      />
      <AutoRefresh active={runningCount > 0 && maint} />
      {staff && usedDead > 0 && (
        <Link href="?tab=changes&change=dead_used" className="mb-4 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 hover:bg-rose-100">
          <span aria-hidden>⚠</span>
          <span>
            <b>{t("targeting.page.deadUsed", { n: usedDead })}</b>{t("targeting.page.deadUsedRest")}
          </span>
        </Link>
      )}
      <nav className="mb-5 flex gap-1 overflow-x-auto border-b border-line">
        {TABS.filter((tb) => staff || tb.key !== "runs").map((tb) => {
          const on = tb.key === "runs" ? maint : tab === tb.key;
          return (
            <Link
              key={tb.key}
              href={`?tab=${tb.key}`}
              className={`-mb-px border-b-2 px-3 py-2 text-sm whitespace-nowrap ${on ? "border-indigo-600 font-medium text-indigo-700" : "border-transparent text-mut hover:text-ink"}`}
            >
              {t(tb.label)}
              {tb.key === "runs" && (runningCount > 0 || !workerAlive) && <span className={`ml-1.5 inline-block size-1.5 rounded-full align-middle ${workerAlive ? "bg-sky-500" : "bg-amber-500"}`} />}
            </Link>
          );
        })}
      </nav>
      {tab === "browse" && <Browse sp={sp} qs={qs} />}
      {tab === "industry" && <IndustryTab sp={sp} qs={qs} />}
      {maint && (
        <div className="space-y-5">
          <MaintStats workerAlive={workerAlive} runningCount={runningCount} lastCatalog={lastCatalog?.finishedAt ?? null} />
          <div className="flex flex-wrap gap-2">
            {MAINT.map((m) => (
              <Link key={m.key} href={`?tab=${m.key}`} className={`rounded-full px-3 py-1 text-sm ${tab === m.key ? "bg-ink text-panel" : "bg-panel text-ink2 ring-1 ring-line hover:bg-slate-50"}`}>
                {t(m.label)}
                {m.key === "runs" && runningCount > 0 && <span className="ml-1 opacity-70">{runningCount}</span>}
              </Link>
            ))}
          </div>
          {tab === "runs" && <Runs sp={sp} workerAlive={workerAlive} />}
          {tab === "changes" && <Changes sp={sp} qs={qs} />}
          {tab === "seeds" && <Seeds />}
          {tab === "settings" && <SettingsTab workerAlive={workerAlive} />}
        </div>
      )}
    </>
  );
}

async function MaintStats({ workerAlive, runningCount, lastCatalog }: { workerAlive: boolean; runningCount: number; lastCatalog: Date | null }) {
  const t = await getT();
  const [active, dead, hidden, recent] = await Promise.all([
    db.targetingItem.count({ where: { status: "active", OR: [{ findable: true }, { findable: null }] } }),
    db.targetingItem.count({ where: { status: "dead" } }),
    db.targetingItem.count({ where: { status: "active", findable: false } }),
    db.targetingItem.count({ where: { status: "active", firstSeenAt: { gt: daysAgo(30) }, source: { not: "import" } } }),
  ]);
  return (
    <div className="grid gap-3 @xl:grid-cols-2 @4xl:grid-cols-4">
      <Stat label={t("targeting.page.stats.usable")} value={num(active)} hint={t("targeting.page.stats.usableHint", { hidden: num(hidden), dead: num(dead) })} />
      <Stat label={t("targeting.page.stats.new30")} value={num(recent)} hint={t("targeting.page.stats.new30Hint")} />
      <Stat label={t("targeting.page.stats.lastScan")} value={lastCatalog ? dateOnly(lastCatalog) : t("targeting.page.stats.notScanned")} hint={lastCatalog ? t("targeting.page.daysAgo", { n: Math.round((nowMs() - lastCatalog.getTime()) / DAY) }) : t("targeting.page.stats.legacy")} />
      <Stat
        label={t("targeting.page.stats.worker")}
        value={workerAlive ? t("targeting.page.stats.running") : t("targeting.page.stats.notRunning")}
        tone={workerAlive ? "good" : "bad"}
        hint={workerAlive ? (runningCount ? t("targeting.page.stats.queued", { n: runningCount }) : t("targeting.page.stats.ready")) : t("targeting.page.stats.where")}
      />
    </div>
  );
}

// ------------------------------------------------------------ Targeting search

const parseList = (s: string | null) => (s ? (JSON.parse(s) as string[]) : []);

async function Browse({ sp, qs }: { sp: SP; qs: QS }) {
  const t = await getT();
  const status = sp.status ?? "usable";
  const show = sp.show ?? "";
  const q = (sp.q ?? "").trim();
  const [all, perf, usage] = await Promise.all([
    db.targetingItem.findMany({
      where: status === "usable" ? { status: "active", OR: [{ findable: true }, { findable: null }] } : status === "hidden" ? { status: "active", findable: false } : status === "dead" ? { status: "dead" } : {},
      select: { key: true, id: true, name: true, nameVi: true, copyText: true, findable: true, type: true, path: true, description: true, vnLo: true, vnHi: true, industries: true, status: true, source: true, firstSeenAt: true, deadAt: true },
    }),
    perfByKey(),
    usageById(),
  ]);
  const recent = nowMs() - 30 * DAY;
  const isNew = (i: (typeof all)[number]) => i.status === "active" && i.source !== "import" && i.firstSeenAt.getTime() > recent;
  // Proven items: real runs beat the client's average, with minimum confidence.
  const proven = (key: string) => {
    const p = perf.get(key);
    return p && p.index > 1 && p.confidence >= 0.2 ? p.confidence * (p.index - 1) : 0;
  };

  const industryNames = [...new Set(all.flatMap((i) => parseList(i.industries)))].sort((a, b) => a.localeCompare(b, "vi"));
  const scored = all
    .filter((i) => !sp.industry || parseList(i.industries).includes(sp.industry))
    .map((i) => ({ i, m: q ? matchScore({ name: i.nameVi || i.name, en: i.nameVi && i.nameVi !== i.name ? i.name : null, path: i.path, desc: i.description, id: i.id }, q) : 1 }))
    .filter((x) => x.m > 0);
  const showCount = {
    perf: scored.filter((x) => perf.has(x.i.key)).length,
    running: scored.filter((x) => usage.get(x.i.id)?.running).length,
    new: scored.filter((x) => isNew(x.i)).length,
  };
  const byShow = scored.filter((x) => (show === "perf" ? perf.has(x.i.key) : show === "running" ? !!usage.get(x.i.id)?.running : show === "new" ? isNew(x.i) : true));
  const typeCount = new Map<string, number>();
  for (const x of byShow) typeCount.set(x.i.type, (typeCount.get(x.i.type) ?? 0) + 1);
  let rows = byShow.filter((x) => !sp.type || x.i.type === sp.type);

  const sort = sp.sort ?? "fit";
  const vn = (i: (typeof all)[number]) => i.vnHi ?? -1;
  rows.sort((a, b) => {
    if (sort === "name") return (a.i.nameVi || a.i.name).localeCompare(b.i.nameVi || b.i.name, "vi");
    if (sort === "new") return b.i.firstSeenAt.getTime() - a.i.firstSeenAt.getTime();
    if (sort === "vn") return vn(b.i) - vn(a.i);
    if (sort === "perf") return (perf.get(b.i.key)?.index ?? 0) * (perf.get(b.i.key)?.confidence ?? 0) - (perf.get(a.i.key)?.index ?? 0) * (perf.get(a.i.key)?.confidence ?? 0) || vn(b.i) - vn(a.i);
    // Best match: matches the typed text → proven effective → running in ads → verified copyable → VN reach.
    return (
      b.m - a.m ||
      proven(b.i.key) - proven(a.i.key) ||
      Number(!!usage.get(b.i.id)?.running) - Number(!!usage.get(a.i.id)?.running) ||
      Number(b.i.findable === true) - Number(a.i.findable === true) ||
      vn(b.i) - vn(a.i)
    );
  });
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const page = Math.min(pages, Math.max(1, Number(sp.page) || 1));
  rows = rows.slice((page - 1) * PAGE, page * PAGE);
  const filtered = !!(q || sp.type || sp.industry || show || status !== "usable" || sort !== "fit");

  const chip = (on: boolean) => `inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium whitespace-nowrap ${on ? "bg-ink text-panel" : "bg-panel text-ink2 ring-1 ring-line hover:bg-slate-50"}`;

  return (
    <div className="space-y-4">
      <Card>
        <form className="space-y-3">
          <input type="hidden" name="tab" value="browse" />
          {show && <input type="hidden" name="show" value={show} />}
          {sp.type && <input type="hidden" name="type" value={sp.type} />}
          <div className="flex gap-2">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-mut" />
              <input name="q" defaultValue={q} autoFocus={!q} placeholder={t("targeting.page.browse.searchPlaceholder")} className={`${inputClass} pl-9`} />
            </div>
            <button className={btnClass("primary")}>{t("targeting.page.browse.search")}</button>
          </div>
          <div className="grid grid-cols-2 items-end gap-2 @2xl:flex @2xl:flex-wrap @2xl:gap-3">
            <FilterSelect
              name="industry"
              label={t("targeting.page.browse.industryLabel")}
              value={sp.industry ?? ""}
              options={[
                { value: "", label: t("targeting.page.browse.allIndustries") },
                ...industryNames.filter((n) => !n.startsWith(EXPAND_PREFIX)).map((n) => ({ value: n, label: n, group: t("targeting.page.browse.groupIndustry") })),
                ...industryNames.filter((n) => n.startsWith(EXPAND_PREFIX)).map((n) => ({ value: n, label: n.slice(EXPAND_PREFIX.length), group: t("targeting.page.browse.groupExpand") })),
              ]}
            />
            <FilterSelect
              name="status"
              label={t("targeting.page.browse.statusLabel")}
              value={status}
              options={[
                { value: "usable", label: t("targeting.page.browse.usable") },
                { value: "hidden", label: t("targeting.page.browse.hidden") },
                { value: "dead", label: t("targeting.page.browse.dead") },
                { value: "all", label: t("targeting.page.browse.allStatus") },
              ]}
            />
            <FilterSelect
              name="sort"
              label={t("targeting.page.browse.sortLabel")}
              value={sort}
              options={[
                { value: "fit", label: t("targeting.page.browse.sortFit") },
                { value: "perf", label: t("targeting.page.browse.sortPerf") },
                { value: "vn", label: t("targeting.page.browse.sortVn") },
                { value: "new", label: t("targeting.page.browse.sortNew") },
                { value: "name", label: t("targeting.page.browse.sortName") },
              ]}
            />
            {filtered && (
              <Link href="?tab=browse" className="pb-2 text-xs text-indigo-600 hover:underline">
                {t("targeting.page.browse.clearFilter")}
              </Link>
            )}
          </div>
        </form>
      </Card>

      <div className="flex flex-wrap gap-2">
        {[
          ["", t("targeting.page.browse.showAll"), scored.length],
          ["perf", t("targeting.page.browse.showPerf"), showCount.perf],
          ["running", t("targeting.page.browse.showRunning"), showCount.running],
          ["new", t("targeting.page.browse.showNew"), showCount.new],
        ].map(([k, label, n]) => (
          <Link key={k} href={qs({ show: (k as string) || undefined, page: undefined, type: undefined })} className={chip(show === k)}>
            {label} <span className="opacity-60">{num(n as number)}</span>
          </Link>
        ))}
      </div>
      {typeCount.size > 1 && (
        <div className="-mt-1 flex flex-wrap gap-1.5 text-xs">
          <span className="py-1 text-mut">{t("targeting.page.browse.type")}</span>
          <Link href={qs({ type: undefined, page: undefined })} className={`rounded-md px-2 py-1 ${!sp.type ? "bg-indigo-50 font-medium text-indigo-700" : "text-ink2 hover:bg-slate-100"}`}>
            {t("targeting.page.browse.showAll")}
          </Link>
          {[...typeCount].sort((a, b) => b[1] - a[1]).map(([ty, n]) => (
            <Link key={ty} href={qs({ type: ty, page: undefined })} className={`rounded-md px-2 py-1 ${sp.type === ty ? "bg-indigo-50 font-medium text-indigo-700" : "text-ink2 hover:bg-slate-100"}`}>
              {typeLabel(t, ty)} <span className="opacity-60">{num(n)}</span>
            </Link>
          ))}
        </div>
      )}

      <Card className="overflow-hidden">
        <div className="-mx-5 -mt-5 flex flex-wrap items-center justify-between gap-2 border-b border-line bg-slate-50/60 px-5 py-2 text-xs text-mut">
          <span>
            <b className="text-ink">{num(total)}</b> {t("targeting.page.browse.itemsWord")}{q && t("targeting.page.browse.matching", { q })}
            {pages > 1 && t("targeting.page.browse.pageOf", { page, pages })}
          </span>
          <span className="hidden @2xl:inline">{t("targeting.page.browse.copyHint")}</span>
        </div>
        {!rows.length ? (
          <div className="py-8 text-center text-sm text-mut">{q ? t("targeting.page.browse.noMatchQ", { q }) : t("targeting.page.browse.noMatch")}</div>
        ) : (
          <ul className="-mx-5 -mb-5 divide-y divide-line">
            {rows.map(({ i }) => {
              const p = perf.get(i.key);
              const u = usage.get(i.id);
              const display = i.nameVi || i.name;
              const copy = i.findable === false || i.status === "dead" ? null : copyTextOf({ name: display, copyText: i.copyText });
              const inds = parseList(i.industries).map((n) => (n.startsWith(EXPAND_PREFIX) ? n.slice(EXPAND_PREFIX.length) : n));
              return (
                <li key={i.key} className={`flex flex-col gap-2 px-5 py-3.5 @2xl:flex-row @2xl:items-center @2xl:gap-6 ${i.status === "dead" ? "opacity-60" : ""}`}>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium text-ink">{display}</span>
                      {p && (
                        <span title={t("targeting.page.browse.runPerf", { clients: p.clients, results: num(Math.round(p.results)), confidence: confidenceLabel(t, p.confidence), industries: p.industries.map((k) => industryLabels(t)[k] ?? k).join(", ") })}>
                          <Badge tone={p.index >= 1.1 ? "green" : p.index <= 0.9 ? "red" : "gray"}>
                            {t("targeting.page.browse.realRun", { index: indexLabel(p.index) })}
                            {p.confidence < 0.33 && <span className="font-normal opacity-70">{t("targeting.page.browse.fewData")}</span>}
                          </Badge>
                        </span>
                      )}
                      {!!u?.running && <Badge tone="blue">{t("targeting.page.browse.runningGroups", { n: u.running })}</Badge>}
                      {!!u?.drafts && <Badge tone="gray">{t("targeting.page.browse.drafts", { n: u.drafts })}</Badge>}
                      {isNew(i) && <Badge tone="green">{t("targeting.page.browse.badgeNew")}</Badge>}
                      {i.status === "dead" && <Badge tone="red">{t("targeting.page.browse.retired", { date: i.deadAt ? ` ${dateOnly(i.deadAt)}` : "" })}</Badge>}
                      {i.status === "active" && i.findable === false && <Badge tone="amber">{t("targeting.page.browse.hidden")}</Badge>}
                    </div>
                    <p className="mt-0.5 text-xs text-mut">
                      {typeLabel(t, i.type)}
                      {i.nameVi && i.nameVi !== i.name && <> · {i.name}</>}
                      {inds.length > 0 && <> · {inds.slice(0, 3).join(", ")}{inds.length > 3 && ` +${inds.length - 3}`}</>}
                    </p>
                    {i.path && (
                      <p className="mt-0.5 truncate text-xs text-mut2" title={t("targeting.page.browse.tipPath", { path: i.path, id: i.id, source: SOURCE[i.source] ? t(SOURCE[i.source]) : i.source })}>
                        {i.path.split(" > ").join(" › ")}
                      </p>
                    )}
                    {i.description && <p className="mt-0.5 line-clamp-1 text-xs text-mut2" title={i.description}>{i.description}</p>}
                  </div>
                  <div className="flex shrink-0 items-center gap-4">
                    <div className="w-20 text-right">
                      {i.vnHi != null && i.vnHi < 1000 ? (
                        <div className="text-xs text-mut2" title={t("targeting.page.browse.under1kTip")}>{t("targeting.page.browse.under1k")}</div>
                      ) : i.vnHi != null ? (
                        <>
                          <div className="text-sm font-semibold text-ink tabular-nums">{formatSize(i.vnLo, i.vnHi)}</div>
                          <div className="text-[11px] text-mut">{t("targeting.page.browse.vnPeople")}</div>
                        </>
                      ) : (
                        <div className="text-xs text-mut2">{t("targeting.page.browse.notMeasured")}</div>
                      )}
                    </div>
                    <div className="flex w-36 flex-col items-end gap-0.5">
                      {copy ? (
                        <>
                          <CopyText text={copy} />
                          <span className={`max-w-full truncate text-[11px] ${i.findable ? "text-emerald-700" : "text-mut2"}`} title={copy}>
                            {i.findable ? (copy === display ? t("targeting.page.browse.found") : t("targeting.page.browse.typed", { copy })) : t("targeting.page.browse.notTried")}
                          </span>
                        </>
                      ) : (
                        <span className="text-[11px] text-mut2">{t("targeting.page.browse.unusable")}</span>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      {pages > 1 && (
        <div className="flex items-center justify-end gap-2 text-sm">
          {page > 1 && <Link href={qs({ page: String(page - 1) })} className={btnClass("secondary")}>{t("targeting.page.browse.prev")}</Link>}
          <span className="px-2 text-xs text-mut">{t("targeting.page.browse.pageLabel", { page, pages })}</span>
          {page < pages && <Link href={qs({ page: String(page + 1) })} className={btnClass("secondary")}>{t("targeting.page.browse.next")}</Link>}
        </div>
      )}
      {q.length >= 2 && <MetaSearch q={q} />}
    </div>
  );
}

// ------------------------------------------------------------ Updates

async function Runs({ sp, workerAlive }: { sp: SP; workerAlive: boolean }) {
  const t = await getT();
  const [runs, seedSets, metaClients, scanApi] = await Promise.all([
    db.targetingRun.findMany({ orderBy: { createdAt: "desc" }, take: 30, include: { _count: { select: { changes: true } } } }),
    db.targetingSeedSet.findMany({ orderBy: { name: "asc" } }),
    db.client.count({ where: { dataSource: "meta", metaAccessToken: { not: null }, metaAdAccountId: { not: null } } }),
    db.setting.findUnique({ where: { key: "targeting.scanToken" } }),
  ]);
  const disabledReason =
    !scanApi && !metaClients ? t("targeting.page.runs.noApi") : null;
  return (
    <div className="space-y-6">
      {!workerAlive && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          {t("targeting.page.runs.workerDown1", { docker: "\u0001", npm: "\u0002" }).split(/(\u0001|\u0002)/).map((part, i) => (part === "\u0001" ? <code key={i}>docker compose up -d worker</code> : part === "\u0002" ? <code key={i}>npm run targeting:worker</code> : part))}
        </p>
      )}
      <StartRun seedSets={seedSets.map((s) => ({ id: s.id, name: s.name, count: (JSON.parse(s.keywords) as string[]).length, active: s.active }))} disabledReason={disabledReason} />
      <Card title={t("targeting.page.runs.history")}>
        {!runs.length ? (
          <Empty>{t("targeting.page.runs.none")}</Empty>
        ) : (
          <ul className="-my-5 divide-y divide-slate-100">
            {runs.map((r) => {
              const p = JSON.parse(r.progress || "{}") as { done?: number; total?: number; found?: number; calls?: number; phase?: string };
              const stats = r.stats ? (JSON.parse(r.stats) as Record<string, number | string>) : null;
              const pct = p.total ? Math.min(100, Math.round(((p.done ?? 0) / p.total) * 100)) : 0;
              const st = STATUS[r.status];
              return (
                <li key={r.id} className="py-4" id={r.id}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-slate-900">{runLabel(t, r.kind)}</span>
                    <Badge tone={st?.tone}>{st ? t(st.label) : r.status}</Badge>
                    {r.kind === "reach" && <span className="text-xs text-slate-500">{t("targeting.page.runs.scope", { scope: JSON.parse(r.params).scope })}</span>}
                    <span className="text-xs text-slate-400">
                      {dateTime(r.createdAt)} · {r.triggeredBy ? actorLabel(r.triggeredBy, t) : "?"}
                    </span>
                    {(r.status === "queued" || r.status === "running") && <CancelRun id={r.id} />}
                    {r._count.changes > 0 && (
                      <Link href={`?tab=changes&run=${r.id}`} className="ml-auto text-xs font-medium text-indigo-600 hover:underline">
                        {t("targeting.page.runs.changes", { n: num(r._count.changes) })}
                      </Link>
                    )}
                  </div>
                  {r.status === "running" && (
                    <div className="mt-2 flex items-center gap-3">
                      <div className="h-1.5 w-64 overflow-hidden rounded-full bg-slate-100">
                        <div className="h-full rounded-full bg-sky-500" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-xs text-slate-500 tabular-nums">
                        {t("targeting.page.runs.progress", { done: p.done ?? 0, total: p.total ?? "?", phase: p.phase ? `· ${p.phase} ` : "", found: num(p.found ?? 0), calls: num(p.calls ?? 0) })}
                      </span>
                    </div>
                  )}
                  {stats && (
                    <p className="mt-1 text-xs text-slate-600">
                      {Object.entries(stats)
                        .filter(([k]) => ["added", "dead", "revived", "renamed", "sizeChanged", "ok", "errors", "published", "calls", "sized"].includes(k))
                        .map(([k, v]) => `${t(`targeting.page.runs.stat.${k}` as MessageKey)}: ${typeof v === "number" ? num(v) : v}`)
                        .join(" · ")}
                    </p>
                  )}
                  {r.error && <p className="mt-1 text-xs text-rose-600">{r.error}</p>}
                  {r.log && (
                    <details className="mt-1" open={sp.run === r.id}>
                      <summary className="cursor-pointer text-xs text-slate-400 hover:text-slate-600">{t("targeting.page.runs.log")}</summary>
                      <pre className="mt-1 max-h-64 overflow-y-auto rounded-lg bg-slate-50 p-2 text-[11px] leading-relaxed whitespace-pre-wrap text-slate-600">{r.log.split("\n").slice(-60).join("\n")}</pre>
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

// ------------------------------------------------------------ Changes

async function Changes({ sp, qs }: { sp: SP; qs: QS }) {
  const t = await getT();
  const filter = sp.change;
  const where = {
    ...(sp.run && { runId: sp.run }),
    ...(filter === "dead_used" ? { change: "dead", usedIn: { not: null } } : filter ? { change: filter } : {}),
  };
  const [rows, counts] = await Promise.all([
    db.targetingChange.findMany({ where, orderBy: { createdAt: "desc" }, take: 300, include: { run: { select: { kind: true, createdAt: true } } } }),
    db.targetingChange.groupBy({ by: ["change"], where: sp.run ? { runId: sp.run } : {}, _count: true }),
  ]);
  const count = new Map(counts.map((c) => [c.change, c._count]));
  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {[["", t("targeting.page.changes.all")], ["dead_used", t("targeting.page.changes.deadUsed")], ...Object.entries(CHANGE).map(([k, v]) => [k, t(v.label)])].map(([k, label]) => (
          <Link
            key={k}
            href={qs({ change: k || undefined })}
            className={`rounded-full px-3 py-1 text-xs font-medium ${(filter ?? "") === k ? "bg-ink text-panel" : "bg-panel text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"}`}
          >
            {label}
            {k && k !== "dead_used" && count.get(k) ? <span className="opacity-60"> {count.get(k)}</span> : null}
          </Link>
        ))}
        {sp.run && <Link href={qs({ run: undefined })} className="text-xs text-indigo-600 hover:underline">{t("targeting.page.changes.clearRun")}</Link>}
      </div>
      {!rows.length ? (
        <Empty>{t("targeting.page.changes.empty", { scope: filter ? t("targeting.page.changes.emptyScope") : "" })}</Empty>
      ) : (
        <ul className="-mx-5 -mb-5 divide-y divide-slate-100">
          {rows.map((c) => {
            const before = c.before ? JSON.parse(c.before) : null;
            const after = c.after ? JSON.parse(c.after) : null;
            const used = c.usedIn ? (JSON.parse(c.usedIn) as { kind: string; name: string; client: string }[]) : null;
            return (
              <li key={c.id} className={`flex flex-wrap items-start gap-3 px-5 py-3 text-sm ${used ? "bg-rose-50/60" : ""}`}>
                <span className="w-28 shrink-0 text-xs text-slate-400">{dateTime(c.createdAt)}</span>
                <Badge tone={CHANGE[c.change]?.tone}>{CHANGE[c.change] ? t(CHANGE[c.change].label) : c.change}</Badge>
                <div className="min-w-0 flex-1">
                  <p className="text-slate-800">
                    {c.name} <span className="text-xs text-slate-400">· {typeLabel(t, c.type)}</span>
                  </p>
                  {c.change === "renamed" && before && <p className="text-xs text-slate-500">{t("targeting.page.changes.oldName", { name: before.name })}</p>}
                  {(c.change === "size_up" || c.change === "size_down") && (
                    <p className="text-xs text-slate-500">
                      {t("targeting.page.changes.size", { from: formatSize(before?.vnLo, before?.vnHi), to: formatSize(after?.vnLo, after?.vnHi) })}
                    </p>
                  )}
                  {c.change === "added" && after?.vnHi != null && <p className="text-xs text-slate-500">{t("targeting.page.changes.sizeOne", { size: formatSize(null, after.vnHi) })}</p>}
                  {used && (
                    <p className="mt-1 text-xs text-rose-700">
                      {t("targeting.page.changes.usedIn", { list: used.map((u) => `${u.kind} "${u.name}" (${u.client})`).join("; ") })}
                    </p>
                  )}
                </div>
                <span className="text-xs text-slate-400">{runLabel(t, c.run.kind)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

// ------------------------------------------------------------ Performance by industry

async function IndustryTab({ sp, qs }: { sp: SP; qs: QS }) {
  const tr = await getT();
  const [groups, clients] = await Promise.all([
    db.targetingClientStat.groupBy({ by: ["industryKey", "resultType"], _count: { _all: true } }),
    db.client.groupBy({ by: ["industryKey"], where: { dataSource: "meta" }, _count: { _all: true } }),
  ]);
  const clientCount = new Map(clients.map((c) => [c.industryKey, c._count._all]));
  const industries = [...new Set(groups.map((g) => g.industryKey))];
  const ind = sp.ind && industries.includes(sp.ind) ? sp.ind : industries[0];
  const types = groups.filter((g) => g.industryKey === ind).map((g) => g.resultType);
  const rt = sp.rt && types.includes(sp.rt) ? sp.rt : types[0];
  const stats = ind && rt ? await industryStats(ind, rt) : [];
  const broad = stats.find((s) => s.key === BROAD_KEY);
  const rows = stats.filter((s) => s.key !== BROAD_KEY);
  const lib = new Map((await db.targetingItem.findMany({ where: { key: { in: rows.map((r) => r.key) } }, select: { key: true, name: true, nameVi: true, copyText: true, findable: true, status: true, vnLo: true, vnHi: true } })).map((t) => [t.key, t]));
  const noIndustry = clientCount.get(null) ?? 0;

  return (
    <div className="space-y-4">
      <p className="text-sm text-mut">
        {tr("targeting.page.ind.how", { bold: "\u0001" }).split("\u0001").flatMap((part, i) => (i ? [<b key="b" className="text-ink">{tr("targeting.page.ind.howBold")}</b>, part] : [part]))}
        {" "}
        <Hint tip={tr("targeting.page.ind.tip")}>
          <span className="cursor-help text-indigo-600 underline decoration-dotted">{tr("targeting.page.ind.howCalc")}</span>
        </Hint>
      </p>
      {noIndustry > 0 && <p className="text-xs text-amber-700">{tr("targeting.page.ind.noIndustry", { n: noIndustry })}</p>}
      {!industries.length ? (
        <Empty>{tr("targeting.page.ind.empty")}</Empty>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {industries.map((k) => (
              <Link key={k} href={qs({ ind: k, rt: undefined })} className={`rounded-full px-3 py-1 text-sm ${k === ind ? "bg-indigo-600 text-white" : "bg-panel text-ink2 ring-1 ring-line hover:bg-slate-50"}`}>
                {industryLabels(tr)[k] ?? k} <span className="opacity-70">{tr("targeting.page.ind.clients", { n: clientCount.get(k) ?? 0 })}</span>
              </Link>
            ))}
          </div>
          {types.length > 1 && (
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-mut">{tr("targeting.page.ind.resultType")}</span>
              {types.map((t) => (
                <Link key={t} href={qs({ ind, rt: t })} className={`rounded-md px-2 py-1 ${t === rt ? "bg-indigo-50 font-medium text-indigo-700" : "text-ink2 hover:bg-slate-100"}`}>
                  {resultLabels(tr)[t] ?? t}
                </Link>
              ))}
            </div>
          )}
          <Card
            title={`${industryLabels(tr)[ind!] ?? ind} · ${resultLabels(tr)[rt!] ?? rt}`}
            action={broad && <span className="text-xs text-mut">{tr("targeting.page.ind.baseline", { index: "\u0001", clients: broad.clients, results: num(Math.round(broad.results)) }).split("\u0001").flatMap((part, i) => (i ? [<b key="b" className="text-ink">{indexLabel(broad.index)}</b>, part] : [part]))}</span>}
          >
            {!rows.length ? (
              <p className="text-sm text-mut">{tr("targeting.page.ind.noRows")}</p>
            ) : (
              <div className="-mx-5 -my-5 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs text-mut">
                    <tr>
                      <th className="px-5 py-2 font-medium">{tr("targeting.page.ind.colTarget")}</th>
                      <th className="px-3 py-2 text-right font-medium">{tr("targeting.page.ind.colIndex")}</th>
                      <th className="px-3 py-2 font-medium">{tr("targeting.page.ind.colConf")}</th>
                      <th className="px-3 py-2 text-right font-medium">{tr("targeting.page.ind.colClients")}</th>
                      <th className="px-3 py-2 text-right font-medium">{tr("targeting.page.ind.colVn")}</th>
                      <th className="px-5 py-2 text-right font-medium">{tr("targeting.page.ind.colAm")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {rows.map((r) => {
                      const t = lib.get(r.key);
                      const usable = t && t.status === "active" && t.findable !== false;
                      return (
                        <tr key={r.key}>
                          <td className="px-5 py-2.5">
                            <p className="font-medium text-ink">{t?.nameVi || r.name}</p>
                            <p className="text-xs text-mut">{typeLabel(tr, r.type)}</p>
                          </td>
                          <td className={`px-3 py-2.5 text-right font-semibold tabular-nums ${r.index >= 1.1 ? "text-emerald-700" : r.index <= 0.9 ? "text-rose-600" : "text-ink"}`}>{indexLabel(r.index)}</td>
                          <td className="px-3 py-2.5">
                            <Badge tone={r.confidence >= 0.99 ? "green" : r.confidence >= 0.33 ? "amber" : "gray"}>{confidenceLabel(tr, r.confidence)}</Badge>
                          </td>
                          <td className="px-3 py-2.5 text-right text-xs whitespace-nowrap text-mut tabular-nums">{r.clients} · {num(Math.round(r.results))}</td>
                          <td className="px-3 py-2.5 text-right whitespace-nowrap tabular-nums">{t?.vnHi != null ? formatSize(t.vnLo, t.vnHi) : <span className="text-mut2">—</span>}</td>
                          <td className="px-5 py-2.5 text-right">
                            {usable ? (
                              <CopyText text={copyTextOf({ name: t.nameVi || t.name, copyText: t.copyText })} />
                            ) : (
                              <span className="text-[11px] text-mut2">{t?.status === "dead" ? tr("targeting.page.ind.retired") : t ? tr("targeting.page.ind.notFound") : tr("targeting.page.ind.notInLibrary")}</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------ Industry keyword sets

async function Seeds() {
  const t = await getT();
  const sets = await db.targetingSeedSet.findMany({ orderBy: { name: "asc" } });
  const base = sets.filter((s) => !s.name.startsWith(EXPAND_PREFIX));
  const perClient = sets.filter((s) => s.name.startsWith(EXPAND_PREFIX));
  const editor = (s: (typeof sets)[number]) => <SeedSetEditor key={s.id} set={{ id: s.id, name: s.name, keywords: JSON.parse(s.keywords), active: s.active }} />;
  return (
    <div className="space-y-3">
      <p className="text-sm text-mut">
        {t("targeting.page.seeds.intro")}
      </p>
      {base.map(editor)}
      <p className="pt-2 text-sm font-medium text-ink">{t("targeting.page.seeds.addNew")}</p>
      <SeedSetEditor />
      {perClient.length > 0 && (
        <details className="pt-4">
          <summary className="cursor-pointer text-sm font-medium text-ink">
            {t("targeting.page.seeds.perClient")} <span className="font-normal text-mut">{t("targeting.page.seeds.perClientSub", { n: perClient.length })}</span>
          </summary>
          <div className="mt-3 space-y-3">{perClient.map(editor)}</div>
        </details>
      )}
    </div>
  );
}

// ------------------------------------------------------------ Settings

async function SettingsTab({ workerAlive }: { workerAlive: boolean }) {
  const t = await getT();
  const [clients, scan, auto, apiAct, apiToken, apiOwner, apiExp] = await Promise.all([
    db.client.findMany({ where: { dataSource: "meta", metaAccessToken: { not: null }, metaAdAccountId: { not: null } }, select: { id: true, name: true, metaAdAccountId: true }, orderBy: { name: "asc" } }),
    db.setting.findUnique({ where: { key: "targeting.scanClientId" } }),
    db.setting.findUnique({ where: { key: "targeting.autoUpdate" } }),
    ...["targeting.scanAct", "targeting.scanToken", "targeting.scanOwner", "targeting.scanExpiresAt"].map((key) => db.setting.findUnique({ where: { key } })),
  ]);
  return (
    <Card>
      <div className="mb-6">
        <ScanApi current={apiAct && apiToken ? { act: apiAct.value, owner: apiOwner?.value ?? "", expiresAt: apiExp?.value ?? "" } : null} />
      </div>
      <TargetingSettings clients={clients.map((c) => ({ id: c.id, name: c.name, act: c.metaAdAccountId! }))} scanClientId={scan?.value ?? ""} autoUpdate={auto?.value === "on"} />
      <div className="mt-6 border-t border-slate-100 pt-4 text-sm text-slate-600">
        <p className="font-medium text-slate-800">{t("targeting.page.set.how")}</p>
        <ul className="mt-1 list-disc space-y-1 pl-5">
          <li>{t("targeting.page.set.b1")}</li>
          <li>{t("targeting.page.set.b2")}</li>
          <li>{t("targeting.page.set.b3")}</li>
          <li>{t("targeting.page.set.worker", { state: workerAlive ? t("targeting.page.set.running") : t("targeting.page.set.notRunning") })}</li>
        </ul>
      </div>
    </Card>
  );
}
