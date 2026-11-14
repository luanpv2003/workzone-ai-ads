import Link from "next/link";
import { connection } from "next/server";
import { ListChecks, Plus } from "lucide-react";
import { todayOverview, type Tone } from "@/lib/today";
import { PipelineMini } from "@/components/pipeline-bar";
import { dateTime, money, num, pct, resultLabels } from "@/lib/format";
import { Badge, btnClass, Empty, LinkButton } from "@/components/ui";
import { RefreshButton } from "@/components/shell/refresh-button";
import { Sparkline } from "@/components/sparkline";
import { requirePageUser } from "@/lib/auth";
import { visibleClientIds } from "@/lib/access";
import { gettingStartedStatus } from "@/lib/getting-started";
import { BRAND } from "@/lib/brand";
import { getT, getLocale } from "@/i18n/server";
import type { MessageKey, T } from "@/i18n/translate";

// "Hôm nay" (Today) home page: open it and immediately know what to do today, for which client, and do it right from here.

function ScoreBadge({ score, t }: { score: number | null; t: T }) {
  if (score == null) return <Badge>{t("system.home.notAudited")}</Badge>;
  return <Badge tone={score >= 75 ? "good" : score >= 50 ? "warn" : "bad"}>{score}/100</Badge>;
}

const BAR: Record<Tone, string> = { red: "bg-rose-600", amber: "bg-amber-400", green: "bg-emerald-500" };
const HEALTH: Record<Tone, { label: MessageKey; tone: "bad" | "warn" | "good" }> = {
  red: { label: "system.home.healthRed", tone: "bad" },
  amber: { label: "system.home.healthAmber", tone: "warn" },
  green: { label: "system.home.healthGreen", tone: "good" },
};

