import { actorName } from "./auth";
import type { Client, Recommendation } from "@prisma/client";
import { db, retryBusy } from "./db";
import { getMetaClient } from "./meta";
import { errorMessage, logActivity } from "./activity";
import type { RecommendationOut } from "./ai/schemas";
import { defaultDailyBudget, money } from "./format";
import { RESULT_TYPES } from "./ai/schemas";
import { draftCampaign } from "./ai/tasks";
import { captureBaseline, type AddAdParams, type DuplicateParams, type UpdateTargetingParams } from "./optimize";
import type { AdVariant } from "./meta/types";
import { getT } from "@/i18n/server";
import type { T } from "@/i18n/translate";

const pickDefined = <T extends object>(o: T | undefined, keys: (keyof T)[]) => (o ? Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]])) : {});

type Target = { level: "campaign" | "adset" | "ad"; id: string; name: string; status: string; dailyBudget: number | null };

async function findTarget(clientId: string, level: string | null, id: string | null): Promise<Target | null> {
  if (!id) return null;
  const where = { id, clientId };
  if (level === "campaign" || !level) {
    const c = await db.campaign.findFirst({ where });
    if (c) return { level: "campaign", id, name: c.name, status: c.status, dailyBudget: c.dailyBudget };
  }
  if (level === "adset" || !level) {
    const s = await db.adSet.findFirst({ where });
    if (s) return { level: "adset", id, name: s.name, status: s.status, dailyBudget: s.dailyBudget };
  }
  if (level === "ad" || !level) {
    const a = await db.ad.findFirst({ where });
    if (a) return { level: "ad", id, name: a.name, status: a.status, dailyBudget: null };
  }
  return null;
}

/** Check whether a budget change is within the client's safety limits. Returns an error or null. */
export function checkBudget(client: Client, current: number | null, next: number | null, t: T): string | null {
  if (current == null) return t("workflow.recs.noOwnBudget");
  if (next == null || !(next > 0)) return t("workflow.recs.invalidBudget");
  const change = (Math.abs(next - current) / current) * 100;
  if (change > client.maxBudgetChangePct + 0.01) {
    return t("workflow.recs.changeOverLimit", { change: change.toFixed(0), limit: client.maxBudgetChangePct, current: money(current, client.currency) });
  }
  if (client.maxDailyBudget && next > client.maxDailyBudget) {
    return t("workflow.recs.overMax", { max: money(client.maxDailyBudget, client.currency) });
  }
  return null;
}

// ------------------------------------------------------------ Pending cards vs the client's current state

/** Cards pending longer than this many days have stale data (optimization scores after 1–2 days; audits / messages re-run daily). */
const PENDING_TTL_DAYS = { optimize: 3, audit: 7 } as const;
const DAY_MS = 86_400_000;

/** Actual running status of every campaign / ad set / ad: itself ACTIVE and all parent levels ACTIVE too. */
async function liveStatuses(clientId: string) {
  const [camps, sets, ads] = await Promise.all([
    db.campaign.findMany({ where: { clientId }, select: { id: true, status: true } }),
    db.adSet.findMany({ where: { clientId }, select: { id: true, status: true, campaignId: true } }),
    db.ad.findMany({ where: { clientId }, select: { id: true, status: true, campaignId: true, adSetId: true } }),
  ]);
  const camp = new Map(camps.map((c) => [c.id, c.status]));
  const set = new Map(sets.map((s) => [s.id, s]));
  const map = new Map<string, { own: string; running: boolean }>();
  for (const c of camps) map.set(c.id, { own: c.status, running: c.status === "ACTIVE" });
  for (const s of sets) map.set(s.id, { own: s.status, running: s.status === "ACTIVE" && camp.get(s.campaignId) === "ACTIVE" });
  for (const a of ads) map.set(a.id, { own: a.status, running: a.status === "ACTIVE" && set.get(a.adSetId)?.status === "ACTIVE" && camp.get(a.campaignId) === "ACTIVE" });
  return map;
}

