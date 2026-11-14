import { randomUUID } from "node:crypto";
import type { ClientJob } from "@prisma/client";
import { db, retryBusy } from "./db";
import { logActivity } from "./activity";
import { syncClient } from "./sync";
import { formatEta, recordSeconds, typicalSeconds } from "./job-timing";
import { runOptimize } from "./optimize";
import { runCreativeAnalysis } from "./creative-analysis";
import { analyzeConversations, analyzeIdleConversations } from "./ai/tasks";
import { conversationsToSummarize } from "./freshness";
import { IDLE_HOURS } from "./schedule";
import { runAudienceAnalysis } from "./audience";
import { draftFromIdea, proposeCampaigns, type ProposalBrief } from "./proposals";
import { runContentPlan, runPolicyCheck } from "./content-review";
import { runDraftPolicyCheck } from "./draft-policy";
import { runNurtureCheck, runNurtureWrite } from "./nurture";
import { CANCELLED, throwIfStopped } from "./job-signal";
import { getT } from "@/i18n/server";
import type { MessageKey, T } from "@/i18n/translate";

// Background jobs per client (processed by scripts/targeting-worker.ts). The manual way (individual buttons) remains unchanged.
// The worker runs multiple jobs in parallel (different clients), at most 1 job per client at a time. Each run has a reservation code
// (allocationId): every write includes it, so a cancelled / reclaimed job's old run cannot overwrite and stops itself.

/** items: detailed report of the step (e.g. each synced channel + counts). warn = missing / error. */
export type JobStepItem = { label: string; value: string; warn?: boolean };
/** ref: the step's result id (e.g. created draft), so resuming after an interruption keeps prior results. */
export type JobStep = { key: string; label: string; status: "pending" | "running" | "done" | "skipped" | "failed"; detail?: string; note?: string; items?: JobStepItem[]; ref?: string };

const JOB_LABEL: Record<string, string> = { full_analysis: "Phân tích đầy đủ", propose_campaigns: "Claude đề xuất chiến dịch", draft_campaigns: "Soạn chiến dịch từ đề xuất", conversations: "Phân tích tin nhắn", conv_idle: "Đọc hội thoại đã im lặng", sync: "Đồng bộ dữ liệu", optimize: "Tối ưu chiến dịch", creative: "Phân tích nội dung quảng cáo", content_check: "Kiểm tra chính sách nội dung", content_plan: "Soạn phương án quảng cáo", draft_check: "Kiểm tra chính sách bản nháp", nurture_write: "Claude soạn tin chăm sóc lại", nurture_check: "Kiểm tra chính sách tin chăm sóc", google_negatives: "Claude lọc từ khóa phủ định Google", google_restructure: "Claude tách nhóm & viết quảng cáo Google" };

/** Job names in the UI language of `t` (JOB_LABEL stays Vietnamese for existing importers). */
export const jobLabels = (t: T): Record<string, string> => Object.fromEntries(Object.keys(JOB_LABEL).map((k) => [k, t(`core.jobs.label.${k}` as MessageKey)]));

const STEP_LABEL_KEY: Record<string, MessageKey> = {
  sync: "customers.actions.stepSync",
  conversations: "customers.actions.stepConv",
  audience: "core.jobs.step.audience",
  creative: "customers.actions.stepCreative",
  optimize: "customers.actions.stepOptimize",
  ideas: "customers.actions.stepIdeas",
  policy: "targeting.contentActions.stepPolicy",
  plan: "targeting.contentActions.stepPlan",
};
/**
 * Display label of a job step. Step labels are stored in the job's JSON in the language of whoever queued it
 * (background schedules write Vietnamese), so known step keys are re-translated with `t`; other steps (e.g. idea titles) keep their stored label.
 */
export function stepLabel(kind: string, step: Pick<JobStep, "key" | "label">, t: T): string {
  if (step.key === "conversations_idle") return t("workflow.plan.lanes.idleTitle", { hours: IDLE_HOURS });
  if (step.key === "ai") return kind === "google_negatives" ? t("settings.googleActions.stepNegatives") : kind === "google_restructure" ? t("settings.googleActions.stepRestructure") : step.label;
  const k = STEP_LABEL_KEY[step.key];
  if (k) return t(k);
  return step.key in JOB_LABEL ? t(`core.jobs.label.${step.key}` as MessageKey) : step.label;
}

