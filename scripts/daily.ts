// Automatic update schedule; cron runs it EVERY HOUR (see deploy/crontab.txt). Each client picks a schedule in Settings → Schedule & automation:
// - Full sync: at the chosen hours / manual only (lib/schedule.ts). Ad metrics + messages are refreshed by the background process
//   every 15 / 2 minutes, so full syncs need not be frequent.
// - Claude: only runs steps that have new data (lib/freshness.ts), in mode: when a conversation goes quiet for 3 hours / daily / every sync / off.
//   "When a conversation goes quiet for 3 hours": every hour, read conversations with no messages for 3 hours; overall report + persona + audit once a day as in "daily"
//   (first sync from 6am, AI_SUMMARY_HOUR).
// - Automation (lib/auto-rules.ts): every hour within the client's time window, auto-pause expensive ad sets / ads and raise the budget of winning ad sets that are running out of money.
// - Client reports (email / Telegram / Zalo OA) on a weekly / monthly schedule (lib/client-report.ts); refresh the Zalo token before it expires.
// Heavy work is queued as ClientJob; the background process (targeting-worker) runs them in turn and shows progress on the web.
// Manual run: npx tsx scripts/daily.ts [--force] [client id or name]   (--force: ignore the schedule, sync + analyze now)
import { closeSync, mkdirSync, openSync, rmSync, statSync } from "node:fs";
import { db } from "../src/lib/db";
import { runAccountAudit } from "../src/lib/ai/tasks";
import { errorMessage, logActivity } from "../src/lib/activity";
import { checkAllTokens } from "../src/lib/token-status";
import { buildRanking } from "../src/lib/audience";
import { enqueueClientJob } from "../src/lib/client-jobs";
import { auditFreshness, audienceFreshness, conversationFreshness, idleConversationCount } from "../src/lib/freshness";
import { IDLE_HOURS, isAiAllowed, isOptimizeDue, isSyncDue, localTime, toAiMode } from "../src/lib/schedule";
import { accessToken, loadOa } from "../src/lib/zalo";
import { isAutoDue, runAutoRules } from "../src/lib/auto-rules";
import { loadGoogleAds } from "../src/lib/google-ads";
import { isGoogleSyncDue, syncGoogleAds } from "../src/lib/google-ads-sync";
import { runGoogleRules } from "../src/lib/google-ads-rules";
import { pruneAllMessageImages } from "../src/lib/msg-images";
import { expireStaleRecommendations } from "../src/lib/recommendations";
import { translator } from "../src/i18n/translate";
import { DEFAULT_LOCALE } from "../src/i18n/config";

const WHO = "Lịch tự động";
/** After a sync that included Claude, for the next 3 hours check persona / audit once the sync job has finished. */
const FOLLOW_UP_MS = 3 * 3600_000;
// Step labels are stored on the job in the default language (the UI re-translates known step keys).
const L = translator(DEFAULT_LOCALE);
const AUDIENCE_STEP = { key: "audience", label: L("core.jobs.step.audience") };
const LOCK = "logs/scheduler.lock";

function lock() {
  mkdirSync("logs", { recursive: true });
  try {
    if (Date.now() - statSync(LOCK).mtimeMs < 55 * 60_000) return false; // previous run is still going
    rmSync(LOCK, { force: true });
  } catch {}
  try {
    closeSync(openSync(LOCK, "wx"));
    return true;
  } catch {
    return false;
  }
}

