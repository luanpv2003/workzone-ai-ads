import type { Client, Message } from "@prisma/client";
import { db, findPaged, retryBusy } from "../db";
import { logActivity } from "../activity";
import { maskPii } from "../pii";
import { recommendationHistory, saveRecommendations } from "../recommendations";
import { getMetaClient } from "../meta";
import { MetaApiError } from "../meta/graph";
import { markTokenError } from "../token-status";
import { ClaudeError, generateStructured, type ImageInput } from "./claude";
import { parseImages, readMessageImage } from "../msg-images";
import { accountData, clientProfile, latestConversationInsights, loadPlannerPosts, pageAndBreakdownContext, type PlannerPost } from "./context";
import { knowledgePromptSection } from "../knowledge";
import { clientPages, pageLabel } from "../client-pages";
import { enforceTargetingRules, testModeFor, testModePrompt } from "../test-mode";
import { audiencePromptSection } from "../audience";
import { healthChecks, healthPromptSection } from "../health-checks";
import { AUDIT_SYSTEM, CONVERSATIONS_MERGE_SYSTEM, CONVERSATIONS_SYSTEM, PLANNER_SYSTEM } from "./prompts";
import {
  AccountAuditSchema,
  CampaignBriefSchema,
  CampaignPlanSchema,
  ConversationAnalysisSchema,
  ConversationMergeSchema,
  type ConversationAnalysis,
  EditablePlanSchema,
  type CampaignBrief,
  type CampaignPlan,
  type EditablePlan,
} from "./schemas";
import { blankPlan, normalizePlan, reviewPlan, totalDailyBudget } from "../plan";
import { catalog, formatSize, geoList, plannerCandidates } from "../targeting";
import { searchMetaGeo } from "../meta/geo-search";
import { plannerDataSection } from "../planner-context";
import { resolvePlanTargeting } from "../targeting-resolve";
import { checkPlanTargeting } from "../targeting-validate";
import { decrypt } from "../crypto";
import { NEW_PROVINCES } from "../vn-geo";
import { money } from "../format";
import { queueDraftPolicyCheck } from "../draft-policy";
import { getT } from "@/i18n/server";

const BATCH_SIZE = 25; // conversations Claude reads per call (50 conversations sometimes exceeded Claude Code's 15 minutes)

// ---------------------------------------------------------------- Account audit

export async function runAccountAudit(clientId: string) {
  const t = await getT();
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId } });
  const [data, convInsights, health, history] = await Promise.all([accountData(clientId), latestConversationInsights(clientId), healthChecks(client), recommendationHistory(clientId, "account")]);
  if (!data.campaigns.length) throw new Error(t("ai.analysis.auditNoCampaigns"));

  const prompt = `# Client profile
${clientProfile(client)}

${await knowledgePromptSection(client.id)}

${healthPromptSection(health)}

# Insights from customer messages (latest analysis)
${convInsights ? JSON.stringify(convInsights) : "Messages not analysed yet."}

# Ad account data
${JSON.stringify(data)}

${history.text}

Audit this account.`;

  const res = await generateStructured({ clientId: clientId, system: AUDIT_SYSTEM, prompt, schema: AccountAuditSchema });

  const audit = await db.audit.create({
    data: {
      clientId,
      kind: "account",
      score: health.score,
      summary: res.data.summary,
      report: JSON.stringify({ ...res.data, score: health.score, health }),
      model: res.model,
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
    },
  });
  await saveRecommendations(client, audit.id, res.data.recommendations, history.codes);
  await logActivity(clientId, "audit", t("ai.analysis.auditLog", { score: health.score != null ? `${health.score}/100` : t("ai.analysis.auditNotScored"), coverage: health.coverage, count: res.data.recommendations.length }));
  return audit.id;
}

// ---------------------------------------------------------------- Message analysis

function conversationStats(convs: { messages: Message[] }[]) {
  const delays: number[] = [];
  let unanswered = 0;
  for (const c of convs) {
    const msgs = c.messages;
    for (let i = 0; i < msgs.length; i++) {
      if (!msgs[i].fromCustomer) continue;
      if (i > 0 && msgs[i - 1].fromCustomer) continue; // only count the first message of each customer turn
      const reply = msgs.slice(i + 1).find((m) => !m.fromCustomer);
      if (reply) delays.push((reply.createdTime.getTime() - msgs[i].createdTime.getTime()) / 60000);
    }
    if (msgs.at(-1)?.fromCustomer) unanswered++;
  }
  delays.sort((a, b) => a - b);
  return {
    conversations: convs.length,
    last_message_from_customer_unanswered: unanswered,
    median_reply_minutes: delays.length ? Math.round(delays[Math.floor(delays.length / 2)]) : null,
    replies_over_60_minutes: delays.filter((d) => d > 60).length,
  };
}

type ConvWithMessages = Awaited<ReturnType<typeof db.conversation.findMany<{ include: { messages: true } }>>>[number];

