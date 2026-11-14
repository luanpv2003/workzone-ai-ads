"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { requireClient, requirePlatformStaff } from "@/lib/access";
import { errorMessage, logActivity } from "@/lib/activity";
import { db } from "@/lib/db";
import { disconnectGoogleAds, formatCustomerId, googleAuthorizeUrl, listMccAccounts, normalizeCustomerId, saveGoogleAdsApp, type GoogleAccount } from "@/lib/google-ads";
import { syncGoogleAds } from "@/lib/google-ads-sync";
import { runGoogleRules } from "@/lib/google-ads-rules";
import { draftAdGroup, executeChange, manualChange, type GChangeParams } from "@/lib/google-ads-write";
import { enqueueClientJob } from "@/lib/client-jobs";
import { requireClientOf } from "@/lib/access";
import { money, num } from "@/lib/format";
import type { ActionResult } from "./actions";
import { getT } from "@/i18n/server";
import type { T } from "@/i18n/translate";

// Google Ads: global connection (System settings, admins) and per-client account linking (Client settings).

async function run(fn: () => Promise<string | void>): Promise<ActionResult> {
  try {
    const id = await fn();
    revalidatePath("/", "layout");
    return { ok: true, ...(id && { id }) };
  } catch (err) {
    console.error(err);
    return { ok: false, error: errorMessage(err) };
  }
}

export async function saveGoogleAdsAppAction(input: { clientId: string; clientSecret: string; developerToken: string; mccId: string }) {
  return run(async () => {
    const t = await getT();
    await requireAdmin();
    await saveGoogleAdsApp(input);
    await logActivity(null, "google", t("settings.googleActions.saved", { mcc: input.mccId.trim() }));
  });
}

