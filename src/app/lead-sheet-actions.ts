"use server";

import { revalidatePath } from "next/cache";
import { requireClient } from "@/lib/access";
import { getT } from "@/i18n/server";
import { errorMessage, logActivity } from "@/lib/activity";
import { db } from "@/lib/db";
import { createSheetKey, revokeSheetKey, saveFeedback, sinceToDate, type Feedback } from "@/lib/lead-sheet";
import type { ActionResult } from "./actions";

// Lead list (Form + Messages): sales ratings entered manually on the web, and the Google Sheet link.

async function run(fn: () => Promise<void>): Promise<ActionResult> {
  try {
    await fn();
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (err) {
    console.error(err);
    return { ok: false, error: errorMessage(err) };
  }
}

/** Sales rates a lead right on the web (the next Google Sheet sync gets the new value). */
export async function saveFeedbackAction(clientId: string, key: string, patch: Partial<Feedback>) {
  return run(async () => {
    const { user: u } = await requireClient(clientId, "edit");
    await saveFeedback(clientId, [{ key, ...patch }], "web", u.name);
  });
}

/** Create or rotate the Google Sheet link (the old link stops working). The link exposes customer phone numbers, so Full access is required. */
export async function createSheetLinkAction(clientId: string) {
  return run(async () => {
    await requireClient(clientId, "manage");
    await createSheetKey(clientId);
    await logActivity(clientId, "pii", (await getT())("customers.leadSheetActions.linkCreated"));
  });
}

export async function revokeSheetLinkAction(clientId: string) {
  return run(async () => {
    await requireClient(clientId, "manage");
    await revokeSheetKey(clientId);
    await logActivity(clientId, "pii", (await getT())("customers.leadSheetActions.linkRevoked"));
  });
}

/** Start date for syncing to Google Sheet (YYYY-MM-DD, Vietnam time); empty = all leads. */
export async function setSheetSinceAction(clientId: string, day: string) {
  return run(async () => {
    const t = await getT();
    await requireClient(clientId, "manage");
    const d = day.trim();
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(t("customers.leadSheetActions.badDate"));
    await db.client.update({ where: { id: clientId }, data: { sheetSince: d ? sinceToDate(d) : null } });
    await logActivity(clientId, "sheet", d ? t("customers.leadSheetActions.sinceFrom", { date: d.split("-").reverse().join("/") }) : t("customers.leadSheetActions.sinceAll"));
  });
}