const fullSteps = (t: T): Omit<JobStep, "status">[] => [
  { key: "sync", label: t("core.jobs.label.sync") },
  { key: "conversations", label: t("core.jobs.label.conversations") },
  { key: "audience", label: t("core.jobs.step.audience") },
];

/** Enqueue; does not create a duplicate when the client already has a queued / running job of the same type. */
export async function enqueueClientJob(
  clientId: string,
  kind: "full_analysis" | "propose_campaigns" | "draft_campaigns" | "conversations" | "conv_idle" | "sync" | "optimize" | "creative" | "content_check" | "content_plan" | "nurture_write" | "nurture_check" | "google_negatives" | "google_restructure",
  triggeredBy: string | null,
  opts: { params?: Record<string, unknown>; steps?: Omit<JobStep, "status">[] } = {},
) {
  const pending = await db.clientJob.findFirst({ where: { clientId, kind, status: { in: ["queued", "running"] } } });
  if (pending) return pending;
  const steps = opts.steps ?? fullSteps(await getT());
  return db.clientJob.create({
    data: { clientId, kind, triggeredBy, params: JSON.stringify(opts.params ?? {}), steps: JSON.stringify(steps.map((s) => ({ ...s, status: "pending" }))) },
  });
}

/** A "running" job without a heartbeat for too long = worker died abruptly: return it to the queue, resuming from the unfinished step next time. */
const JOB_STALE_MS = 3 * 60_000;

/** Max concurrent jobs per business (across all workers), so one agency queuing many jobs doesn't take every slot. */
const WORKSPACE_JOB_LIMIT = Math.max(1, Number(process.env.WORKSPACE_JOB_LIMIT) || 2);

/**
 * Atomically reserve the next job (queued → running, issuing a new reservation code). Safe when several workers claim jobs at once:
 * a Postgres advisory lock serializes claims, so no 2 workers grab jobs of the same client.
 * Fair ordering: skip clients with a running job and businesses already running WORKSPACE_JOB_LIMIT jobs; then prefer
 * the business running the fewest jobs, then the earliest-queued job.
 */
