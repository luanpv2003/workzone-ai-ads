import type { Client } from "@prisma/client";
import { db } from "./db";
import { getMetaClient } from "./meta";
import { errorMessage, logActivity } from "./activity";
import { money } from "./format";
import { approveRecommendation } from "./recommendations";
import { coolingFor, recentExecuted, rejectedSkips, ruleFindings, thresholdsFor } from "./optimize";
import { qualityByAd } from "./lead-quality";
import { deliver } from "./lead-notify";
import { parseAutoTargets } from "./auto-rules-config";
import { renderNotice } from "./notify-templates";
import { globalTemplates } from "./notify-templates-db";
import { localTime } from "./schedule";
import { publicUrl } from "./zalo";
import { getT } from "@/i18n/server";

// Optimization automation (Settings → Automation). scripts/daily.ts calls it every hour within the client's time window.
// Uses exactly the campaign optimization rule set (optimize.ts), does not call Claude, and does only 2 kinds of actions:
// - Pause expensive or non-converting ad sets / ads (including early cuts of new ad sets), never pausing the last running ad set / ad,
//   never pausing the whole campaign.
// - Raise the budget of winning ad sets that RUN OUT OF BUDGET EARLY, by at most the client's step each time, at least optScaleGapHours hours apart,
//   without total campaign budget exceeding the daily budget cap (a cap must be set for auto scaling).
// Dry run (dryrun): changes nothing on Meta, only tags the "Chờ duyệt" (Pending approval) card with "Chạy thử" (Dry run) (would have been auto-applied) for a human to preview.
// Every automatic action is logged in Activity, reported to INTERNAL destinations (platform group / private chat with the bot, not the client group) and can be undone.

export * from "./auto-rules-config";

/** Pause rules allowed to auto-apply (all have statistical confidence + minimum spend). Pausing a whole campaign always needs human approval. */
const PAUSE_RULES = new Set(["adset_zero", "adset_early", "adset_expensive", "ad_expensive"]);
const AUTO_BY = "Tự động";
/** Ad set statuses that do not spend. Other statuses (ACTIVE, IN_PROCESS, WITH_ISSUES, PENDING_REVIEW...) still count toward the budget cap. */
const NOT_SPENDING = new Set(["PAUSED", "CAMPAIGN_PAUSED", "ADSET_PAUSED", "DELETED", "ARCHIVED", "DISAPPROVED"]);

/** Due for an automatic check (hourly within the client's time window, not yet run this hour). */
export function isAutoDue(c: Pick<Client, "autoMode" | "autoFromHour" | "autoToHour" | "timezone" | "lastAutoRunAt">, at = new Date()) {
  if (c.autoMode !== "on" && c.autoMode !== "dryrun") return false;
  const now = localTime(c.timezone, at);
  if (now.hour < c.autoFromHour || now.hour > c.autoToHour) return false;
  if (!c.lastAutoRunAt) return true;
  const last = localTime(c.timezone, c.lastAutoRunAt);
  return !(last.date === now.date && last.hour === now.hour);
}

type Done = { line: string; ok: boolean; short?: string };

