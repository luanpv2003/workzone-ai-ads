import type { ReportSchedule } from "@prisma/client";
import { getT } from "@/i18n/server";
import { db } from "./db";
import { errorMessage, logActivity } from "./activity";
import { createClientReport, sendClientReport, sendSummary } from "./client-report";
import { createDailyReport } from "./client-daily-report";
import { isScheduleDue, kindLabel, timeLabel, toKind, toView, type ScheduleView } from "./report-schedule";

// Run report schedules (ReportSchedule table). The background job calls runDueReports() every minute.

const WHO = "Lịch tự động"; // stored as the report creator and compared in runSchedule: a data marker, kept as is

export async function loadSchedules(clientId: string): Promise<ScheduleView[]> {
  const rows = await db.reportSchedule.findMany({ where: { clientId }, orderBy: [{ hour: "asc" }, { minute: "asc" }, { createdAt: "asc" }] });
  return rows.map(toView);
}

/** Build the report for the schedule's type; if auto-send is on, send to the schedule's recipients (empty = all). */
export async function runSchedule(s: ReportSchedule, by = WHO, send = s.autoSend) {
  const kind = toKind(s.kind);
  const trigger = by === WHO ? "schedule" : "manual";
  const report =
    kind === "daily" || kind === "today" ? await createDailyReport(s.clientId, trigger, by, kind === "today") : await createClientReport(s.clientId, Number(kind), trigger, by);
  if (!send) return { report, sent: null, error: null };
  try {
    const v = toView(s);
    return { report, sent: await sendClientReport(report.id, by, v.targets ?? undefined), error: null };
  } catch (err) {
    return { report, sent: null, error: errorMessage(err) };
  }
}

/** Due schedules (all clients). Marked as run before building so they don't run twice if this run is interrupted. */
export async function runDueReports(at = new Date()): Promise<string[]> {
  const t = await getT();
  const rows = await db.reportSchedule.findMany({ where: { active: true }, include: { client: { select: { id: true, name: true, timezone: true } } } });
  const out: string[] = [];
  for (const s of rows) {
    if (!isScheduleDue(s, s.client.timezone, at)) continue;
    await db.reportSchedule.update({ where: { id: s.id }, data: { lastRunAt: at } });
    const label = t("notify.report.runLabel", { kind: kindLabel(s.kind, t), time: timeLabel(s) });
    let result: string;
    try {
      const { report, sent, error } = await runSchedule(s);
      const range = `${report.since} → ${report.until}`;
      if (sent) result = t("notify.report.runSent", { range, summary: sendSummary(sent, t) });
      else if (error) result = t("notify.report.runSendFailed", { range, error });
      else result = t("notify.report.runAwaiting", { range });
      await logActivity(s.clientId, error ? "error" : "report", t("notify.report.runLog", { label, result }));
    } catch (err) {
      result = t("notify.report.runBuildFailed", { error: errorMessage(err) });
      await logActivity(s.clientId, "error", t("notify.report.runLog", { label, result }));
    }
    await db.reportSchedule.update({ where: { id: s.id }, data: { lastResult: result.slice(0, 500) } });
    out.push(`${s.client.name} · ${label}: ${result}`);
  }
  return out;
}
