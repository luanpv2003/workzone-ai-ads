"use server";

import { DEFAULT_PRESET } from "@/lib/schedule";
import { getT } from "@/i18n/server";
import type { MessageKey, T, Vars } from "@/i18n/translate";
import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { INDUSTRIES } from "@/lib/industries";
import { clientPages, parseExtraPages } from "@/lib/client-pages";
import { rebuildClientStats } from "@/lib/industry-stats";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { errorMessage, logActivity } from "@/lib/activity";
import { suggestAdCopy, type CopyVariant } from "@/lib/ad-copy";
import {
  createBlankDraft,
  createDraftFromPlan,
  deleteDraft,
  duplicateDraft,
  publishDraft,
  reverifyDraft,
  revisePlan,
  runAccountAudit,
  saveDraft,
} from "@/lib/ai/tasks";
import { approveRecommendation, manualSetBudget, manualSetStatus, rejectRecommendation, type ApproveEdits } from "@/lib/recommendations";
import { searchGeo, searchTargeting, type Location } from "@/lib/targeting";
import { searchNewProvinces } from "@/lib/vn-geo";
import { ideateForCampaign, type CampaignContext, type WizardTarget } from "@/lib/wizard-targets";
import { buildRecGuide, toggleGuideStep } from "@/lib/rec-guide";
import type { RecGuide } from "@/lib/ai/schemas";
import { searchMetaGeo } from "@/lib/meta/geo-search";
import { getMetaClient } from "@/lib/meta";
import type { AudienceEstimate, CustomAudienceRef, LeadForm, PagePost } from "@/lib/meta/types";
import { EditablePlanSchema } from "@/lib/ai/schemas";
import { saveUpload, saveUploadBuffer } from "@/lib/uploads";
import { decrypt } from "@/lib/crypto";
import { cleanToken, inspectToken, type TokenInspection } from "@/lib/meta/inspect";
import { checkAllTokens, checkClientToken, replaceToken } from "@/lib/token-status";
import { addKnowledgeFile, addKnowledgeText, deleteKnowledge, knowledgeFilePath, updateKnowledge } from "@/lib/knowledge";
import { ensureDefaultKnowledge } from "@/lib/knowledge-defaults";
import { transcribeDocument } from "@/lib/ai/claude";
import { buildRanking, runAudienceAnalysis } from "@/lib/audience";
import { requireAdmin, requireUser } from "@/lib/auth";
import { aiWorkspaceOf, isPlatformStaff, isSystemAdmin, memberWorkspaces, requireClient, requireClientOf, requireWorkspaceMember, userGrants } from "@/lib/access";
import { enqueueClientJob } from "@/lib/client-jobs";
import { queueDraftPolicyCheck } from "@/lib/draft-policy";
import { cleanProposalBrief } from "@/lib/proposals";
import { analyzeStaged, appendChunk, beginStaging, importStagedFiles, type SetupResult } from "@/lib/client-setup";
import { refreshAutoTargetCpr } from "@/lib/target-cpr-refresh";
import { pruneMessageImages } from "@/lib/msg-images";

export type ActionResult = { ok: true; id?: string } | { ok: false; error: string };

async function run(fn: () => Promise<string | void>): Promise<ActionResult> {
  try {
    const id = await fn();
    revalidatePath("/", "layout");
    return { ok: true, id: id ?? undefined };
  } catch (err) {
    console.error(err);
    revalidatePath("/", "layout");
    return { ok: false, error: errorMessage(err) };
  }
}

// ------------------------------------------------------------ Clients

/** Translate in the request language (server actions run per request; background code gets Vietnamese). */
const tx = async (key: MessageKey, vars?: Vars) => (await getT())(key, vars);

/**
 * Store coordinates: accepts "10.7712, 106.6986" or a pasted Google Maps link.
 * In the link, "!3d<lat>!4d<lng>" is the place's location; "@lat,lng" is only the map viewport center (used when there is no 3d/4d).
 */
function parseCoords(text: string, t: T): { storeLat: number | null; storeLng: number | null } {
  if (!text) return { storeLat: null, storeLng: null };
  const place = text.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  const view = text.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  const plain = text.match(/(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)/);
  const m = place ?? view ?? plain;
  const lat = m ? Number(m[1]) : NaN;
  const lng = m ? Number(m[2]) : NaN;
  if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) throw new Error(t("customers.actions.badCoords"));
  return { storeLat: lat, storeLng: lng };
}

/** "VNĐ", "vnd", "đ" → "VND". An invalid currency code makes Intl.NumberFormat throw and crashes every page that shows money. */
function parseCurrency(raw: string, t: T) {
  const c = raw.trim().toUpperCase().replace(/Đ/g, "D");
  const code = c === "D" || c === "DONG" || c === "ĐỒNG" ? "VND" : c || "VND";
  try {
    if (!/^[A-Z]{3}$/.test(code)) throw new Error();
    new Intl.NumberFormat("vi-VN", { style: "currency", currency: code });
  } catch {
    throw new Error(t("customers.actions.badCurrency", { raw }));
  }
  return code;
}

/** Parse an amount by currency: VND "300.000" = 300000; USD "100.50" = 100.5, "1,234.50" = 1234.5. */
function parseAmount(raw: string, currency: string, label: string, tr: T) {
  let t = raw.replace(/\s/g, "");
  if (!t) return null;
  if (currency === "VND") t = t.replace(/[.,]/g, "");
  else {
    const last = Math.max(t.lastIndexOf("."), t.lastIndexOf(","));
    const decimal = last >= 0 && /^\d{1,2}$/.test(t.slice(last + 1));
    t = decimal ? `${t.slice(0, last).replace(/[.,]/g, "")}.${t.slice(last + 1)}` : t.replace(/[.,]/g, "");
  }
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) throw new Error(tr("customers.actions.badAmount", { label, raw }));
  return n;
}

