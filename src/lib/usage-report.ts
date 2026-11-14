import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { db } from "./db";
import type { T } from "@/i18n/translate";

// System usage summary (System settings → Usage tab): Claude, background jobs, data storage.
// Meta API usage is read separately from lib/meta/rate-limit.ts (readUsage).

const HOUR = 3600_000;
const DAY = 24 * HOUR;

type Agg = { calls: number; failed: number; input: number; output: number; ms: number };
const empty = (): Agg => ({ calls: 0, failed: 0, input: 0, output: 0, ms: 0 });
const addTo = (a: Agg, r: { ok: boolean; inputTokens: number; outputTokens: number; ms: number }) => {
  a.calls++;
  if (!r.ok) a.failed++;
  a.input += r.inputTokens;
  a.output += r.outputTokens;
  a.ms += r.ms;
  return a;
};

/** Midnight today in VN time. */
function startOfTodayVN(now = new Date()) {
  const vn = new Date(now.getTime() + 7 * HOUR);
  vn.setUTCHours(0, 0, 0, 0);
  return new Date(vn.getTime() - 7 * HOUR);
}
const dayKeyVN = (d: Date) => new Date(d.getTime() + 7 * HOUR).toISOString().slice(0, 10);

function dirSize(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : statSync(p).size;
  }
  return total;
}

function dbFileSize() {
  const url = process.env.DATABASE_URL ?? "";
  const rel = url.replace(/^file:/, "");
  if (!rel) return null;
  const file = path.isAbsolute(rel) ? rel : path.join(process.cwd(), "prisma", rel.replace(/^\.\//, ""));
  try {
    return statSync(file).size + (existsSync(`${file}-wal`) ? statSync(`${file}-wal`).size : 0);
  } catch {
    return null;
  }
}

export async function usageReport(t: T) {
  const now = new Date();
  const since30 = new Date(now.getTime() - 30 * DAY);
  const [rows, clients, jobs, runs] = await Promise.all([
    db.aiUsage.findMany({ where: { at: { gt: since30 } }, orderBy: { at: "desc" } }),
    db.client.findMany({ select: { id: true, name: true } }),
    db.clientJob.findMany({ where: { createdAt: { gt: new Date(now.getTime() - 7 * DAY) } }, select: { kind: true, status: true, startedAt: true, finishedAt: true, client: { select: { name: true } } } }),
    db.targetingRun.findMany({ where: { createdAt: { gt: new Date(now.getTime() - 7 * DAY) } }, select: { kind: true, status: true, progress: true, startedAt: true, finishedAt: true } }),
  ]);
  const clientName = new Map(clients.map((c) => [c.id, c.name.split(" – ")[0]]));

  const today = startOfTodayVN(now);
  const P5 = t("system.usage.period5h");
  const PDAY = t("system.usage.periodToday");
  const P7 = t("system.usage.period7d");
  const P30 = t("system.usage.period30d");
  const periods = {
    [P5]: empty(),
    [PDAY]: empty(),
    [P7]: empty(),
    [P30]: empty(),
  };
  const byTask = new Map<string, Agg>();
  const byClient = new Map<string, Agg>();
  const byDay = new Map<string, Agg>();
  for (const r of rows) {
    const ms = r.at.getTime();
    if (ms > now.getTime() - 5 * HOUR) addTo(periods[P5], r);
    if (ms >= today.getTime()) addTo(periods[PDAY], r);
    if (ms > now.getTime() - 7 * DAY) addTo(periods[P7], r);
    addTo(periods[P30], r);
    addTo(byTask.get(r.task) ?? byTask.set(r.task, empty()).get(r.task)!, r);
    const ck = r.clientId ? (clientName.get(r.clientId) ?? t("system.usage.clientDeleted")) : t("system.usage.noClient");
    addTo(byClient.get(ck) ?? byClient.set(ck, empty()).get(ck)!, r);
    const dk = dayKeyVN(r.at);
    addTo(byDay.get(dk) ?? byDay.set(dk, empty()).get(dk)!, r);
  }
  const days: { day: string; agg: Agg }[] = [];
  for (let i = 13; i >= 0; i--) {
    const k = dayKeyVN(new Date(now.getTime() - i * DAY));
    days.push({ day: k, agg: byDay.get(k) ?? empty() });
  }

  // Background jobs over 7 days
  const jobBy = new Map<string, { count: number; failed: number; ms: number; done: number }>();
  for (const j of jobs) {
    const x = jobBy.get(j.kind) ?? { count: 0, failed: 0, ms: 0, done: 0 };
    x.count++;
    if (j.status === "failed") x.failed++;
    if (j.startedAt && j.finishedAt) {
      x.ms += j.finishedAt.getTime() - j.startedAt.getTime();
      x.done++;
    }
    jobBy.set(j.kind, x);
  }
  const runBy = new Map<string, { count: number; calls: number; failed: number }>();
  for (const r of runs) {
    const x = runBy.get(r.kind) ?? { count: 0, calls: 0, failed: 0 };
    x.count++;
    if (r.status === "failed") x.failed++;
    try {
      x.calls += Number((JSON.parse(r.progress || "{}") as { calls?: number }).calls) || 0;
    } catch {}
    runBy.set(r.kind, x);
  }

  const sort = (m: Map<string, Agg>) => [...m].sort((a, b) => b[1].input + b[1].output - (a[1].input + a[1].output));
  return {
    since: rows.at(-1)?.at ?? null,
    periods: Object.entries(periods),
    byTask: sort(byTask),
    byClient: sort(byClient),
    days,
    recent: rows.slice(0, 25).map((r) => ({ ...r, client: r.clientId ? (clientName.get(r.clientId) ?? null) : null })),
    jobs: [...jobBy].sort((a, b) => b[1].count - a[1].count),
    runs: [...runBy],
    storage: { db: dbFileSize(), uploads: dirSize(path.join(process.cwd(), "data", "uploads")), knowledge: dirSize(path.join(process.cwd(), "data", "knowledge")) },
  };
}