/** Reason a pending card no longer matches the current state; null = still valid. */
function staleReason(r: Pick<Recommendation, "kind" | "actionType" | "targetId" | "campaignId" | "createdAt">, live: Map<string, { own: string; running: boolean }>, t: T, now = Date.now()) {
  const ttl = r.kind === "optimize" ? PENDING_TTL_DAYS.optimize : PENDING_TTL_DAYS.audit;
  if (now - r.createdAt.getTime() > ttl * DAY_MS) return t("workflow.recs.expiredTtl", { ttl });
  if (r.targetId) {
    const tgt = live.get(r.targetId);
    if (!tgt) return t("workflow.recs.expiredGone");
    if (r.actionType === "resume") return tgt.own === "ACTIVE" ? t("workflow.recs.expiredAlreadyOn") : null;
    if (r.actionType === "pause" && !tgt.running) return t("workflow.recs.expiredAlreadyOff");
    if (!tgt.running) return t("workflow.recs.expiredGroupStopped");
  }
  if (r.kind === "optimize" && r.campaignId && live.get(r.campaignId)?.running === false) return t("workflow.recs.expiredCampaignStopped");
  return null;
}

/**
 * Clean up pending cards that no longer apply: expired, pointing to paused / deleted objects, or belonging to stopped campaigns.
 * Runs after every sync and hourly (scripts/daily.ts). Keeps user-created cards and automation dry-run cards.
 */
export async function expireStaleRecommendations(clientId: string) {
  const t = await getT();
  const pending = await db.recommendation.findMany({
    where: { clientId, status: "pending", OR: [{ rule: null }, { rule: { not: "manual" } }], AND: [{ OR: [{ auto: null }, { auto: { not: "dryrun" } }] }] },
    select: { id: true, kind: true, actionType: true, targetId: true, campaignId: true, createdAt: true },
  });
  if (!pending.length) return 0;
  const live = await liveStatuses(clientId);
  const byReason = new Map<string, string[]>();
  for (const r of pending) {
    const reason = staleReason(r, live, t);
    if (reason) byReason.set(reason, [...(byReason.get(reason) ?? []), r.id]);
  }
  let n = 0;
  for (const [result, ids] of byReason) {
    n += (await db.recommendation.updateMany({ where: { id: { in: ids }, status: "pending" }, data: { status: "expired", result, decidedAt: new Date() } })).count;
  }
  if (n) await logActivity(clientId, "analyze", t("workflow.recs.cleanedUp", { count: n }));
  return n;
}

const SOURCE_LABEL: Record<string, string> = { account: "account audit", conversations: "message analysis", optimize: "campaign optimisation" };
const dm = (d: Date) => `${d.getDate()}/${d.getMonth() + 1}`;

/**
 * The client's existing recommendations (pending / applied / dismissed in 30 days) for the prompt, so Claude doesn't repeat old work.
 * Pending cards are coded P1, P2…; Claude puts the code in "replaces" when a new recommendation replaces that card. source = the report type being run.
 */
