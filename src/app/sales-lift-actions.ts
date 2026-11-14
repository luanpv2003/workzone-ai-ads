"use server";

import { revalidatePath } from "next/cache";
import type { SalesLift } from "@prisma/client";
import { requireClient, requireClientOf } from "@/lib/access";
import { errorMessage, logActivity } from "@/lib/activity";
import { db } from "@/lib/db";
import { addDays, isDay } from "@/lib/sales-lift-calc";
import { ensureLiftMeta, liftDefaults } from "@/lib/sales-lift";
import type { ActionResult } from "./actions";
import { getT } from "@/i18n/server";

// Sales lift by SKU (Campaigns → Lift by SKU): create a measurement with prefilled suggestions, user edits, re-read Meta numbers, delete.
// Only reads Meta and KiotViet, changes nothing on the ads.

async function run(clientId: string, fn: () => Promise<string | void>): Promise<ActionResult> {
  try {
    const id = await fn();
    revalidatePath(`/clients/${clientId}/lift`, "layout");
    return { ok: true, id: id ?? undefined };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** Check permission + load the measurement inside try: missing permission / not found returns { ok: false } instead of throwing to the error page. */
async function runLift(liftId: string, fn: (lift: SalesLift) => Promise<string | void>): Promise<ActionResult> {
  let lift: SalesLift;
  try {
    await requireClientOf("salesLift", liftId, "edit");
    lift = await db.salesLift.findUniqueOrThrow({ where: { id: liftId } });
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
  return run(lift.clientId, () => fn(lift));
}

export async function createLiftAction(clientId: string, input: { level: "campaign" | "ad"; objectId: string }): Promise<ActionResult> {
  return run(clientId, async () => {
    const t = await getT();
    await requireClient(clientId, "edit");
    const client = await db.client.findUniqueOrThrow({ where: { id: clientId } });
    if (!client.kiotSecret) throw new Error(t("settings.liftActions.noKiot"));
    const obj =
      input.level === "ad"
        ? await db.ad.findFirst({ where: { id: input.objectId, clientId }, select: { name: true, campaign: { select: { name: true } } } }).then((a) => a && { name: `${a.name} · ${a.campaign.name}` })
        : await db.campaign.findFirst({ where: { id: input.objectId, clientId }, select: { name: true } });
    if (!obj) throw new Error(t("settings.liftActions.notFound"));
    const d = await liftDefaults(client, input.level, input.objectId);
    const lift = await db.salesLift.create({
      data: {
        clientId,
        name: obj.name,
        level: input.level,
        objectId: input.objectId,
        objectName: obj.name,
        testIds: JSON.stringify(d.testIds),
        controlIds: JSON.stringify(d.controlIds),
        runStart: d.runStart,
        baseStart: d.baseStart,
        baseEnd: d.baseEnd,
        branchWords: d.branchWords,
        note: d.note,
      },
    });
    await logActivity(clientId, "sales_lift", t("settings.liftActions.created", { name: obj.name, test: d.testIds.length, control: d.controlIds.length }));
    return lift.id;
  });
}

export type LiftInput = {
  name: string;
  runStart: string;
  runEnd: string; // "" = through yesterday
  baseStart: string;
  baseEnd: string;
  testIds: string[];
  controlIds: string[];
  branchWords: string;
  manualSpend: string; // "" = read from Meta
  manualOrders: string; // "" = count automatically
};

export async function saveLiftAction(liftId: string, input: LiftInput): Promise<ActionResult> {
  return runLift(liftId, async (lift) => {
    const t = await getT();
    for (const [k, v] of [
      [t("settings.liftActions.runStart"), input.runStart],
      [t("settings.liftActions.baseStart"), input.baseStart],
      [t("settings.liftActions.baseEnd"), input.baseEnd],
    ] as const)
      if (!isDay(v)) throw new Error(t("settings.liftActions.invalid", { label: k }));
    if (input.runEnd && !isDay(input.runEnd)) throw new Error(t("settings.liftActions.invalid", { label: t("settings.liftActions.runEnd") }));
    if (input.baseStart > input.baseEnd) throw new Error(t("settings.liftActions.baseOrder"));
    if (input.runEnd && input.runStart > input.runEnd) throw new Error(t("settings.liftActions.runOrder"));
    if (input.baseEnd >= input.runStart) throw new Error(t("settings.liftActions.baseBeforeRun", { latest: addDays(input.runStart, -1) }));
    const test = [...new Set(input.testIds)];
    const control = [...new Set(input.controlIds)].filter((id) => !test.includes(id));
    const num = (s: string, label: string) => {
      const cleaned = s.replace(/[.\s₫đ]/g, "").replace(",", ".");
      if (!cleaned) return null;
      const n = Number(cleaned);
      if (!Number.isFinite(n) || n < 0) throw new Error(t("settings.liftActions.invalid", { label }));
      return n;
    };
    const orders = num(input.manualOrders, t("settings.liftActions.orderComments"));
    await db.salesLift.update({
      where: { id: liftId },
      data: {
        name: input.name.trim() || lift.objectName,
        runStart: input.runStart,
        runEnd: input.runEnd || null,
        baseStart: input.baseStart,
        baseEnd: input.baseEnd,
        testIds: JSON.stringify(test),
        controlIds: JSON.stringify(control),
        branchWords: input.branchWords.trim(),
        manualSpend: num(input.manualSpend, t("settings.liftActions.spend")),
        manualOrders: orders == null ? null : Math.round(orders),
      },
    });
  });
}

/** Re-suggest everything (periods, ad SKUs, control SKUs, base keywords) — overwrites edits. */
export async function resuggestLiftAction(liftId: string): Promise<ActionResult> {
  return runLift(liftId, async (lift) => {
    const client = await db.client.findUniqueOrThrow({ where: { id: lift.clientId } });
    const d = await liftDefaults(client, lift.level as "campaign" | "ad", lift.objectId);
    await db.salesLift.update({
      where: { id: liftId },
      data: { testIds: JSON.stringify(d.testIds), controlIds: JSON.stringify(d.controlIds), runStart: d.runStart, runEnd: null, baseStart: d.baseStart, baseEnd: d.baseEnd, branchWords: d.branchWords, note: d.note, metaCache: "{}" },
    });
  });
}

/** The run period starts on the first day with spend (Meta). If the baseline period overlaps the run period it shifts back, keeping its length. */
export async function applyFirstSpendAction(liftId: string, day: string): Promise<ActionResult> {
  return runLift(liftId, async (lift) => {
    if (!isDay(day)) throw new Error((await getT())("settings.liftActions.badDay"));
    const len = Math.round((Date.parse(lift.baseEnd) - Date.parse(lift.baseStart)) / 86400_000);
    const baseEnd = lift.baseEnd >= day ? addDays(day, -1) : lift.baseEnd;
    await db.salesLift.update({ where: { id: liftId }, data: { runStart: day, baseEnd, baseStart: lift.baseEnd >= day ? addDays(baseEnd, -len) : lift.baseStart } });
  });
}

export async function refreshLiftMetaAction(liftId: string): Promise<ActionResult> {
  return runLift(liftId, async (lift) => {
    const client = await db.client.findUniqueOrThrow({ where: { id: lift.clientId } });
    const c = await ensureLiftMeta(lift, client, true);
    if (c.error) throw new Error(c.error);
  });
}

export async function deleteLiftAction(liftId: string): Promise<ActionResult> {
  return runLift(liftId, async (lift) => {
    const t = await getT();
    await db.salesLift.delete({ where: { id: liftId } });
    await logActivity(lift.clientId, "sales_lift", t("settings.liftActions.deleted", { name: lift.name }));
    return "deleted";
  });
}