/** Clickable stat tile: takes you straight to where it's handled. */
function Tile({ label, value, hint, href, tone }: { label: string; value: string; hint?: string; href?: string; tone?: "bad" | "good" }) {
  const body = (
    <>
      <div className="text-[13px] text-mut">{label}</div>
      <div className={`mt-1 text-[22px] leading-tight font-semibold tracking-tight tabular-nums ${tone === "bad" ? "text-rose-700" : "text-ink"}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-mut">{hint}</div>}
    </>
  );
  const cls = `block rounded-xl border bg-panel px-4 py-3.5 ${tone === "bad" ? "border-rose-300" : "border-line"}`;
  return href ? (
    <Link href={href} className={`${cls} transition hover:border-indigo-300`}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

function greeting(t: T) {
  const h = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: "Asia/Ho_Chi_Minh" }).format(new Date()));
  return h < 11 ? t("system.home.greetMorning") : h < 14 ? t("system.home.greetNoon") : h < 18 ? t("system.home.greetAfternoon") : t("system.home.greetEvening");
}

export default async function OverviewPage({ searchParams }: { searchParams: Promise<{ f?: string }> }) {
  const user = await requirePageUser(); // check the session right on the page: the layout may not re-run on client-side navigation
  await connection();
  const t = await getT();
  const RESULT_LABEL = resultLabels(t);
  const locale = await getLocale();
  const { f } = await searchParams;
  const [{ rows, list }, start] = await Promise.all([visibleClientIds(user).then(todayOverview), gettingStartedStatus(user)]);
  const pipelines = new Map(list.map((c) => [c.id, c.pipeline]));
  const vnd = rows.filter((r) => r.currency === "VND");
  const totalSpend = vnd.reduce((a, r) => a + r.spend, 0);
  const pending = rows.reduce((a, r) => a + r.pending, 0);
  const hot = rows.reduce((a, r) => a + r.hotLeads, 0);
  const hotClients = rows.filter((r) => r.hotLeads > 0);
  const withTarget = rows.filter((r) => r.cprVsTarget != null);
  const overTarget = withTarget.filter((r) => r.cprVsTarget! > 0.15);

  // To-dos across all clients, sorted by urgency.
  const RANK: Record<Tone, number> = { red: 0, amber: 1, green: 2 };
  const allTasks = list.flatMap((c) => c.tasks.map((tk) => ({ ...tk, client: c.name.split(" – ")[0] }))).sort((a, b) => RANK[a.tone] - RANK[b.tone]);
  const urgent = allTasks.filter((tk) => tk.tone === "red");
  const should = allTasks.filter((tk) => tk.tone !== "red");
  const shown = f === "red" ? urgent : f === "todo" ? should : allTasks;
  const todo = allTasks.filter((tk) => tk.tone !== "green").length;
  const busyClients = list.filter((c) => c.health !== "green").length;
  const today = new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "vi-VN", { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
  const chip = (key: string | undefined, label: string, n: number) => (
    <Link
      href={key ? `/?f=${key}` : "/"}
      scroll={false}
      className={`inline-flex h-7 items-center rounded-full px-3 text-xs font-medium ${f === key || (!f && !key) ? "bg-ink text-panel" : "border border-line bg-panel text-ink2 hover:bg-hover"}`}
    >
      {label} {n}
    </Link>
  );

  return (
    <>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-mut2 first-letter:uppercase">{today}</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink">
            {greeting(t)}. {todo ? t("system.home.todoCount", { n: todo, clients: busyClients }) : t("system.home.noUrgent")}
          </h1>
          <p className="mt-1 text-sm text-mut">{t("system.home.subtitle")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <RefreshButton />
          <LinkButton href="/clients/new" variant="dark">
            <Plus /> {t("system.shell.addClient")}
          </LinkButton>
        </div>
      </div>

      {start.left > 0 && (
        <Link href="/getting-started" className="mb-6 flex flex-wrap items-center gap-2.5 rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-900 transition hover:border-indigo-300">
          <ListChecks className="size-4 shrink-0" />
          <span className="min-w-0 flex-1">{t("system.gettingStarted.banner", { n: start.left, app: BRAND.app })}</span>
          <span className="font-medium underline">{t("system.gettingStarted.bannerCta")}</span>
        </Link>
      )}

      <div className="mb-6 grid grid-cols-2 gap-3 @4xl:grid-cols-4">
        <Tile label={t("system.home.spend7d")} value={money(totalSpend)} hint={t("system.home.clientsN", { n: rows.length })} />
        <Tile label={t("system.home.pendingRecs")} value={num(pending)} tone={pending ? "bad" : undefined} hint={pending ? t("system.home.clickToApprove") : t("system.home.allDone")} href={pending ? "/recommendations" : undefined} />
        <Tile
          label={t("system.home.hotUnanswered")}
          value={num(hot)}
          tone={hot ? "bad" : undefined}
          hint={hot ? (hotClients.length === 1 ? t("system.home.leadScoreClient", { name: hotClients[0].name.split(" – ")[0] }) : t("system.home.leadScoreClick")) : t("system.home.leadScore")}
          href={hot ? (hotClients.length === 1 ? `/clients/${hotClients[0].id}/messages?f=hot` : "/contacts") : undefined}
        />
        <Tile
          label={t("system.home.overTarget")}
          value={withTarget.length ? `${overTarget.length} / ${withTarget.length}` : "—"}
          tone={overTarget.length ? "bad" : undefined}
          hint={overTarget.length ? overTarget.map((r) => `${r.name.split(" – ")[0]} +${Math.round(r.cprVsTarget! * 100)}%`).join(", ") : t("system.home.over15")}
          href={overTarget.length === 1 ? `/clients/${overTarget[0].id}/campaigns` : undefined}
        />
      </div>

      {list.length === 0 ? (
        <Empty>
          {t("system.home.noClients")} <Link href="/clients/new" className="text-indigo-600 underline">{t("system.shell.addClient")}</Link> {t("system.home.toStart")}
        </Empty>
      ) : (
        <div className="mb-6 grid items-start gap-4 @5xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
          <section className="min-w-0 rounded-xl border border-line bg-panel">
            <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3">
              <h2 className="text-[15px] font-semibold text-ink">{t("system.home.todos")}</h2>
              <div className="flex flex-wrap gap-1.5">
                {chip(undefined, t("system.home.all"), allTasks.length)}
                {chip("red", t("system.home.urgent"), urgent.length)}
                {chip("todo", t("system.home.should"), should.length)}
              </div>
            </header>
            {shown.length ? (
              <ul className="divide-y divide-line">
                {shown.map((tk, i) => (
                  <li key={i} className="flex items-center gap-3 px-5 py-3">
                    <span className={`w-[3px] self-stretch rounded-full ${BAR[tk.tone]}`} />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-mut">
                        {tk.client} · {tk.category}
                      </p>
                      <p className="text-sm font-medium text-ink">{tk.text}</p>
                    </div>
                    <Link href={tk.href} className={btnClass(tk.tone === "red" && tk.cta === t("core.today.approve") ? "primary" : tk.category === t("core.today.catProcess") ? "ai" : "secondary")}>
                      {tk.cta}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-5 py-8 text-center text-sm text-emerald-700">{t("system.home.noTasksHere")}</p>
            )}
          </section>

          <div className="min-w-0 space-y-3">
            {list.map((c) => (
              <Link key={c.id} href={`/clients/${c.id}`} className={`block rounded-xl border border-l-[3px] border-line bg-panel px-4 py-3.5 transition hover:border-indigo-300 ${c.health === "red" ? "border-l-rose-600" : c.health === "amber" ? "border-l-amber-400" : "border-l-emerald-500"}`}>
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 truncate font-semibold text-ink">{c.name}</p>
                  <Badge tone={HEALTH[c.health].tone}>{t(HEALTH[c.health].label)}</Badge>
                </div>
                <p className="truncate text-xs text-mut">{c.industry}</p>
                <div className="mt-2 flex items-end justify-between gap-3">
                  <div className="min-w-0 text-xs text-mut tabular-nums">
                    <p>
                      {t("system.home.campaignsSpend", { n: c.activeCampaigns, spend: money(c.spend, c.currency) })}
                    </p>
                    <p className="text-sm font-medium text-ink">
                      {c.cpr != null ? `${money(c.cpr, c.currency)}/${(RESULT_LABEL[c.resultLabel] ?? t("system.home.result")).toLowerCase()}` : `${num(c.results)} ${(RESULT_LABEL[c.resultLabel] ?? "").toLowerCase()}`}
                    </p>
                  </div>
                  <Sparkline data={c.spark} className={c.health === "red" ? "text-rose-600" : "text-emerald-600"} />
                </div>
                <div className="mt-2.5">
                  <PipelineMini p={c.pipeline} />
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}

      {rows.length > 0 && (
        <details className="group rounded-xl border border-line bg-panel">
          <summary className="cursor-pointer list-none px-5 py-3 text-sm font-semibold text-ink">
            <span className="mr-1 inline-block transition group-open:rotate-90">▸</span> {t("system.home.detailTable")}
          </summary>
          <div className="overflow-x-auto border-t border-line">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs text-mut">
                <tr>
                  <th className="min-w-56 px-5 py-2 font-medium">{t("system.home.colClient")}</th>
                  <th className="px-3 py-2 font-medium">{t("system.home.colPipeline")}</th>
                  <th className="px-3 py-2 font-medium">{t("system.home.colScore")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("system.home.colSpend")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("system.home.colResults")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("system.home.colCpr")}</th>
                  <th className="px-3 py-2 text-right font-medium">ROAS</th>
                  <th className="px-3 py-2 text-right font-medium">{t("system.home.colPending")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("system.home.colNeedsReply")}</th>
                  <th className="px-5 py-2 font-medium">{t("system.home.colUpdated")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => (
                  <tr key={r.id} className="hover:bg-hover">
                    <td className="px-5 py-3">
                      <Link href={`/clients/${r.id}`} className="font-medium text-ink hover:text-indigo-600">
                        {r.name}
                      </Link>
                      <div className="flex items-center gap-2 text-xs text-mut">
                        {r.industry} · {t("system.home.activeCampaigns", { n: r.activeCampaigns })}
                        {r.dataSource === "mock" && <Badge>{t("system.home.notConnected")}</Badge>}
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <PipelineMini p={pipelines.get(r.id)!} href={`/clients/${r.id}`} />
                    </td>
                    <td className="px-3 py-3">
                      <ScoreBadge score={r.score} t={t} />
                    </td>
                    <td className="px-3 py-3 text-right whitespace-nowrap tabular-nums">{money(r.spend, r.currency)}</td>
                    <td className="px-3 py-3 text-right whitespace-nowrap tabular-nums">
                      {num(r.results)} <span className="text-xs text-mut2">{RESULT_LABEL[r.primaryResult]}</span>
                    </td>
                    <td className="px-3 py-3 text-right whitespace-nowrap tabular-nums">
                      <div>{money(r.cpr, r.currency)}</div>
                      {r.cprVsTarget != null && (
                        <div className={`text-xs ${r.cprVsTarget > 0.15 ? "text-rose-700" : r.cprVsTarget < 0 ? "text-emerald-700" : "text-mut"}`}>
                          {r.cprVsTarget > 0 ? "+" : ""}
                          {t("system.home.vsTarget", { pct: pct(r.cprVsTarget * 100, 0), target: money(r.targetCpr, r.currency) })}
                          {r.targetAuto ? t("system.home.autoSuggested") : ""}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">{r.roas ? num(r.roas, 2) : "—"}</td>
                    <td className="px-3 py-3 text-right">{r.pending ? <Badge tone="bad">{r.pending}</Badge> : <span className="text-mut2">0</span>}</td>
                    <td className="px-3 py-3 text-right">
                      {r.needsReply ? (
                        <Badge tone={r.hotLeads ? "bad" : "warn"}>
                          {r.needsReply}
                          {r.hotLeads ? ` (${t("system.home.hotN", { n: r.hotLeads })})` : ""}
                        </Badge>
                      ) : (
                        <span className="text-mut2">0</span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-xs text-mut">{dateTime(r.lastSyncedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </>
  );
}