function clientFields(form: FormData, t: T) {
  const str = (k: string) => String(form.get(k) ?? "").trim();
  const name = str("name");
  if (!name) throw new Error(t("customers.actions.nameRequired"));
  const currency = parseCurrency(str("currency"), t);
  const expires = str("metaTokenExpiresAt");
  const expiresAt = expires && expires !== "never" ? new Date(expires) : null;
  if (expiresAt && Number.isNaN(expiresAt.getTime())) throw new Error(t("customers.actions.badExpiry"));
  const pct = Number(str("maxBudgetChangePct") || 30);
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) throw new Error(t("customers.actions.badPct"));
  const days = Number(str("analysisDays") || 90);
  if (![30, 60, 90, 180, 365].includes(days)) throw new Error(t("customers.actions.badDays"));
  const minResults = Math.round(Number(str("minResults") || 20));
  if (!Number.isFinite(minResults) || minResults < 1 || minResults > 1000) throw new Error(t("customers.actions.badMinResults"));
  const conversationLimit = Number(str("conversationLimit") || 500);
  if (![100, 250, 500, 1000].includes(conversationLimit)) throw new Error(t("customers.actions.badConvLimit"));
  const roas = str("targetRoas") ? Number(str("targetRoas").replace(",", ".")) : null;
  if (roas != null && !Number.isFinite(roas)) throw new Error(t("customers.actions.badRoas"));
  return {
    name,
    industry: str("industry"),
    industryKey: INDUSTRIES.some((i) => i.key === str("industryKey")) ? str("industryKey") : null,
    brief: str("brief"),
    currency,
    primaryResult: str("primaryResult") || "messages",
    ...(form.has("audienceOrigin") && { audienceOrigin: ["vn", "foreign", "mixed"].includes(str("audienceOrigin")) ? str("audienceOrigin") : "vn" }),
    targetCpr: parseAmount(str("targetCpr"), currency, t("customers.actions.amountTargetCpr"), t),
    targetRoas: roas,
    maxDailyBudget: parseAmount(str("maxDailyBudget"), currency, t("customers.actions.amountMaxBudget"), t),
    maxBudgetChangePct: pct,
    analysisDays: days,
    minResults,
    conversationLimit,
    ...(form.has("readImages") && { readImages: str("readImages") === "on" }),
    dataSource: str("dataSource") === "meta" ? "meta" : "mock",
    // The Meta fields are hidden when "Chưa kết nối Meta" (Not connected to Meta) is chosen: if absent from the form, keep the old ID instead of clearing it.
    ...(form.has("metaAdAccountId") && { metaAdAccountId: str("metaAdAccountId") || null }),
    ...(form.has("metaPageId") && { metaPageId: str("metaPageId") || null }),
    ...(form.has("metaPageName") && { metaPageName: str("metaPageName") || null }),
    // Secondary Pages: drop duplicates of the main Page.
    ...(form.has("metaExtraPages") && {
      metaExtraPages: JSON.stringify(parseExtraPages(str("metaExtraPages")).filter((p) => p.id !== str("metaPageId")).slice(0, 20)),
    }),
    ...(form.has("metaInstagramId") && { metaInstagramId: str("metaInstagramId") || null }),
    ...(expires && { metaTokenExpiresAt: expiresAt }),
    ...parseCoords(str("storeCoords"), t),
  };
}

export async function createClientAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  let id: string;
  try {
    const user = await requireUser();
    const data = clientFields(form, await getT());
    // A client belongs to a workspace: the form sends workspaceId; empty = the creator's first workspace.
    const workspaceId = String(form.get("workspaceId") ?? "").trim() || (await memberWorkspaces(user))[0]?.id;
    if (!workspaceId) throw new Error(await tx("customers.actions.noWorkspace"));
    await requireWorkspaceMember(workspaceId);
    const token = cleanToken(String(form.get("metaAccessToken") ?? ""));
    // New client: "Cân bằng" (Balanced) mode (sync at 6h·12h·18h, Claude reads once a conversation is idle for 3 hours, optimization suggestions at 8h·20h into "Chờ duyệt" (Pending approval)),
    // changeable in Settings → Schedule & automation.
    const p = DEFAULT_PRESET;
    const schedule = { syncMode: "hours", syncHours: p.sync.join(","), aiMode: p.aiMode, optimizeMode: "hours", optimizeHours: p.optimize.join(",") };
    const client = await db.client.create({ data: { ...data, ...schedule, workspaceId, metaAccessToken: token ? encrypt(token) : null } });
    // A staff member who creates a client automatically gets Full access on it (workspace Owner / Admin already have it).
    const wsRole = (await userGrants(user.id)).workspaces.find((w) => w.id === workspaceId)?.role;
    if (!isSystemAdmin(user) && wsRole !== "owner" && wsRole !== "admin") {
      await db.clientAccess.create({ data: { clientId: client.id, userId: user.id, role: "admin", grantedBy: user.name } });
    }
    await logActivity(client.id, "sync", (await tx("customers.actions.clientAdded", { name: client.name })));
    // Default documents (ad content framework…), users edit / delete them in the Knowledge base.
    await ensureDefaultKnowledge(client.id);
    // Created from documents: move the files the AI read into the client's Knowledge base.
    const stagingId = String(form.get("stagingId") ?? "");
    if (stagingId) {
      const docs = JSON.parse(String(form.get("stagingDocs") ?? "[]"));
      const n = await importStagedFiles(client.id, stagingId, user.id, docs);
      if (n) await logActivity(client.id, "sync", (await tx("customers.actions.knowledgeFromCreate", { n })));
    }
    if (token) await checkClientToken(client.id).catch(() => {});
    id = client.id;
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
  revalidatePath("/", "layout");
  // Next workflow step: connect Meta (token, Page, ad account, Instagram) in Settings.
  redirect(`/clients/${id}/settings?new=1`); // redirect throws a special error so it must be outside the try
}

