// Background process: per-client jobs (analysis, sync, campaign drafting...) + Targeting library update runs
// + fast message sync + re-engagement sends.
// Run:  npm run targeting:worker        (the Docker install runs it as the `worker` service)
//        npm run targeting:worker -- --once   (drain the queue, then exit)
//
// Each part is its own loop and does not wait on the others:
// - Client jobs: up to WORKER_CONCURRENCY jobs in parallel (default 3), 1 job per client at a time.
// - Targeting scans: one run at a time.
// - Fast message sync (2 min), ad metrics (15 min), re-engagement (1 min), targeting scan schedule (1 hour):
//   not blocked by long jobs.
import { EventEmitter } from "node:events";
import type { ClientJob } from "@prisma/client";
import { db } from "../src/lib/db";
import { bootstrapLibrary } from "../src/lib/targeting-store";
import { enqueueScheduled, processRun } from "../src/lib/targeting-crawl";
import { jobLabels, claimNextClientJob, failClientJob, heartbeatClientJobs, processClientJob, requeueClientJob, requeueStaleClientJobs } from "../src/lib/client-jobs";
import { runWithSignal } from "../src/lib/job-signal";
import { translator } from "../src/i18n/translate";
import { runWithAiScope } from "../src/lib/ai/credential";
import { runInBackground } from "../src/lib/meta/rate-limit";
import { runDueNurture } from "../src/lib/nurture";
import { runDueReports } from "../src/lib/report-schedule-run";
import { pollFormLeads, runLeadNotify } from "../src/lib/lead-notify";
import { runLeadReminders, runRecalls } from "../src/lib/lead-confirm";
import { quickSyncAds, quickSyncConversations } from "../src/lib/sync";
import { kiotDue, syncKiot } from "../src/lib/kiotviet-sync";
import { ghlDue, syncGhl } from "../src/lib/highlevel-sync";

const JOB_LABEL_EN = jobLabels(translator("en")); // console logs are in English

const once = process.argv.includes("--once");
// Run exactly one worker: the periodic loops below would otherwise send notifications / reports twice. For more capacity raise WORKER_CONCURRENCY.
const CONCURRENCY = Math.max(1, Number(process.env.WORKER_CONCURRENCY) || 3);
const JOB_TIMEOUT_MS = 2 * 3600_000; // safety cap: a job stuck for more than 2 hours is stopped, freeing the slot for others

let stopping = false;
const bell = new EventEmitter().setMaxListeners(0); // wakes sleeping loops (a job finished, or shutting down)
const stopped = new Promise<void>((r) => bell.once("stop", r));
const stop = () => {
  stopping = true;
  bell.emit("ring");
  bell.emit("stop");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(t);
      bell.off("ring", done);
      resolve();
    };
    const t = setTimeout(done, ms);
    bell.once("ring", done);
  });

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ------------------------------------------------------------------ Client jobs (parallel)

type Running = { job: ClientJob; ctl: AbortController; done: Promise<void> };
const running = new Map<string, Running>();

function start(job: ClientJob) {
  const ctl = new AbortController();
  const timer = setTimeout(() => {
    void failClientJob(job, `Chạy quá ${JOB_TIMEOUT_MS / 3600_000} giờ, đã dừng.`).finally(() => ctl.abort());
  }, JOB_TIMEOUT_MS);
  console.log(`Starting ${JOB_LABEL_EN[job.kind] ?? job.kind} · ${job.id} (${running.size + 1}/${CONCURRENCY})`);
  // Background jobs: when close to Meta's API rate limit, wait automatically to leave room for actions on the web.
  const done = runInBackground(() => runWithSignal(ctl.signal, () => runWithAiScope({ clientId: job.clientId }, () => processClientJob(job))))
    .catch((err) => console.error(`Job ${job.id} failed:`, errMsg(err)))
    .finally(() => {
      clearTimeout(timer);
      running.delete(job.id);
      bell.emit("ring");
    });
  running.set(job.id, { job, ctl, done });
}

async function jobLoop() {
  while (!stopping) {
    try {
      if (running.size < CONCURRENCY) {
        const job = await claimNextClientJob();
        if (job) {
          start(job);
          continue;
        }
      }
    } catch (err) {
      // Transient error (DB busy, network...): log it and retry later.
      console.error("Fetching client jobs failed, retrying in 15 seconds:", errMsg(err));
      await sleep(15_000);
      continue;
    }
    if (once && !running.size) return;
    await sleep(5_000);
  }
}

