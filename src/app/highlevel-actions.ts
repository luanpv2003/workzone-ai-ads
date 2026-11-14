"use server";

import { revalidatePath } from "next/cache";
import { requireClient } from "@/lib/access";
import { getT } from "@/i18n/server";
import { errorMessage, logActivity } from "@/lib/activity";
import { encrypt } from "@/lib/crypto";
import { db } from "@/lib/db";
import { ghlCreds, testGhl, type GhlPipeline } from "@/lib/highlevel";
import { parseGhlPipelines, parseReverseMap, parseStageMap, suggestReverse, suggestStage, type ReverseMap, type StageMap } from "@/lib/highlevel-sync";
import { randomBytes } from "node:crypto";
import { FEEDBACK_FIELDS, sinceToDate } from "@/lib/lead-sheet";
import { collectCrmContacts, type CrmAudienceCounts, type CrmAudienceFilter } from "@/lib/crm-audience";
import { createCustomerListAudience, createLookalikeAudience, type CreatedAudience } from "@/lib/meta/audiences";
import type { ActionResult } from "./actions";

// HighLevel CRM (Client settings → HighLevel CRM): save the connection after a successful test, choose pipeline / stage,
// map stages → sales ratings, request sync, disconnect.

type TestResult =
  | { ok: true; location: string; pipelines: GhlPipeline[]; pipelineId: string | null; stageId: string | null; stageMap: StageMap; reverseMap: ReverseMap }
  | { ok: false; error: string };

/** Suggested mappings for unmapped stages (keeps what the user already adjusted). */
function withSuggestions(pipelines: GhlPipeline[], map: StageMap): StageMap {
  const out = { ...map };
  for (const p of pipelines) for (const s of p.stages) out[s.id] ??= suggestStage(s.name);
  return out;
}