export async function updateClientAction(id: string, _prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  return run(async () => {
    await requireClient(id, "edit");
    const data = clientFields(form, await getT());
    const token = cleanToken(String(form.get("metaAccessToken") ?? ""));
    // Empty token field = keep the old token.
    const before = await db.client.findUniqueOrThrow({ where: { id } });
    // Changing the Meta connection (token, data source, ad account, Page, Instagram) needs Full access; editing other info only needs edit permission.
    const metaKeys = ["dataSource", "metaAdAccountId", "metaPageId", "metaPageName", "metaExtraPages", "metaInstagramId", "metaTokenExpiresAt"] as const;
    const norm = (k: string, v: unknown) => (k === "metaExtraPages" ? JSON.stringify(parseExtraPages(v as string)) : v instanceof Date ? v.getTime() : (v ?? null));
    const changed = (k: (typeof metaKeys)[number]) => k in data && norm(k, data[k as keyof typeof data]) !== norm(k, before[k]);
    if (token || metaKeys.some(changed)) await requireClient(id, "manage");
    // A1: an empty token field keeps the stored token. Without this check, someone could point
    // the client at another ad account / Page that the stored token can reach (e.g. a platform
    // token) and read or edit it. Re-targeting therefore needs the token pasted again, unless
    // the caller is platform staff.
    const retarget = (["metaAdAccountId", "metaPageId", "metaExtraPages", "metaInstagramId"] as const).some(changed);
    if (retarget && !token && before.metaAccessToken && !(await isPlatformStaff(await requireUser()))) {
      throw new Error(await tx("customers.actions.retargetToken"));
    }
    // Brief edited → the progress bar says "rebuild the persona" (lib/freshness.ts).
    const briefChanged = before.brief.trim() !== data.brief.trim();
    await db.client.update({ where: { id }, data: { ...data, ...(token && { metaAccessToken: encrypt(token) }), ...(briefChanged && { briefUpdatedAt: new Date() }) } });
    // Standard industry changed: immediately recompute the client's targeting performance for the new industry.
    if (before.industryKey !== data.industryKey) await rebuildClientStats(id).catch(() => {});
    // Primary result / minimum result count changed: recompute the auto-suggested target CPR (DB reads only).
    await refreshAutoTargetCpr(id).catch(() => {});
    // New token → record owner, expiry and permissions so the Meta Token page (System settings) can track it.
    if (token) await checkClientToken(id).catch(() => {});
    // Image reading turned off → immediately delete the client's stored message images.
    if (data.readImages === false) await pruneMessageImages(id).catch(() => 0);
  });
}

export async function deleteClientAction(id: string) {
  await requireClient(id, "manage"); // deletes all of the client's data: Full access only
  await db.client.delete({ where: { id } });
  revalidatePath("/", "layout");
  redirect("/");
}

// ------------------------------------------------------------ Message webhook (which ad the customer messaged from)

/** Register the Meta App that sends webhooks (App ID + App Secret, encrypted at rest). Admins only. */
export async function saveWebhookAppAction(appId: string, name: string, secret: string) {
  return run(async () => {
    await requireAdmin();
    const id = appId.trim();
    const sec = secret.trim();
    if (!/^\d{6,20}$/.test(id)) throw new Error(await tx("customers.actions.badAppId"));
    if (!/^[a-f0-9]{32}$/i.test(sec)) throw new Error(await tx("customers.actions.badAppSecret"));
    await db.webhookApp.upsert({ where: { appId: id }, create: { appId: id, name: name.trim(), secretEnc: encrypt(sec) }, update: { name: name.trim(), secretEnc: encrypt(sec) } });
    await logActivity(null, "sync", await tx("customers.actions.webhookSaved", { name: name.trim() || id }));
  });
}

export async function deleteWebhookAppAction(appId: string) {
  return run(async () => {
    await requireAdmin();
    await db.webhookApp.delete({ where: { appId } });
    await logActivity(null, "sync", await tx("customers.actions.webhookDeleted", { appId }));
  });
}