/** Heartbeat (lets the UI know the worker is alive) + keep claims on running jobs + stop jobs cancelled on the web. */
async function controlLoop() {
  let lastStale = 0;
  while (!stopping) {
    try {
      const now = new Date().toISOString();
      // Heartbeat: the UI uses it to know targeting scans / periodic schedules are running.
      await db.setting.upsert({ where: { key: "targeting.workerHeartbeat" }, create: { key: "targeting.workerHeartbeat", value: now }, update: { value: now } });
      for (const id of await heartbeatClientJobs([...running.values()].map((r) => r.job))) {
        console.log(`Job ${id} was cancelled / reclaimed, stopping.`);
        running.get(id)?.ctl.abort();
      }
      if (Date.now() - lastStale > 60_000) {
        lastStale = Date.now();
        const n = await requeueStaleClientJobs();
        if (n) console.log(`Returned ${n} jobs with a lost heartbeat (previous worker was killed) to the queue.`);
      }
    } catch (err) {
      console.error("Heartbeat failed:", errMsg(err));
    }
    await sleep(10_000);
  }
}

// ------------------------------------------------------------------ Targeting library (one run at a time)

const STALE_MS = 5 * 60_000;

/**
  * Next run. Claims atomically (queued → running) so two processes never run the same run.
  * A "running" run with no update for 5 minutes = the previous attempt was interrupted (VPS restart, deploy): resume from the checkpoint.
 */
async function nextRun() {
  const stale = await db.targetingRun.findFirst({
    where: { status: "running", kind: { not: "import" }, updatedAt: { lt: new Date(Date.now() - STALE_MS) } },
    orderBy: { createdAt: "asc" },
  });
  if (stale) {
    const claimed = await db.targetingRun.updateMany({ where: { id: stale.id, status: "running", updatedAt: stale.updatedAt }, data: { status: "running" } });
    if (claimed.count) return db.targetingRun.findUnique({ where: { id: stale.id } });
  }
  const queued = await db.targetingRun.findFirst({ where: { status: "queued" }, orderBy: { createdAt: "asc" } });
  if (!queued) return null;
  const claimed = await db.targetingRun.updateMany({ where: { id: queued.id, status: "queued" }, data: { status: "running", startedAt: new Date() } });
  return claimed.count ? db.targetingRun.findUnique({ where: { id: queued.id } }) : null;
}

async function targetingLoop() {
  while (!stopping) {
    let run;
    try {
      run = await nextRun();
    } catch (err) {
      console.error("Fetching targeting scan failed, retrying in 15 seconds:", errMsg(err));
      await sleep(15_000);
      continue;
    }
    if (run) {
      try {
        await runInBackground(() => processRun(run));
      } catch (err) {
        console.error(`Run ${run.id} failed:`, errMsg(err));
      }
      continue;
    }
    if (once) return;
    await sleep(15_000);
  }
}

// ------------------------------------------------------------------ Periodic jobs

/** Run fn every ms (measured from the start of the previous run). One failure does not stop the loop. */
async function every(name: string, ms: number, fn: () => Promise<void>) {
  while (!stopping) {
    const t0 = Date.now();
    try {
      await fn();
    } catch (err) {
      console.error(`${name} failed:`, errMsg(err));
    }
    await sleep(Math.max(5_000, ms - (Date.now() - t0)));
  }
}

async function scheduleTargeting() {
  for (const r of await enqueueScheduled()) console.log(`Scheduler: queued ${r.kind}`);
}

/** Messages: fast sync (covers cases the webhook misses, e.g. Page replies sent from the inbox). */
async function quickSync() {
  // Clients set to sync "Manual only" (Paused) are not pulled automatically (messages still arrive via webhook).
  const clients = await db.client.findMany({ where: { dataSource: "meta", metaAccessToken: { not: null }, syncMode: { not: "manual" } }, select: { id: true, name: true } });
  for (const c of clients) {
    if (stopping) return;
    // If this client already has a job running (e.g. full sync), let that job handle it.
    if (await db.clientJob.findFirst({ where: { clientId: c.id, status: "running" }, select: { id: true } })) continue;
    const key = `sync.quick.${c.id}`;
    let value: string;
    try {
      const n = await runInBackground(() => quickSyncConversations(c.id));
      if (n) console.log(`New messages · ${c.name}: ${n} conversations`);
      value = JSON.stringify({ at: new Date().toISOString(), every: 120, changed: n });
    } catch (err) {
      const msg = errMsg(err);
      console.error(`Quick message sync for ${c.name} failed:`, msg);
      value = JSON.stringify({ at: new Date().toISOString(), every: 120, error: msg.slice(0, 200) });
    }
    // The Messages page reads this timestamp to show "updated at … · next scan …".
    await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
  }
}

