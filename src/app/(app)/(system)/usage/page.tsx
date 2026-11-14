import { connection } from "next/server";
import { db } from "@/lib/db";
import { dateTime } from "@/lib/format";
import { Badge, Card, Empty, PageHeader } from "@/components/ui";
import { ApiUsagePanel } from "@/components/api-usage-panel";
import { requirePlatformPage } from "@/lib/access";
import { readUsage } from "@/lib/meta/rate-limit";
import { jobLabels } from "@/lib/client-jobs";
import { usageReport } from "@/lib/usage-report";
import { taskLabel } from "@/lib/ai/model-tiers";
import { getT } from "@/i18n/server";
import type { MessageKey, T } from "@/i18n/translate";

const n = (v: number) => Math.round(v).toLocaleString("vi-VN");
const tokOf = (t: T) => (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)} ${t("system.usage.unitMillion")}` : v >= 1e3 ? `${Math.round(v / 1e3)}k` : String(v));
const secsOf = (t: T) => (ms: number) => (ms >= 60_000 ? t("system.usage.minutes", { n: (ms / 60_000).toFixed(1) }) : t("system.usage.seconds", { n: Math.round(ms / 1000) }));
const mb = (b: number | null) => (b == null ? "—" : b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`);
const RUN: Record<string, MessageKey> = { import: "system.usage.run.import", catalog: "system.usage.run.catalog", expand: "system.usage.run.expand", reach: "system.usage.run.reach", find: "system.usage.run.find", account: "system.usage.run.account" };

