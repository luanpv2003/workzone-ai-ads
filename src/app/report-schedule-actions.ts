"use server";

import { revalidatePath } from "next/cache";
import { requireClient, requireClientOf } from "@/lib/access";
import { errorMessage, logActivity } from "@/lib/activity";
import { db, isDbBusy } from "@/lib/db";
import { cleanInput, kindLabel, MAX_SCHEDULES, repeatLabel, timeLabel, type ScheduleInput } from "@/lib/report-schedule";
import { runSchedule } from "@/lib/report-schedule-run";
import type { ActionResult } from "./actions";
import { getT } from "@/i18n/server";
import type { T } from "@/i18n/translate";

// Client report schedules (Notifications & reports → Report schedule): add / edit / delete / toggle / test run.

async function run(fn: () => Promise<string | void>): Promise<ActionResult> {
  try {
    const id = await fn();
    revalidatePath("/", "layout");
    return { ok: true, ...(id && { id }) };
  } catch (err) {
    console.error(err);
    if (isDbBusy(err)) return { ok: false, error: (await getT())("notify.actions.busy") };
    return { ok: false, error: errorMessage(err) };
  }
}

const describe = (v: ScheduleInput, t: T) => t("notify.scheduleActions.describe", { kind: kindLabel(v.kind, t), repeat: repeatLabel(v, t), time: timeLabel(v), mode: v.autoSend ? t("notify.scheduleActions.autoSend") : t("notify.scheduleActions.awaiting") });

/** Add (id = null) or edit a schedule. */
export async function saveReportScheduleAction(clientId: string, id: string | null, input: ScheduleInput) {
  return run(async () => {
    await requireClient(clientId, "edit");
    const t = await getT();
    const v = cleanInput(input, t);
    const data = {
      kind: v.kind,
      repeat: v.repeat,
      days: JSON.stringify(v.days),
      hour: v.hour,
      minute: v.minute,
      autoSend: v.autoSend,
      targets: v.targets ? JSON.stringify(v.targets) : "",
      active: v.active,
    };
    if (id) {
      const old = await db.reportSchedule.findUniqueOrThrow({ where: { id } });
      if (old.clientId !== clientId) throw new Error(t("notify.scheduleActions.notOwner"));
      await db.reportSchedule.update({ where: { id }, data });
      await logActivity(clientId, "report", t("notify.scheduleActions.edited", { d: describe(v, t) }));
      return id;
    }
    if ((await db.reportSchedule.count({ where: { clientId } })) >= MAX_SCHEDULES) throw new Error(t("notify.scheduleActions.max", { max: MAX_SCHEDULES }));
    const row = await db.reportSchedule.create({ data: { clientId, ...data } });
    await logActivity(clientId, "report", t("notify.scheduleActions.added", { d: describe(v, t) }));
    return row.id;
  });
}

export async function deleteReportScheduleAction(id: string) {
  return run(async () => {
    await requireClientOf("reportSchedule", id, "edit");
    const s = await db.reportSchedule.delete({ where: { id } });
    const t = await getT();
    await logActivity(s.clientId, "report", t("notify.scheduleActions.deleted", { kind: kindLabel(s.kind, t), time: timeLabel(s) }));
  });
}

export async function toggleReportScheduleAction(id: string, active: boolean) {
  return run(async () => {
    await requireClientOf("reportSchedule", id, "edit");
    const s = await db.reportSchedule.update({ where: { id }, data: { active } });
    const t = await getT();
    await logActivity(s.clientId, "report", t(active ? "notify.scheduleActions.on" : "notify.scheduleActions.off", { kind: kindLabel(s.kind, t), time: timeLabel(s) }));
  });
}

/** Generate a report now using the schedule's type, for preview. Not sent to the client, not counted as a schedule run. */
export async function runReportScheduleNowAction(id: string) {
  return run(async () => {
    const { user: u } = await requireClientOf("reportSchedule", id, "edit");
    const s = await db.reportSchedule.findUniqueOrThrow({ where: { id } });
    const { report } = await runSchedule(s, u.name, false);
    const t = await getT();
    await logActivity(s.clientId, "report", t("notify.scheduleActions.testRun", { kind: kindLabel(s.kind, t), time: timeLabel(s), since: report.since, until: report.until }));
    return report.id;
  });
}