/** Ad metrics: refresh the campaign table (7 days including today) so the latest numbers are always shown. */
async function quickAds() {
  const clients = await db.client.findMany({
    where: { dataSource: "meta", metaAccessToken: { not: null }, metaAdAccountId: { not: null }, syncMode: { not: "manual" } },
    select: { id: true, name: true },
  });
  for (const c of clients) {
    if (stopping) return;
    // If this client already has a job running (e.g. full sync), let that job handle it.
    if (await db.clientJob.findFirst({ where: { clientId: c.id, status: "running" }, select: { id: true } })) continue;
    const key = `sync.ads.${c.id}`;
    let value: string;
    try {
      const n = await runInBackground(() => quickSyncAds(c.id));
      value = JSON.stringify({ at: new Date().toISOString(), every: 900, campaigns: n });
    } catch (err) {
      const msg = errMsg(err);
      console.error(`Ads refresh for ${c.name} failed:`, msg);
      value = JSON.stringify({ at: new Date().toISOString(), every: 900, error: msg.slice(0, 200) });
    }
    // The campaign table reads this timestamp to show "metrics as of …".
    await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
  }
}

/** Re-engagement: which sequences are due to send (automatic schedule or the user clicked "Send now"). */
async function nurture() {
  for (const line of await runInBackground(() => runDueNurture())) console.log(`Nurture · ${line}`);
}

/** New-lead notifications to the client's Zalo / Telegram group (Client list → Lead notifications). */
async function leadNotify() {
  for (const line of await runLeadNotify()) console.log(`Lead notify · ${line}`);
  for (const line of await runLeadReminders()) console.log(`Lead notify · ${line}`);
  for (const line of await runRecalls()) console.log(`Lead notify · ${line}`);
}
/** Client report schedules (Notifications & reports → Report schedule): schedules due at this hour:minute are built, and sent right away if auto-send is on. */
async function reports() {
  for (const line of await runInBackground(() => runDueReports())) console.log(`Client reports · ${line}`);
}
async function formLeads() {
  await runInBackground(() => pollFormLeads());
}

/** KiotViet: clients that are due (clicked Sync now / history not fully pulled / more than 2 hours). Each client gets at most 15 minutes per turn, then yields. */
async function kiotviet() {
  const clients = await db.client.findMany({ where: { kiotSecret: { not: null } } });
  for (const c of clients) {
    if (stopping) return;
    if (!kiotDue(c)) continue;
    try {
      const r = await syncKiot(c.id, { budgetMs: 15 * 60_000, shouldStop: () => stopping });
      console.log(`KiotViet · ${c.name}: ${r.customers} customers, ${r.days} days, ${r.invoices} invoices${r.complete ? "" : " (history not finished, continues next run)"}`);
    } catch (err) {
      console.error(`KiotViet · ${c.name} failed:`, errMsg(err));
    }
  }
}

/** HighLevel CRM: clients that are due (clicked Sync now / more than 30 minutes) → push new leads + pull pipeline stages. */
async function highlevel() {
  const clients = await db.client.findMany({ where: { ghlToken: { not: null } } });
  for (const c of clients) {
    if (stopping) return;
    if (!ghlDue(c)) continue;
    try {
      const r = await syncGhl(c.id);
      if (r.pushed || r.updated || r.pending) console.log(`HighLevel · ${c.name}: pushed ${r.pushed} customers${r.pending ? ` (${r.pending} left, continues next run)` : ""}, ${r.updated} ratings changed by stage`);
    } catch (err) {
      console.error(`HighLevel · ${c.name} failed:`, errMsg(err));
    }
  }
}

// ------------------------------------------------------------------

/** Shutdown (deploy, restart): return running jobs to the queue, then stop them; next time they resume from the unfinished step. */
async function shutdown() {
  const list = [...running.values()];
  for (const r of list) {
    await requeueClientJob(r.job).catch(() => {});
    r.ctl.abort();
  }
  if (list.length) console.log(`Shutting down: returning ${list.length} jobs to the queue.`);
  await Promise.race([Promise.allSettled(list.map((r) => r.done)), new Promise((r) => setTimeout(r, 10_000))]);
}

async function main() {
  if (await bootstrapLibrary()) console.log("Library initialised from data/targeting.json");
  console.log(`Worker running: up to ${CONCURRENCY} client jobs at once${once ? " (--once)" : ""}`);
  void controlLoop();
  const loops = once
    ? Promise.all([jobLoop(), targetingLoop()])
    : Promise.all([
        jobLoop(),
        targetingLoop(),
        every("Targeting scan schedule", 3600_000, scheduleTargeting),
        every("Quick message sync", 120_000, quickSync),
        every("Ads data refresh", 900_000, quickAds),
        every("Nurture", 60_000, nurture),
        every("Lead notify", 60_000, leadNotify),
        every("Report schedule", 60_000, reports),
        every("Read lead forms (lead notify)", 300_000, formLeads),
        every("KiotViet", 60_000, kiotviet),
        every("HighLevel", 60_000, highlevel),
      ]);
  // While shutting down, don't wait for an unfinished targeting scan (it has a checkpoint and resumes next time): return client jobs to the queue immediately.
  await Promise.race([loops, stopped]);
  stop();
  await shutdown();
  await db.$disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await db.$disconnect();
  process.exit(1);
});