export async function runAutoRules(clientId: string) {
  const t = await getT();
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId } });
  if (client.dataSource !== "meta" || (client.autoMode !== "on" && client.autoMode !== "dryrun")) return null;
  const dry = client.autoMode === "dryrun";
  await db.client.update({ where: { id: clientId }, data: { lastAutoRunAt: new Date() } });
  const campaigns = await db.campaign.findMany({ where: { clientId, status: "ACTIVE" } });
  if (!campaigns.length) return { checked: 0, done: [] as Done[] };

  const [th, recent, skip, quality] = await Promise.all([thresholdsFor(client), recentExecuted(clientId), rejectedSkips(clientId), qualityByAd(clientId)]);
  const snaps = await getMetaClient(client).fetchOptimizeSnapshots(campaigns.map((c) => c.id));
  const m = (x: number | null) => money(x, client.currency);
  const done: Done[] = [];
  const notes: string[] = [];
  const matched = new Set<string>(); // dry-run cards still meeting the conditions in this run

  for (const snap of snaps) {
    if (snap.campaign.status !== "ACTIVE") continue;
    const c = campaigns.find((x) => x.id === snap.campaign.id)!;
    const sets = snap.adSets.filter((s) => s.status === "ACTIVE");
    let activeSets = sets.length;
    const activeAds = new Map(sets.map((s) => [s.id, snap.ads.filter((a) => a.adSetId === s.id && a.status === "ACTIVE").length]));
    // Total daily campaign budget (CBO: campaign budget; ABO: sum of all ad sets still spending, including in review / with issues) to stay under the cap.
    let total = snap.campaign.dailyBudget ?? snap.adSets.filter((s) => !NOT_SPENDING.has(s.status)).reduce((a, s) => a + (s.dailyBudget ?? 0), 0);

    for (const f of ruleFindings(client, snap, th, quality, c.resultType)) {
      const kind = f.action === "pause" && PAUSE_RULES.has(f.rule) ? "pause" : f.action === "update_budget" && f.rule === "adset_winner" && f.limited ? "scale" : null;
      if (!kind || (kind === "pause" && !client.autoPause) || (kind === "scale" && !client.autoScale)) continue;
      if (coolingFor(recent, f, th) || skip.has(`${f.rule}:${f.targetId}`)) continue;

      // Update the count of running ad sets / ads and the total budget ONLY after the action is done (or dry-run),
      // not beforehand: if a skipped / failed pause were still subtracted, a later budget increase would exceed the real cap.
      let applied: () => void;
      if (kind === "pause") {
        if (f.level === "adset") {
          if (activeSets <= 1) continue; // never pause the last ad set of a campaign
          const budget = sets.find((s) => s.id === f.targetId)?.dailyBudget ?? 0;
          applied = () => {
            activeSets--;
            if (snap.campaign.dailyBudget == null) total -= budget;
          };
        } else if (f.level === "ad") {
          const setId = snap.ads.find((a) => a.id === f.targetId)?.adSetId ?? "";
          if ((activeAds.get(setId) ?? 0) <= 1) continue; // never pause the last ad of an ad set
          applied = () => activeAds.set(setId, activeAds.get(setId)! - 1);
        } else continue;
      } else {
        if (!client.maxDailyBudget) {
          notes.push(t("core.autoRules.noCap", { name: f.targetName }));
          continue;
        }
        const cur = f.level === "campaign" ? snap.campaign.dailyBudget : sets.find((s) => s.id === f.targetId)?.dailyBudget;
        if (cur == null || f.newDailyBudget == null) continue;
        if (total - cur + f.newDailyBudget > client.maxDailyBudget + 0.5) {
          notes.push(t("core.autoRules.overCap", { name: f.targetName, cap: m(client.maxDailyBudget) }));
          continue;
        }
        const delta = f.newDailyBudget - cur;
        applied = () => (total += delta);
        // DB figures may be staler than Meta (manual changes in Ads Manager): refresh first so the % limit check is correct.
        if (f.level === "adset") await db.adSet.updateMany({ where: { id: f.targetId, clientId }, data: { dailyBudget: cur } });
        else await db.campaign.updateMany({ where: { id: f.targetId, clientId }, data: { dailyBudget: cur } });
      }

      // Reuse the pending card for the same rule / object (if any), otherwise create a new card.
      const data = {
        title: f.title,
        rationale: f.facts,
        priority: f.priority,
        actionType: f.action,
        targetLevel: f.level,
        targetId: f.targetId,
        targetName: f.targetName,
        newDailyBudget: f.newDailyBudget ?? null,
        evidence: JSON.stringify({ ...f.evidence, ...(f.learningReset && { learningReset: f.learningReset }) }),
        auto: dry ? "dryrun" : "on",
      };
      matched.add(`${f.rule}:${f.targetId}`);
      const pending = await db.recommendation.findFirst({ where: { clientId, kind: "optimize", status: "pending", rule: f.rule, targetId: f.targetId } });
      // The previous automatic action got an error from Meta: leave it for a human, don't retry every hour.
      if (!dry && pending?.auto === "on" && pending.result?.startsWith("Lỗi")) continue;
      // Card already has the same action (Claude wrote the reason): keep the title / reason, only update metrics and tags.
      // Old card with a different action (e.g. "cần chỉnh tay" (needs manual adjustment) while over the cap): overwrite entirely, otherwise Approve would just mark it done without calling Meta.
      const fresh =
        pending && pending.actionType === data.actionType && pending.targetLevel === data.targetLevel
          ? { priority: data.priority, newDailyBudget: data.newDailyBudget, evidence: data.evidence, auto: data.auto }
          : { ...data, result: null };
      if (dry && pending?.auto === "dryrun") {
        await db.recommendation.update({ where: { id: pending.id }, data: fresh });
        applied();
        continue; // dry run already reported earlier
      }
      const rec = pending
        ? await db.recommendation.update({ where: { id: pending.id }, data: fresh })
        : await db.recommendation.create({ data: { ...data, clientId, kind: "optimize", campaignId: c.id, campaignName: c.name, rule: f.rule } });
      const what =
        kind === "pause"
          ? t(f.level === "ad" ? "core.autoRules.pauseAd" : "core.autoRules.pauseSet", { name: f.targetName })
          : t("core.autoRules.raiseBudget", { name: f.targetName, from: m(snap.adSets.find((s) => s.id === f.targetId)?.dailyBudget ?? snap.campaign.dailyBudget), to: m(f.newDailyBudget!) });
      const why = f.facts.split(/(?<=\.)\s/)[0];
      // Short line for the internal message.
      const e = f.evidence as { m7?: { spend: string; results: number; cpr: string }; benchmark?: string | null; adSetCpr?: string; budgetUsedToday?: string };
      const nums = e.m7 ? (e.m7.results ? t("core.autoRules.numsResults", { cpr: e.m7.cpr, results: e.m7.results, spend: e.m7.spend }) : t("core.autoRules.numsNone", { spend: e.m7.spend })) : "";
      const short =
        kind === "pause"
          ? `⏸ ${what}: ${nums}${e.benchmark || e.adSetCpr ? t("core.autoRules.benchmark", { v: String(e.benchmark ?? e.adSetCpr) }) : ""}`
          : `⬆️ ${what.replace(/ → (.*)$/, ` → $1${t("core.autoRules.perDay")}`)}: ${nums}${e.budgetUsedToday ? t("core.autoRules.spentToday", { v: e.budgetUsedToday }) : ""}`;
      if (dry) {
        applied();
        done.push({ line: `${what} (${c.name}): ${why}`, ok: true });
        continue;
      }
      try {
        await approveRecommendation(rec.id, undefined, undefined, { by: AUTO_BY });
        applied();
        done.push({ line: `${what} (${c.name}): ${why}`, ok: true, short });
      } catch (err) {
        done.push({ line: t("core.autoRules.errorWhile", { what: what.toLowerCase(), campaign: c.name, error: errorMessage(err) }), ok: false });
      }
    }
  }

  // Dry-run cards of just-checked campaigns that no longer meet the conditions: expire.
  if (dry) {
    const stale = await db.recommendation.findMany({
      where: { clientId, kind: "optimize", status: "pending", auto: "dryrun", campaignId: { in: snaps.map((s) => s.campaign.id) } },
      select: { id: true, rule: true, targetId: true },
    });
    const ids = stale.filter((r) => !matched.has(`${r.rule}:${r.targetId}`)).map((r) => r.id);
    if (ids.length) await db.recommendation.updateMany({ where: { id: { in: ids } }, data: { status: "expired", result: t("core.autoRules.dryExpired"), decidedAt: new Date() } });
  }

  const tag = dry ? t("core.autoRules.dryTag") : "";
  for (const d of done) await logActivity(clientId, d.ok ? (dry ? "analyze" : "execute") : "error", `${tag}${t("core.autoRules.autoPrefix")}: ${d.line}`);
  for (const n of [...new Set(notes)]) await logActivity(clientId, "analyze", `${t("core.autoRules.autoPrefix")}: ${n}`);

  const sent = done.filter((d) => d.ok);
  if (!dry && sent.length && client.autoNotify) {
    const targets = parseAutoTargets(client.autoNotifyTargets);
    if (targets.length) {
      const text = renderNotice(
        "autoAction",
        {
          khach_hang: client.name,
          thoi_gian: new Date().toLocaleString("vi-VN", { timeZone: client.timezone, hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }),
          viec_da_lam: sent.map((d) => d.short ?? d.line).join("\n"),
          link_hoan_tac: `${publicUrl()}/clients/${clientId}/recommendations`,
        },
        undefined,
        await globalTemplates(),
        t,
      );
      const res = await deliver(targets, text);
      const bad = res.filter((r) => !r.ok);
      if (bad.length) await logActivity(clientId, "error", t("core.autoRules.notifyFailed", { error: bad.map((b) => b.error).join("; ") }));
    }
  }
  return { checked: snaps.length, done };
}