export async function recommendationHistory(clientId: string, source: "account" | "conversations" | "optimize") {
  const since = new Date(Date.now() - 30 * DAY_MS);
  const [pending, decided] = await Promise.all([
    db.recommendation.findMany({ where: { clientId, status: "pending" }, include: { audit: { select: { kind: true } } }, orderBy: { createdAt: "desc" }, take: 40 }),
    db.recommendation.findMany({ where: { clientId, status: { in: ["executed", "done", "rejected"] }, decidedAt: { gt: since } }, orderBy: { decidedAt: { sort: "desc", nulls: "last" } }, take: 30 }),
  ]);
  const codes = new Map<string, string>();
  const src = (r: (typeof pending)[number]) => (r.kind === "optimize" ? "optimize" : (r.audit?.kind ?? "account"));
  const lines = pending.map((r, i) => {
    const code = `P${i + 1}`;
    codes.set(code, r.id);
    const s = src(r);
    return `${code} | ${SOURCE_LABEL[s] ?? s}${s === source ? " (same kind, will be replaced by this run)" : ""} | ${dm(r.createdAt)} | ${r.title}`;
  });
  const done = decided.filter((r) => r.status !== "rejected").map((r) => `- ${dm(r.decidedAt ?? r.createdAt)}: ${r.title}${r.result ? ` → ${r.result.slice(0, 120)}` : ""}`);
  const rejected = decided.filter((r) => r.status === "rejected").map((r) => `- ${dm(r.decidedAt ?? r.createdAt)}: ${r.title}${r.result ? ` (${r.result.slice(0, 120)})` : ""}`);
  if (!lines.length && !done.length && !rejected.length) return { text: "", codes };
  const text = `# Existing recommendations (do not repeat)
Pending approval (code | source | created | title):
${lines.join("\n") || "None."}

Done in the last 30 days:
${done.join("\n") || "None."}

Dismissed by the approver in the last 30 days:
${rejected.join("\n") || "None."}`;
  return { text, codes };
}

/**
 * Save recommendations from Claude. Recommendations with wrong IDs, or budgets over the limit, are converted to "manual"
 * so they're never executed by mistake. codes: P1, P2… codes from recommendationHistory, to replace the pending cards Claude lists in "replaces".
 */
export async function saveRecommendations(client: Client, auditId: string, recs: RecommendationOut[], codes?: Map<string, string>) {
  const tr = await getT();
  // A new report replaces the pending recommendations of the old report of the same type.
  const { kind } = await db.audit.findUniqueOrThrow({ where: { id: auditId }, select: { kind: true } });
  await db.recommendation.updateMany({
    where: { clientId: client.id, status: "pending", auditId: { not: auditId }, audit: { is: { kind } } },
    data: { status: "expired", result: tr("workflow.recs.expiredNewReport"), decidedAt: new Date() },
  });
  const live = await liveStatuses(client.id);

  for (const rec of recs) {
    let actionType = rec.action_type;
    let note = "";
    const target = actionType === "manual" ? null : await findTarget(client.id, rec.target_level, rec.target_id);
    // Pausing something already paused / enabling something already running: no card.
    const lv = target && live.get(target.id);
    if (lv && ((actionType === "pause" && !lv.running) || (actionType === "resume" && lv.own === "ACTIVE"))) continue;
    // Pending cards from other sources that this recommendation replaces (same action, newer situation).
    const replaced = (rec.replaces ?? []).map((c) => codes?.get(c.trim().toUpperCase())).filter((x): x is string => !!x);
    if (replaced.length) {
      await db.recommendation.updateMany({
        where: { id: { in: replaced }, clientId: client.id, status: "pending", OR: [{ rule: null }, { rule: { not: "manual" } }] },
        data: { status: "expired", result: tr("workflow.recs.replacedBy", { title: rec.title.slice(0, 120) }), decidedAt: new Date() },
      });
    }
    if (actionType !== "manual" && !target) {
      actionType = "manual";
      note = tr("workflow.recs.noteNotFound", { id: rec.target_id ?? "" });
    }
    if (actionType === "update_budget" && target) {
      const err = checkBudget(client, target.dailyBudget, rec.new_daily_budget, tr);
      if (err) {
        actionType = "manual";
        note = tr("workflow.recs.noteBudget", { error: err });
      }
    }
    if (actionType !== "manual" && target) {
      // Same action on the same object as a pending recommendation (from another report type) → keep the new one.
      await db.recommendation.updateMany({
        where: { clientId: client.id, status: "pending", actionType, targetId: target.id },
        data: { status: "expired", result: tr("workflow.recs.replacedNewer"), decidedAt: new Date() },
      });
    }
    await db.recommendation.create({
      data: {
        clientId: client.id,
        auditId,
        title: rec.title,
        rationale: rec.rationale + note,
        priority: rec.priority,
        expectedImpact: rec.expected_impact,
        actionType,
        targetLevel: target?.level ?? null,
        targetId: target?.id ?? null,
        targetName: target?.name ?? null,
        newDailyBudget: actionType === "update_budget" ? rec.new_daily_budget : null,
      },
    });
  }
}

