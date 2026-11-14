import { db } from "./db";
import { defaultDailyBudget } from "./format";
import { logActivity } from "./activity";
import { generateStructured } from "./ai/claude";
import { IDEAS_SYSTEM } from "./ai/prompts";
import { CampaignIdeasSchema, RESULT_TYPES, type CampaignIdeas } from "./ai/schemas";
import { clientProfile, latestConversationInsights, loadPlannerPosts, pageAndBreakdownContext } from "./ai/context";
import { draftCampaign, historyForPlanner } from "./ai/tasks";
import { knowledgePromptSection } from "./knowledge";
import { audiencePromptSection } from "./audience";
import { testModeFor, testModePrompt } from "./test-mode";
import { plannerDataSection } from "./planner-context";
import { getT } from "@/i18n/server";

// "Nhờ Claude lên camp" (ask Claude to plan a campaign): step 1 (background) produces ideas + questions from the brief (optional) and client data;
// step 2 (background) drafts the chosen ideas.

/** User-entered brief (all optional): what to run, daily budget, objective. */
export type ProposalBrief = { text: string; dailyBudget: number | null; goal: string | null };

export function cleanProposalBrief(raw: unknown): ProposalBrief {
  const o = (raw ?? {}) as Record<string, unknown>;
  const budget = Number(o.dailyBudget);
  return {
    text: String(o.text ?? "").trim().slice(0, 3000),
    dailyBudget: Number.isFinite(budget) && budget > 0 ? Math.round(budget) : null,
    goal: typeof o.goal === "string" && (RESULT_TYPES as readonly string[]).includes(o.goal) ? o.goal : null,
  };
}

export async function proposeCampaigns(clientId: string, brief: ProposalBrief = { text: "", dailyBudget: null, goal: null }) {
  const t = await getT();
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId } });
  const [audience, knowledge, pageData, posts, history, insights, drafts, mode] = await Promise.all([
    audiencePromptSection(clientId),
    knowledgePromptSection(clientId),
    pageAndBreakdownContext(clientId, { posts: false }),
    loadPlannerPosts(client, brief.text),
    historyForPlanner(clientId),
    latestConversationInsights(clientId),
    db.campaignDraft.findMany({ where: { clientId }, orderBy: { updatedAt: "desc" }, take: 10, select: { plan: true, status: true } }),
    testModeFor(clientId),
  ]);
  if (!audience.text && !brief.text) throw new Error(t("campaigns.proposals.noPersona"));
  const draftNames = drafts.flatMap((d) => {
    try {
      return [`${JSON.parse(d.plan).campaign_name} (${d.status === "published" ? "published" : "draft"})`];
    } catch {
      return [];
    }
  });
  const today = new Date().toLocaleDateString("vi-VN", { timeZone: client.timezone });
  const prompt = `# Client profile
${clientProfile(client)}

${knowledge}

${audience.text}

${pageData}

${posts.text}

# Insights from messages
${insights ? JSON.stringify(insights) : "None yet."}

# Campaigns & 7-day performance
${JSON.stringify(history)}

${await plannerDataSection(client)}

# Recent drafts
${draftNames.join("\n") || "None yet."}

${testModePrompt(mode, client.currency, brief.dailyBudget ?? client.maxDailyBudget)}

${briefSection(brief)}

Today: ${today}. Propose campaign ideas and ask about anything that is missing.`;
  const res = await generateStructured({ clientId: clientId, system: IDEAS_SYSTEM, prompt, schema: CampaignIdeasSchema, effort: "medium" });
  // Store the test mode too so the UI shows "Khách mới / Đang học / Đã có tệp thắng" (new client / learning / has winning audience).
  const p = await db.campaignProposal.create({ data: { clientId, report: JSON.stringify({ ...res.data, test_mode: { mode: mode.mode, label: mode.label, reason: mode.reason }, brief }), model: res.model } });
  await logActivity(clientId, "analyze", t("campaigns.proposals.activity", { ideas: res.data.ideas.length }) + (res.data.questions.length ? t("campaigns.proposals.activityQuestions", { count: res.data.questions.length }) : ""));
  return p.id;
}