/** Claude reads a batch of conversations (≤ 50): labels each conversation + the batch's insight. */
async function analyzeConversationBatch(client: Client, convs: ConvWithMessages[], adNames: Map<string, string>, knowledge: string, extra = "") {
  const pages = clientPages(client);
  const time = (d: Date) =>
    d.toLocaleString("vi-VN", { timeZone: client.timezone, hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
  // Read images sent by customers (client opt-in): at most 2 latest images per conversation, at most MAX_BATCH_IMAGES per batch.
  const picked = client.readImages ? pickImages(convs) : new Map<string, string[]>();
  const images: ImageInput[] = [];
  const imageNo = new Map<string, number>();
  for (const rel of [...picked.values()].flat()) {
    const data = await readMessageImage(rel).catch(() => null);
    if (!data) continue;
    images.push({ name: `image-${images.length + 1}.jpg`, data, mediaType: "image/jpeg" });
    imageNo.set(rel, images.length);
  }
  const imageTag = (m: Message) => {
    const nos = (picked.get(m.id) ?? []).map((r) => imageNo.get(r)).filter(Boolean);
    return nos.length ? ` ${nos.map((n) => `(see image image-${n}.jpg)`).join(" ")}` : "";
  };
  const transcripts = convs
    .map((c) => {
      const src = c.sourceAdId ? `from ad "${adNames.get(c.sourceAdId) ?? c.sourceAdId}" (ad_id ${c.sourceAdId})` : "unknown source";
      const lines = c.messages.map((m) => `[${m.fromCustomer ? "Customer" : "Page"} ${time(m.createdTime)}] ${maskPii(m.text)}${imageTag(m)}`);
      // Clients with multiple Pages: include the Page so Claude can point out differences between Pages.
      const page = pages.length > 1 ? ` | Page: ${pageLabel(pages, c.pageId)}` : "";
      return `### conversation_id: ${c.id}${page} | ${src}\n${lines.join("\n")}`;
    })
    .join("\n\n");

  const prompt = `# Client profile
${clientProfile(client)}

${knowledge}

# Customer-care statistics (computed automatically)
${JSON.stringify(conversationStats(convs))}
${extra && `\n${extra}\n`}
# ${convs.length} conversations
${transcripts}
${
  images.length
    ? `
# Images sent by customers
Attached are ${images.length} images sent by customers, matched by the file name noted in the conversation "(see image image-n.jpg)". The images are compressed: you only need to understand what each image is (the product asked about, a bank transfer / order screenshot, a defect / damage photo, a screenshot of an ad…) to judge the need and stage. Do not copy phone numbers, account numbers or ID numbers visible in the images. A "[Ảnh]" ("[Image]") message without a file name is an image not included in this read.
`
    : ""
}
Analyse the conversations above.`;

  // Labeling each conversation is simple: effort medium for speed; merging insights uses high.
  const res = await generateStructured({ clientId: client.id, system: CONVERSATIONS_SYSTEM, prompt, schema: ConversationAnalysisSchema, effort: "medium", ...(images.length && { images }) });
  const ids = new Set(convs.map((c) => c.id));
  const now = new Date();
  for (const c of res.data.conversations) {
    if (!ids.has(c.conversation_id)) continue;
    await db.conversation.update({
      where: { id: c.conversation_id },
      data: {
        intent: c.intent,
        stage: c.stage,
        sentiment: c.sentiment,
        leadScore: Math.max(0, Math.min(100, c.lead_score)),
        tags: JSON.stringify(c.tags),
        needsReply: c.needs_reply,
        suggestedReply: c.suggested_reply,
        analysisNote: c.note,
        analyzedAt: now,
      },
    });
  }
  return res;
}

const MAX_BATCH_IMAGES = 20;

/** Pick customer-sent images for Claude to view: every conversation gets a turn (at most 2 latest images), total ≤ MAX_BATCH_IMAGES. Returns message id → image. */
function pickImages(convs: ConvWithMessages[]) {
  const perConv = convs.map((c) =>
    c.messages
      .filter((m) => m.fromCustomer && m.images)
      .flatMap((m) => parseImages(m.images).map((rel) => ({ id: m.id, rel })))
      .slice(-2),
  );
  const out = new Map<string, string[]>();
  let n = 0;
  for (let round = 0; round < 2 && n < MAX_BATCH_IMAGES; round++) {
    for (const list of perConv) {
      const x = list[list.length - 1 - round];
      if (!x || n >= MAX_BATCH_IMAGES) continue;
      out.set(x.id, [...(out.get(x.id) ?? []), x.rel]);
      n++;
    }
  }
  return out;
}

type BatchResult = Awaited<ReturnType<typeof analyzeConversationBatch>>;

/** Window of conversations analyzed: the conversationLimit latest conversations, with messages. */
function conversationWindow(client: Client) {
  return findPaged(
    (skip, take) =>
      db.conversation.findMany({
        where: { clientId: client.id },
        include: { messages: { orderBy: { createdTime: "asc" } } },
        orderBy: [{ updatedTime: "desc" }, { id: "asc" }],
        skip,
        take,
      }),
    client.conversationLimit,
  );
}

/**
 * Claude labels conversations in batches of BATCH_SIZE (labels saved to each conversation right after each batch).
 * Batch timed out: split in half and rerun (finished batches stay saved; rerunning the job only reads what is missing).
 * Batch blocked by Claude's safety filter: split down (5 → single conversations) to find the offending one; that conversation is marked
 * "Cần xem tay" (needs manual review) and skipped, the others are still analyzed, and the run as a whole does not fail.
 */
/** extra: extra prompt for the report run (ads currently running, existing proposals); idle conversation reads don't need it. */
async function labelConversations(client: Client, todo: ConvWithMessages[], onBatch?: (done: number, total: number) => Promise<void>, extra = "") {
  const adNames = new Map((await db.ad.findMany({ where: { clientId: client.id }, select: { id: true, name: true } })).map((a) => [a.id, a.name]));
  const knowledge = await knowledgePromptSection(client.id);
  const batches: ConvWithMessages[][] = [];
  for (let i = 0; i < todo.length; i += BATCH_SIZE) batches.push(todo.slice(i, i + BATCH_SIZE));

  const blocked: string[] = [];
  const runBatch = async (batch: ConvWithMessages[]): Promise<BatchResult[]> => {
    try {
      return [await analyzeConversationBatch(client, batch, adNames, knowledge, extra)];
    } catch (err) {
      if (!(err instanceof ClaudeError)) throw err;
      if (err.refused) {
        if (batch.length === 1) {
          await markBlocked(batch[0].id, err.message);
          blocked.push(batch[0].id);
          return [];
        }
        const size = batch.length > 5 ? 5 : 1;
        console.warn(`[message analysis] Batch of ${batch.length} conversations blocked by Claude's filter → splitting into batches of ${size}`);
        const out: BatchResult[] = [];
        for (let i = 0; i < batch.length; i += size) out.push(...(await runBatch(batch.slice(i, i + size))));
        return out;
      }
      if (!err.timedOut || batch.length < 8) throw err;
      const half = Math.ceil(batch.length / 2);
      return [...(await runBatch(batch.slice(0, half))), ...(await runBatch(batch.slice(half)))];
    }
  };
  const results: BatchResult[] = [];
  for (const [i, batch] of batches.entries()) {
    results.push(...(await runBatch(batch)));
    await onBatch?.(i + 1, batches.length);
  }
  if (blocked.length) {
    await logActivity(client.id, "error", (await getT())("ai.analysis.blockedLog", { count: blocked.length }));
  }
  return { results, blocked: blocked.length, batches: batches.length };
}

/** Each idle-conversation read handles at most this many conversations (4 batches); the rest is left for the next hourly run. */
const MAX_IDLE_PER_RUN = 100;

/**
 * "idle" mode (hourly schedule): Claude labels unread conversations that have been silent ≥ idleHours hours
 * (neither the customer nor the page sent anything more = one exchange is done). Only labels conversations, no overall report:
 * the overall report (frequent questions, objections, proposals) merges these labels once a day in analyzeConversations.
 */
export async function analyzeIdleConversations(clientId: string, idleHours: number, onProgress?: (done: number, total: number, todo: number) => Promise<void>) {
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId } });
  const cutoff = Date.now() - idleHours * 3600_000;
  const waiting = (await conversationWindow(client)).filter((c) => !c.analyzedAt && c.updatedTime.getTime() <= cutoff);
  const todo = waiting.slice(0, MAX_IDLE_PER_RUN);
  if (!todo.length) return { read: 0, batches: 0, left: 0, hot: 0, reply: 0, blocked: 0 };
  await onProgress?.(0, Math.ceil(todo.length / BATCH_SIZE), todo.length);
  const r = await labelConversations(client, todo, (done, total) => onProgress?.(done, total, todo.length) ?? Promise.resolve());
  const labels = r.results.flatMap((x) => x.data.conversations);
  const hot = labels.filter((c) => c.lead_score >= 75).length;
  const reply = labels.filter((c) => c.needs_reply).length;
  const t = await getT();
  await logActivity(
    clientId,
    "analyze",
    t("ai.analysis.idleLog", { count: labels.length, hours: idleHours, hot, reply, left: waiting.length > todo.length ? t("ai.analysis.idleLeft", { count: waiting.length - todo.length }) : "" }),
  );
  return { read: labels.length, batches: r.batches, left: waiting.length - todo.length, hot, reply, blocked: r.blocked };
}

