import { db } from "./db";
import { logActivity } from "./activity";
import { catalog, copyTextOf, lookupTargeting, targetingKey } from "./targeting";
import { isVerified, audiencePromptSection, type FitItem, type RankedTargeting } from "./audience";
import { industryStats } from "./industry-stats";
import { generateStructured } from "./ai/claude";
import { TARGET_IDEAS_SYSTEM } from "./ai/prompts";
import { TargetIdeasSchema } from "./ai/schemas";
import { clientProfile, latestConversationInsights } from "./ai/context";
import { knowledgePromptSection } from "./knowledge";
import { plannerDataSection } from "./planner-context";
import { resolveIdeas } from "./targeting-resolve";
import { RESULT_LABEL } from "./format";
import { getT } from "@/i18n/server";

// The "Targeting" step of the campaign wizard. Claude leads: table 1 is Claude's recommendations (from the persona, or recommendations specific
// to the campaign being created), each row with EVIDENCE from system data; table 2 is the system's assessment of items Claude didn't pick.

export type WizardTarget = {
  id: string;
  name: string;
  type: string;
  copy: string; // text to paste into Ads Manager search
  checked: boolean; // verified findable in Ads Manager
  size: number | null;
  source: "claude" | "campaign" | "system" | "industry";
  score: number | null; // Claude's score (table 1) or system score (table 2)
  systemScore: number | null;
  status: string; // evidence: Đã kiểm chứng / Đang kiểm chứng / Chưa chạy / Ngành +x% (proven / being proven / not run / industry +x%)
  spend?: number;
  results?: number;
  cpr?: number | null;
  persona: string | null;
  reason: string | null;
  hypothesis?: string | null;
  role?: "core" | "explore" | "narrow" | null;
  explore: boolean;
  free?: boolean; // Claude's own suggestion outside the list (found on Meta)
};

type Entry = Pick<WizardTarget, "id" | "type" | "name" | "source" | "score" | "persona" | "reason" | "explore"> & Partial<Pick<WizardTarget, "hypothesis" | "role" | "free" | "status">>;

async function rankingOf(clientId: string) {
  const ranking = await db.targetingRanking.findFirst({ where: { clientId }, orderBy: { createdAt: "desc" } });
  const items: RankedTargeting[] = ranking ? JSON.parse(ranking.items) : [];
  return { ranking, items, byId: new Map(items.filter((i) => i.id).map((i) => [i.id!, i])) };
}

/** Attach system evidence + Ads Manager copy text. Drop items no longer usable (dead / not findable in Ads Manager). */
async function toWizardTargets(clientId: string, entries: Entry[], rank?: Awaited<ReturnType<typeof rankingOf>>): Promise<WizardTarget[]> {
  const tr = await getT();
  const r = rank ?? (await rankingOf(clientId));
  const keys = entries.map((e) => targetingKey(e.type, e.id));
  const lib = new Map(
    (
      await db.targetingItem.findMany({
        where: { key: { in: keys }, status: "active", OR: [{ findable: true }, { findable: null }] },
        select: { key: true, name: true, nameVi: true, copyText: true, findable: true },
      })
    ).map((t) => [t.key, t]),
  );
  const seen = new Set<string>();
  const out: WizardTarget[] = [];
  for (const e of entries) {
    const key = targetingKey(e.type, e.id);
    const l = lib.get(key);
    const c = lookupTargeting(e.id, e.type);
    if (!l || !c || seen.has(key)) continue;
    seen.add(key);
    const ev = r.byId.get(e.id);
    const name = l.nameVi || l.name || e.name;
    out.push({
      ...e,
      name,
      copy: copyTextOf({ name, copyText: l.copyText }),
      checked: !!l.findable,
      size: c.vnHi ?? null,
      systemScore: ev?.score ?? null,
      status: e.status ?? (ev?.perf == null ? tr("core.wizardTargets.notRun") : isVerified(ev) ? tr("core.wizardTargets.verified") : tr("core.wizardTargets.verifying")),
      spend: ev?.spend,
      results: ev?.results,
      cpr: ev?.cpr,
    });
  }
  return out;
}