function briefSection(b: ProposalBrief) {
  if (!b.text && !b.dailyBudget && !b.goal) return "# User brief\nNone: propose on your own from the data.";
  return [
    "# User brief (takes priority over your own proposals)",
    b.text && `Wants to run: ${b.text}`,
    b.dailyBudget && `Total budget/day: ${b.dailyBudget}`,
    b.goal && `Objective: ${b.goal}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** "300k", "300.000đ/ngày", "10tr/tháng" → amount per day. Unparseable → null. */
function parseDailyBudget(text: string | undefined) {
  if (!text) return null;
  const t = text.toLowerCase();
  const m = t.match(/(\d+(?:[.,]\d+)*)\s*(.*)$/);
  if (!m) return null;
  let n = Number(m[1].replace(/[.,](?=\d{3}(?!\d))/g, "").replace(",", "."));
  if (!Number.isFinite(n)) return null;
  // Unit right after the number, standing alone (not the first letter of another word, e.g. "m" in "mỗi").
  const unit = m[2].match(/^(k|nghìn|ngàn|triệu|tr|m)(?!\p{L})/u)?.[1];
  if (unit === "k" || unit === "nghìn" || unit === "ngàn") n *= 1000;
  if (unit === "tr" || unit === "triệu" || unit === "m") n *= 1_000_000;
  if (/tháng|thang|month/.test(t)) n = n / 30;
  return n >= 10000 ? Math.round(n) : null;
}

/** Draft a chosen idea into a campaign draft (reusing the existing planning step). */
export async function draftFromIdea(proposalId: string, index: number, answers: Record<string, string>) {
  const t = await getT();
  const p = await db.campaignProposal.findUniqueOrThrow({ where: { id: proposalId }, include: { client: true } });
  const report: CampaignIdeas & { brief?: ProposalBrief } = JSON.parse(p.report);
  const userBrief = report.brief;
  const idea = report.ideas[index];
  if (!idea) throw new Error(t("campaigns.proposals.ideaNotFound"));
  const qa = report.questions.map((q) => `- ${q.question} → ${answers[q.id]?.trim() || q.suggested}`).join("\n");
  const budgetAnswer = report.questions.find((q) => /budget|ngan.?sach|ngân sách/i.test(`${q.id} ${q.question}`));
  const budget =
    parseDailyBudget(budgetAnswer ? answers[budgetAnswer.id] || budgetAnswer.suggested : undefined) ??
    idea.daily_budget ??
    userBrief?.dailyBudget ??
    p.client.maxDailyBudget ??
    defaultDailyBudget(p.client.currency);
  const landing = Object.values(answers).find((a) => /^https?:\/\//.test(a.trim()))?.trim();
  const clamp = (v: number) => Math.max(18, Math.min(65, Math.round(v)));
  const brief = {
    product: `${idea.title}. Main product / offer: ${idea.offer}${userBrief?.text ? `\nThe user wants to run: ${userBrief.text}` : ""}`,
    goal: idea.result_type,
    dailyBudget: p.client.maxDailyBudget ? Math.min(budget, p.client.maxDailyBudget) : budget,
    locations: idea.locations,
    ageMin: clamp(idea.age_min),
    ageMax: Math.max(clamp(idea.age_min), clamp(idea.age_max)),
    ...(landing && { landingUrl: landing }),
    notes: [
      `Target personas: ${idea.personas.join(", ")}`,
      `Proposed structure: ${idea.structure}`,
      `Content: ${idea.creative}`,
      `Reason: ${idea.why}`,
      `Success threshold (write it into each ad set's hypothesis): ${idea.success}`,
      qa && `The user answered:\n${qa}`,
    ]
      .filter(Boolean)
      .join("\n"),
  };
  return draftCampaign(p.clientId, brief);
}