/** Ads actually running (with ad set and campaign both active) so Claude proposes pausing / adjusting budgets with the correct IDs. */
async function runningAdsSection(client: Client) {
  const ads = await db.ad.findMany({
    where: { clientId: client.id, status: "ACTIVE", adSet: { status: "ACTIVE" }, campaign: { status: "ACTIVE" } },
    select: { id: true, name: true, adSet: { select: { id: true, name: true, dailyBudget: true } }, campaign: { select: { name: true } } },
    orderBy: { spend: "desc" },
    take: 60,
  });
  const lines = ads.map(
    (a) => `ad ${a.id} | ${a.name} | ad set ${a.adSet.id} "${a.adSet.name}"${a.adSet.dailyBudget ? ` (daily budget ${money(a.adSet.dailyBudget, client.currency)})` : ""} | campaign "${a.campaign.name}"`,
  );
  return `# Ads currently running (ad id | name | ad set | campaign)
${lines.join("\n") || "No ads are running on the connected ad account (the client has paused ads, or the messages come from another account): do not propose pausing / raising budgets."}`;
}

/**
 * Message analysis: read unanalyzed conversations (among the conversationLimit most recent) in batches,
 * then merge the batch insights, labels of conversations read since the previous report (idle reads, interrupted runs) and the previous report
 * into one overall report. If there is nothing new, re-read the BATCH_SIZE most recent conversations.
 */