/** Approver's edits before applying ("Sửa trước khi làm" (edit before applying)). */
export type ApproveEdits = {
  name?: string;
  dailyBudget?: number | null;
  detailedTargeting?: { id: string; name: string; type: string }[] | null;
  advantageAudience?: boolean | null;
  variants?: AdVariant[];
  brief?: string;
};

/** User clicks Approve (or the system applies it, opts.by = "Tự động"): re-check limits, call the Meta API, update the DB. */
export async function approveRecommendation(id: string, overrideBudget?: number, edits?: ApproveEdits, opts: { by?: string } = {}) {
  const t = await getT();
  const rec = await db.recommendation.findUniqueOrThrow({ where: { id }, include: { client: true } });
  if (rec.status !== "pending") throw new Error(t("workflow.recs.alreadyHandled"));
  const client = rec.client;
  // Reserve before calling Meta: if two people (or two tabs) click Approve at once, it's executed only once.
  const claimed = await db.recommendation.updateMany({ where: { id, status: "pending" }, data: { status: "executing", decidedAt: new Date() } });
  if (!claimed.count) throw new Error(t("workflow.recs.handledElsewhere"));

  if (rec.actionType === "manual") {
    await finish(rec, "done", t("workflow.recs.markedDone"));
    return;
  }

  // Actions Meta HAS completed (even partially). Errors after that (usually a failed DB write) must not return the card
  // to the queue: re-approving would act a second time on Meta (creating duplicate ad sets / ads).
  let applied: { result: string; params?: unknown } | null = null;
  try {
    const meta = getMetaClient(client);
    // Campaign optimization: store the 7-day metrics before applying so they can be compared 3 / 7 days later.
    const baseline = rec.kind === "optimize" && rec.actionType !== "new_draft" && rec.actionType !== "manual" ? await captureBaseline(client, rec) : null;
    const done = async (result: string, params?: unknown) => {
      applied = { result, params };
      const by = opts.by ?? (await actorName());
      await retryBusy(() => db.recommendation.update({
        where: { id: rec.id },
        data: {
          status: "executed",
          result,
          decidedAt: new Date(),
          executedAt: new Date(),
          decidedBy: by,
          ...(baseline && { baseline: JSON.stringify(baseline) }),
          ...(params !== undefined && { params: JSON.stringify(params) }),
        },
      }));
      await logActivity(rec.clientId, "execute", `${rec.title}: ${result}`);
    };

    if (rec.actionType === "duplicate_adset") {
      const p = { ...(JSON.parse(rec.params) as DuplicateParams), ...pickDefined(edits, ["name", "dailyBudget", "detailedTargeting", "advantageAudience"]) } as DuplicateParams;
      if (!p.name?.trim()) throw new Error(t("workflow.recs.noGroupName"));
      if (p.dailyBudget != null && client.maxDailyBudget && p.dailyBudget > client.maxDailyBudget) throw new Error(t("workflow.recs.overMax", { max: money(client.maxDailyBudget, client.currency) }));
      const newId = await meta.duplicateAdSet(p.sourceAdSetId, {
        name: p.name.trim(),
        dailyBudget: p.dailyBudget,
        detailedTargeting: p.detailedTargeting,
        advantageAudience: p.advantageAudience,
        excludePlatforms: p.excludePlatforms,
        genders: p.genders,
        ageMin: p.ageMin,
        ageMax: p.ageMax,
        locales: p.locales,
        ageRange: p.ageRange,
      });
      applied = { result: t("workflow.recs.createdGroup", { name: p.name, id: newId }), params: { ...p, createdId: newId } };
      await done(
        t("workflow.recs.createdGroup", { name: p.name, id: newId }) + (p.detailedTargeting?.length ? t("workflow.recs.audienceList", { names: p.detailedTargeting.map((x) => x.name).join(", ") }) : p.detailedTargeting ? t("workflow.recs.broadAudience") : t("workflow.recs.keepAudience")) + t("workflow.recs.enableWhenReady"),
        { ...p, createdId: newId },
      );
      return;
    }
    if (rec.actionType === "update_targeting") {
      const p = JSON.parse(rec.params) as UpdateTargetingParams;
      const updated = await meta.updateAdSetTargeting(p.adSetId, p.patch);
      applied = { result: t("workflow.recs.editedAudience", { name: rec.targetName ?? "" }), params: p };
      const local = await db.adSet.findFirst({ where: { id: p.adSetId, clientId: client.id } });
      if (local) await db.adSet.update({ where: { id: local.id }, data: { targeting: JSON.stringify(updated) } });
      await done(t("workflow.recs.editedAudienceDetail", { name: rec.targetName ?? "", langBefore: p.before.locales, langAfter: p.after.locales, ageBefore: p.before.age, ageAfter: p.after.age }), p);
      return;
    }
    if (rec.actionType === "add_ad") {
      const p = JSON.parse(rec.params) as AddAdParams;
      const variants = (edits?.variants ?? p.variants).filter((v) => v.primary_text.trim());
      if (!variants.length) throw new Error(t("workflow.recs.noAdContent"));
      const ids: string[] = [];
      for (const [i, v] of variants.slice(0, 3).entries()) {
        ids.push(await meta.addAdFromTemplate(p.adSetId, p.templateAdId, `${p.templateName} - Mới ${i + 1}`, v));
        applied = { result: t("workflow.recs.addedAds", { count: ids.length, group: rec.targetName ?? "" }), params: { ...p, variants, createdIds: [...ids] } };
      }
      await done(t("workflow.recs.addedAdsDetail", { count: ids.length, group: rec.targetName ?? "", template: p.templateName }), { ...p, variants, createdIds: ids });
      return;
    }
    if (rec.actionType === "new_draft") {
      const brief = (edits?.brief ?? (JSON.parse(rec.params) as { brief?: string }).brief ?? "").trim();
      if (brief.length < 10) throw new Error(t("workflow.recs.briefTooShort"));
      const draftId = await draftCampaign(client.id, {
        product: brief.slice(0, 500),
        goal: (RESULT_TYPES as readonly string[]).includes(client.primaryResult) ? client.primaryResult : "messages",
        dailyBudget: client.maxDailyBudget ?? defaultDailyBudget(client.currency),
        locations: t("workflow.recs.draftLocations"),
        ageMin: 18,
        ageMax: 65,
        notes: `${t("workflow.recs.draftNotes", { title: rec.title })}\n${rec.rationale}\n${brief}`,
      });
      await done(t("workflow.recs.draftCreated"), { brief, draftId });
      return;
    }

    const target = await findTarget(client.id, rec.targetLevel, rec.targetId);
    if (!target) throw new Error(t("workflow.recs.objectGone"));
    if (rec.actionType === "pause" || rec.actionType === "resume") {
      const status = rec.actionType === "pause" ? "PAUSED" : "ACTIVE";
      await meta.setStatus(target.level, target.id, status);
      applied = { result: t("workflow.recs.switchedTo", { name: target.name, status }), params: { ...JSON.parse(rec.params || "{}"), prevStatus: target.status } };
      await updateLocal(target, { status });
      // Store the old state so Undo works.
      await done(t("workflow.recs.switchedTo", { name: target.name, status }), { ...JSON.parse(rec.params || "{}"), prevStatus: target.status });
    } else if (rec.actionType === "update_budget") {
      if (target.level === "ad") throw new Error(t("workflow.recs.adNoBudget"));
      const next = overrideBudget ?? rec.newDailyBudget;
      const err = checkBudget(client, target.dailyBudget, next, t);
      if (err) throw new Error(err);
      // A "budget increase" card built from old numbers: if the budget was already raised (manually / in Ads Manager) to or beyond the proposed level, approving would DECREASE it.
      if (overrideBudget == null && rec.rule === "adset_winner" && target.dailyBudget != null && next! <= target.dailyBudget) {
        throw new Error(t("workflow.recs.budgetAlreadyHigher", { current: money(target.dailyBudget, client.currency), proposed: money(next, client.currency) }));
      }
      await meta.setDailyBudget(target.level, target.id, next!);
      applied = { result: t("workflow.recs.budgetChanged", { name: target.name, from: money(target.dailyBudget, client.currency), to: money(next, client.currency) }), params: { ...JSON.parse(rec.params || "{}"), prevBudget: target.dailyBudget } };
      await updateLocal(target, { dailyBudget: next });
      await done(t("workflow.recs.budgetChanged", { name: target.name, from: money(target.dailyBudget, client.currency), to: money(next, client.currency) }), { ...JSON.parse(rec.params || "{}"), prevBudget: target.dailyBudget });
    }
  } catch (err) {
    const done = applied as { result: string; params?: unknown } | null;
    if (done) {
      // Meta acted: record it as applied (with created IDs for Undo / no redo), only warn about the later error.
      const note = `${done.result} · ${t("workflow.recs.saveFailed", { error: errorMessage(err) })}`;
      const by = opts.by ?? (await actorName().catch(() => null));
      await retryBusy(() =>
        db.recommendation.update({
          where: { id },
          data: { status: "executed", result: note, decidedAt: new Date(), executedAt: new Date(), decidedBy: by, ...(done.params !== undefined && { params: JSON.stringify(done.params) }) },
        }),
      ).catch(() => {});
      await logActivity(client.id, "error", `"${rec.title}": ${note}`).catch(() => {});
      return;
    }
    // Meta did nothing: return to the queue so the user can edit and re-approve.
    await db.recommendation.update({ where: { id }, data: { status: "pending", decidedAt: null, result: t("workflow.recs.errorPrefix", { error: errorMessage(err) }) } });
    await logActivity(client.id, "error", t("workflow.recs.executeFailed", { title: rec.title, error: errorMessage(err) }));
    throw err;
  }
}