async function busy(clientId: string) {
  return !!(await db.clientJob.findFirst({ where: { clientId, status: { in: ["queued", "running"] } }, select: { id: true } }));
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const only = args.find((a) => !a.startsWith("--"));
  if (!lock()) return console.log("Previous run is still going, skipping.");
  let failures = 0;
  const fail = async (clientId: string, label: string, err: unknown) => {
    failures++;
    console.error(`  ✗ ${label}: ${errorMessage(err)}`);
    await logActivity(clientId, "error", `[scheduler] ${label} failed: ${errorMessage(err)}`);
  };

  try {
    // Check tokens once a day (7am VN time); lightweight, no Claude calls.
    if (force || localTime("Asia/Ho_Chi_Minh").hour === 7) {
      const tokens = await checkAllTokens().catch((err) => void console.error(`Token check failed: ${errorMessage(err)}`));
      if (tokens) console.log(`Token check: ${tokens.total - tokens.failed}/${tokens.total} OK`);
    }

    // Zalo OA: access token lives 25 hours, refresh token 3 months and is single-use → refresh before expiry so the client need not reconnect.
    if ((await loadOa())?.refreshToken) {
      await accessToken(3 * 3600_000).catch((err) => void console.error(`Zalo OA token refresh failed: ${errorMessage(err)}`));
    }

    // Clients on sample data do not run automatically (avoid spending Claude calls on fake numbers).
    const clients = await db.client.findMany({ where: { dataSource: "meta" }, orderBy: { name: "asc" } });
    for (const c of clients.filter((x) => !only || x.id === only || x.name === only)) {
      const now = new Date();
      const logs: string[] = [];

      // 0. Clean up pending-approval cards that are expired / point to things already turned off (DB only, including clients without auto sync).
      const expired = await expireStaleRecommendations(c.id).catch((err) => void console.error(`Cleaning recommendations for ${c.name} failed: ${errorMessage(err)}`));
      if (expired) logs.push(`cleaned ${expired} old recommendations`);

      const idle = toAiMode(c.aiMode) === "idle";
      const syncing = force || isSyncDue(c, now);

      // 1. After a sync that included Claude (within 3 hours): persona and audit run only when there is new data.
      //    Check BEFORE queueing this hour's sync: for clients syncing every hour there is always "a job in progress" after the sync step,
      //    and the persona job (same full_analysis kind) would be merged into the sync job (enqueueClientJob) → previously it never ran.
      let withAudience = false;
      const followUp = force || (c.lastAutoAiAt && now.getTime() - c.lastAutoAiAt.getTime() < FOLLOW_UP_MS);
      if (followUp && !(await busy(c.id))) {
        try {
          const conv = await conversationFreshness(c.id);
          const aud = await audienceFreshness(c.id);
          // Many conversations still unread (previous run failed / was interrupted): wait until they are read before building the persona.
          if (aud.need && conv.unanalyzed < 10) {
            // This hour has a sync: build the persona in the sync job's last step (on the freshest data); otherwise queue it separately.
            if (syncing) withAudience = true;
            else await enqueueClientJob(c.id, "full_analysis", WHO, { steps: [AUDIENCE_STEP] });
            logs.push(`queued persona build (${aud.reasons.join("; ")})`);
          }
        } catch (err) {
          await fail(c.id, "Persona check", err);
        }
        try {
          const audit = await auditFreshness(c.id);
          if (audit.need) {
            await runAccountAudit(c.id);
            logs.push("account audit");
          }
        } catch (err) {
          await fail(c.id, "Audit", err);
        }
      }

      // 2. Sync (+ message analysis if allowed and there are new conversations: this step skips itself when nothing is new)
      //    "idle" mode: on runs without the summary, read conversations quiet for 3 hours (the step skips itself when there are none).
      if (syncing) {
        const ai = force || isAiAllowed(c, now);
        const steps = [
          { key: "sync", label: L("customers.actions.stepSync") },
          ...(ai ? [{ key: "conversations", label: L("customers.actions.stepConv") }] : idle ? [{ key: "conversations_idle", label: L("workflow.plan.lanes.idleTitle", { hours: IDLE_HOURS }) }] : []),
          ...(withAudience ? [AUDIENCE_STEP] : []),
        ];
        try {
          const job = await enqueueClientJob(c.id, "full_analysis", WHO, { steps });
          // If an earlier sync job is still queued / running, enqueueClientJob returns that job (without this run's Claude step):
          // do not mark Claude as run, retry next hour; previously the Claude run for the whole day was lost.
          const aiQueued = ai && (JSON.parse(job.steps) as { key: string; status: string }[]).some((s) => s.key === "conversations" && s.status !== "done" && s.status !== "skipped");
          await db.client.update({ where: { id: c.id }, data: { lastAutoSyncAt: now, ...(aiQueued && { lastAutoAiAt: now }) } });
          logs.push(aiQueued ? "queued sync + message analysis" : ai ? "an earlier sync is still running, Claude waits until next hour" : idle ? "queued sync + silent-conversation read" : "queued sync");
        } catch (err) {
          await fail(c.id, "Queue sync", err);
        }
      } else if (idle && !(await busy(c.id))) {
        // 2b. Hours without a sync (e.g. sync once a day): still read conversations quiet for 3 hours (messages arrive via webhook / fast sync).
        try {
          const n = await idleConversationCount(c.id, IDLE_HOURS);
          if (n) {
            await enqueueClientJob(c.id, "conv_idle", WHO, { steps: [{ key: "conversations_idle", label: L("workflow.plan.lanes.idleTitle", { hours: IDLE_HOURS }) }] });
            logs.push(`queued reading ${n} silent conversations`);
          }
        } catch (err) {
          await fail(c.id, "Queue silent-conversation read", err);
        }
      }

      // 3. Optimize running campaigns (morning + evening per the client's schedule): suggestions go to Pending approval, nothing is applied automatically.
      if (force || isOptimizeDue(c, now)) {
        try {
          if (await db.campaign.count({ where: { clientId: c.id, status: "ACTIVE" } })) {
            await enqueueClientJob(c.id, "optimize", WHO, { steps: [{ key: "optimize", label: L("customers.actions.stepOptimize") }] });
            logs.push("queued campaign optimisation");
          }
          await db.client.update({ where: { id: c.id }, data: { lastOptimizeAt: now } });
        } catch (err) {
          await fail(c.id, "Queue campaign optimisation", err);
        }
      }

      // 3b. Automation: every hour (Meta calls only, no Claude). --force does not apply: runs only on the client's schedule.
      if (isAutoDue(c, now)) {
        try {
          const r = await runAutoRules(c.id);
          if (r?.done.length) logs.push(`automation${c.autoMode === "dryrun" ? " (dry run)" : ""}: ${r.done.length} actions`);
        } catch (err) {
          await fail(c.id, "Automation", err);
        }
      }

      // 4. Re-score targeting with the latest ad metrics + sales feedback, at most once a day after a new sync (no Claude calls).
      try {
        const ranking = await db.targetingRanking.findFirst({ where: { clientId: c.id }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
        const hasAnalysis = await db.audienceAnalysis.count({ where: { clientId: c.id } });
        if (hasAnalysis && (!ranking || (Date.now() - ranking.createdAt.getTime() > 20 * 3600_000 && !!c.lastSyncedAt && c.lastSyncedAt > ranking.createdAt))) {
          await buildRanking(c.id);
          logs.push("re-scored targeting");
        }
      } catch (err) {
        await fail(c.id, "Targeting scoring", err);
      }

      // 5. Scheduled client reports: run by the background process every minute (lib/report-schedule-run.ts).

      if (logs.length) console.log(`${new Date().toISOString()} ${c.name}: ${logs.join(", ")}`);
    }

    // Google Ads: sync every 3 hours (6am–10pm), then run suggestion rules (pending approval, never applied automatically). Also runs for sample-data clients if a real Google account is attached.
    if ((await loadGoogleAds())?.refreshToken) {
      const gClients = await db.client.findMany({ where: { googleCustomerId: { not: null } }, orderBy: { name: "asc" } });
      for (const c of gClients.filter((x) => !only || x.id === only || x.name === only)) {
        if (!force && !isGoogleSyncDue(c)) continue;
        try {
          const r = await syncGoogleAds(c.id);
          const recs = await runGoogleRules(c.id);
          console.log(`${new Date().toISOString()} ${c.name}: Google Ads sync (${r.campaigns} campaigns, ${r.keywords} keywords${recs ? `, ${recs} recommendations` : ""})`);
        } catch (err) {
          await fail(c.id, "Google Ads sync", err);
        }
      }
    }

    // Images customers send in messages: keep only the 1000 most recent conversations per client; delete all if the client turned off image reading (saves VPS disk).
    const pruned = await pruneAllMessageImages().catch((err) => void console.error(`Cleaning message images failed: ${errorMessage(err)}`));
    if (pruned) console.log(`${new Date().toISOString()} Cleaned ${pruned} old message images`);
  } finally {
    rmSync(LOCK, { force: true });
  }
  // Non-zero exit code so cron/monitoring knows a step failed.
  if (failures) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