export async function analyzeConversations(clientId: string, onProgress?: (done: number, total: number, info: { todo: number; window: number; reread: boolean; labeled: number }) => Promise<void>) {
  const t = await getT();
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId } });
  const window = await conversationWindow(client);
  if (!window.length) throw new Error(t("ai.analysis.noConversations"));
  const prevAudit = await db.audit.findFirst({ where: { clientId, kind: "conversations" }, orderBy: { createdAt: "desc" } });
  let todo = window.filter((c) => !c.analyzedAt);
  // Conversations labeled after the latest report but not yet aggregated (idle conversation reads, a previous run that was interrupted).
  const orphans = window.filter((c) => c.analyzedAt && (!prevAudit || c.analyzedAt > prevAudit.createdAt));
  const fresh = !todo.length && !orphans.length;
  if (fresh) todo = window.slice(0, BATCH_SIZE);

  const info = { todo: todo.length, window: window.length, reread: fresh, labeled: fresh ? 0 : orphans.length };
  await onProgress?.(0, Math.ceil(todo.length / BATCH_SIZE), info);
  // Proposals must match the current state: which ads are running (to pause / adjust with the correct ID), which tasks are pending / done / skipped.
  const [ads, history] = await Promise.all([runningAdsSection(client), recommendationHistory(clientId, "conversations")]);
  const extra = [ads, history.text].filter(Boolean).join("\n\n");
  const { results, blocked, batches } = await labelConversations(client, todo, (done, total) => onProgress?.(done, total, info) ?? Promise.resolve(), extra);
  if (todo.length && !results.length && !orphans.length) {
    throw new Error(t("ai.analysis.allBlocked", { count: blocked }));
  }

  // The previous report (conversations analyzed earlier) is merged in so the insight reflects the whole sample.
  const prevParsed = prevAudit && !fresh ? ConversationAnalysisSchema.safeParse(JSON.parse(prevAudit.report)) : null;
  const prev = prevParsed?.success ? prevParsed.data : null;
  const todoIds = new Set(todo.map((t) => t.id));
  const labeled = fresh ? [] : orphans.filter((c) => !todoIds.has(c.id));
  const analyzedCount = window.filter((c) => c.analyzedAt || todoIds.has(c.id)).length;

  const conversations = results.flatMap((r) => r.data.conversations);
  let report: ConversationAnalysis | null = results.length ? { ...results[0].data, conversations } : null;
  let model = results[0]?.model ?? "";
  let inputTokens = results.reduce((a, r) => a + (r.inputTokens ?? 0), 0);
  let outputTokens = results.reduce((a, r) => a + (r.outputTokens ?? 0), 0);
  if (results.length > 1 || prev || labeled.length) {
    const parts = [
      ...(prev ? [{ source: `previous report (${prev.analyzed_count ?? prev.conversations.length} older conversations)`, ...insightsOnly(prev) }] : []),
      ...(labeled.length
        ? [{
            source: `${labeled.length} conversations labelled since the previous report (read when the conversation went quiet, or a previous run was interrupted), not yet merged`,
            labels: labeled.map((c) => ({ intent: c.intent, stage: c.stage, lead_score: c.leadScore, tags: c.tags ? (JSON.parse(c.tags) as string[]) : [], note: c.analysisNote })),
          }]
        : []),
      ...results.map((r, i) => ({ source: `batch ${i + 1} (${r.data.conversations.length} new conversations)`, ...insightsOnly(r.data) })),
    ];
    const merged = await generateStructured({
      clientId,
      system: CONVERSATIONS_MERGE_SYSTEM,
      prompt: `# Client profile
${clientProfile(client)}

# Customer-care statistics over the ${window.length} most recent conversations (computed automatically)
${JSON.stringify(conversationStats(window))}

# Analysis results per part
${JSON.stringify(parts)}

${extra}

Merge them into one overall report.`,
      schema: ConversationMergeSchema,
    });
    report = { ...merged.data, conversations };
    model = merged.model;
    inputTokens += merged.inputTokens ?? 0;
    outputTokens += merged.outputTokens ?? 0;
  }
  if (!report) throw new Error(t("ai.analysis.noResults"));
  report.analyzed_count = analyzedCount;

  const hot = report.conversations.filter((c) => c.lead_score >= 75).length;
  const audit = await db.audit.create({
    data: { clientId, kind: "conversations", score: null, summary: report.summary, report: JSON.stringify(report), model, inputTokens, outputTokens },
  });
  await saveRecommendations(client, audit.id, report.recommendations, history.codes);
  await logActivity(
    clientId,
    "analyze",
    t("ai.analysis.analyzeLog", { count: todo.length, batches, merged: labeled.length ? t("ai.analysis.analyzeMerged", { count: labeled.length }) : "", total: analyzedCount, hot, recs: report.recommendations.length }),
  );
  return { auditId: audit.id, read: todo.length, labeled: labeled.length, reread: fresh, batches, analyzed: analyzedCount, window: window.length, recommendations: report.recommendations.length, blocked };
}