async function updateLocal(t: Target, data: { status?: string; dailyBudget?: number | null }) {
  if (t.level === "campaign") await db.campaign.update({ where: { id: t.id }, data });
  else if (t.level === "adset") await db.adSet.update({ where: { id: t.id }, data });
  else await db.ad.update({ where: { id: t.id }, data: { status: data.status } });
}

async function finish(rec: Recommendation, status: string, result: string) {
  await db.recommendation.update({ where: { id: rec.id }, data: { status, result, decidedAt: new Date(), decidedBy: await actorName() } });
  await logActivity(rec.clientId, "execute", `${rec.title}: ${result}`);
}

/**
 * Undo a pause / budget change already applied (especially ones the system applied itself): re-enable / restore the old budget on Meta.
 * That object won't be recommended the same action for 3 days (optimize.ts coolingFor).
 */
export async function undoRecommendation(id: string) {
  const t = await getT();
  const rec = await db.recommendation.findUniqueOrThrow({ where: { id }, include: { client: true } });
  const p = JSON.parse(rec.params || "{}") as { prevStatus?: string; prevBudget?: number | null };
  if (rec.status !== "executed" || rec.undoneAt) throw new Error(t("workflow.recs.notUndoable"));
  const target = await findTarget(rec.clientId, rec.targetLevel, rec.targetId);
  if (!target) throw new Error(t("workflow.recs.objectGone"));
  const meta = getMetaClient(rec.client);
  let what: string;
  if (rec.actionType === "pause" && p.prevStatus === "ACTIVE") {
    await meta.setStatus(target.level, target.id, "ACTIVE");
    await updateLocal(target, { status: "ACTIVE" });
    what = t("workflow.recs.undoEnable", { name: target.name });
  } else if (rec.actionType === "update_budget" && p.prevBudget != null && target.level !== "ad") {
    await meta.setDailyBudget(target.level, target.id, p.prevBudget);
    await updateLocal(target, { dailyBudget: p.prevBudget });
    what = t("workflow.recs.undoBudget", { name: target.name, value: money(p.prevBudget, rec.client.currency) });
  } else throw new Error(t("workflow.recs.undoManual"));
  const by = (await actorName()) ?? t("workflow.recs.userFallback");
  await db.recommendation.update({ where: { id }, data: { undoneAt: new Date(), result: `${rec.result ?? ""} · ${t("workflow.recs.undone", { what, by })}` } });
  await logActivity(rec.clientId, "execute", t("workflow.recs.undoLog", { title: rec.title, what }));
}

