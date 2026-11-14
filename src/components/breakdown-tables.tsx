import { money, num } from "@/lib/format";
import { groupByNewProvince, viRegionName } from "@/lib/vn-geo";
import { Card } from "./ui";
import { getT } from "@/i18n/server";
import type { T } from "@/i18n/translate";

type Row = { dimension: string; key: string; spend: number; impressions: number; clicks: number; results: number; days?: number; estimated?: boolean; parts?: string[] };

const PLATFORM: Record<string, string> = { facebook: "Facebook", instagram: "Instagram", messenger: "Messenger", audience_network: "Audience Network", threads: "Threads" };

function label(r: Row, t: T) {
  if (r.dimension === "age_gender") {
    const [age, g] = r.key.split("|");
    const gender = g === "female" ? t("core.breakdown.female") : g === "male" ? t("core.breakdown.male") : g === "unknown" ? t("core.breakdown.unknown") : g;
    return `${gender} · ${age}`;
  }
  if (r.dimension === "platform") return PLATFORM[r.key] ?? r.key;
  if (r.dimension === "newprov") return r.key;
  return /^unknown$/i.test(r.key) ? t("core.breakdown.unknown") : viRegionName(r.key);
}

function Table({ title, rows, currency, resultLabel, limit = 12, note, t }: { title: string; rows: Row[]; currency: string; resultLabel: string; limit?: number; note?: string; t: T }) {
  const list = rows.filter((r) => r.spend > 0).sort((a, b) => b.spend - a.spend).slice(0, limit);
  if (!list.length) return null;
  const cprs = list.filter((r) => r.results > 0).map((r) => r.spend / r.results);
  const best = cprs.length ? Math.min(...cprs) : null;
  const maxSpend = Math.max(...list.map((r) => r.spend));
  return (
    <div className="min-w-0">
      <p className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">{title}</p>
      {note && <p className="-mt-1 mb-2 text-xs text-amber-700">{note}</p>}
      <table className="w-full text-sm">
        <thead className="text-left text-xs whitespace-nowrap text-slate-400">
          <tr>
            <th className="py-1 pr-3 font-medium">{t("core.breakdown.group")}</th>
            <th className="py-1 pr-3 font-medium">{t("core.breakdown.spend")}</th>
            <th className="py-1 pr-3 text-right font-medium" title={resultLabel}>{t("core.breakdown.kq")}</th>
            <th className="py-1 text-right font-medium" title={t("core.breakdown.costPer", { result: resultLabel.toLowerCase() })}>CPR</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {list.map((r) => {
            const cpr = r.results ? r.spend / r.results : null;
            return (
              <tr key={r.key}>
                <td className="py-1.5 pr-3 text-slate-800">
                  <span className="whitespace-nowrap">{label(r, t)}</span>
                  {r.parts && r.parts.length > 0 && <span className="block text-xs text-mut">{t("core.breakdown.includes", { parts: r.parts.join(", ") })}</span>}
                </td>
                <td className="py-1.5 pr-3">
                  <span className="flex items-center gap-2">
                    <span className="h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-slate-100">
                      <span className="block h-full rounded-full bg-indigo-400" style={{ width: `${(r.spend / maxSpend) * 100}%` }} />
                    </span>
                    <span className="text-xs whitespace-nowrap text-slate-600 tabular-nums">{money(r.spend, currency)}</span>
                  </span>
                </td>
                <td className="py-1.5 pr-3 text-right whitespace-nowrap tabular-nums" title={r.estimated ? t("core.breakdown.estimated") : undefined}>
                  {r.estimated ? "≈" : ""}
                  {num(r.estimated ? Math.round(r.results) : r.results)}
                </td>
                <td className={`py-1.5 text-right whitespace-nowrap tabular-nums ${cpr != null && best != null && cpr <= best * 1.15 ? "font-medium text-emerald-700" : ""}`}>
                  {cpr != null ? money(cpr, currency) : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Ads data (analysisDays days) by age/gender, region, platform (from the latest sync). The cheapest CPR is highlighted green. */
export async function BreakdownTables({ rows, currency, resultLabel }: { rows: Row[]; currency: string; resultLabel: string }) {
  const t = await getT();
  if (!rows.some((r) => r.spend > 0)) return null;
  const by = (d: string) => rows.filter((r) => r.dimension === d);
  const estNote = by("region").some((r) => r.estimated) ? t("core.breakdown.estNote") : undefined;
  return (
    <Card title={t("core.breakdown.title", { days: rows[0]?.days ?? 30 })}>
      <p className="-mt-1 mb-4 text-xs text-slate-500">{t("core.breakdown.legend", { result: resultLabel.toLowerCase() })}</p>
      <div className="grid gap-8 @5xl:grid-cols-2">
        <Table t={t} title={t("core.breakdown.ageGender")} rows={by("age_gender")} currency={currency} resultLabel={resultLabel} />
        <div className="space-y-8">
          <div>
            <Table t={t} title={t("core.breakdown.region")} rows={by("region")} currency={currency} resultLabel={resultLabel} limit={10} note={estNote} />
            {by("region").some((r) => r.spend > 0) && (
              <details className="mt-3">
                <summary className="cursor-pointer text-xs font-medium text-indigo-700">{t("core.breakdown.viewNew")}</summary>
                <div className="mt-3">
                  <Table t={t} title={t("core.breakdown.newProvinces")} rows={groupByNewProvince(by("region")).map((g) => ({ ...g, dimension: "newprov" }))} currency={currency} resultLabel={resultLabel} limit={12} />
                </div>
              </details>
            )}
          </div>
          <Table t={t} title={t("core.breakdown.platform")} rows={by("platform")} currency={currency} resultLabel={resultLabel} limit={6} />
        </div>
      </div>
    </Card>
  );
}