/** Table 1 (Claude's recommendations from the persona step) + table 2 (system assessment: items Claude didn't pick, winning items in the industry). */
export async function wizardTables(client: { id: string; industryKey: string | null; primaryResult: string }) {
  const tr = await getT();
  const [analysis, rank] = await Promise.all([db.audienceAnalysis.findFirst({ where: { clientId: client.id }, orderBy: { createdAt: "desc" } }), rankingOf(client.id)]);
  const fits: FitItem[] = analysis ? JSON.parse(analysis.candidates) : [];
  const claude = await toWizardTargets(
    client.id,
    [...fits]
      .sort((a, b) => b.fit - a.fit)
      .map((f) => ({ id: f.id, type: f.type, name: f.name, source: "claude" as const, score: f.fit, persona: f.direction ?? f.persona, reason: f.reason, explore: !!f.explore, free: !!f.free })),
    rank,
  );
  const inClaude = new Set(claude.map((t) => t.id));
  const system = await toWizardTargets(
    client.id,
    rank.items
      .filter((i) => i.id && i.type !== "custom_audiences" && !inClaude.has(i.id))
      .map((i) => ({ id: i.id!, type: i.type, name: i.name, source: "system" as const, score: i.score, persona: i.persona, reason: i.reason, explore: !!i.explore })),
    rank,
  );
  if (client.industryKey) {
    const seen = new Set([...inClaude, ...system.map((t) => t.id)]);
    const ind = (await industryStats(client.industryKey, client.primaryResult, client.id)).filter((x) => x.index > 1 && x.itemId && x.confidence >= 0.2 && !seen.has(x.itemId)).slice(0, 12);
    system.push(
      ...(await toWizardTargets(
        client.id,
        ind.map((s) => ({ id: s.itemId!, type: s.type, name: s.name, source: "industry" as const, score: null, persona: null, reason: tr("core.wizardTargets.industryReason", { clients: s.clients, results: Math.round(s.results) }), explore: false, status: tr("core.wizardTargets.industryPlus", { pct: Math.round((s.index - 1) * 100) }) })),
        rank,
      )),
    );
  }
  return { claude, system, hasAnalysis: !!analysis, rankingStage: rank.ranking?.stage ?? null };
}

export type CampaignContext = { resultType: string; ageMin: number; ageMax: number; genders: string; locations: string[]; adText: string; notes: string; selected: string[] };

/** "Claude đề xuất cho chiến dịch này" (Claude recommends for this campaign): Claude forms hypotheses + picks targeting for the exact campaign being created; the system matches it on Meta. */
export async function ideateForCampaign(clientId: string, ctx: CampaignContext) {
  const tr = await getT();
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId } });
  const [audience, data, insights, knowledge] = await Promise.all([audiencePromptSection(clientId), plannerDataSection(client), latestConversationInsights(clientId), knowledgePromptSection(clientId)]);
  const prompt = `# Client profile
${clientProfile(client)}

${knowledge}

# Insights from messages
${insights ? JSON.stringify(insights) : "None yet."}

${audience.text}

${data}

# Campaign being created
- Result needed: ${ctx.resultType} (${RESULT_LABEL[ctx.resultType] ?? ctx.resultType})
- Audience chosen: age ${ctx.ageMin}–${ctx.ageMax}, ${ctx.genders === "all" ? "men & women" : ctx.genders === "male" ? "men" : "women"}, locations: ${ctx.locations.join(", ") || "Vietnam"}
- Ad content: ${ctx.adText.slice(0, 600) || "not written yet"}
- Notes: ${ctx.notes || "—"}
- Already selected: ${ctx.selected.join(", ") || "nothing selected"}

Recommend targeting for this campaign.`;
  const res = await generateStructured({ clientId: clientId, system: TARGET_IDEAS_SYSTEM, prompt, schema: TargetIdeasSchema, effort: "medium" });
  const resolved = await resolveIdeas(res.data.ideas.map((i) => ({ name: i.name, type: i.type })));
  const missing: string[] = [];
  const entries = res.data.ideas.flatMap((i, k) => {
    const r = resolved[k];
    if (!r) {
      missing.push(i.name);
      return [];
    }
    return [
      {
        id: r.item.id,
        type: r.item.type,
        name: r.item.name,
        source: "campaign" as const,
        score: i.fit,
        persona: i.persona,
        reason: r.exact ? i.why : tr("core.wizardTargets.closest", { why: i.why, name: i.name, closest: r.item.name }),
        hypothesis: i.hypothesis,
        role: i.role,
        explore: i.role === "explore",
        free: r.source === "meta",
      },
    ];
  });
  catalog(); // items just added to the library
  const targets = await toWizardTargets(clientId, entries);
  await logActivity(clientId, "analyze", tr("core.wizardTargets.logSuggested", { n: targets.length }) + (missing.length ? tr("core.wizardTargets.logMissing", { n: missing.length }) : ""));
  return { summary: res.data.summary, targets, missing };
}