/** Conversations Claude's safety filter refuses to read: treat as read (not resent next time) for a human to review. A new message makes sync reopen it automatically. */
async function markBlocked(conversationId: string, reason: string) {
  const t = await getT();
  await db.conversation.update({
    where: { id: conversationId },
    data: {
      intent: null,
      stage: null,
      sentiment: null,
      leadScore: null,
      tags: JSON.stringify([t("ai.analysis.manualReviewTag")]),
      needsReply: true,
      suggestedReply: null,
      analysisNote: t("ai.analysis.blockedNote", { reason: reason.slice(0, 120) }),
      analyzedAt: new Date(),
    },
  });
}

/** The report's insight part (without the per-conversation list), for merging. */
function insightsOnly(r: ConversationAnalysis) {
  const { conversations: _c, analyzed_count: _n, ...rest } = r;
  void _c;
  void _n;
  return rest;
}

// ---------------------------------------------------------------- Campaign planning

export async function historyForPlanner(clientId: string) {
  const ads = await db.ad.findMany({
    where: { clientId, spend: { gt: 0 } },
    include: { adSet: true },
    orderBy: { spend: "desc" },
    take: 30,
  });
  const withCpr = ads.map((a) => ({
    name: a.name,
    ad_set: a.adSet.name,
    targeting: a.adSet.targeting,
    primary_text: a.primaryText.slice(0, 300),
    spend: Math.round(a.spend),
    results: a.results,
    cpr: a.results ? Math.round(a.spend / a.results) : null,
    ctr_pct: a.impressions ? Number(((a.clicks / a.impressions) * 100).toFixed(2)) : 0,
  }));
  const ranked = withCpr.filter((a) => a.cpr != null).sort((a, b) => a.cpr! - b.cpr!);
  return { best_ads: ranked.slice(0, 5), worst_ads: ranked.slice(-3).reverse(), no_result_ads: withCpr.filter((a) => a.cpr == null).slice(0, 3) };
}

async function targetingCatalogText(client: Client, brief: CampaignBrief, extraIds: string[] = []) {
  const items = plannerCandidates(`${client.industry} ${client.brief} ${brief.product} ${brief.notes ?? ""}`);
  // Always include items ranked / proposed by Claude in the persona step in the reference catalog.
  const { byId } = catalog();
  for (const id of extraIds) {
    const it = byId.get(id);
    if (it && !items.some((x) => x.id === id)) items.unshift(it);
  }
  const lines = items.map((t) => `${t.id} | ${t.type} | ${t.name} | ${formatSize(t.vnLo, t.vnHi) || "?"}`);
  const provinces = geoList().filter((g) => g.type === "region");
  // Locations smaller than a province (city, district, ward/commune) are searched directly on Meta from the brief, with the exact Ads Manager codes.
  const smaller: string[] = [];
  for (const q of brief.locations.split(/[,;\n]/).map((x) => x.trim()).filter((x) => x.length >= 2).slice(0, 6)) {
    for (const g of ((await searchMetaGeo(q)) ?? []).filter((x) => x.type !== "region").slice(0, 4)) {
      const line = `${g.key} | ${g.type} | ${g.name}${g.region ? ` (${g.region})` : ""}`;
      if (!smaller.includes(line)) smaller.push(line);
    }
  }
  const geo = [...provinces.map((g) => `${g.key} | region | ${g.name}`), ...smaller];
  const merged = NEW_PROVINCES.filter((p) => p.old.length > 1).map((p) => `${p.name} (new) = ${p.old.join(" + ")}`);
  return `# Reference targeting catalogue (id | type | name | size in VN) — filtered by industry keywords, NOT mandatory
Ready to use (copy the exact id). Ideas outside the list are still allowed: write the exact name as in Ads Manager, id "".
${lines.join("\n")}

# Locations (key | type | name; place names in Vietnamese). The whole country uses key "VN" of type country.
Meta still targets by the 63 old provinces. When the brief names a new province (after the merger of 01/07/2025), choose ALL the corresponding old provinces (fill group = the new province name):
${merged.join("\n")}
Districts use type subcity, wards/communes use type neighborhood (no radius). Never select a province together with a district/ward inside it.
${geo.join("\n")}`;
}

/** Text in the brief used to find the link / ID of the post the user wants to run. */
const briefHint = (b: CampaignBrief) => `${b.product} ${b.notes ?? ""} ${b.landingUrl ?? ""}`;

export async function planPrompt(clientId: string, brief: CampaignBrief, extraHint = "") {
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId } });
  const [history, insights, audience, mode] = await Promise.all([historyForPlanner(clientId), latestConversationInsights(clientId), audiencePromptSection(clientId), testModeFor(clientId)]);
  const today = new Date().toLocaleDateString("vi-VN", { timeZone: client.timezone });
  return `# Client profile
${clientProfile(client)}

${await knowledgePromptSection(client.id)}

# Insights from customer messages
${insights ? JSON.stringify(insights) : "None yet."}

${audience.text}

${await pageAndBreakdownContext(clientId, { posts: false })}

${(await loadPlannerPosts(client, `${briefHint(brief)} ${extraHint}`)).text}

# Ads with spend in the last 7 days (cheapest / most expensive / no results)
${JSON.stringify(history)}

${await plannerDataSection(client)}

${await targetingCatalogText(client, brief, audience.ids)}

${testModePrompt(mode, client.currency, brief.dailyBudget)}

# New campaign brief (date ${today})
${JSON.stringify(brief)}`;
}

