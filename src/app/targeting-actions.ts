"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { requirePlatformStaff } from "@/lib/access";
import { errorMessage, logActivity } from "@/lib/activity";
import { enqueueRun, runLabel, scanAccount, type RunKind } from "@/lib/targeting-crawl";
import { encrypt } from "@/lib/crypto";
import { cleanToken, inspectToken } from "@/lib/meta/inspect";
import { searchMetaLive, type LiveHit } from "@/lib/targeting-resolve";
import { formatSize, typeLabel } from "@/lib/targeting";
import { getT } from "@/i18n/server";

export type LiveHitView = LiveHit & { typeLabel: string; size: string };

type Result = { ok: true } | { ok: false; error: string };

async function guard(fn: () => Promise<void>): Promise<Result> {
  try {
    await fn();
    revalidatePath("/targeting");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** Queue an update run; the background process (targeting-worker) will run it. */
export async function startTargetingRunAction(kind: RunKind, params: Record<string, unknown>): Promise<Result> {
  return guard(async () => {
    const user = await requirePlatformStaff();
    const t = await getT();
    if (!["catalog", "expand", "reach", "find"].includes(kind)) throw new Error(t("targeting.targetingActions.badKind"));
    const clean =
      kind === "expand"
        ? {
            seedSetIds: Array.isArray(params.seedSetIds) ? params.seedSetIds.map(String) : [],
            rounds: Math.min(5, Math.max(1, Number(params.rounds) || 2)),
            maxCalls: Math.min(10000, Math.max(100, Number(params.maxCalls) || 3000)),
          }
        : kind === "reach"
          ? { scope: ["new", "weekly", "all"].includes(String(params.scope)) ? String(params.scope) : "weekly" }
          : kind === "find"
            ? { scope: ["unchecked", "priority", "all"].includes(String(params.scope)) ? String(params.scope) : "unchecked", maxCalls: Math.min(20000, Math.max(200, Number(params.maxCalls) || 8000)) }
            : {};
    await scanAccount(); // throws right away if there's no scan account yet
    const run = await enqueueRun(kind, clean, user.name);
    await logActivity(null, "sync", t("targeting.targetingActions.logQueued", { label: runLabel(t, kind), id: run.id.slice(-6) }));
  });
}

export async function cancelTargetingRunAction(id: string): Promise<Result> {
  return guard(async () => {
    await requirePlatformStaff();
    const r = await db.targetingRun.updateMany({ where: { id, status: { in: ["queued", "running"] } }, data: { status: "cancelled" } });
    if (!r.count) throw new Error((await getT())("targeting.targetingActions.runEnded"));
  });
}

export async function saveSeedSetAction(input: { id?: string; name: string; keywords: string; active: boolean }): Promise<Result> {
  return guard(async () => {
    await requirePlatformStaff();
    const name = input.name.trim();
    const keywords = [...new Set(input.keywords.split(/\n|,/).map((k) => k.trim()).filter(Boolean))];
    if (!name) throw new Error((await getT())("targeting.targetingActions.noIndustryName"));
    if (!keywords.length) throw new Error((await getT())("targeting.targetingActions.needKeyword"));
    if (keywords.length > 300) throw new Error((await getT())("targeting.targetingActions.maxKeywords"));
    const data = { name, keywords: JSON.stringify(keywords), active: input.active };
    if (input.id) await db.targetingSeedSet.update({ where: { id: input.id }, data });
    else await db.targetingSeedSet.create({ data });
  });
}

export async function deleteSeedSetAction(id: string): Promise<Result> {
  return guard(async () => {
    await requirePlatformStaff();
    await db.targetingSeedSet.delete({ where: { id } });
  });
}

export async function saveTargetingSettingsAction(input: { scanClientId: string; autoUpdate: boolean }): Promise<Result> {
  return guard(async () => {
    await requirePlatformStaff();
    const set = (key: string, value: string) => db.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
    if (input.scanClientId) {
      const c = await db.client.findUnique({ where: { id: input.scanClientId } });
      if (!c?.metaAccessToken || !c.metaAdAccountId) throw new Error((await getT())("targeting.targetingActions.clientNoToken"));
      await set("targeting.scanClientId", input.scanClientId);
    } else await db.setting.deleteMany({ where: { key: "targeting.scanClientId" } });
    await set("targeting.autoUpdate", input.autoUpdate ? "on" : "off");
  });
}

/** Save the agency's own API for targeting scans: verify the token + permissions on the ad account before saving (encrypted). */
export async function saveScanApiAction(input: { act: string; token: string }): Promise<Result & { owner?: string }> {
  try {
    const user = await requirePlatformStaff();
    const t = await getT();
    const raw = input.act.trim().replace(/\s/g, "");
    if (!/^(act_)?\d{5,}$/.test(raw)) throw new Error(t("targeting.targetingActions.badActId"));
    const act = raw.startsWith("act_") ? raw : `act_${raw}`;
    const token = cleanToken(input.token);
    if (!token) throw new Error(t("targeting.targetingActions.noToken"));
    const info = await inspectToken(token);
    if (!info.adAccounts.some((a) => a.id === act)) {
      throw new Error(t("targeting.targetingActions.noAccess", { user: info.userName, act }));
    }
    const lacking = ["ads_read", "ads_management"].every((p) => info.missingPermissions.includes(p));
    if (lacking) throw new Error(t("targeting.targetingActions.needPermission"));
    const set = (key: string, value: string) => db.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
    await set("targeting.scanAct", act);
    await set("targeting.scanToken", encrypt(token));
    await set("targeting.scanOwner", info.userName);
    await set("targeting.scanExpiresAt", info.expiresAt ?? "");
    await logActivity(null, "sync", t("targeting.targetingActions.logSetApi", { user: user.name, act, owner: info.userName }));
    revalidatePath("/targeting");
    return { ok: true, owner: info.userName };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function clearScanApiAction(): Promise<Result> {
  return guard(async () => {
    const user = await requirePlatformStaff();
    await db.setting.deleteMany({ where: { key: { in: ["targeting.scanAct", "targeting.scanToken", "targeting.scanOwner", "targeting.scanExpiresAt"] } } });
    await logActivity(null, "sync", (await getT())("targeting.targetingActions.logClearApi", { user: user.name }));
  });
}

/** Search Meta directly (Ads Manager search box) when the Library doesn't have it; usable items are added to the Library automatically. */
export async function searchMetaTargetingAction(q: string): Promise<{ ok: true; hits: LiveHitView[] } | { ok: false; error: string }> {
  try {
    const user = await requireUser();
    const t = await getT();
    const query = q.trim();
    if (query.length < 2) throw new Error(t("targeting.targetingActions.minChars"));
    const hits = await searchMetaLive(query);
    const added = hits.filter((h) => h.isNew).length;
    if (added) await logActivity(null, "sync", t("targeting.targetingActions.logSearch", { user: user.name, query, added }));
    revalidatePath("/targeting");
    return { ok: true, hits: hits.map((h) => ({ ...h, typeLabel: typeLabel(t, h.type), size: formatSize(null, h.globalHi) })) };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