/** Return the Google consent page link; the browser opens it, Google redirects back to /api/google-ads/callback. */
export async function googleAuthorizeAction(): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  try {
    await requireAdmin();
    return { ok: true, url: await googleAuthorizeUrl() };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function googleDisconnectAction() {
  return run(async () => {
    const t = await getT();
    await requireAdmin();
    await disconnectGoogleAds();
    await logActivity(null, "google", t("settings.googleActions.disconnected"));
  });
}

/**
 * Accounts under the shared MCC. The MCC is a platform-wide resource: listing it
 * exposes every linked advertiser, so only platform staff may see it (A1).
 */
export async function googleAccountsAction(clientId?: string): Promise<{ ok: true; list: GoogleAccount[] } | { ok: false; error: string }> {
  try {
    await requirePlatformStaff();
    if (clientId) await requireClient(clientId, "manage");
    return { ok: true, list: await listMccAccounts() };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** Link / unlink a Google Ads account for a client. Changing the account deletes the client's old Google data. */
export async function setClientGoogleAccountAction(clientId: string, customerId: string, name: string | null) {
  return run(async () => {
    const t = await getT();
    // A1: binding an MCC account lets the client read and edit that account, so it is
    // limited to platform staff, the account must really sit under the MCC, and one
    // account can belong to only one client.
    await requirePlatformStaff();
    await requireClient(clientId, "manage");
    const id = customerId.trim() ? normalizeCustomerId(customerId) : null;
    if (customerId.trim() && !id) throw new Error(t("settings.googleActions.badCustomerId"));
    const old = await db.client.findUniqueOrThrow({ where: { id: clientId }, select: { googleCustomerId: true } });
    if (old.googleCustomerId === id) return;
    if (id) {
      const underMcc = (await listMccAccounts()).some((a) => normalizeCustomerId(a.id) === id);
      if (!underMcc) throw new Error(t("settings.googleActions.notUnderMcc"));
      const taken = await db.client.findFirst({ where: { googleCustomerId: id, NOT: { id: clientId } }, select: { id: true } });
      if (taken) throw new Error(t("settings.googleActions.alreadyLinked"));
    }
    await db.$transaction([
      db.gAdsCampaign.deleteMany({ where: { clientId } }),
      db.gAdsAdGroup.deleteMany({ where: { clientId } }),
      db.gAdsKeyword.deleteMany({ where: { clientId } }),
      db.gAdsSearchTerm.deleteMany({ where: { clientId } }),
      db.gAdsDaily.deleteMany({ where: { clientId } }),
      db.gAdsAd.deleteMany({ where: { clientId } }),
      db.gAdsChange.deleteMany({ where: { clientId, status: "pending" } }),
      db.client.update({ where: { id: clientId }, data: { googleCustomerId: id, googleAccountName: id ? name : null, googleCurrency: null, googleSyncedAt: null, googleSyncError: null } }),
    ]);
    await logActivity(clientId, "google", id ? t("settings.googleActions.linked", { id: formatCustomerId(id), name: name ? ` (${name})` : "" }) : t("settings.googleActions.unlinked"));
  });
}

export async function syncGoogleAdsAction(clientId: string) {
  return run(async () => {
    const t = await getT();
    await requireClient(clientId, "edit");
    const r = await syncGoogleAds(clientId);
    const recs = await runGoogleRules(clientId);
    await logActivity(clientId, "sync", t("settings.googleActions.synced", { campaigns: r.campaigns, keywords: num(r.keywords), terms: num(r.searchTerms), spend: money(r.spend30, r.currency), recs: recs ? `, ${t("settings.googleActions.newSuggestions", { n: recs })}` : "" }));
  });
}

// ------------------------------------------------------------------ Edits on Google Ads (lib/google-ads-write.ts)

const KINDS = ["negatives", "target_cpa", "budget", "device", "keyword_status", "campaign_status", "ad_group_create", "ad_group_switch", "ad_schedule"];
function checkKind(p: GChangeParams, t: T) {
  if (!p || !KINDS.includes(p.kind)) throw new Error(t("settings.googleActions.invalidChange"));
}

/** Manual edit: sent to Google immediately. Requires Edit permission on the client. */
export async function googleManualChangeAction(clientId: string, campaignId: string, params: GChangeParams) {
  return run(async () => {
    const { user } = await requireClient(clientId, "edit");
    checkKind(params, await getT());
    await manualChange(clientId, campaignId, params, user.name);
  });
}

/** Approve a suggestion (optionally with edited parameters: unticked keywords, changed levels). */
export async function googleApproveChangeAction(changeId: string, edited?: GChangeParams) {
  return run(async () => {
    const { user } = await requireClientOf("gAdsChange", changeId, "edit");
    if (edited) checkKind(edited, await getT());
    const change = await db.gAdsChange.findUniqueOrThrow({ where: { id: changeId } });
    await executeChange(change, user.name, edited);
  });
}

export async function googleRejectChangeAction(changeId: string) {
  return run(async () => {
    const t = await getT();
    const { user, clientId } = await requireClientOf("gAdsChange", changeId, "edit");
    const r = await db.gAdsChange.updateMany({ where: { id: changeId, status: "pending" }, data: { status: "rejected", decidedAt: new Date(), decidedBy: user.name } });
    if (r.count) {
      const c = await db.gAdsChange.findUniqueOrThrow({ where: { id: changeId } });
      await logActivity(clientId, "google", t("settings.googleActions.rejected", { campaign: c.campaignName, title: c.title }));
    }
  });
}

/** Claude reads search terms → negative-keyword cards awaiting approval (background job, you can leave the page). */
export async function googleClaudeNegativesAction(clientId: string) {
  return run(async () => {
    const { user } = await requireClient(clientId, "edit");
    const t = await getT();
    await enqueueClientJob(clientId, "google_negatives", user.name, { steps: [{ key: "ai", label: t("settings.googleActions.stepNegatives") }] });
  });
}

/** Claude splits ad groups & writes new ads (to raise Quality Score) → "Create group" card awaiting approval (background job). */
export async function googleClaudeRestructureAction(clientId: string) {
  return run(async () => {
    const { user } = await requireClient(clientId, "edit");
    const t = await getT();
    await enqueueClientJob(clientId, "google_restructure", user.name, { steps: [{ key: "ai", label: t("settings.googleActions.stepRestructure") }] });
  });
}

/** Draft a new ad group yourself (prefilled card awaiting approval, edit then approve). */
export async function googleDraftGroupAction(clientId: string, campaignId: string) {
  return run(async () => {
    const { user } = await requireClient(clientId, "edit");
    await draftAdGroup(clientId, campaignId, user.name);
  });
}