/**
 * Find the matching item in the old plan: by name first (Claude may delete/reorder),
 * only by position when the count is unchanged. No match means images/posts are not carried over, to avoid wrong attachments.
 */
function match<T extends { name: string }>(prev: T[] | undefined, name: string, i: number, count: number): T | undefined {
  if (!prev) return undefined;
  const byName = prev.filter((p) => p.name.trim() === name.trim());
  if (byName.length === 1) return byName[0];
  return prev.length === count ? prev[i] : undefined;
}

/**
 * Attach the default landing page link from the brief, keeping images/schedules the user edited when Claude redrafts.
 * posts: existing posts Claude may choose from (existing_post_id must be in this list to be used, avoiding made-up IDs).
 */
export function withEditorFields(plan: CampaignPlan, brief: CampaignBrief, prev?: EditablePlan, posts?: Map<string, PlannerPost>): EditablePlan {
  // Fields edited only in the editor (Claude does not return them): kept from the version before Claude redrafted.
  const pick = <T extends object, K extends keyof T>(o: T | undefined, keys: K[]) => (o ? Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]])) : {});
  return EditablePlanSchema.parse({
    ...plan,
    ...pick(prev, ["budget_period", "bid_strategy", "bid_amount", "spend_cap", "page_id"]),
    ad_sets: plan.ad_sets.map((s, i) => {
      const p = match(prev?.ad_sets, s.name, i, plan.ad_sets.length);
      return {
        ...s,
        start_time: p?.start_time ?? null,
        end_time: p?.end_time ?? null,
        placements: p?.placements ?? "advantage",
        platforms: p?.platforms,
        ...pick(p, ["performance_goal", "lead_destination", "positions", "devices", "custom_audiences", "excluded_custom_audiences", "excluded_locations", "narrow_targeting"]),
      };
    }),
    ads: plan.ads.map((a, i) => {
      const p = match(prev?.ads, a.name, i, plan.ads.length);
      // Instant forms cannot be attached to existing posts (blocked by plan-rules), so ignore the post Claude chose.
      const postId = a.existing_post_id?.trim();
      const post = postId && plan.result_type !== "leads" ? posts?.get(postId) : undefined;
      if (post) {
        // Copy the post content into the text so switching to "Tạo mới" (Create new) in the editor still has the text.
        return {
          ...a,
          primary_text: a.primary_text || post.message,
          image_path: p?.image_path ?? null,
          link_url: p?.link_url ?? brief.landingUrl ?? null,
          source: "existing" as const,
          post_id: postId,
          post_preview: post,
          lead_form: null,
          welcome: p?.welcome ?? null,
        };
      }
      return {
        ...a,
        image_path: p?.image_path ?? null,
        link_url: p?.link_url ?? brief.landingUrl ?? null,
        // Keep the existing post / form / message template the user chose when Claude redrafts.
        source: p?.source ?? "new",
        post_id: p?.post_id ?? null,
        post_preview: p?.post_preview ?? null,
        lead_form: p?.lead_form ?? null,
        welcome: p?.welcome ?? null,
        video_id: p?.video_id ?? null,
        video_preview: p?.video_preview ?? null,
        // Carousels the user built (image + text per card) are kept as is.
        format: p?.format ?? "single",
        cards: p?.cards ?? [],
        carousel_auto_order: p?.carousel_auto_order ?? true,
      };
    }),
  });
}

export async function draftCampaign(clientId: string, rawBrief: unknown) {
  const brief = CampaignBriefSchema.parse(rawBrief);
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId } });
  const prompt = `${await planPrompt(clientId, brief)}\n\nDraw up the campaign plan.`;
  const res = await generateStructured({ clientId, system: PLANNER_SYSTEM, prompt, schema: CampaignPlanSchema });
  const resolved = await resolvePlanTargeting(res.data); // items Claude proposed outside the list → search on Meta
  const { byId } = await loadPlannerPosts(client, briefHint(brief));
  const { plan, notes: n } = normalizePlan(enforceTargetingRules(withEditorFields(resolved.plan, brief, undefined, byId), await getT()), { maxTotal: brief.dailyBudget, t: await getT() });
  const notes = [...resolved.notes, ...n];
  const draft = await db.campaignDraft.create({
    data: { clientId, brief: JSON.stringify(brief), plan: JSON.stringify(plan), result: notes.length ? JSON.stringify({ notes }) : null },
  });
  await logActivity(clientId, "analyze", (await getT())("ai.analysis.planLog", { name: plan.campaign_name }));
  await queueDraftPolicyCheck(clientId, draft.id, null); // check content policy right away (required before publishing)
  return draft.id;
}

/** Draft from the step-by-step builder (the user picks every setting). */
export async function createDraftFromPlan(clientId: string, raw: unknown) {
  const { plan } = normalizePlan(EditablePlanSchema.parse(raw), { userGeo: true, t: await getT() });
  const draft = await db.campaignDraft.create({ data: { clientId, brief: JSON.stringify({ source: "wizard" }), plan: JSON.stringify(plan) } });
  await logActivity(clientId, "publish", (await getT())("ai.analysis.wizardDraftLog", { name: plan.campaign_name }));
  return draft.id;
}

