import type { UsageEntry, UsageSnapshot } from "@/lib/meta/rate-limit";
import { dateTime } from "@/lib/format";
import { Badge, Card, Empty, type Tone } from "@/components/ui";
import { getT } from "@/i18n/server";
import type { MessageKey } from "@/i18n/translate";

// Meta API rate-limit usage (read from the headers of the most recent calls, see lib/meta/rate-limit.ts).

const TIER: Record<string, { label: MessageKey | null; tone: Tone }> = {
  development_access: { label: "core.apiUsage.tierDev", tone: "amber" },
  standard_access: { label: null, tone: "green" },
};
const TYPES = new Set(["ads_management", "ads_insights", "custom_audience", "pages", "messenger", "instagram", "leadgen"]);

function tone(pct: number): Tone {
  return pct >= 90 ? "red" : pct >= 75 ? "amber" : "green";
}

export async function ApiUsagePanel({ snap, names }: { snap: UsageSnapshot | null; names: Map<string, string> }) {
  const t = await getT();
  const now = new Date().getTime();
  // Only show numbers from the last hour (Meta uses a sliding 1-hour window); each entry keeps its latest value.
  const latest = new Map<string, UsageEntry>();
  for (const e of snap?.entries ?? []) if (now - e.at < 3600_000 && (!latest.has(e.id) || latest.get(e.id)!.at < e.at)) latest.set(e.id, e);
  const rows = [...latest.values()].sort((a, b) => b.pct - a.pct);
  const tiers = [...new Set(rows.map((r) => r.tier).filter(Boolean))] as string[];
  const typeLabel = (type?: string | null) => (type && TYPES.has(type) ? t(`core.apiUsage.type.${type}` as MessageKey) : type);
  const name = (e: UsageEntry) => {
    if (e.kind === "app") return e.id === "limited" ? t("core.apiUsage.blocked", { type: e.type ?? "" }) : t("core.apiUsage.wholeApp");
    const n = (e.objectId && names.get(e.objectId.replace(/^act_/, ""))) || e.objectId || "?";
    return `${e.kind === "account" ? t("core.apiUsage.adAccount") : e.kind === "page" ? t("core.apiUsage.page") : typeLabel(e.type)} · ${n}`;
  };

  return (
    <Card
      title={t("core.apiUsage.title")}
      action={tiers.map((tier) => <Badge key={tier} tone={TIER[tier]?.tone ?? "gray"}>{TIER[tier]?.label ? t(TIER[tier].label) : (tier === "standard_access" ? "Standard" : tier)}</Badge>)}
      className="mt-6"
    >
      <p className="mb-3 text-sm text-slate-600">
        {t("core.apiUsage.intro1")} <b>75%</b> {t("core.apiUsage.intro2")} <b>90%</b> {t("core.apiUsage.intro3")}
      </p>
      {!rows.length ? (
        <Empty>{t("core.apiUsage.empty")}</Empty>
      ) : (
        <ul className="space-y-2 text-sm">
          {rows.map((e) => (
            <li key={`${e.gate}|${e.id}`} className="flex flex-wrap items-center gap-3">
              <span className="min-w-56 flex-1 text-slate-700">{name(e)}</span>
              <span className="h-2 w-40 overflow-hidden rounded-full bg-slate-100">
                <span className={`block h-full ${e.pct >= 90 ? "bg-red-500" : e.pct >= 75 ? "bg-amber-500" : "bg-emerald-500"}`} style={{ width: `${Math.min(100, e.pct)}%` }} />
              </span>
              <Badge tone={tone(e.pct)}>{Math.round(e.pct)}%</Badge>
              {e.regainAt && e.regainAt > now && <span className="text-xs text-red-600">{t("core.apiUsage.regain", { at: dateTime(new Date(e.regainAt)) })}</span>}
            </li>
          ))}
        </ul>
      )}
      {snap && <p className="mt-3 text-xs text-slate-400">{t("core.apiUsage.updated", { at: dateTime(new Date(snap.updatedAt)) })}</p>}
    </Card>
  );
}