/** Test the connection then save. Empty token = keep the stored token (change Location ID / reload pipelines). */
export async function saveGhlAction(clientId: string, input: { locationId: string; token: string }): Promise<TestResult> {
  try {
    const t = await getT();
    await requireClient(clientId, "manage");
    const locationId = input.locationId.trim();
    if (!locationId) throw new Error(t("customers.highlevelActions.locationRequired"));
    const old = await db.client.findUniqueOrThrow({ where: { id: clientId }, select: { ghlLocationId: true, ghlToken: true, ghlPipelineId: true, ghlStageId: true, ghlStageMap: true, ghlSince: true, ghlReverseMap: true } });
    const token = input.token.trim() || (old.ghlToken ? ghlCreds(old)?.token : "") || "";
    if (!token) throw new Error(t("customers.highlevelActions.tokenRequired"));
    const r = await testGhl({ locationId, token });
    const changed = old.ghlLocationId !== locationId;
    // Sub-account changed: pushed leads belong to the old sub-account, push again from scratch.
    if (changed) await db.ghlLink.deleteMany({ where: { clientId } });
    const keepPipeline = !changed && r.pipelines.some((p) => p.id === old.ghlPipelineId);
    const pipeline = keepPipeline ? r.pipelines.find((p) => p.id === old.ghlPipelineId)! : r.pipelines[0];
    const stageId = keepPipeline && pipeline.stages.some((s) => s.id === old.ghlStageId) ? old.ghlStageId : (pipeline?.stages[0]?.id ?? null);
    const stageMap = withSuggestions(r.pipelines, changed ? {} : parseStageMap(old.ghlStageMap));
    const options = Object.fromEntries(FEEDBACK_FIELDS.filter((f) => f.options.length).map((f) => [f.field, f.options]));
    const reverseMap = { ...suggestReverse(pipeline, stageMap, options), ...(changed ? {} : parseReverseMap(old.ghlReverseMap)) };
    await db.client.update({
      where: { id: clientId },
      data: {
        ghlLocationId: locationId,
        ghlToken: encrypt(token),
        ghlLocation: r.location,
        ghlPipelines: JSON.stringify(r.pipelines),
        ghlPipelineId: pipeline?.id ?? null,
        ghlStageId: stageId,
        ghlStageMap: JSON.stringify(stageMap),
        ghlReverseMap: JSON.stringify(reverseMap),
        ghlSince: changed || !old.ghlSince ? new Date() : old.ghlSince,
        ghlSyncError: null,
      },
    });
    await logActivity(clientId, "crm", t("customers.highlevelActions.connectedLog", { location: r.location, n: r.pipelines.length }));
    revalidatePath(`/clients/${clientId}`, "layout");
    return { ok: true, location: r.location, pipelines: r.pipelines, pipelineId: pipeline?.id ?? null, stageId, stageMap, reverseMap };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** Receiving pipeline, stage for new leads, stage → rating mapping, auto-push, push start date (YYYY-MM-DD). */
export async function saveGhlSettingsAction(
  clientId: string,
  input: { pipelineId: string; stageId: string; stageMap: StageMap; push: boolean; since: string; reverseMap: ReverseMap; dealPipelineId: string },
): Promise<ActionResult> {
  try {
    const t = await getT();
    await requireClient(clientId, "edit");
    const c = await db.client.findUniqueOrThrow({ where: { id: clientId }, select: { ghlPipelines: true, ghlToken: true } });
    if (!c.ghlToken) throw new Error(t("customers.highlevelActions.notConnected"));
    const pipe = parseGhlPipelines(c.ghlPipelines).find((p) => p.id === input.pipelineId);
    if (!pipe) throw new Error(t("customers.highlevelActions.pickPipeline"));
    if (!pipe.stages.some((s) => s.id === input.stageId)) throw new Error(t("customers.highlevelActions.pickStage"));
    // Only accept values in the lead list's option list.
    const allowed = Object.fromEntries(FEEDBACK_FIELDS.filter((f) => f.options.length).map((f) => [f.field, new Set<string>(f.options)]));
    const map: StageMap = {};
    for (const p of parseGhlPipelines(c.ghlPipelines))
      for (const s of p.stages) {
        const v = input.stageMap[s.id] ?? {};
        map[s.id] = Object.fromEntries(Object.entries(v).filter(([k, x]) => x && allowed[k]?.has(x)));
      }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.since)) throw new Error(t("customers.highlevelActions.badSince"));
    // Reverse mapping: only accept stages of the receiving pipeline, "won", "lost" or "" (no change).
    const stageIds = new Set(pipe.stages.map((s) => s.id));
    const rev: ReverseMap = {};
    for (const [k, v] of Object.entries(input.reverseMap ?? {})) {
      const [field, value] = [k.slice(0, k.indexOf(":")), k.slice(k.indexOf(":") + 1)];
      if (allowed[field]?.has(value)) rev[k] = v === "won" || v === "lost" || stageIds.has(v) ? v : "";
    }
    const deal = input.dealPipelineId && input.dealPipelineId !== pipe.id && parseGhlPipelines(c.ghlPipelines).some((p) => p.id === input.dealPipelineId) ? input.dealPipelineId : null;
    await db.client.update({
      where: { id: clientId },
      data: { ghlPipelineId: pipe.id, ghlStageId: input.stageId, ghlStageMap: JSON.stringify(map), ghlPush: input.push, ghlSince: sinceToDate(input.since), ghlReverseMap: JSON.stringify(rev), ghlDealPipelineId: deal },
    });
    await logActivity(clientId, "crm", t("customers.highlevelActions.settingsLog", { pipeline: pipe.name, mode: t(input.push ? "customers.highlevelActions.modeAuto" : "customers.highlevelActions.modeManual"), since: input.since }));
    revalidatePath(`/clients/${clientId}`, "layout");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** Create / rotate the webhook key: the old link (if any) stops working. */
export async function rotateGhlHookAction(clientId: string): Promise<{ ok: true; key: string } | { ok: false; error: string }> {
  try {
    const t = await getT();
    await requireClient(clientId, "manage");
    const c = await db.client.findUniqueOrThrow({ where: { id: clientId }, select: { ghlToken: true, ghlHookKey: true } });
    if (!c.ghlToken) throw new Error(t("customers.highlevelActions.notConnected"));
    const key = randomBytes(24).toString("base64url");
    await db.client.update({ where: { id: clientId }, data: { ghlHookKey: key } });
    await logActivity(clientId, "crm", t(c.ghlHookKey ? "customers.highlevelActions.hookRotated" : "customers.highlevelActions.hookCreated"));
    revalidatePath(`/clients/${clientId}`, "layout");
    return { ok: true, key };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** Sync now (push leads + pull stages): the background process picks it up within about 1 minute. */
export async function requestGhlSyncAction(clientId: string): Promise<ActionResult> {
  try {
    const t = await getT();
    await requireClient(clientId, "edit");
    const c = await db.client.findUniqueOrThrow({ where: { id: clientId }, select: { ghlToken: true } });
    if (!c.ghlToken) return { ok: false, error: t("customers.highlevelActions.notConnected") };
    await db.client.update({ where: { id: clientId }, data: { ghlRequestAt: new Date(), ghlSyncError: null } });
    revalidatePath(`/clients/${clientId}`, "layout");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** Disconnect: delete the token and the lead ↔ contact links (contacts on HighLevel and already-pulled ratings are kept). */
export async function disconnectGhlAction(clientId: string): Promise<ActionResult> {
  try {
    const t = await getT();
    await requireClient(clientId, "manage");
    await db.ghlLink.deleteMany({ where: { clientId } });
    await db.client.update({
      where: { id: clientId },
      data: { ghlLocationId: null, ghlToken: null, ghlLocation: null, ghlPipelines: "[]", ghlPipelineId: null, ghlStageId: null, ghlStageMap: "{}", ghlSince: null, ghlSyncAt: null, ghlSyncError: null, ghlRequestAt: null, ghlReverseMap: "{}", ghlDealPipelineId: null, ghlHookKey: null },
    });
    await logActivity(clientId, "crm", t("customers.highlevelActions.disconnectedLog"));
    revalidatePath(`/clients/${clientId}`, "layout");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

// ------------------------------------------------------------------ Meta audiences from HighLevel CRM

type CrmFilterInput = { excludeTags: string; includeTags: string; pipelineIds: string[]; addLeadForms: boolean };
const splitTags = (s: string) =>
  s
    .split(/[,\n]/)
    .map((t) => t.trim())
    .filter(Boolean);
const toFilter = (i: CrmFilterInput): CrmAudienceFilter => ({ excludeTags: splitTags(i.excludeTags), includeTags: splitTags(i.includeTags), pipelineIds: i.pipelineIds, addLeadForms: i.addLeadForms });

/** Step 1: count contacts / phones / emails after filtering (no real data returned). */
export async function previewCrmAudienceAction(clientId: string, input: CrmFilterInput): Promise<({ ok: true } & CrmAudienceCounts) | { ok: false; error: string }> {
  try {
    await requireClient(clientId, "view");
    const r = await collectCrmContacts(clientId, toFilter(input));
    return { ok: true, scanned: r.scanned, kept: r.kept, excluded: r.excluded, leadForms: r.leadForms, phones: r.phones, emails: r.emails, topTags: r.topTags };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** Step 2: filter again, create a Custom Audience on Meta (phones / emails hashed with SHA-256), optionally with a VN Lookalike. */
export async function createCrmAudienceAction(
  clientId: string,
  input: CrmFilterInput & { name: string; lookalike: { name: string; pct: number } | null },
): Promise<
  { ok: true; audience: CreatedAudience; lookalike: { id: string; name: string } | null; lookalikeError: string | null } | { ok: false; error: string }
> {
  try {
    const t = await getT();
    await requireClient(clientId, "edit");
    const name = input.name.trim();
    if (!name) throw new Error(t("customers.highlevelActions.audienceNameRequired"));
    const lal = input.lookalike ? { name: input.lookalike.name.trim(), pct: Math.round(input.lookalike.pct) } : null;
    if (lal && !lal.name) throw new Error(t("customers.highlevelActions.lookalikeNameRequired"));
    if (lal && !(lal.pct >= 1 && lal.pct <= 10)) throw new Error(t("customers.highlevelActions.lookalikePct"));
    const client = await db.client.findUniqueOrThrow({ where: { id: clientId } });
    const r = await collectCrmContacts(clientId, toFilter(input));
    const desc = `HighLevel CRM${client.ghlLocation ? ` (${client.ghlLocation})` : ""}: ${r.kept} contact${input.addLeadForms ? ` + lead form Meta` : ""}; bỏ tag chứa: ${input.excludeTags || "—"}`;
    const audience = await createCustomerListAudience(client, { name, description: desc.slice(0, 200), phones: r.phoneSet, emails: r.emailSet });
    await logActivity(clientId, "publish", t("customers.highlevelActions.audienceLog", { name, phones: audience.phones, emails: audience.emails }));
    let lookalike: { id: string; name: string } | null = null;
    let lookalikeError: string | null = null;
    if (lal) {
      try {
        lookalike = await createLookalikeAudience(client, { name: lal.name, originId: audience.id, country: "VN", startPct: 0, endPct: lal.pct });
        await logActivity(clientId, "publish", t("customers.highlevelActions.lookalikeLog", { name: lal.name, pct: lal.pct, origin: name }));
      } catch (err) {
        lookalikeError = errorMessage(err);
      }
    }
    revalidatePath(`/clients/${clientId}/audiences`);
    return { ok: true, audience, lookalike, lookalikeError };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