// System usage: Claude (per call), Meta API, background jobs, data storage.
export default async function UsagePage() {
  await connection();
  const t = await getT();
  const tok = tokOf(t);
  const secs = secsOf(t);
  await requirePlatformPage(); // shared settings: only members of the platform workspace
  const [r, meta, clients] = await Promise.all([usageReport(t), readUsage(), db.client.findMany({ select: { name: true, metaAdAccountId: true, metaPageId: true, metaPageName: true } })]);
  const maxDay = Math.max(1, ...r.days.map((d) => d.agg.input + d.agg.output));
  return (
    <>
      <PageHeader title={t("system.usage.title")} subtitle={t("system.usage.subtitle") + (r.since ? t("system.usage.since", { date: dateTime(r.since) }) : "")} />

      <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4">
        {r.periods.map(([label, a]) => (
          <div key={label} className="rounded-xl border border-line bg-panel p-4">
            <p className="text-xs font-medium text-mut">Claude · {label}</p>
            <p className="mt-1 text-2xl font-semibold text-ink tabular-nums">{t("system.usage.callsN", { n: n(a.calls) })}</p>
            <p className="mt-1 text-xs text-ink2 tabular-nums">
              {t("system.usage.tokensInOut", { inn: tok(a.input), out: tok(a.output) })}
            </p>
            <p className="text-xs text-mut tabular-nums">
              {t("system.usage.ran", { time: secs(a.ms) })}
              {a.failed ? <span className="text-rose-700"> · {t("system.usage.failedN", { n: a.failed })}</span> : null}
            </p>
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-mut">
        {t("system.usage.note")}
      </p>

      <Card title={t("system.usage.chart14")} className="mt-6">
        {r.days.every((d) => !d.agg.calls) ? (
          <Empty>{t("system.usage.noCalls")}</Empty>
        ) : (
          <div className="flex h-40 items-end gap-1.5">
            {r.days.map((d) => (
              <div key={d.day} className="flex flex-1 flex-col items-center gap-1" title={t("system.usage.dayTitle", { day: d.day, calls: d.agg.calls, inn: tok(d.agg.input), out: tok(d.agg.output) })}>
                <span className="text-[10px] text-mut tabular-nums">{d.agg.calls || ""}</span>
                <div className="w-full rounded-t bg-indigo-400" style={{ height: Math.max(d.agg.calls ? 3 : 0, Math.round(((d.agg.input + d.agg.output) / maxDay) * 110)) }} />
                <span className="text-[10px] text-mut">{d.day.slice(8)}/{d.day.slice(5, 7)}</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <div className="mt-6 grid gap-6 @5xl:grid-cols-2">
        <Card title={t("system.usage.byTask")}>
          {!r.byTask.length ? (
            <Empty>{t("system.usage.noData")}</Empty>
          ) : (
            <table className="-mx-5 -my-5 w-[calc(100%+2.5rem)] text-sm">
              <thead className="bg-slate-50 text-left text-xs text-mut">
                <tr>
                  <th className="px-5 py-2 font-medium">{t("system.usage.colTask")}</th>
                  <th className="px-2 py-2 text-right font-medium">{t("system.usage.colCalls")}</th>
                  <th className="px-2 py-2 text-right font-medium">{t("system.usage.colTokens")}</th>
                  <th className="px-5 py-2 text-right font-medium">{t("system.usage.colAvg")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {r.byTask.map(([task, a]) => (
                  <tr key={task}>
                    <td className="px-5 py-2 text-ink">
                      {taskLabel(task, t)}
                      {a.failed > 0 && <span className="ml-1 text-xs text-rose-700">({t("system.usage.failedN", { n: a.failed })})</span>}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">{n(a.calls)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{tok(a.input + a.output)}</td>
                    <td className="px-5 py-2 text-right text-xs text-mut tabular-nums">
                      {tok((a.input + a.output) / a.calls)} · {secs(a.ms / a.calls)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card title={t("system.usage.byClient")}>
          {!r.byClient.length ? (
            <Empty>{t("system.usage.noData")}</Empty>
          ) : (
            <table className="-mx-5 -my-5 w-[calc(100%+2.5rem)] text-sm">
              <thead className="bg-slate-50 text-left text-xs text-mut">
                <tr>
                  <th className="px-5 py-2 font-medium">{t("system.usage.colClient")}</th>
                  <th className="px-2 py-2 text-right font-medium">{t("system.usage.colCalls")}</th>
                  <th className="px-2 py-2 text-right font-medium">{t("system.usage.colTokens")}</th>
                  <th className="px-5 py-2 text-right font-medium">{t("system.usage.colRuntime")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {r.byClient.map(([name, a]) => (
                  <tr key={name}>
                    <td className="px-5 py-2 text-ink">{name}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{n(a.calls)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{tok(a.input + a.output)}</td>
                    <td className="px-5 py-2 text-right text-xs text-mut tabular-nums">{secs(a.ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <Card title={t("system.usage.recent")} className="mt-6">
        {!r.recent.length ? (
          <Empty>{t("system.usage.noCallsSince")}</Empty>
        ) : (
          <ul className="-my-5 divide-y divide-line text-sm">
            {r.recent.map((x) => (
              <li key={x.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
                <span className="w-28 shrink-0 text-xs text-mut">{dateTime(x.at)}</span>
                <span className="font-medium text-ink">{taskLabel(x.task, t)}</span>
                {x.client && <span className="text-xs text-indigo-700">{x.client}</span>}
                {x.images > 0 && <Badge tone="mut">{t("system.usage.images", { n: x.images })}</Badge>}
                <span className="ml-auto text-xs text-mut tabular-nums">
                  {t("system.usage.inOutTime", { inn: tok(x.inputTokens), out: tok(x.outputTokens), time: secs(x.ms) })}
                </span>
                {!x.ok && <span className="w-full text-xs text-rose-700">{t("system.usage.errorPrefix", { error: x.error ?? "" })}</span>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="mt-6">
        <ApiUsagePanel
          snap={meta}
          names={new Map(clients.flatMap((c) => [...(c.metaAdAccountId ? [[c.metaAdAccountId.replace(/^act_/, ""), c.name] as [string, string]] : []), ...(c.metaPageId ? [[c.metaPageId, c.metaPageName || c.name] as [string, string]] : [])]))}
        />
      </div>

      <div className="mt-6 grid gap-6 @5xl:grid-cols-2">
        <Card title={t("system.usage.bgJobs")}>
          {!r.jobs.length && !r.runs.length ? (
            <Empty>{t("system.usage.noJobs")}</Empty>
          ) : (
            <ul className="-my-5 divide-y divide-line text-sm">
              {r.jobs.map(([kind, x]) => (
                <li key={kind} className="flex flex-wrap items-center gap-3 py-2.5">
                  <span className="text-ink">{jobLabels(t)[kind] ?? kind}</span>
                  <span className="ml-auto text-xs text-mut tabular-nums">
                    {t("system.usage.timesN", { n: x.count })}{x.done ? ` · ${t("system.usage.avgAbbr")} ${secs(x.ms / x.done)}` : ""}
                    {x.failed ? <span className="text-rose-700"> · {t("system.usage.failedN", { n: x.failed })}</span> : null}
                  </span>
                </li>
              ))}
              {r.runs.map(([kind, x]) => (
                <li key={`run-${kind}`} className="flex flex-wrap items-center gap-3 py-2.5">
                  <span className="text-ink">{t("system.usage.targetingLib")} · {RUN[kind] ? t(RUN[kind]) : kind}</span>
                  <span className="ml-auto text-xs text-mut tabular-nums">
                    {t("system.usage.timesN", { n: x.count })} · {t("system.usage.metaCalls", { n: n(x.calls) })}
                    {x.failed ? <span className="text-rose-700"> · {t("system.usage.failedN", { n: x.failed })}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title={t("system.usage.storage")}>
          <ul className="-my-5 divide-y divide-line text-sm">
            <li className="flex justify-between py-2.5">
              <span className="text-ink">{t("system.usage.storageDb")}</span>
              <span className="tabular-nums">{mb(r.storage.db)}</span>
            </li>
            <li className="flex justify-between py-2.5">
              <span className="text-ink">{t("system.usage.storageUploads")}</span>
              <span className="tabular-nums">{mb(r.storage.uploads)}</span>
            </li>
            <li className="flex justify-between py-2.5">
              <span className="text-ink">{t("system.usage.storageKnowledge")}</span>
              <span className="tabular-nums">{mb(r.storage.knowledge)}</span>
            </li>
          </ul>
        </Card>
      </div>
    </>
  );
}
