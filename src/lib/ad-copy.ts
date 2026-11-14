import { z } from "zod";
import { db } from "./db";
import { generateStructured } from "./ai/claude";
import { clientProfile, latestConversationInsights } from "./ai/context";
import { knowledgePromptSection } from "./knowledge";
import { audiencePromptSection } from "./audience";
import { creativePromptSection } from "./creative-analysis";
import { RESULT_LABEL } from "./format";

// Ad copy suggestions in the step-by-step builder: based on documents, persona, customers' frequent questions and winning content.

const CopySchema = z.object({
  variants: z
    .array(
      z.object({
        angle: z.string().describe("Short angle, e.g. 'Proof from real conversations'"),
        primary_text: z.string().describe("Primary text of 2-6 lines in natural Vietnamese, with a hook in the first line, no exaggeration, no untrue promises"),
        headline: z.string().describe("Headline of at most 40 characters, in Vietnamese"),
        description: z.string().describe("Short description in Vietnamese, may be empty"),
      }),
    )
    .describe("3 variants with different angles"),
});
export type CopyVariant = z.infer<typeof CopySchema>["variants"][number];

const SYSTEM = `You are a Facebook/Instagram ad copywriter for small and medium businesses in Vietnam.
Write 3 content variants with different angles, matching the campaign objective and the audience described.
Only use product, price and offer information present in the data; never invent prices, figures or commitments. Follow Meta's advertising policies (do not target personal attributes such as "bạn béo" ("you're fat"), do not promise medical results).
The ad copy (primary_text, headline, description) is for the client's customers: write it in Vietnamese with full, correct diacritics. The angle follows the OUTPUT LANGUAGE line.`;

export async function suggestAdCopy(clientId: string, input: { resultType: string; campaignName: string; audienceNote: string }) {
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId } });
  const [knowledge, insights, audience, creative] = await Promise.all([
    knowledgePromptSection(clientId),
    latestConversationInsights(clientId),
    audiencePromptSection(clientId).catch(() => ({ text: "" })),
    creativePromptSection(clientId).catch(() => ""),
  ]);
  const prompt = `# Client
${clientProfile(client)}

${knowledge}

${audience.text}

${creative}

# Customers' frequent questions / objections
${insights ? JSON.stringify({ top_questions: insights.top_questions, objections: insights.objections }) : "Messages not analysed yet."}

# Campaign being created
Name: ${input.campaignName}
Objective: ${input.resultType} (${RESULT_LABEL[input.resultType] ?? input.resultType})
Audience: ${input.audienceNote || "not described"}

Write 3 content variants.`;
  const res = await generateStructured({ clientId: clientId, system: SYSTEM, prompt, schema: CopySchema, effort: "low" });
  return res.data.variants.slice(0, 3);
}