export async function rejectRecommendation(id: string, reason?: string) {
  const t = await getT();
  const r = await db.recommendation.updateMany({
    where: { id, status: "pending" },
    data: { status: "rejected", decidedAt: new Date(), decidedBy: await actorName(), ...(reason && { result: t("workflow.recs.skipped", { reason: reason.slice(0, 200) }) }) },
  });
  if (!r.count) throw new Error(t("workflow.recs.alreadyHandled"));
  const rec = await db.recommendation.findUniqueOrThrow({ where: { id } });
  await logActivity(rec.clientId, "reject", t("workflow.recs.skipLog", { title: rec.title }) + (reason ? ` (${reason})` : ""));
}

// ------------------------------------------------------------ Manual actions (like on/off in Ads Manager)

/** User toggles on/off on the Performance table. A human action, so it skips the approval queue. */
export async function manualSetStatus(clientId: string, level: string, id: string, status: "ACTIVE" | "PAUSED") {
  const t = await getT();
  // TypeScript types aren't checked at runtime: block values like DELETED/ARCHIVED.
  if (status !== "ACTIVE" && status !== "PAUSED") throw new Error(t("workflow.recs.invalidStatus"));
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId } });
  const target = await findTarget(clientId, level, id);
  if (!target) throw new Error(t("workflow.recs.objectNotFound"));
  await getMetaClient(client).setStatus(target.level, target.id, status);
  await updateLocal(target, { status });
  await logActivity(clientId, "execute", t("workflow.recs.manualToggle", { name: target.name, state: status === "ACTIVE" ? t("workflow.recs.stateOn") : t("workflow.recs.stateOff") }));
}

/** User edits the budget manually. Only the max daily budget limit applies (not the % limit used for Claude's recommendations). */
export async function manualSetBudget(clientId: string, level: string, id: string, amount: number) {
  const t = await getT();
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId } });
  const target = await findTarget(clientId, level, id);
  if (!target || target.level === "ad") throw new Error(t("workflow.recs.noBudgetObject"));
  if (target.dailyBudget == null) throw new Error(t("workflow.recs.noDailyBudget"));
  if (!Number.isFinite(amount) || amount <= 0) throw new Error(t("workflow.recs.invalidBudgetShort"));
  if (client.maxDailyBudget && amount > client.maxDailyBudget) {
    throw new Error(t("workflow.recs.overMaxSettings", { max: money(client.maxDailyBudget, client.currency) }));
  }
  await getMetaClient(client).setDailyBudget(target.level, target.id, amount);
  await updateLocal(target, { dailyBudget: amount });
  await logActivity(clientId, "execute", t("workflow.recs.manualBudget", { name: target.name, from: money(target.dailyBudget, client.currency), to: money(amount, client.currency) }));
}
