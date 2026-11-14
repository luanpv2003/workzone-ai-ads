import { db } from "./db";
import { clientSummaries } from "./overview";
import { clientPipeline, type Pipeline } from "./pipeline";
import { tokenLevel } from "./token-status";
import { pct } from "./format";
import { getT } from "@/i18n/server";

// "Hôm nay cần làm" (today's to-dos) home page: a task list per client, sorted by urgency, each with 1 button going straight to where it's handled.

export type Tone = "red" | "amber" | "green";
type Task = { tone: Tone; text: string; cta: string; href: string; category: string };
type ClientToday = {
  id: string;
  name: string;
  industry: string;
  currency: string;
  activeCampaigns: number;
  spend: number;
  results: number;
  resultLabel: string;
  cpr: number | null;
  health: Tone;
  tasks: Task[];
  pipeline: Pipeline;
  spark: number[]; // spend over the last 14 days
};

const DAY = 86400000;
const RANK: Record<Tone, number> = { red: 0, amber: 1, green: 2 };

/** scope: only clients the user may view (visibleClientIds); null/empty = all clients. */
export async function todayOverview(scope?: string[] | null) {
  const t = await getT();
  const rows = await clientSummaries(scope);
  const ids = rows.map((r) => r.id);
  const since = new Date(Date.now() - DAY);
  const sparkSince = new Date(Date.now() - 15 * DAY).toISOString().slice(0, 10);
  const [clients, drafts, failedJobs, pipelines, daily] = await Promise.all([
    db.client.findMany({
      where: { id: { in: ids } },
      select: { id: true, dataSource: true, metaAccessToken: true, metaTokenExpiresAt: true, metaTokenError: true, metaTokenMissing: true, metaTokenCheckedAt: true, targetCpr: true },
    }),
    db.campaignDraft.groupBy({ by: ["clientId"], where: { clientId: { in: ids }, status: "draft" }, _count: true }),
    db.clientJob.findMany({ where: { clientId: { in: ids }, status: "failed", finishedAt: { gt: since } }, orderBy: { finishedAt: { sort: "desc", nulls: "last" } }, select: { clientId: true, kind: true } }),
    Promise.all(ids.map((id) => clientPipeline(id))),
    db.dailyMetric.findMany({ where: { clientId: { in: ids }, date: { gte: sparkSince } }, orderBy: { date: "asc" }, select: { clientId: true, date: true, spend: true } }),
  ]);
  const clientBy = new Map(clients.map((c) => [c.id, c]));
  const draftsBy = new Map(drafts.map((d) => [d.clientId, d._count]));
  const failedBy = new Map<string, number>();
  for (const j of failedJobs) failedBy.set(j.clientId, (failedBy.get(j.clientId) ?? 0) + 1);

  const list: ClientToday[] = rows.map((r, i) => {
    const c = clientBy.get(r.id);
    const p = pipelines[i];
    const base = `/clients/${r.id}`;
    const tasks: Task[] = [];
    const isMeta = c?.dataSource === "meta";

    // Urgent (red)
    if (r.pending) tasks.push({ tone: "red", text: t("core.today.pending", { n: r.pending }), cta: t("core.today.approve"), href: `${base}/recommendations`, category: t("core.today.catOptimise") });
    if (isMeta && c) {
      const lv = tokenLevel(c);
      if (lv === "expired" || lv === "error" || lv === "missing")
        tasks.push({ tone: "red", text: lv === "missing" ? t("core.today.tokenMissing") : lv === "expired" ? t("core.today.tokenExpired") : t("core.today.tokenError"), cta: t("core.today.fixToken"), href: "/connections", category: t("core.today.catMeta") });
      else if (lv === "warning") tasks.push({ tone: "amber", text: t("core.today.tokenWarning"), cta: t("core.today.view"), href: "/connections", category: t("core.today.catMeta") });
    }
    if (r.hotLeads) tasks.push({ tone: "red", text: t("core.today.hotLeads", { n: r.hotLeads }), cta: t("core.today.reply"), href: `${base}/messages?f=hot`, category: t("core.today.catMessages") });
    if (failedBy.get(r.id)) tasks.push({ tone: "red", text: t("core.today.jobsFailed"), cta: t("core.today.view"), href: base, category: t("core.today.catJobs") });

    // To do (yellow)
    if (r.cprVsTarget != null && r.cprVsTarget > 0.15)
      tasks.push({ tone: "amber", text: t("core.today.cprHigh", { pct: pct(r.cprVsTarget * 100, 0) }), cta: t("core.today.viewReport"), href: `${base}/campaigns`, category: t("core.today.catCost") });
    if (isMeta && r.lastSyncedAt && Date.now() - r.lastSyncedAt.getTime() > 3 * DAY)
      tasks.push({ tone: "amber", text: t("core.today.staleData", { n: Math.floor((Date.now() - r.lastSyncedAt.getTime()) / DAY) }), cta: t("core.today.update"), href: base, category: t("core.today.catData") });
    for (const s of p.steps.filter((x) => x.state === "stale" && x.key !== "collect" && x.key !== "optimize").slice(0, 2))
      tasks.push({ tone: "amber", text: `${s.label}: ${s.detail}`, cta: s.action ?? t("core.today.open"), href: s.href, category: t("core.today.catProcess") });
    if (!r.pending && p.current && p.current.state !== "done" && ["analyze", "audience", "plan"].includes(p.current.key) && !p.steps.some((x) => x.key === p.current!.key && x.state === "stale"))
      tasks.push({ tone: "amber", text: t("core.today.nextStep", { label: p.current.label, detail: p.current.detail }), cta: p.current.action ?? t("core.today.open"), href: p.current.href, category: t("core.today.catProcess") });
    const d = draftsBy.get(r.id);
    if (d) tasks.push({ tone: "amber", text: t("core.today.drafts", { n: d }), cta: t("core.today.open"), href: `${base}/drafts`, category: t("core.today.catDrafts") });
    if (isMeta && r.activeCampaigns > 0 && !r.spend) tasks.push({ tone: "amber", text: t("core.today.noSpend"), cta: t("core.today.view"), href: base, category: t("core.today.catCampaign") });

    // Suggestion (green)
    if (isMeta && c && c.targetCpr == null && r.targetCpr) tasks.push({ tone: "green", text: t("core.today.noTarget"), cta: t("core.today.set"), href: `${base}/settings`, category: t("core.today.catTarget") });

    tasks.sort((a, b) => RANK[a.tone] - RANK[b.tone]);
    const health: Tone = tasks.some((t) => t.tone === "red") ? "red" : tasks.some((t) => t.tone === "amber") ? "amber" : "green";
    return {
      id: r.id,
      name: r.name,
      industry: r.industry,
      currency: r.currency,
      activeCampaigns: r.activeCampaigns,
      spend: r.spend,
      results: r.results,
      resultLabel: r.primaryResult,
      cpr: r.cpr,
      health,
      tasks: tasks.slice(0, 5),
      pipeline: p,
      spark: daily.filter((x) => x.clientId === r.id).slice(-14).map((x) => x.spend),
    };
  });
  list.sort((a, b) => RANK[a.health] - RANK[b.health] || a.name.localeCompare(b.name, "vi"));
  return { rows, list };
}
