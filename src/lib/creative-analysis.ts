import { db } from "./db";
import { getMetaClient } from "./meta";
import { logActivity } from "./activity";
import { generateStructured, type ImageInput } from "./ai/claude";
import { CREATIVE_SYSTEM } from "./ai/prompts";
import { CreativeAnalysisSchema } from "./ai/schemas";
import { clientProfile } from "./ai/context";
import { audiencePromptSection } from "./audience";
import { knowledgePromptSection } from "./knowledge";
import { money } from "./format";
import type { CreativeRow } from "./meta/types";
import { targetCprOf } from "./target-cpr";
import { getT } from "@/i18n/server";

// Winning / losing ad creative analysis (30 days): Claude views images / video frames + text, derives the winning formula,
// and proposes new ad templates. Saved as a report (Audit kind "creative"); optimization uses it when writing new ads.

const DAYS = 30;
const PICK = 4; // number of winning / losing ads given to Claude

export async function runCreativeAnalysis(clientId: string, onProgress?: (label: string) => Promise<void>) {
  const t = await getT();
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId } });
  if (client.dataSource !== "meta") throw new Error(t("ai.creative.notMeta"));
  const meta = getMetaClient(client);
  await onProgress?.(t("ai.creative.progressReading"));
  const all = await meta.fetchCreativePerformance(DAYS);
  // Only compare ads with the client's primary result type.
  const rows = all.filter((r) => r.resultType === client.primaryResult);
  const spend = rows.reduce((a, r) => a + r.spend, 0);
  const results = rows.reduce((a, r) => a + r.results, 0);
  const ref = targetCprOf(client) ?? (results ? spend / results : null);
  if (!ref) throw new Error(t("ai.creative.noResults"));
  const eligible = rows.filter((r) => r.spend >= client.optMinSpendX * ref);
  if (eligible.length < 4) throw new Error(t("ai.creative.notEnough", { x: client.optMinSpendX, amount: money(client.optMinSpendX * ref, client.currency), count: eligible.length }));
  const cpr = (r: CreativeRow) => (r.results ? r.spend / r.results : Number.POSITIVE_INFINITY);
  const sorted = [...eligible].sort((a, b) => cpr(a) - cpr(b));
  const n = Math.min(PICK, Math.floor(sorted.length / 2));
  const winners = sorted.slice(0, n);
  const losers = sorted.slice(-n).reverse();

  await onProgress?.(t("ai.creative.progressImages"));
  // tag is stored in the report and matched by the audits page / job summary: keep the Vietnamese values. The prompt says WINNER / LOSER.
  const picked = [...winners.map((r) => ({ r, tag: "THẮNG" })), ...losers.map((r) => ({ r, tag: "THUA" }))];
  const contents = new Map((await meta.fetchAdCreatives(picked.map((p) => p.r.adId))).map((c) => [c.adId, c]));
  const images: ImageInput[] = [];
  const lines: string[] = [];
  for (const [i, { r, tag }] of picked.entries()) {
    const c = contents.get(r.adId);
    let img: string | null = null;
    if (c?.imageUrl) {
      try {
        const res = await fetch(c.imageUrl);
        const type = res.headers.get("content-type") ?? "";
        const buf = Buffer.from(await res.arrayBuffer());
        if (res.ok && buf.length < 4_000_000 && /image\/(jpeg|png|webp|gif)/.test(type)) {
          img = `ad_${i + 1}.${type.split("/")[1].replace("jpeg", "jpg")}`;
          images.push({ name: img, data: buf, mediaType: type.split(";")[0] as ImageInput["mediaType"] });
        }
      } catch {}
    }
    const c3 = r.impressions ? (r.plays3s / r.impressions) * 100 : 0;
    lines.push(
      [
        `### ${tag === "THẮNG" ? "WINNER" : "LOSER"} · ad_id ${r.adId} · ${r.adName}`,
        `Campaign: ${r.campaignName} · Ad set: ${r.adSetName} · Format: ${c?.format ?? "?"}${img ? ` · Image: ./${img}` : " · (image could not be downloaded)"}`,
        `30 days: spend ${money(r.spend, client.currency)} · ${r.results} results · CPR ${r.results ? money(r.spend / r.results, client.currency) : "—"} · CTR ${r.impressions ? ((r.clicks / r.impressions) * 100).toFixed(2) : 0}%` +
          (r.plays3s ? ` · 3-second views ${c3.toFixed(1)}% of impressions · completions ${((r.thruplays / r.plays3s) * 100).toFixed(1)}% of 3-second views` : ""),
        `Headline: ${c?.headline || "—"}`,
        `Text: ${(c?.text || "—").replace(/\s+/g, " ").slice(0, 700)}`,
      ].join("\n"),
    );
  }

  await onProgress?.(t("ai.creative.progressClaude", { images: images.length, ads: picked.length }));
  const [audience, knowledge] = await Promise.all([audiencePromptSection(clientId), knowledgePromptSection(clientId)]);
  const prompt = `# Client profile
${clientProfile(client)}

${knowledge}

${audience.text}

# Baseline: 30-day average CPR ${money(ref, client.currency)} (${rows.length} ads with spend, ${eligible.length} ads with enough data)

# Winning and losing ads
${lines.join("\n\n")}

Compare them and make your proposals.`;
  const res = await generateStructured({ clientId: clientId, system: CREATIVE_SYSTEM, prompt, schema: CreativeAnalysisSchema, effort: "high", images });
  const report = {
    ...res.data,
    ads: picked.map(({ r, tag }) => ({ ...r, tag, format: contents.get(r.adId)?.format ?? null, headline: contents.get(r.adId)?.headline ?? "", imageUrl: contents.get(r.adId)?.imageUrl ?? null })),
    ref,
    days: DAYS,
  };
  const audit = await db.audit.create({
    data: { clientId, kind: "creative", score: null, summary: res.data.summary, report: JSON.stringify(report), model: res.model, inputTokens: res.inputTokens, outputTokens: res.outputTokens },
  });
  await logActivity(clientId, "analyze", t("ai.creative.log", { win: winners.length, lose: losers.length, images: images.length, count: res.data.new_ads.length }));
  return audit.id;
}

/** Summary of the latest winning formula (fed into optimization when writing new ads). */
export async function creativePromptSection(clientId: string) {
  const a = await db.audit.findFirst({ where: { clientId, kind: "creative" }, orderBy: { createdAt: "desc" } });
  if (!a) return "";
  const r = CreativeAnalysisSchema.safeParse(JSON.parse(a.report));
  if (!r.success) return "";
  return `# Ad creative analysis, latest (${a.createdAt.toISOString().slice(0, 10)})
Winning patterns: ${r.data.winning_patterns.map((p) => p.pattern).join("; ")}
Losing patterns: ${r.data.losing_patterns.map((p) => p.pattern).join("; ")}
Write new ads following the winning patterns, avoid the losing ones.`;
}