export async function createBlankDraft(clientId: string) {
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId } });
  const draft = await db.campaignDraft.create({ data: { clientId, brief: "{}", plan: JSON.stringify(blankPlan(client, await getT())) } });
  return draft.id;
}

/**
 * Only write the plan while the draft is still unpublished (a Claude redraft may finish after Publish was clicked).
 * baseRevision: saves from an editor holding an older version (before Claude redrafted) are rejected.
 */
async function writeDraftPlan(draftId: string, plan: EditablePlan, opts: { baseRevision?: number; bump?: boolean } = {}) {
  const r = await db.campaignDraft.updateMany({
    where: { id: draftId, status: "draft", ...(opts.baseRevision != null && { revision: opts.baseRevision }) },
    data: { plan: JSON.stringify(plan), ...(opts.bump && { revision: { increment: 1 } }) },
  });
  if (r.count) return;
  const d = await db.campaignDraft.findUniqueOrThrow({ where: { id: draftId } });
  const t = await getT();
  if (d.status !== "draft") throw new Error(t("ai.analysis.draftLocked"));
  throw new Error(t("ai.analysis.draftRedrafted"));
}

export async function saveDraft(draftId: string, raw: unknown, baseRevision?: number) {
  const draft = await db.campaignDraft.findUniqueOrThrow({ where: { id: draftId } });
  if (draft.status !== "draft") throw new Error((await getT())("ai.analysis.draftLocked"));
  const { plan, notes } = normalizePlan(EditablePlanSchema.parse(raw), { userGeo: true, t: await getT() });
  await writeDraftPlan(draftId, plan, { baseRevision });
  return notes;
}

export async function revisePlan(draftId: string, feedback: string) {
  const draft = await db.campaignDraft.findUniqueOrThrow({ where: { id: draftId } });
  if (draft.status !== "draft") throw new Error((await getT())("ai.analysis.onlyUnpublished"));
  const prev = EditablePlanSchema.parse(JSON.parse(draft.plan));
  const parsedBrief = CampaignBriefSchema.safeParse(JSON.parse(draft.brief));
  // Self-created drafts have no brief: build a minimal brief from the current plan.
  const brief: CampaignBrief = parsedBrief.success
    ? parsedBrief.data
    : {
        product: prev.campaign_name,
        goal: prev.result_type,
        dailyBudget: totalDailyBudget(prev) || 1,
        locations: prev.ad_sets.flatMap((s) => s.locations.map((l) => l.name)).join(", ") || "VN",
        ageMin: prev.ad_sets[0]?.age_min ?? 18,
        ageMax: prev.ad_sets[0]?.age_max ?? 65,
      };
  const prompt = `${await planPrompt(draft.clientId, brief, feedback)}

# Current plan
${JSON.stringify(prev)}

# Edit request from the account manager
${feedback}

Return the complete plan after making the requested edits, keeping every part not asked to change exactly as it is. For ads using an existing post (source "existing"), existing_post_id = the current post_id, unless the request asks to change the post.`;
  const res = await generateStructured({ clientId: draft.clientId, system: PLANNER_SYSTEM, prompt, schema: CampaignPlanSchema });
  const resolved = await resolvePlanTargeting(res.data);
  const client = await db.client.findUniqueOrThrow({ where: { id: draft.clientId } });
  const { byId } = await loadPlannerPosts(client, `${briefHint(brief)} ${feedback}`);
  const { plan } = normalizePlan(enforceTargetingRules(withEditorFields(resolved.plan, brief, prev, byId), await getT()), { maxTotal: parsedBrief.success ? brief.dailyBudget : undefined, t: await getT() });
  // Only write if nobody saved anything new while Claude was drafting (to avoid overwriting edits), then bump revision so the editor reloads.
  await writeDraftPlan(draftId, plan, { baseRevision: draft.revision, bump: true });
  await queueDraftPolicyCheck(draft.clientId, draftId, null); // re-check whichever content changed
}

// Still "publishing" after this long means the previous publish was interrupted midway (machine shut down, server crash).
const PUBLISH_LOCK_MS = 20 * 60 * 1000;