/** Subscribe the client's Pages to send message webhooks to the token's app. */
export async function subscribeWebhookAction(clientId: string): Promise<{ ok: true; lines: string[] } | { ok: false; error: string }> {
  try {
    await requireClient(clientId, "manage");
    const client = await db.client.findUniqueOrThrow({ where: { id: clientId } });
    const meta = getMetaClient(client);
    const lines: string[] = [];
    for (const p of clientPages(client)) {
      const st = await meta.subscribePageWebhook(p.id);
      lines.push(await tx(st.subscribed ? "customers.actions.whEnabled" : "customers.actions.whNotEnabled", { name: p.name, app: st.appName ?? st.appId ?? "" }));
    }
    await logActivity(clientId, "sync", await tx("customers.actions.whLog", { lines: lines.join("; ") }));
    return { ok: true, lines };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

// ------------------------------------------------------------ Customer contacts

/** Reveal a contact's full phone / email (masked by default); log who viewed it. */
export async function revealContactAction(conversationId: string): Promise<{ ok: true; phones: string[]; email: string | null } | { ok: false; error: string }> {
  try {
    await requireClientOf("conversation", conversationId, "view");
    const c = await db.conversation.findUniqueOrThrow({ where: { id: conversationId }, select: { clientId: true, customerName: true, phones: true, email: true } });
    await logActivity(c.clientId, "pii", await tx("customers.actions.piiConv", { name: c.customerName }));
    return { ok: true, phones: JSON.parse(c.phones) as string[], email: c.email };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** Same as above, for leads from Instant Forms. */
export async function revealLeadAction(leadId: string): Promise<{ ok: true; phones: string[]; email: string | null } | { ok: false; error: string }> {
  try {
    await requireClientOf("lead", leadId, "view");
    const l = await db.lead.findUniqueOrThrow({ where: { id: leadId }, select: { clientId: true, name: true, phones: true, email: true } });
    await logActivity(l.clientId, "pii", await tx("customers.actions.piiLead", { name: l.name }));
    return { ok: true, phones: JSON.parse(l.phones) as string[], email: l.email };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

// ------------------------------------------------------------ Sync & AI

/** Sync (manual): runs in the background; the progress panel shows how much data each channel fetched. */
export async function syncAction(clientId: string) {
  return run(async () => {
    const { user } = await requireClient(clientId, "edit");
    await enqueueClientJob(clientId, "sync", user.name, { steps: [{ key: "sync", label: await tx("customers.actions.stepSync") }] });
  });
}

export async function auditAction(clientId: string) {
  return run(async () => {
    await requireClient(clientId, "edit");
    return runAccountAudit(clientId);
  });
}

/** Message analysis (manual): runs in the background since there may be many batches; progress shows in the running-jobs panel. */
export async function analyzeAction(clientId: string) {
  return run(async () => {
    const { user } = await requireClient(clientId, "edit");
    await enqueueClientJob(clientId, "conversations", user.name, { steps: [{ key: "conversations", label: await tx("customers.actions.stepConv") }] });
  });
}

// ------------------------------------------------------------ Suggestions

export async function approveAction(recId: string, overrideBudget?: number, edits?: ApproveEdits) {
  return run(async () => {
    await requireClientOf("recommendation", recId, "edit");
    return approveRecommendation(recId, overrideBudget, edits);
  });
}

/** ✦ Analyze winning / losing ad content (background, a few minutes). */
export async function creativeAnalysisAction(clientId: string) {
  return run(async () => {
    const { user } = await requireClient(clientId, "edit");
    await enqueueClientJob(clientId, "creative", user.name, { steps: [{ key: "creative", label: await tx("customers.actions.stepCreative") }] });
  });
}

/** ✦ Optimize (manual): immediately check one campaign or all of the client's running campaigns, in the background. */
export async function optimizeAction(clientId: string, campaignId?: string) {
  return run(async () => {
    const { user } = await requireClient(clientId, "edit");
    await enqueueClientJob(clientId, "optimize", user.name, { params: campaignId ? { campaignId } : {}, steps: [{ key: "optimize", label: await tx("customers.actions.stepOptimize") }] });
  });
}

/**
 * Manual: "Nhân bản nhóm" (Duplicate ad set) / "Thêm quảng cáo" (Add ad) on the Performance table creates a prefilled card in "Chờ duyệt" (Pending approval);
 * the user edits it (name, budget, audience, content) then clicks to execute. Same execution path as system suggestions.
 */
export async function manualOptimizeCardAction(clientId: string, adSetId: string, kind: "duplicate_adset" | "add_ad") {
  return run(async () => {
    const { user } = await requireClient(clientId, "edit");
    const s = await db.adSet.findFirstOrThrow({ where: { id: adSetId, clientId }, include: { campaign: true, ads: { orderBy: { spend: "desc" } } } });
    const tpl = s.ads.find((a) => a.status === "ACTIVE") ?? s.ads[0];
    if (kind === "add_ad" && !tpl) throw new Error(await tx("customers.actions.noTemplateAd"));
    const params =
      kind === "duplicate_adset"
        ? { sourceAdSetId: s.id, name: await tx("customers.actions.copySuffix", { name: s.name }), dailyBudget: s.dailyBudget, detailedTargeting: null, advantageAudience: null, candidates: [] }
        : { adSetId: s.id, templateAdId: tpl!.id, templateName: tpl!.name, variants: [{ primary_text: "", headline: "", description: "" }] };
    const rec = await db.recommendation.create({
      data: {
        clientId,
        kind: "optimize",
        campaignId: s.campaignId,
        campaignName: s.campaign.name,
        rule: "manual",
        title: await tx(kind === "duplicate_adset" ? "customers.actions.manualDup" : "customers.actions.manualAddAd", { name: s.name }),
        rationale: await tx("customers.actions.manualWhy", { user: user.name }),
        priority: "medium",
        actionType: kind,
        targetLevel: "adset",
        targetId: s.id,
        targetName: s.name,
        params: JSON.stringify(params),
      },
    });
    return rec.id;
  });
}

export async function rejectAction(recId: string, reason?: string) {
  return run(async () => {
    await requireClientOf("recommendation", recId, "edit");
    return rejectRecommendation(recId, reason);
  });
}

// ------------------------------------------------------------ Campaign creation

export async function reviseAction(draftId: string, feedback: string) {
  return run(async () => {
    await requireClientOf("campaignDraft", draftId, "edit");
    return revisePlan(draftId, feedback);
  });
}

export async function publishAction(draftId: string) {
  return run(async () => {
    await requireClientOf("campaignDraft", draftId, "edit");
    return publishDraft(draftId);
  });
}

/** Content policy check for a draft (background). force = re-check ads that were already checked. */
export async function checkDraftPolicyAction(draftId: string, force = false) {
  return run(async () => {
    const { user } = await requireClientOf("campaignDraft", draftId, "edit");
    const d = await db.campaignDraft.findUniqueOrThrow({ where: { id: draftId }, select: { clientId: true, status: true } });
    if (d.status !== "draft") throw new Error(await tx("customers.actions.draftPosted"));
    await queueDraftPolicyCheck(d.clientId, draftId, user.name, force);
  });
}

export async function blankDraftAction(clientId: string) {
  return run(async () => {
    await requireClient(clientId, "edit");
    return createBlankDraft(clientId);
  });
}

/** Save the draft from the editor. Doesn't revalidate the whole page, to avoid losing in-progress typing state. */
export async function saveDraftAction(
  draftId: string,
  plan: unknown,
  baseRevision?: number,
): Promise<{ ok: true; notes: string[] } | { ok: false; error: string }> {
  try {
    await requireClientOf("campaignDraft", draftId, "edit");
    return { ok: true, notes: await saveDraft(draftId, plan, baseRevision) };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function uploadImageAction(draftId: string, form: FormData): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  try {
    await requireClientOf("campaignDraft", draftId, "edit");
    const file = form.get("file");
    if (!(file instanceof File)) throw new Error(await tx("customers.actions.noImage"));
    // Only accept images for drafts that exist and aren't published yet (avoid creating junk folders).
    const draft = await db.campaignDraft.findUnique({ where: { id: draftId }, select: { status: true } });
    if (!draft) throw new Error(await tx("customers.actions.draftNotFound"));
    if (draft.status !== "draft") throw new Error(await tx("customers.actions.draftPostedNoImage"));
    return { ok: true, path: await saveUpload(draftId, file) };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/**
 * Carousel: fetch the images of an existing Page post (main image + album images, up to 10) into the draft's image folder.
 * Only downloads from Facebook's image servers; returns the saved image paths in the post's order.
 */
export async function importPostImagesAction(
  clientId: string,
  draftId: string,
  postId: string,
  pageId?: string | null,
): Promise<{ ok: true; paths: string[]; skipped: number } | { ok: false; error: string }> {
  try {
    await requireClient(clientId, "edit");
    const draft = await db.campaignDraft.findUnique({ where: { id: draftId }, select: { status: true, clientId: true } });
    if (!draft || draft.clientId !== clientId) throw new Error(await tx("customers.actions.draftNotFound"));
    if (draft.status !== "draft") throw new Error(await tx("customers.actions.draftPostedNoImage"));
    const { meta, client } = await metaFor(clientId, pageId);
    const pages = clientPages(client).map((p) => p.id);
    if (!pages.includes(postId.split("_")[0])) throw new Error(await tx("customers.actions.postNotOwned"));
    const detail = await meta.postDetail(postId, 10);
    const paths: string[] = [];
    const seen = new Set<string>();
    let skipped = 0;
    for (const url of detail.images) {
      try {
        const host = new URL(url).hostname;
        if (!/(^|\.)(fbcdn\.net|facebook\.com|cdninstagram\.com)$/.test(host)) throw new Error("host");
        const res = await fetch(url);
        if (!res.ok) throw new Error(String(res.status));
        const data = Buffer.from(await res.arrayBuffer());
        const hash = createHash("sha1").update(data).digest("hex");
        if (seen.has(hash)) continue; // same image under 2 different links
        seen.add(hash);
        paths.push(saveUploadBuffer(draftId, data, await getT()));
      } catch {
        skipped++;
      }
    }
    if (!paths.length) throw new Error(await tx(detail.images.length ? "customers.actions.imagesNone" : "customers.actions.postNoImages"));
    return { ok: true, paths, skipped };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function searchTargetingAction(query: string) {
  await requireUser();
  return searchTargeting(query, 40);
}

export type GeoHit = { kind: "loc"; loc: Location } | { kind: "group"; name: string; regions: Location[] };

/**
 * Location picker: new provinces (34, merging old provinces) + direct search on Meta (province, city, district, ward — exact Ads Manager codes).
 * No token or Meta error → only the 63 provinces from the built-in list (`live: false`).
 */
export async function searchGeoAction(query: string): Promise<{ live: boolean; hits: GeoHit[] }> {
  await requireUser();
  const groups: GeoHit[] = searchNewProvinces(query).map((p) => ({
    kind: "group",
    name: p.name,
    regions: p.regions.map((r) => ({ key: r.key, name: r.name, type: "region" as const, group: p.name })),
  }));
  const meta = query.trim().length >= 2 ? await searchMetaGeo(query) : [];
  if (meta) {
    const hits: GeoHit[] = meta.map((g) => ({ kind: "loc", loc: { key: g.key, name: g.name, type: g.type, parent: g.type === "region" ? null : g.region || null, parentKey: g.type === "region" ? null : g.regionKey } }));
    return { live: true, hits: [...groups, ...hits] };
  }
  const regions: GeoHit[] = searchGeo(query, 40)
    .filter((g) => g.type === "region")
    .slice(0, 12)
    .map((g) => ({ kind: "loc", loc: { key: g.key, name: g.name, type: "region" } }));
  return { live: false, hits: [...groups, ...regions] };
}

// ------------------------------------------------------------ Direct actions on the Performance table

export async function setStatusAction(clientId: string, level: string, id: string, status: "ACTIVE" | "PAUSED") {
  return run(async () => {
    await requireClient(clientId, "edit");
    return manualSetStatus(clientId, level, id, status);
  });
}

export async function setBudgetAction(clientId: string, level: string, id: string, amount: number) {
  return run(async () => {
    await requireClient(clientId, "edit");
    return manualSetBudget(clientId, level, id, amount);
  });
}

/** Check the just-pasted token (or the client's stored token if left empty) and list the accounts. */
export async function inspectTokenAction(
  clientId: string | null,
  token: string,
): Promise<{ ok: true; data: TokenInspection } | { ok: false; error: string }> {
  // With clientId: may use the client's stored token → needs Full access. Without (create-client form): only checks the just-pasted token.
  try {
    if (clientId) await requireClient(clientId, "manage");
    else await requireUser();
    let t = cleanToken(token);
    if (!t && clientId) {
      const c = await db.client.findUnique({ where: { id: clientId }, select: { metaAccessToken: true } });
      if (c?.metaAccessToken) t = decrypt(c.metaAccessToken);
    }
    if (!t) throw new Error(await tx("customers.actions.noToken"));
    return { ok: true, data: await inspectToken(t) };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

// ------------------------------------------------------------ Access Token management

export async function checkTokenAction(clientId: string) {
  return run(async () => {
    await requireClient(clientId, "edit");
    await checkClientToken(clientId);
  });
}

export async function checkAllTokensAction() {
  return run(async () => {
    await requireAdmin();
    const r = await checkAllTokens();
    if (r.failed) throw new Error(await tx("customers.actions.tokensFailed", { failed: r.failed, total: r.total }));
  });
}

export async function replaceTokenAction(clientId: string, token: string, applyToSameOwner: boolean) {
  try {
    const { user } = await requireClient(clientId, "manage");
    // Applying to every client with the same token owner can touch clients of other workspaces: system admins only.
    if (applyToSameOwner && !isSystemAdmin(user)) throw new Error(await tx("customers.actions.tokenAdminOnly"));
    const r = await replaceToken(clientId, token, applyToSameOwner);
    revalidatePath("/", "layout");
    return { ok: true as const, updated: r.updated };
  } catch (err) {
    return { ok: false as const, error: errorMessage(err) };
  }
}

/** Recent posts of the client's Page, for "Sử dụng bài viết có sẵn" (Use existing post). */
export async function listPostsAction(clientId: string, pageId?: string | null): Promise<{ ok: true; posts: PagePost[] } | { ok: false; error: string }> {
  try {
    await requireClient(clientId, "view");
    const { meta, page } = await metaFor(clientId, pageId);
    return { ok: true, posts: await meta.listPosts(100, page) };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** Meta client + Page (must be one of the client's Pages; omitted = main Page). */
async function metaFor(clientId: string, pageId?: string | null) {
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId } });
  if (client.dataSource === "meta" && !client.metaPageId) throw new Error(await tx("customers.actions.noPage"));
  if (pageId && !clientPages(client).some((p) => p.id === pageId)) throw new Error(await tx("customers.actions.pageNotOwned"));
  return { client, meta: getMetaClient(client), page: pageId ?? undefined };
}

export async function listLeadFormsAction(clientId: string, pageId?: string | null): Promise<{ ok: true; forms: LeadForm[] } | { ok: false; error: string }> {
  try {
    await requireClient(clientId, "view");
    const { meta, page } = await metaFor(clientId, pageId);
    return { ok: true, forms: await meta.listLeadForms(page) };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

const leadFormInputSchema = (t: T) => z.object({
  name: z.string().trim().min(1, t("customers.actions.form.name")).max(100),
  higherIntent: z.boolean(),
  introTitle: z.string().max(60),
  introText: z.string().max(500),
  questions: z
    .array(z.object({ type: z.string().regex(/^[A-Z_]+$/), label: z.string().trim().max(80).optional(), options: z.array(z.string().trim().min(1).max(80)).max(10).optional() }))
    .min(1, t("customers.actions.form.questions"))
    .max(15),
  privacyUrl: z.url(t("customers.actions.form.privacy")),
  privacyText: z.string().max(70),
  thanksTitle: z.string().trim().min(1, t("customers.actions.form.thanksTitle")).max(60),
  thanksBody: z.string().max(160),
  thanksButton: z.enum(["VIEW_WEBSITE", "CALL_BUSINESS", "MESSAGE_BUSINESS"]),
  websiteUrl: z.string(),
  phone: z.string(),
});

/** Create an Instant Form on the Page (manual, the user fills it in and clicks create). */
export async function createLeadFormAction(clientId: string, input: unknown, pageId?: string | null): Promise<{ ok: true; form: LeadForm } | { ok: false; error: string }> {
  try {
    await requireClient(clientId, "edit");
    const f = leadFormInputSchema(await getT()).parse(input);
    if (f.questions.some((q) => q.type === "CUSTOM" && !q.label)) throw new Error(await tx("customers.actions.customQuestion"));
    if (f.thanksButton === "VIEW_WEBSITE" && !/^https?:\/\//.test(f.websiteUrl)) throw new Error(await tx("customers.actions.needWebsite"));
    if (f.thanksButton === "CALL_BUSINESS" && !/^\+?\d{8,15}$/.test(f.phone.replace(/[\s.-]/g, ""))) throw new Error(await tx("customers.actions.needPhone"));
    const { meta, page } = await metaFor(clientId, pageId);
    const form = await meta.createLeadForm({ ...f, phone: f.phone.replace(/[\s.-]/g, "") }, page);
    await logActivity(clientId, "execute", await tx("customers.actions.formCreated", { name: form.name }));
    return { ok: true, form };
  } catch (err) {
    return { ok: false, error: err instanceof z.ZodError ? err.issues[0].message : errorMessage(err) };
  }
}

export async function listCustomAudiencesAction(clientId: string): Promise<{ ok: true; audiences: CustomAudienceRef[] } | { ok: false; error: string }> {
  try {
    await requireClient(clientId, "view");
    const client = await db.client.findUniqueOrThrow({ where: { id: clientId } });
    return { ok: true, audiences: await getMetaClient(client).listCustomAudiences() };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

// Cache estimates for 10 minutes to avoid repeated Meta calls when targeting hasn't changed.
const estimateCache = new Map<string, { at: number; value: AudienceEstimate | null; sentences: string[] }>();

/** Estimate audience size for an ad set in the editor. */
export async function estimateAudienceAction(
  clientId: string,
  resultType: string,
  adSet: unknown,
): Promise<{ ok: true; estimate: AudienceEstimate | null; sentences: string[] } | { ok: false; error: string }> {
  try {
    await requireClient(clientId, "view");
    const s = EditablePlanSchema.shape.ad_sets.element.parse(adSet);
    const key = JSON.stringify([clientId, resultType, s.locations, s.custom_locations, s.location_types, s.locales, s.age_min, s.age_max, s.genders, s.detailed_targeting, s.advantage_audience, s.placements, s.platforms, s.message_destination, s.positions, s.devices, s.custom_audiences, s.excluded_custom_audiences, s.excluded_locations, s.narrow_targeting, s.performance_goal, s.lead_destination]);
    const hit = estimateCache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60_000) return { ok: true, estimate: hit.value, sentences: hit.sentences };
    const client = await db.client.findUniqueOrThrow({ where: { id: clientId } });
    const meta = getMetaClient(client);
    const [value, sentences] = await Promise.all([meta.estimateAudience(s, resultType), meta.describeTargeting(s, resultType).catch(() => [])]);
    // Cache cap: evict the oldest entry once over 500 entries (Map keeps insertion order).
    if (estimateCache.size >= 500) estimateCache.delete(estimateCache.keys().next().value!);
    estimateCache.set(key, { at: Date.now(), value, sentences });
    return { ok: true, estimate: value, sentences };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function reverifyAction(draftId: string) {
  return run(async () => {
    await requireClientOf("campaignDraft", draftId, "edit");
    return reverifyDraft(draftId);
  });
}

export async function duplicateDraftAction(draftId: string) {
  return run(async () => {
    await requireClientOf("campaignDraft", draftId, "edit");
    return duplicateDraft(draftId);
  });
}

export async function deleteDraftAction(draftId: string) {
  return run(async () => {
    await requireClientOf("campaignDraft", draftId, "edit");
    return deleteDraft(draftId);
  });
}

// ------------------------------------------------------------ Knowledge base

type KnowledgeResult = { ok: true; id: string; warning: string | null } | { ok: false; error: string };

/** Upload 1 file to the knowledge base (the UI calls it one file at a time to show progress). */
export async function uploadKnowledgeAction(clientId: string, form: FormData): Promise<KnowledgeResult> {
  try {
    await requireClient(clientId, "edit");
    const file = form.get("file");
    if (!(file instanceof File) || !file.size) throw new Error(await tx("customers.actions.noFile"));
    const { doc, warning } = await addKnowledgeFile(clientId, file, String(form.get("category") ?? "auto"));
    await logActivity(clientId, "sync", await tx("customers.actions.kbAdded", { title: doc.title }));
    revalidatePath(`/clients/${clientId}`, "layout");
    return { ok: true, id: doc.id, warning };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function addKnowledgeTextAction(clientId: string, input: { title: string; category: string; content: string }): Promise<KnowledgeResult> {
  try {
    await requireClient(clientId, "edit");
    const doc = await addKnowledgeText(clientId, input);
    await logActivity(clientId, "sync", await tx("customers.actions.kbAdded", { title: doc.title }));
    revalidatePath(`/clients/${clientId}`, "layout");
    return { ok: true, id: doc.id, warning: null };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function updateKnowledgeAction(id: string, input: { title?: string; category?: string; content?: string; useForAi?: boolean }) {
  return run(async () => {
    await requireClientOf("knowledgeDoc", id, "edit");
    await updateKnowledge(id, input);
  });
}

export async function deleteKnowledgeAction(id: string) {
  return run(async () => {
    await requireClientOf("knowledgeDoc", id, "edit");
    const doc = await deleteKnowledge(id);
    await logActivity(doc.clientId, "sync", await tx("customers.actions.kbDeleted", { title: doc.title }));
  });
}

/** Have Claude read the PDF directly (font issues / scans) and replace the content with its transcription. */
export async function transcribeKnowledgeAction(id: string) {
  return run(async () => {
    await requireClientOf("knowledgeDoc", id, "edit");
    const doc = await db.knowledgeDoc.findUniqueOrThrow({ where: { id } });
    if (!doc.filePath || !doc.fileName) throw new Error(await tx("customers.actions.noOriginal"));
    const { text, model } = await transcribeDocument(knowledgeFilePath(doc.filePath), doc.fileName, doc.clientId);
    if (text.trim().length < 20) throw new Error(await tx("customers.actions.noText"));
    await updateKnowledge(id, { content: text, useForAi: true });
    await logActivity(doc.clientId, "analyze", await tx("customers.actions.kbReread", { title: doc.title, model }));
  });
}

// ------------------------------------------------------------ Customer persona & targeting ranking

export async function audienceAction(clientId: string) {
  return run(async () => {
    await requireClient(clientId, "edit");
    return runAudienceAnalysis(clientId);
  });
}

/** Rescore performance with the latest ads data (no Claude call). */
export async function refreshRankingAction(clientId: string) {
  return run(async () => {
    await requireClient(clientId, "edit");
    if (!(await db.audienceAnalysis.count({ where: { clientId } }))) throw new Error(await tx("customers.actions.needPersona"));
    await buildRanking(clientId);
    await logActivity(clientId, "analyze", await tx("customers.actions.rankingUpdated"));
  });
}

// ------------------------------------------------------------ Full analysis (automatic, background)

export async function fullAnalysisAction(clientId: string) {
  return run(async () => {
    const { user } = await requireClient(clientId, "edit");
    await enqueueClientJob(clientId, "full_analysis", user.name);
  });
}

export async function cancelClientJobAction(jobId: string) {
  return run(async () => {
    await requireClientOf("clientJob", jobId, "edit");
    const r = await db.clientJob.updateMany({ where: { id: jobId, status: { in: ["queued", "running"] } }, data: { status: "cancelled", finishedAt: new Date() } });
    if (!r.count) throw new Error(await tx("customers.actions.jobDone"));
  });
}

// ------------------------------------------------------------ Create client from documents (AI prefills, user reviews)

/** Create a client (including document upload + Claude reading before creation): must belong to at least one workspace. */
async function requireCreator() {
  const user = await requireUser();
  if (!(await memberWorkspaces(user)).length) throw new Error(await tx("customers.actions.noWorkspace"));
  return user;
}

/** Start a document upload session (files sent in 8MB chunks to stay under the request size limit). */
export async function beginClientFilesAction(): Promise<string> {
  const user = await requireCreator();
  return beginStaging(user.id);
}

export async function uploadClientFileChunkAction(form: FormData): Promise<{ ok: true; file: { fileName: string; chars: number; warning: string | null } | null } | { ok: false; error: string }> {
  try {
    const user = await requireCreator();
    const chunk = form.get("chunk");
    if (!(chunk instanceof Blob)) throw new Error(await tx("customers.actions.noChunk"));
    const file = await appendChunk(
      String(form.get("stagingId")),
      user.id,
      String(form.get("fileKey")),
      String(form.get("fileName")),
      Number(form.get("index")),
      Number(form.get("total")),
      Buffer.from(await chunk.arrayBuffer()),
    );
    return { ok: true, file };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function analyzeClientFilesAction(stagingId: string, note: string): Promise<{ ok: true; data: SetupResult } | { ok: false; error: string }> {
  try {
    const user = await requireCreator();
    return { ok: true, data: await analyzeStaged(stagingId, user.id, note, await aiWorkspaceOf(user)) };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

// ------------------------------------------------------------ AI campaign suggestions from the persona

/** Ask Claude to plan campaigns: queue a background job that suggests ideas (brief optional). Results show in Campaign creation for picking. */
export async function proposeCampaignsAction(clientId: string, rawBrief: unknown) {
  return run(async () => {
    const { user } = await requireClient(clientId, "edit");
    const brief = cleanProposalBrief(rawBrief);
    if (!brief.text && !(await db.audienceAnalysis.count({ where: { clientId } }))) {
      throw new Error(await tx("customers.actions.noPersona"));
    }
    const busy = await db.clientJob.findFirst({ where: { clientId, kind: { in: ["propose_campaigns", "draft_campaigns"] }, status: { in: ["queued", "running"] } } });
    if (busy) throw new Error(await tx("customers.actions.proposeBusy"));
    await enqueueClientJob(clientId, "propose_campaigns", user.name, { params: { brief }, steps: [{ key: "ideas", label: await tx("customers.actions.stepIdeas") }] });
  });
}

/** Draft the chosen ideas into drafts (background, one step per idea). */
export async function draftProposalAction(proposalId: string, ideas: number[], answers: Record<string, string>) {
  return run(async () => {
    const { user } = await requireClientOf("campaignProposal", proposalId, "edit");
    const p = await db.campaignProposal.findUniqueOrThrow({ where: { id: proposalId } });
    const report = JSON.parse(p.report) as { ideas: { title: string }[] };
    const chosen = [...new Set(ideas.map(Number))].filter((i) => Number.isInteger(i) && report.ideas[i]);
    if (!chosen.length) throw new Error(await tx("customers.actions.pickIdea"));
    const clean = Object.fromEntries(Object.entries(answers ?? {}).map(([k, v]) => [String(k).slice(0, 40), String(v).slice(0, 500)]));
    await db.campaignProposal.update({ where: { id: proposalId }, data: { status: "drafting", answers: JSON.stringify(clean), chosen: JSON.stringify(chosen) } });
    await enqueueClientJob(p.clientId, "draft_campaigns", user.name, {
      params: { proposalId, ideas: chosen, answers: clean },
      steps: chosen.map((i) => ({ key: `idea${i}`, label: report.ideas[i].title.slice(0, 60) })),
    });
  });
}

/** Step-by-step builder: create a draft from the user's chosen setup (nothing published to Meta yet). */
export async function createDraftFromPlanAction(clientId: string, plan: unknown) {
  return run(async () => {
    await requireClient(clientId, "edit");
    return createDraftFromPlan(clientId, plan);
  });
}

/** Step-by-step builder: Claude suggests 3 ad copy variants. */
export async function suggestAdCopyAction(clientId: string, input: { resultType: string; campaignName: string; audienceNote: string }): Promise<{ ok: true; variants: CopyVariant[] } | { ok: false; error: string }> {
  try {
    await requireClient(clientId, "edit");
    return { ok: true, variants: await suggestAdCopy(clientId, input) };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** ✦ Claude suggests targeting for the campaign being created (step-by-step builder). Only reads / searches on Meta, changes nothing on Meta. */
export async function ideateTargetingAction(clientId: string, ctx: CampaignContext): Promise<{ ok: true; summary: string; targets: WizardTarget[]; missing: string[] } | { ok: false; error: string }> {
  try {
    await requireClient(clientId, "edit");
    return { ok: true, ...(await ideateForCampaign(clientId, ctx)) };
  } catch (err) {
    console.error(err);
    return { ok: false, error: errorMessage(err) };
  }
}

/** Step-by-step instructions for a manual suggestion (written by Claude, ~1 minute; saved so it reopens instantly). Changes nothing on Meta. */
export async function recGuideAction(recId: string): Promise<{ ok: true; guide: RecGuide } | { ok: false; error: string }> {
  try {
    await requireClientOf("recommendation", recId, "edit");
    return { ok: true, guide: await buildRecGuide(recId) };
  } catch (err) {
    console.error(err);
    return { ok: false, error: errorMessage(err) };
  }
}

export async function toggleGuideStepAction(recId: string, index: number): Promise<{ ok: true; done: number[] } | { ok: false; error: string }> {
  try {
    await requireClientOf("recommendation", recId, "edit");
    return { ok: true, done: await toggleGuideStep(recId, index) };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
