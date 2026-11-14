"use server";

import { revalidatePath } from "next/cache";
import { requireClient } from "@/lib/access";
import { errorMessage, logActivity } from "@/lib/activity";
import { encrypt } from "@/lib/crypto";
import { db } from "@/lib/db";
import { kiotCreds, testKiot } from "@/lib/kiotviet";
import { clearKiotData, parseKiotState } from "@/lib/kiotviet-sync";
import type { ActionResult } from "./actions";
import { getT } from "@/i18n/server";

// KiotViet (Client settings → KiotViet): save the connection after a successful test, request sync, disconnect. KiotViet is read-only.

type TestResult = { ok: true; branches: string[]; customers: number; invoices: number } | { ok: false; error: string };

/**
 * Test the connection then save. Empty Secret = keep the stored Secret (only change store name / Client ID / number of months).
 * Changing the store deletes old sales data and pulls again from scratch.
 */
export async function saveKiotAction(clientId: string, input: { retailer: string; clientId: string; secret: string; months: number }): Promise<TestResult> {
  const t = await getT();
  try {
    await requireClient(clientId, "manage");
    // The store name is the login code (the part before .kiotviet.vn), not the display name: pasted links are accepted too.
    const retailer = input.retailer
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\.kiotviet\.vn.*$/, "");
    const kvClientId = input.clientId.trim();
    const months = Math.min(24, Math.max(1, Math.round(input.months) || 12));
    if (!retailer || !kvClientId) throw new Error(t("settings.kiotActions.needStoreAndId"));
    if (!/^[a-z0-9-]+$/.test(retailer)) {
      throw new Error(
        t("settings.kiotActions.displayName", { name: input.retailer.trim() }),
      );
    }
    const old = await db.client.findUniqueOrThrow({ where: { id: clientId }, select: { kiotRetailer: true, kiotClientId: true, kiotSecret: true, kiotMonths: true, kiotState: true } });
    const secret = input.secret.trim() || (old.kiotSecret ? kiotCreds(old)?.secret : "") || "";
    if (!secret) throw new Error(t("settings.kiotActions.needSecret"));
    const r = await testKiot({ retailer, clientId: kvClientId, secret });
    const changed = old.kiotRetailer !== retailer;
    if (changed) await clearKiotData(clientId);
    await db.client.update({
      where: { id: clientId },
      data: {
        kiotRetailer: retailer,
        kiotClientId: kvClientId,
        kiotSecret: encrypt(secret),
        kiotMonths: months,
        kiotSyncError: null,
        kiotRequestAt: new Date(),
        // Store changed: pull again from scratch. Months changed: recompute the backfill start (already-pulled data is kept).
        ...(changed ? { kiotState: "{}", kiotSyncAt: null } : old.kiotMonths !== months && { kiotState: JSON.stringify({ ...parseKiotState(old.kiotState), target: undefined }) }),
      },
    });
    await logActivity(clientId, "kiotviet", t("settings.kiotActions.connected", { retailer, branches: r.branches.length, customers: r.customers.toLocaleString("vi-VN"), invoices: r.invoices.toLocaleString("vi-VN") }));
    revalidatePath(`/clients/${clientId}`, "layout");
    return { ok: true, ...r };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** Sync now: the background process picks it up within about 1 minute. */
export async function requestKiotSyncAction(clientId: string): Promise<ActionResult> {
  const t = await getT();
  try {
    await requireClient(clientId, "edit");
    const c = await db.client.findUniqueOrThrow({ where: { id: clientId }, select: { kiotSecret: true } });
    if (!c.kiotSecret) return { ok: false, error: t("settings.kiotActions.notConnected") };
    await db.client.update({ where: { id: clientId }, data: { kiotRequestAt: new Date(), kiotSyncError: null } });
    revalidatePath(`/clients/${clientId}`, "layout");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** Disconnect: delete the secret and all stored sales data (KiotViet itself is unaffected). */
export async function disconnectKiotAction(clientId: string): Promise<ActionResult> {
  const t = await getT();
  try {
    await requireClient(clientId, "manage");
    await clearKiotData(clientId);
    await db.client.update({
      where: { id: clientId },
      data: { kiotRetailer: null, kiotClientId: null, kiotSecret: null, kiotState: "{}", kiotSyncAt: null, kiotSyncError: null, kiotRequestAt: null, kiotRunningAt: null },
    });
    await logActivity(clientId, "kiotviet", t("settings.kiotActions.disconnected"));
    revalidatePath(`/clients/${clientId}`, "layout");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