export async function publishDraft(draftId: string) {
  const draft = await db.campaignDraft.findUniqueOrThrow({ where: { id: draftId }, include: { client: true } });
  const t = await getT();
  if (draft.status === "published") throw new Error(t("ai.analysis.alreadyPublished"));
  let plan = EditablePlanSchema.parse(JSON.parse(draft.plan));
  const client = draft.client;
  const meta = getMetaClient(client);

  const { errors } = reviewPlan(plan, client, meta.kind === "meta", t);
  if (errors.length) throw new Error(errors.join(" "));

  // Validate detailed targeting against the very account that will publish (targetingvalidation) before creating anything on Meta:
  // items saved with the wrong type get their type fixed, items Meta disallows are reported by name. If validation fails, still publish (Meta reports errors itself, and partially created objects are rolled back).
  if (meta.kind === "meta" && client.metaAdAccountId && client.metaAccessToken) {
    const checked = await checkPlanTargeting(plan, { act: client.metaAdAccountId, token: decrypt(client.metaAccessToken) }).catch(() => null);
    if (checked?.errors.length) throw new Error(t("ai.analysis.nothingCreated", { errors: checked.errors.join(" ") }));
    if (checked?.changed) {
      plan = checked.plan;
      await writeDraftPlan(draftId, plan, { baseRevision: draft.revision, bump: true }); // save the corrected type so the double-check matches
      await logActivity(client.id, "publish", t("ai.analysis.draftNotesLog", { name: plan.campaign_name, notes: checked.notes.join(" ") })).catch(() => {});
    }
  }

  // Reserve before calling Meta: double clicks or 2 open tabs must not create 2 campaigns.
  const claimed = await db.campaignDraft.updateMany({
    where: { id: draftId, OR: [{ status: "draft" }, { status: "publishing", updatedAt: { lt: new Date(Date.now() - PUBLISH_LOCK_MS) } }] },
    data: { status: "publishing" },
  });
  if (!claimed.count) throw new Error(t("ai.analysis.publishBusy"));

  let result;
  try {
    result = await meta.publishPlan(plan);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db.campaignDraft.update({ where: { id: draftId }, data: { status: "draft", result: JSON.stringify({ error: msg }) } });
    if (err instanceof MetaApiError && err.code === 190) await markTokenError(client.id, msg);
    await logActivity(client.id, "error", t("ai.analysis.publishFailedLog", { error: msg }));
    throw err;
  }

  // Meta finished creating: save the IDs immediately so it never publishes again, even if later steps fail.
  const ids = {
    campaignId: result.campaign.id,
    adSetIds: result.adSets.map((s) => s.id),
    adIds: result.ads.map((a) => a.id),
    adPlanIndex: result.adPlanIndex,
  };
  // If the database is busy, retry longer than usual: if the write fails the draft is stuck in "publishing", and 20 minutes later Publish can be clicked again → duplicate campaign.
  await retryBusy(() => db.campaignDraft.update({ where: { id: draftId }, data: { status: "published", result: JSON.stringify({ ...ids, notes: result.notes }) } }), 6).catch(async (err) => {
    await logActivity(client.id, "error", t("ai.analysis.publishedNotSavedLog", { name: plan.campaign_name, id: ids.campaignId })).catch(() => {});
    throw err;
  });

  // Double-check step: read back from Meta and compare with the plan.
  const verify = await meta.verifyPublished(plan, ids).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
  await db.campaignDraft.update({ where: { id: draftId }, data: { result: JSON.stringify({ ...ids, notes: result.notes, verify }) } });
  try {
    // upsert: a concurrent sync may already have written these objects.
    await db.$transaction(async (tx) => {
      const c = { ...result.campaign, clientId: client.id };
      await tx.campaign.upsert({ where: { id: c.id }, create: c, update: {} });
      for (const s of result.adSets) await tx.adSet.upsert({ where: { id: s.id }, create: { ...s, clientId: client.id }, update: {} });
      for (const a of result.ads) await tx.ad.upsert({ where: { id: a.id }, create: { ...a, clientId: client.id }, update: {} });
    });
  } catch (err) {
    await logActivity(client.id, "error", t("ai.analysis.publishedNotStoredLog", { error: err instanceof Error ? err.message : String(err) }));
  }
  const verdict = "ok" in verify ? (verify.ok ? t("ai.analysis.verifyOk") : t("ai.analysis.verifyMismatch")) : "";
  await logActivity(client.id, "publish", t("ai.analysis.publishedLog", { name: plan.campaign_name, verdict, notes: result.notes.join(" ") }));
}

/** Rerun the double-check step for a published draft. */
export async function reverifyDraft(draftId: string) {
  const draft = await db.campaignDraft.findUniqueOrThrow({ where: { id: draftId }, include: { client: true } });
  const prev = draft.result ? JSON.parse(draft.result) : {};
  if (draft.status !== "published" || !prev.campaignId) throw new Error((await getT())("ai.analysis.notPublished"));
  const plan = EditablePlanSchema.parse(JSON.parse(draft.plan));
  const verify = await getMetaClient(draft.client).verifyPublished(plan, prev);
  await db.campaignDraft.update({ where: { id: draftId }, data: { result: JSON.stringify({ ...prev, verify }) } });
}

export async function duplicateDraft(draftId: string) {
  const d = await db.campaignDraft.findUniqueOrThrow({ where: { id: draftId } });
  const plan = EditablePlanSchema.parse(JSON.parse(d.plan));
  const copy = await db.campaignDraft.create({
    data: { clientId: d.clientId, brief: d.brief, plan: JSON.stringify({ ...plan, campaign_name: (await getT())("ai.analysis.copyName", { name: plan.campaign_name }) }), policy: d.policy }, // same content: keep the policy check result
  });
  return copy.id;
}

/** Delete the draft in the system (does not touch campaigns already published on Meta). */
export async function deleteDraft(draftId: string) {
  const d = await db.campaignDraft.delete({ where: { id: draftId } });
  const name = EditablePlanSchema.safeParse(JSON.parse(d.plan));
  await logActivity(d.clientId, "sync", (await getT())("ai.analysis.deleteDraftLog", { name: name.success ? name.data.campaign_name : d.id }));
}
