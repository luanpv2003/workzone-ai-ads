"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { getT } from "@/i18n/server";
import { requireClient, requireClientOf } from "@/lib/access";
import { errorMessage } from "@/lib/activity";
import { cleanAutoTargets } from "@/lib/auto-rules-config";
import { runAutoRules } from "@/lib/auto-rules";
import { undoRecommendation } from "@/lib/recommendations";
import { deliver, type NotifyTarget } from "@/lib/lead-notify";
import { renderNotice } from "@/lib/notify-templates";
import { globalTemplates } from "@/lib/notify-templates-db";
import { publicUrl } from "@/lib/zalo";

type Result = { ok: true; text?: string } | { ok: false; error: string };

/** Send a test automatic notification ("autoAction" template, sample data) to the internal recipients. */
export async function testAutoNotifyAction(clientId: string, targets: NotifyTarget[]): Promise<Result> {
  try {
    const t = await getT();
    await requireClient(clientId, "edit");
    const list = cleanAutoTargets(targets);
    if (!list.length) throw new Error(t("customers.autoActions.noTargets"));
    const c = await db.client.findUniqueOrThrow({ where: { id: clientId }, select: { name: true, timezone: true } });
    const text = renderNotice(
      "autoAction",
      {
        khach_hang: c.name,
        thoi_gian: new Date().toLocaleString("vi-VN", { timeZone: c.timezone, hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }),
        viec_da_lam: t("customers.autoActions.testSample"),
        link_hoan_tac: `${publicUrl()}/clients/${clientId}/recommendations`,
      },
      undefined,
      await globalTemplates(),
      t,
    );
    const res = await deliver(list, text);
    const bad = res.filter((r) => !r.ok);
    if (bad.length === res.length) throw new Error(bad.map((b) => b.error).join("; "));
    return { ok: true, text: bad.length ? t("customers.autoActions.partialSent", { ok: res.length - bad.length, total: res.length, errors: bad.map((b) => b.error).join("; ") }) : t("customers.autoActions.testSent", { n: res.length }) };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** Run the automatic check now (without waiting for the hourly run). */
export async function runAutoNowAction(clientId: string): Promise<Result> {
  try {
    const t = await getT();
    await requireClient(clientId, "edit");
    const r = await runAutoRules(clientId);
    revalidatePath(`/clients/${clientId}`, "layout");
    if (!r) return { ok: false, error: t("customers.autoActions.off") };
    const c = await db.client.findUniqueOrThrow({ where: { id: clientId }, select: { autoMode: true } });
    return { ok: true, text: r.done.length ? t("customers.autoActions.ranWithActions", { mode: t(c.autoMode === "dryrun" ? "customers.autoActions.dryRun" : "customers.autoActions.done"), n: r.done.length }) : t("customers.autoActions.ranNothing", { n: r.checked }) };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** Undo a disable / budget change that was applied. */
export async function undoRecommendationAction(recId: string): Promise<Result> {
  try {
    await requireClientOf("recommendation", recId, "edit");
    await undoRecommendation(recId);
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
