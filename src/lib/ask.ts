import { BRAND } from "@/lib/brand";
import { z } from "zod";
import { db } from "./db";
import { generateStructured } from "./ai/claude";
import { clientProfile, latestConversationInsights } from "./ai/context";
import { audiencePromptSection } from "./audience";
import { todayOverview } from "./today";
import { derive, money, sumMetrics, type Metrics } from "./format";
import { getT } from "@/i18n/server";

// "Ask Claude": answers questions using data already in the system (no Meta calls, no end-customer personal data sent).
// Only returns buttons linking to pages in the system; changes on Meta still go through Pending approval.

export const AskSchema = z.object({
  answer: z.string().describe("Short answer in the output language, results first then details, with concrete numbers; if there is not enough data, say so plainly"),
  table_columns: z.array(z.string()).describe("Column names if a small illustrative table helps (at most 5 columns); otherwise empty"),
  table_rows: z.array(z.array(z.string())).describe("Table rows (at most 8 rows, each cell is formatted text); otherwise empty"),
  actions: z
    .array(
      z.object({
        label: z.string().describe("Short button label in the output language, e.g. 'Open report', 'View recommendations'"),
        kind: z.enum(["report", "recommendations", "messages", "audience", "create", "campaign", "settings", "client"]),
        campaign_id: z.string().describe("Only when kind = campaign: a campaign id present in the data; otherwise empty"),
      }),
    )
    .describe("0-3 buttons linking to relevant pages in the system"),
});
export type AskAnswer = z.infer<typeof AskSchema> & { links: { label: string; href: string }[]; source: string };

// Starts with "You are the Meta ads assistant": usage.ts taskOf recognises the "Ask Claude" task by this opening.
const SYSTEM = `You are the Meta ads assistant of the ${BRAND.agency} agency, answering the agency owner (knows advertising well, likes brevity).
Rules:
- Only use the numbers provided. Never invent numbers, never guess. If data is missing, say exactly what is missing and how to get it (e.g. update the data, run message analysis).
- Short answers (2-5 sentences), in the output language, with number formats matching it: Vietnamese style when writing Vietnamese (49.205.793 ₫, 0,56%), English style when writing English (49,205,793 ₫, 0.56%).
- Never change anything on Meta yourself. If something should change (pause an ad set, raise a budget...), suggest opening the Pending approval / Reports page to approve it.
- Terminology: cost per result (CPR), click-through rate (CTR), frequency, ad set.`;

export async function clientContext(clientId: string) {
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId } });
  const [campaigns, daily, recs, insights, audience, today] = await Promise.all([
    db.campaign.findMany({ where: { clientId }, include: { adSets: { omit: { targeting: true }, orderBy: { spend: "desc" }, take: 8 } }, orderBy: { spend: "desc" } }),
    db.dailyMetric.findMany({ where: { clientId }, orderBy: { date: "desc" }, take: 14 }),
    db.recommendation.findMany({ where: { clientId, status: "pending" }, select: { title: true, actionType: true, priority: true }, take: 10 }),
    latestConversationInsights(clientId),
    audiencePromptSection(clientId).catch(() => ({ text: "" })),
    todayOverview([clientId]),
  ]);
  const cur = client.currency;
  const row = (m: Metrics) => {
    const d = derive(m);
    return `spend ${money(m.spend, cur)} · ${m.results} results · CPR ${money(d.cpr, cur)} · CTR ${d.ctr?.toFixed(2) ?? "—"}% · frequency ${d.frequency?.toFixed(2) ?? "—"}`;
  };
  const camps = campaigns
    .filter((c) => c.status === "ACTIVE" || c.spend > 0)
    .map((c) => `- [${c.id}] ${c.name} (${c.status}, ${c.resultType}): ${row(c)}\n${c.adSets.map((s) => `    · ad set ${s.name} (${s.status}): ${row(s)}`).join("\n")}`)
    .join("\n");
  const main = sumMetrics(campaigns.filter((c) => c.resultType === client.primaryResult));
  return {
    name: client.name,
    lastSync: client.lastSyncedAt,
    text: `# Client
${clientProfile(client)}
Last data update: ${client.lastSyncedAt?.toISOString() ?? "never"}

# 7-day total (${client.primaryResult}): ${row(main)}

# Campaigns & ad sets (7 days)
${camps || "No campaigns running."}

# Daily (last 14 days)
${daily
  .reverse()
  .map((d) => `${d.date}: spend ${money(d.spend, cur)}, ${d.results} results`)
  .join("\n") || "None yet."}

# Recommendations pending approval
${recs.map((r) => `- ${r.title} (${r.actionType}, priority ${r.priority})`).join("\n") || "None."}

# To-do
${today.list.find((c) => c.id === clientId)?.tasks.map((t) => `- ${t.text}`).join("\n") || "None."}

# Message insights
${insights ? JSON.stringify({ summary: insights.summary, top_questions: insights.top_questions, objections: insights.objections }) : "Not analysed yet."}

${audience.text}`,
  };
}

export async function agencyContext(ids: string[] | null) {
  const { rows, list } = await todayOverview(ids);
  return `# Clients (7 days)
${rows
  .map((r) => `- ${r.name}: spend ${money(r.spend, r.currency)}, ${r.results} ${r.primaryResult}, CPR ${money(r.cpr, r.currency)}${r.cprVsTarget != null ? ` (${r.cprVsTarget > 0 ? "+" : ""}${Math.round(r.cprVsTarget * 100)}% vs target)` : ""}, ${r.pending} pending recommendations, ${r.hotLeads} unanswered hot leads`)
  .join("\n")}

# To-do
${list.flatMap((c) => c.tasks.map((t) => `- ${c.name}: ${t.text}`)).join("\n") || "None."}`;
}

/** ids: clients the asker may view, used for general questions (clientId null); null = all clients. workspaceId: business billed for Claude calls on general questions. */
export async function askClaude(clientId: string | null, question: string, ids: string[] | null = null, workspaceId: string | null = null): Promise<AskAnswer> {
  const t = await getT();
  const q = question.trim().slice(0, 600);
  if (!q) throw new Error(t("ai.ask.emptyQuestion"));
  const ctx = clientId ? await clientContext(clientId) : null;
  const prompt = `${ctx ? ctx.text : await agencyContext(ids)}

# Question
${q}`;
  const res = await generateStructured({ clientId, workspaceId, system: SYSTEM, prompt, schema: AskSchema, effort: "low" });
  const base = clientId ? `/clients/${clientId}` : "";
  const href = (a: AskAnswer["actions"][number]) => {
    if (!clientId) return a.kind === "recommendations" ? "/recommendations" : "/";
    switch (a.kind) {
      case "report":
        return `${base}/campaigns`;
      case "recommendations":
        return `${base}/recommendations`;
      case "messages":
        return `${base}/messages`;
      case "audience":
        return `${base}/audience`;
      case "create":
        return `${base}/create`;
      case "settings":
        return `${base}/settings`;
      case "campaign":
        return a.campaign_id ? `${base}/campaigns/${encodeURIComponent(a.campaign_id)}` : `${base}/campaigns`;
      default:
        return base;
    }
  };
  return {
    ...res.data,
    links: res.data.actions.slice(0, 3).map((a) => ({ label: a.label, href: href(a) })),
    source: ctx
      ? t("ai.ask.sourceClient", {
          name: ctx.name.split(" – ")[0],
          updated: ctx.lastSync ? t("ai.ask.sourceUpdated", { at: ctx.lastSync.toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }) }) : "",
        })
      : t("ai.ask.sourceAll"),
  };
}
