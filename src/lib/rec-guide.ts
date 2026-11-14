import { db } from "./db";
import { generateStructured } from "./ai/claude";
import { GUIDE_SYSTEM } from "./ai/prompts";
import { RecGuideSchema, type RecGuide } from "./ai/schemas";
import { clientProfile } from "./ai/context";
import { knowledgePromptSection } from "./knowledge";
import { clientPages } from "./client-pages";
import { RESULT_LABEL } from "./format";
import { audiencePromptSection } from "./audience";

// "Hướng dẫn từng bước" (step-by-step guide) for manual recommendations: Claude writes a concrete procedure for this exact client + recommendation
// (where to click, what to enter, how to check, which steps the platform can do). Stored so reopening doesn't require waiting.

const r0 = (v: number | null | undefined) => (v == null ? "—" : Math.round(v).toLocaleString("vi-VN"));

/** Current account structure (from the latest sync), so the guide uses real names / budgets. */
async function accountStructure(clientId: string) {
  const campaigns = await db.campaign.findMany({
    where: { clientId, OR: [{ status: "ACTIVE" }, { spend: { gt: 0 } }] },
    orderBy: { spend: "desc" },
    take: 25,
    include: { adSets: { where: { OR: [{ status: "ACTIVE" }, { spend: { gt: 0 } }] }, orderBy: { spend: "desc" }, take: 8, select: { name: true, status: true, dailyBudget: true, spend: true, results: true } } },
  });
  if (!campaigns.length) return "No campaigns with spend / running yet.";
  return campaigns
    .map(
      (c) =>
        `- [${c.status}] ${c.name} (${RESULT_LABEL[c.resultType] ?? c.resultType}; budget/day ${r0(c.dailyBudget)}; 7 days: spent ${r0(c.spend)}, ${c.results} results)\n` +
        c.adSets.map((s) => `    · [${s.status}] ${s.name} (budget/day ${r0(s.dailyBudget)}; spent ${r0(s.spend)}, ${s.results} results)`).join("\n"),
    )
    .join("\n");
}

export async function buildRecGuide(recId: string): Promise<RecGuide> {
  const rec = await db.recommendation.findUniqueOrThrow({ where: { id: recId }, include: { client: true } });
  const client = rec.client;
  const [structure, knowledge, audience] = await Promise.all([accountStructure(client.id), knowledgePromptSection(client.id), audiencePromptSection(client.id)]);
  const pages = clientPages(client).map((p) => p.name).join(", ");
  const prompt = `# Client
${clientProfile(client)}
Page: ${pages || "—"} · Ad account: ${client.metaAdAccountId ?? "not connected"}

${knowledge}

${audience.text}

# Current account structure (last 7 days)
${structure}

# Recommendation to carry out
Title: ${rec.title}
Priority: ${rec.priority}
Details: ${rec.rationale}
Expected impact: ${rec.expectedImpact || "—"}
${rec.campaignName ? `Related campaign: ${rec.campaignName}` : ""}${rec.targetName ? `\nTarget: ${rec.targetLevel ?? ""} ${rec.targetName}` : ""}
${rec.evidence && rec.evidence !== "{}" ? `Data at the time of the recommendation: ${rec.evidence}` : ""}

Write a step-by-step guide for carrying out this recommendation.`;
  const res = await generateStructured({ clientId: rec.clientId, system: GUIDE_SYSTEM, prompt, schema: RecGuideSchema, effort: "medium" });
  await db.recommendation.update({ where: { id: recId }, data: { guide: JSON.stringify(res.data), guideDone: "[]" } });
  return res.data;
}

export async function toggleGuideStep(recId: string, index: number) {
  const rec = await db.recommendation.findUniqueOrThrow({ where: { id: recId }, select: { guideDone: true } });
  const done = new Set<number>(JSON.parse(rec.guideDone || "[]"));
  if (done.has(index)) done.delete(index);
  else done.add(index);
  const list = [...done].sort((a, b) => a - b);
  await db.recommendation.update({ where: { id: recId }, data: { guideDone: JSON.stringify(list) } });
  return list;
}