export async function claimNextClientJob() {
  const allocationId = randomUUID();
  const rows = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('workzone-ai-ads:claim-client-job'))`;
    return tx.$queryRaw<{ id: string }[]>`
      WITH busy AS (
        SELECT c."workspaceId" AS ws, COUNT(*)::int AS n
        FROM "ClientJob" r JOIN "Client" c ON c.id = r."clientId"
        WHERE r.status = 'running'
        GROUP BY c."workspaceId"
      ),
      pick AS (
        SELECT j.id
        FROM "ClientJob" j
        JOIN "Client" c ON c.id = j."clientId"
        LEFT JOIN busy b ON b.ws IS NOT DISTINCT FROM c."workspaceId"
        WHERE j.status = 'queued'
          AND NOT EXISTS (SELECT 1 FROM "ClientJob" r WHERE r."clientId" = j."clientId" AND r.status = 'running')
          AND COALESCE(b.n, 0) < ${WORKSPACE_JOB_LIMIT}
        ORDER BY COALESCE(b.n, 0) ASC, j."createdAt" ASC
        LIMIT 1
      )
      UPDATE "ClientJob" u
      SET status = 'running', "allocationId" = ${allocationId}, "startedAt" = COALESCE(u."startedAt", NOW()), "updatedAt" = NOW()
      FROM pick WHERE u.id = pick.id
      RETURNING u.id`;
  });
  return rows[0] ? db.clientJob.findUnique({ where: { id: rows[0].id } }) : null;
}

/** Return "running" jobs that lost their heartbeat (worker died without cleanup) to the queue. */
export async function requeueStaleClientJobs() {
  const r = await db.clientJob.updateMany({ where: { status: "running", updatedAt: { lt: new Date(Date.now() - JOB_STALE_MS) } }, data: { status: "queued", allocationId: null } });
  return r.count;
}

type Lease = Pick<ClientJob, "id" | "allocationId">;
const leaseWhere = (j: Lease) => ({ id: j.id, allocationId: j.allocationId, status: "running" });

/** Heartbeat for running jobs. Returns ids of jobs no longer owned by this run (cancelled on the web, reclaimed) so the worker stops. */
export async function heartbeatClientJobs(running: Lease[]) {
  if (!running.length) return [];
  const rows = await db.clientJob.findMany({ where: { id: { in: running.map((j) => j.id) } }, select: { id: true, status: true, allocationId: true } });
  const row = (j: Lease) => rows.find((r) => r.id === j.id);
  const alive = running.filter((j) => row(j)?.status === "running" && row(j)?.allocationId === j.allocationId);
  if (alive.length) await db.clientJob.updateMany({ where: { OR: alive.map(leaseWhere) }, data: { updatedAt: new Date() } });
  // done / failed: the job just finished on its own, not cancelled.
  return running.filter((j) => !alive.includes(j) && !["done", "failed"].includes(row(j)?.status ?? "")).map((j) => j.id);
}

/** Worker shutting down (deploy, restart): return jobs to the queue immediately, resuming from the unfinished step next time. */
export const requeueClientJob = (j: Lease) => db.clientJob.updateMany({ where: leaseWhere(j), data: { status: "queued", allocationId: null } });

/** Job ran over time: mark as failed (the worker stops what is running). */
export async function failClientJob(j: Lease & Pick<ClientJob, "clientId" | "kind">, error: string) {
  const t = await getT();
  const r = await db.clientJob.updateMany({ where: leaseWhere(j), data: { status: "failed", error, finishedAt: new Date() } });
  if (r.count) await logActivity(j.clientId, "error", t("core.jobs.stopped", { job: jobLabels(t)[j.kind] ?? t("core.jobs.background"), error }));
}

export async function processClientJob(job: ClientJob) {
  const t = await getT();
  const steps: JobStep[] = JSON.parse(job.steps);
  const mine = leaseWhere(job);
  // Write with the reservation code: write fails = job cancelled / reclaimed → stop.
  const save = async () => {
    throwIfStopped();
    // DB busy (another process holds the write lock): retry, so one progress write doesn't fail the whole job.
    const r = await retryBusy(() => db.clientJob.updateMany({ where: mine, data: { steps: JSON.stringify(steps) } }));
    if (!r.count) throw new Error(CANCELLED);
  };
  const run = async (key: string, fn: () => Promise<string | { detail: string; note?: string; items?: JobStepItem[]; ref?: string } | void>, skipIf?: () => Promise<string | null>) => {
    const s = steps.find((x) => x.key === key);
    if (!s || s.status === "done" || s.status === "skipped") return; // jobs with only some of the steps (e.g. message analysis only)
    const skip = skipIf ? await skipIf() : null;
    if (skip) {
      s.status = "skipped";
      s.detail = skip;
      return save();
    }
    s.status = "running";
    await save();
    try {
      const r = await fn();
      if (typeof r === "string") s.detail = r;
      else if (r) {
        s.detail = r.detail;
        s.note = r.note;
        if (r.items) s.items = r.items;
        if (r.ref) s.ref = r.ref;
      }
      s.status = "done";
    } catch (err) {
      s.status = "failed";
      s.detail = err instanceof Error ? err.message : String(err);
      await save();
      throw err;
    }
    await save();
  };

  if (job.kind === "propose_campaigns") {
    const { brief } = JSON.parse(job.params) as { brief?: ProposalBrief };
    try {
      await run("ideas", async () => ({ detail: t("core.jobs.ideasReady"), ref: await proposeCampaigns(job.clientId, brief) }));
      await db.clientJob.updateMany({ where: mine, data: { status: "done", finishedAt: new Date() } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === CANCELLED) return;
      await db.clientJob.updateMany({ where: mine, data: { status: "failed", error: msg, finishedAt: new Date() } });
    }
    return;
  }

  if (job.kind === "draft_campaigns") {
    // Each selected idea is one step: drafted into a draft. One failing idea doesn't block the others.
    const params = JSON.parse(job.params) as { proposalId: string; ideas: number[]; answers: Record<string, string> };
    let failed = 0;
    for (const idx of params.ideas) {
      try {
        await run(`idea${idx}`, async () => ({ detail: t("core.jobs.draftCreated"), ref: await draftFromIdea(params.proposalId, idx, params.answers) }));
      } catch (err) {
        if (err instanceof Error && err.message === CANCELLED) return;
        failed++;
      }
    }
    const draftIds = steps.flatMap((x) => (x.ref ? [x.ref] : [])); // includes drafts from the previous run if it was interrupted midway
    await db.campaignProposal.update({ where: { id: params.proposalId }, data: { status: "used", draftIds: JSON.stringify(draftIds) } });
    await db.clientJob.updateMany({
      where: mine,
      data: { status: failed && !draftIds.length ? "failed" : "done", finishedAt: new Date(), ...(failed && { error: t("core.jobs.ideasFailed", { n: failed }) }) },
    });
    await logActivity(job.clientId, "analyze", t("core.jobs.draftsDone", { n: draftIds.length }));
    return;
  }

  if (job.kind === "draft_check") {
    const { draftId, force } = JSON.parse(job.params) as { draftId: string; force?: boolean };
    try {
      await run("policy", () => runDraftPolicyCheck(draftId, !!force));
      await db.clientJob.updateMany({ where: mine, data: { status: "done", finishedAt: new Date() } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === CANCELLED) return;
      await db.clientJob.updateMany({ where: mine, data: { status: "failed", error: msg, finishedAt: new Date() } });
    }
    return;
  }

  if (job.kind === "google_negatives" || job.kind === "google_restructure") {
    try {
      const g = await import("./google-ads-rules");
      await run("ai", () => (job.kind === "google_negatives" ? g.claudeGoogleNegatives(job.clientId) : g.claudeGoogleRestructure(job.clientId)));
      await db.clientJob.updateMany({ where: mine, data: { status: "done", finishedAt: new Date() } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === CANCELLED) return;
      await db.clientJob.updateMany({ where: mine, data: { status: "failed", error: msg, finishedAt: new Date() } });
    }
    return;
  }

  if (job.kind === "nurture_write" || job.kind === "nurture_check") {
    const { flowId } = JSON.parse(job.params) as { flowId: string };
    try {
      await run("ai", () => (job.kind === "nurture_write" ? runNurtureWrite(flowId) : runNurtureCheck(flowId)));
      await db.clientJob.updateMany({ where: mine, data: { status: "done", finishedAt: new Date() } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === CANCELLED) return;
      await db.clientJob.updateMany({ where: mine, data: { status: "failed", error: msg, finishedAt: new Date() } });
    }
    return;
  }

  if (job.kind === "content_check" || job.kind === "content_plan") {
    const { reviewId, feedback } = JSON.parse(job.params) as { reviewId: string; feedback?: string | null };
    try {
      if (job.kind === "content_check")
        await run("policy", async () => {
          await runPolicyCheck(reviewId);
          return "Xong";
        });
      else
        await run("plan", async () => {
          await runContentPlan(reviewId, feedback ?? null);
          return "Xong";
        });
      await db.clientJob.updateMany({ where: mine, data: { status: "done", finishedAt: new Date() } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === CANCELLED) return;
      await db.clientJob.updateMany({ where: mine, data: { status: "failed", error: msg, finishedAt: new Date() } });
    }
    return;
  }

  try {
    await run("sync", async () => {
      const s = steps.find((x) => x.key === "sync")!;
      const t0 = Date.now();
      const eta = formatEta(await typicalSeconds("sync"));
      const r = await syncClient(job.clientId, async (label) => {
        s.detail = `${label} · ${eta}`; // which part is currently being fetched
        await save();
      });
      await recordSeconds("sync", (Date.now() - t0) / 1000);
      const notes = [...r.warnings, ...r.errors];
      const ok = r.channels.filter((c) => !c.warn).length;
      return { detail: t("core.jobs.sources", { ok, total: r.channels.length }), note: notes.length ? notes.join(" ") : undefined, items: r.channels };
    });
    await run(
      "conversations",
      async () => {
        const s = steps.find((x) => x.key === "conversations")!;
        // Update progress per batch (also keeps the job from being considered stuck during long runs).
        // Estimated time: before the first batch use the average of previous runs; afterwards use this run's actual speed.
        const [perBatch, merge] = await Promise.all([typicalSeconds("conv_batch"), typicalSeconds("conv_merge")]);
        let t0 = Date.now();
        let tDone = t0;
        const r = await analyzeConversations(job.clientId, async (done, total, info) => {
          if (done === 0) t0 = Date.now();
          if (done > 0) tDone = Date.now();
          const avg = done > 0 ? (tDone - t0) / 1000 / done : perBatch;
          const left = (total - done) * avg + (total > 1 ? merge : 0);
          const finish = new Date(Date.now() + left * 1000).toLocaleTimeString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit" });
          s.detail =
            done === total
              ? total > 1
                ? t("core.jobs.batchMerging", { done, total, eta: formatEta(merge, t) })
                : t("core.jobs.saving")
              : t("core.jobs.batchEta", { done, total, eta: formatEta(left, t), finish });
          s.items = [
            {
              label: t("core.jobs.toRead"),
              value: info.reread
                ? t("core.jobs.rereadLatest", { n: info.todo })
                : t("core.jobs.newConvs", { n: info.todo }) + (info.labeled ? t("core.jobs.mergedToday", { n: info.labeled }) : ""),
            },
          ];
          await save();
        });
        if (r.batches > 0) await recordSeconds("conv_batch", (tDone - t0) / 1000 / r.batches);
        if (r.batches > 1) await recordSeconds("conv_merge", (Date.now() - tDone) / 1000);
        const [hot, reply] = await Promise.all([
          db.conversation.count({ where: { clientId: job.clientId, leadScore: { gte: 75 } } }),
          db.conversation.count({ where: { clientId: job.clientId, needsReply: true } }),
        ]);
        return {
          detail: t("core.jobs.analyzedConvs", { n: r.analyzed }),
          items: [
            { label: t("core.jobs.readThisTime"), value: t("core.jobs.readSummary", { read: r.read, batches: r.batches }) + (r.reread ? t("core.jobs.rereadNote") : "") + (r.labeled ? t("core.jobs.mergedToday", { n: r.labeled }) : "") },
            { label: t("core.jobs.sample"), value: t("core.jobs.sampleValue", { analyzed: r.analyzed, window: r.window }) },
            { label: t("core.jobs.result"), value: t("core.jobs.resultAll", { hot, reply, recs: r.recommendations }) },
            ...(r.blocked ? [{ label: t("core.jobs.skipped"), value: t("core.jobs.blocked", { n: r.blocked }), warn: true }] : []),
          ],
        };
      },
      // Full analysis: skip when there are no new conversations; clicking "Phân tích tin nhắn" (Analyze messages) directly always runs (re-reads the most recent conversations).
      job.kind === "full_analysis" ? async () => ((await conversationsToSummarize(job.clientId)) ? null : t("core.jobs.noNewConvs")) : undefined,
    );
    // "Khi hội thoại im 3 giờ" (When a conversation is silent for 3 hours) mode: the hourly schedule reads conversations that stopped, labeling only (the overall report merges once a day in the step above).
    await run("conversations_idle", async () => {
      const s = steps.find((x) => x.key === "conversations_idle")!;
      const r = await analyzeIdleConversations(job.clientId, IDLE_HOURS, async (done, total, todo) => {
        s.detail = done === total ? t("core.jobs.saving") : t("core.jobs.batchConvs", { done, total, todo });
        await save();
      });
      if (!r.read) return t("core.jobs.noIdle", { hours: IDLE_HOURS });
      return {
        detail: t("core.jobs.readN", { n: r.read }),
        items: [
          { label: t("core.jobs.result"), value: t("core.jobs.resultHotReply", { hot: r.hot, reply: r.reply }) },
          ...(r.left ? [{ label: t("core.jobs.remaining"), value: t("core.jobs.remainingValue", { n: r.left }) }] : []),
          ...(r.blocked ? [{ label: t("core.jobs.skipped"), value: t("core.jobs.blocked", { n: r.blocked }), warn: true }] : []),
        ],
      };
    });
    await run("audience", async () => {
      const s = steps.find((x) => x.key === "audience")!;
      s.detail = t("core.jobs.buildingPersona", { eta: formatEta(await typicalSeconds("audience"), t) });
      await save();
      const t0 = Date.now();
      const id = await runAudienceAnalysis(job.clientId);
      await recordSeconds("audience", (Date.now() - t0) / 1000);
      const [analysis, ranking] = await Promise.all([
        db.audienceAnalysis.findUniqueOrThrow({ where: { id } }),
        db.targetingRanking.findFirst({ where: { clientId: job.clientId }, orderBy: { createdAt: "desc" } }),
      ]);
      const st = JSON.parse(analysis.stats) as { conversations: number; adSets: number; documents: number };
      const personas = (JSON.parse(analysis.report) as { personas: unknown[] }).personas.length;
      const items = ranking ? (JSON.parse(ranking.items) as { perf: number | null; verified?: boolean; industry?: unknown }[]) : [];
      return {
        detail: t("core.jobs.personaDetail", { personas, top: items.length }),
        items: [
          { label: t("core.jobs.basedOn"), value: t("core.jobs.basedOnValue", { convs: st.conversations, sets: st.adSets, docs: st.documents }) },
          { label: t("core.jobs.topTargeting"), value: t("core.jobs.topTargetingValue", { n: items.length, perf: items.filter((i) => i.perf != null).length, verified: items.filter((i) => i.verified).length }) + (items.some((i) => i.industry) ? t("core.jobs.topTargetingIndustry", { n: items.filter((i) => i.industry).length }) : "") },
        ],
      };
    });
    await run("creative", async () => {
      const s = steps.find((x) => x.key === "creative")!;
      const id = await runCreativeAnalysis(job.clientId, async (label) => {
        s.detail = label;
        await save();
      });
      const a = await db.audit.findUniqueOrThrow({ where: { id } });
      const r = JSON.parse(a.report) as { winning_patterns: unknown[]; losing_patterns: unknown[]; new_ads: unknown[]; ads: { tag: string }[] };
      return {
        detail: t("core.jobs.newAds", { n: r.new_ads.length }),
        items: [
          { label: t("core.jobs.compared"), value: t("core.jobs.comparedValue", { win: r.ads.filter((x) => x.tag === "THẮNG").length, lose: r.ads.filter((x) => x.tag === "THUA").length }) },
          { label: t("core.jobs.learned"), value: t("core.jobs.learnedValue", { win: r.winning_patterns.length, lose: r.losing_patterns.length }) },
        ],
      };
    });
    await run("optimize", async () => {
      const s = steps.find((x) => x.key === "optimize")!;
      const { campaignId } = JSON.parse(job.params || "{}") as { campaignId?: string };
      const r = await runOptimize(job.clientId, {
        campaignId,
        onProgress: async (label) => {
          s.detail = label;
          await save();
        },
      });
      return {
        detail: r.created ? t("core.jobs.recsPending", { n: r.created }) : t("core.jobs.nothingToDo"),
        items: [
          { label: t("core.jobs.checked"), value: t("core.jobs.checkedValue", { n: r.campaigns }) },
          { label: t("core.jobs.recommendations"), value: r.created ? t("core.jobs.newRecs", { n: r.created, findings: r.findings }) : t("core.jobs.noChange") },
          ...(r.evaluated ? [{ label: t("core.jobs.measured"), value: t("core.jobs.measuredValue", { n: r.evaluated }) }] : []),
        ],
      };
    });
    await retryBusy(() => db.clientJob.updateMany({ where: mine, data: { status: "done", finishedAt: new Date() } }));
    if (job.kind === "full_analysis") await logActivity(job.clientId, "analyze", t("core.jobs.fullDone") + (job.triggeredBy ? t("core.jobs.requestedBy", { by: job.triggeredBy }) : ""));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === CANCELLED) return;
    const r = await retryBusy(() => db.clientJob.updateMany({ where: mine, data: { status: "failed", error: msg, finishedAt: new Date() } }));
    if (r.count) await logActivity(job.clientId, "error", t("core.jobs.stopped", { job: jobLabels(t)[job.kind] ?? t("core.jobs.background"), error: msg }));
  }
}
