import type { Client } from "@prisma/client";
import { db } from "../db";
import { clientPages } from "../client-pages";
import { derive } from "../format";
import { ConversationAnalysisSchema } from "./schemas";
import { norm } from "../text";

const r = (v: number | null, d = 0) => (v == null ? null : Number(v.toFixed(d)));

export function clientProfile(c: Client) {
  return [
    `Client: ${c.name}`,
    `Industry: ${c.industry}`,
    `Currency: ${c.currency}`,
    `Main result: ${c.primaryResult}`,
    `Target cost per result: ${c.targetCpr ?? (c.autoTargetCpr != null ? `${c.autoTargetCpr} (proposed automatically by the system from ${c.analysisDays} days of history, not entered by the user)` : "not set")}`,
    `Target ROAS: ${c.targetRoas ?? "not set"}`,
    `Safety limit: each budget change at most ±${c.maxBudgetChangePct}%` +
      (c.maxDailyBudget ? `, maximum daily budget ${c.maxDailyBudget}` : ""),
    c.storeLat != null && c.storeLng != null
      ? `Store coordinates (for custom_locations): ${c.storeLat}, ${c.storeLng}`
      : "Store coordinates: none (do not use custom_locations)",
    `Instagram: ${c.metaInstagramId ? "connected (Instagram Direct / profile visits available)" : "not connected"}`,
    ...(clientPages(c).length > 1 ? [`Fanpages: ${clientPages(c).map((p) => `${p.name}${p.primary ? " (main)" : ""}`).join(", ")} (sharing one persona)`] : []),
    `Business / product description:\n${c.brief || "(none)"}`,
  ].join("\n");
}

function metrics(m: { spend: number; impressions: number; reach: number; clicks: number; results: number; revenue: number }) {
  const d = derive(m);
  return {
    spend: r(m.spend),
    impressions: m.impressions,
    reach: m.reach,
    link_clicks: m.clicks,
    results: m.results,
    revenue: m.revenue ? r(m.revenue) : undefined,
    ctr_pct: r(d.ctr, 2),
    cpc: r(d.cpc),
    cpm: r(d.cpm),
    cpr: r(d.cpr),
    roas: d.roas == null ? undefined : r(d.roas, 2),
    frequency: r(d.frequency, 2),
  };
}

/** Full structure + 7-day metrics of the account, as compact JSON for Claude to read. */
export async function accountData(clientId: string) {
  const [campaigns, daily, leadQuality] = await Promise.all([
    db.campaign.findMany({
      where: { clientId },
      include: { adSets: { include: { ads: true } } },
      orderBy: { spend: "desc" },
    }),
    // The LATEST 30 days (sorted descending to fetch, then reversed back into chronological order).
    db.dailyMetric.findMany({ where: { clientId }, orderBy: { date: "desc" }, take: 30 }).then((rows) => rows.reverse()),
    leadQualityByAd(clientId),
  ]);

  return {
    period: "last 7 days",
    campaigns: campaigns.map((c) => ({
      id: c.id,
      name: c.name,
      objective: c.objective,
      status: c.status,
      result_type: c.resultType,
      daily_budget: c.dailyBudget,
      ...metrics(c),
      ad_sets: c.adSets.map((s) => ({
        id: s.id,
        name: s.name,
        status: s.status,
        daily_budget: s.dailyBudget,
        targeting: safeJson(s.targeting),
        ...metrics(s),
        ads: s.ads.map((a) => ({
          id: a.id,
          name: a.name,
          status: a.status,
          primary_text: a.primaryText.slice(0, 300),
          headline: a.headline,
          ...metrics(a),
          message_quality: leadQuality.get(a.id),
        })),
      })),
    })),
    daily_account_last_30d: daily.map((d) => ({
      date: d.date,
      spend: r(d.spend),
      results: d.results,
      cpr: d.results ? r(d.spend / d.results) : null,
      revenue: d.revenue ? r(d.revenue) : undefined,
    })),
  };
}

/** Message quality per ad (from conversations Claude has scored). */
async function leadQualityByAd(clientId: string) {
  const rows = await db.conversation.findMany({
    where: { clientId, sourceAdId: { not: null }, leadScore: { not: null } },
    select: { sourceAdId: true, leadScore: true, stage: true },
  });
  const map = new Map<string, { conversations: number; avg_lead_score: number; spam_or_lost: number; ready_or_purchased: number }>();
  for (const row of rows) {
    const m = map.get(row.sourceAdId!) ?? { conversations: 0, avg_lead_score: 0, spam_or_lost: 0, ready_or_purchased: 0 };
    m.avg_lead_score = (m.avg_lead_score * m.conversations + row.leadScore!) / (m.conversations + 1);
    m.conversations++;
    if (row.stage === "spam" || row.stage === "lost") m.spam_or_lost++;
    if (row.stage === "ready_to_buy" || row.stage === "purchased") m.ready_or_purchased++;
    map.set(row.sourceAdId!, m);
  }
  for (const m of map.values()) m.avg_lead_score = Math.round(m.avg_lead_score);
  return map;
}

export async function latestConversationInsights(clientId: string) {
  const audit = await db.audit.findFirst({ where: { clientId, kind: "conversations" }, orderBy: { createdAt: "desc" } });
  if (!audit) return null;
  // Old reports may lack fields (schema changed): on a parse error skip the insight instead of breaking the whole audit.
  const parsed = ConversationAnalysisSchema.safeParse(JSON.parse(audit.report));
  if (!parsed.success) return null;
  const rep = parsed.data;
  return {
    analyzed_at: audit.createdAt.toISOString(),
    summary: rep.summary,
    top_questions: rep.top_questions.map((q) => `${q.question} (${q.count})`),
    objections: rep.objections.map((o) => `${o.objection} (${o.count})`),
    buying_signals: rep.buying_signals,
    personas: rep.personas,
    service_issues: rep.service_issues,
  };
}

function safeJson(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

// ------------------------------------------------------------ Fanpage + ad metrics by breakdown (for persona & campaign planning)

const round = (v: number) => Math.round(v);

/** Summary of top posts, customer comments and ad metrics (analysisDays days) by age/gender/region/platform. Empty if none yet. */
/** posts = false: omit the posts section (campaign planning already has its own post list from loadPlannerPosts). */
export async function pageAndBreakdownContext(clientId: string, opts: { posts?: boolean } = {}) {
  const { maskPii } = await import("../pii");
  const [posts, comments, rows] = await Promise.all([
    opts.posts === false ? [] : db.pagePost.findMany({ where: { clientId }, orderBy: { createdTime: "desc" }, take: 60 }),
    db.postComment.findMany({ where: { clientId, fromPage: false }, orderBy: { createdTime: "desc" }, take: 60 }),
    db.adBreakdown.findMany({ where: { clientId } }),
  ]);
  const parts: string[] = [];
  if (posts.length) {
    const score = (p: (typeof posts)[number]) => p.reactions + p.comments * 2 + p.shares * 3;
    const top = [...posts].sort((a, b) => score(b) - score(a)).slice(0, 12);
    const avg = posts.reduce((a, p) => a + score(p), 0) / posts.length;
    parts.push(
      `# Page posts (${posts.length} most recent, average engagement score ${round(avg)}; the 12 standout posts)\n` +
        top.map((p) => `- [${p.type || "post"} ${p.createdTime.toISOString().slice(0, 10)}] ${p.reactions} reactions · ${p.comments} comments · ${p.shares} shares | ${p.message.replace(/\s+/g, " ").slice(0, 180)}`).join("\n"),
    );
  }
  if (comments.length) {
    parts.push(`# Customer comments on posts (${comments.length} most recent, phone numbers masked)\n` + comments.map((c) => `- ${maskPii(c.message).replace(/\s+/g, " ").slice(0, 160)}${c.likes ? ` (${c.likes} likes)` : ""}`).join("\n"));
  }
  if (rows.length) {
    const fmt = (list: typeof rows, limit = 12) =>
      list
        .filter((r) => r.spend > 0)
        .sort((a, b) => b.spend - a.spend)
        .slice(0, limit)
        .map((r) => `${r.key}: spend ${round(r.spend)} · ${round(r.results)} results${r.results ? ` · CPR ${round(r.spend / r.results)}` : ""} · CTR ${r.impressions ? ((r.clicks / r.impressions) * 100).toFixed(2) : 0}%`)
        .join("\n");
    const by = (d: string) => rows.filter((r) => r.dimension === d);
    const { viRegionName, newProvinceOf } = await import("../vn-geo");
    const regions = by("region").map((r) => {
      const vi = viRegionName(r.key);
      const np = newProvinceOf(r.key);
      return { ...r, key: np && np !== vi ? `${vi} (now part of ${np})` : vi };
    });
    const est = rows.some((r) => r.dimension === "region" && r.estimated) ? " — ESTIMATED RESULTS (Meta does not return message counts by region; derived from messaging connections)" : "";
    parts.push(
      `# Ads data over ${rows[0].days} days by breakdown (result = the client's main result)\n## Age | gender\n${fmt(by("age_gender"))}\n## Region (Meta's 63 old provinces; names in Vietnamese)${est}\n${fmt(regions, 10)}\n## Platform\n${fmt(by("platform"), 6)}`,
    );
  }
  return parts.join("\n\n");
}

// ---------------------------------------------------------------- Existing Page posts for the campaign planning step

export type PlannerPost = { message: string; picture: string | null; permalink: string; type: string; created: string };

const headOf = (t: string) => norm(t).replace(/\s+/g, " ").slice(0, 60);

/**
 * Posts on the main Page for Claude to pick for ads (existing posts) and to learn the format from (signature, hashtags).
 * Includes each post's ad results (matched via published drafts or by the start of the ad text). hint: if the brief has a post link / ID, mark it.
 */
export async function loadPlannerPosts(client: Client, hint = "") {
  const [all, ads, drafts] = await Promise.all([
    db.pagePost.findMany({ where: { clientId: client.id }, orderBy: { createdTime: "desc" }, take: 300 }),
    db.ad.findMany({ where: { clientId: client.id, spend: { gt: 0 } }, select: { id: true, primaryText: true, spend: true, results: true } }),
    db.campaignDraft.findMany({ where: { clientId: client.id, status: "published" }, select: { plan: true, result: true } }),
  ]);
  // Main Page only (the plan publishes under the main Page by default), except posts the user specified.
  const nums = hint.match(/\d{8,}/g) ?? [];
  const picked = new Set(all.filter((p) => nums.some((n) => p.id.endsWith(`_${n}`) || p.permalink.includes(n))).map((p) => p.id));
  const posts = all.filter((p) => picked.has(p.id) || !p.pageId || !client.metaPageId || p.pageId === client.metaPageId);

  // Ads that ran using a post: via published drafts (existing posts), then by ad text whose start matches the start of the post.
  const adById = new Map(ads.map((a) => [a.id, a]));
  const used = new Map<string, Set<string>>();
  const link = (postId: string, adId: string) => {
    if (!adById.has(adId)) return;
    if (!used.has(postId)) used.set(postId, new Set());
    used.get(postId)!.add(adId);
  };
  for (const d of drafts) {
    const plan = safeJson(d.plan) as { ads?: { source?: string; post_id?: string | null }[] } | null;
    const res = safeJson(d.result ?? "") as { adIds?: string[]; adPlanIndex?: number[] } | null;
    res?.adIds?.forEach((adId, i) => {
      const a = plan?.ads?.[res.adPlanIndex?.[i] ?? i];
      if (a?.source === "existing" && a.post_id) link(a.post_id, adId);
    });
  }
  const byHead = new Map<string, string>();
  for (const p of posts) if (p.message.trim().length >= 30) byHead.set(headOf(p.message), p.id);
  for (const a of ads) {
    const id = a.primaryText.trim().length >= 30 ? byHead.get(headOf(a.primaryText)) : undefined;
    if (id) link(id, a.id);
  }
  const adStats = (id: string) => {
    const list = [...(used.get(id) ?? [])].map((x) => adById.get(x)!);
    if (!list.length) return null;
    const spend = list.reduce((t, a) => t + a.spend, 0);
    const results = list.reduce((t, a) => t + a.results, 0);
    return { spend, results, cpr: results ? spend / results : null };
  };

  const score = (p: (typeof posts)[number]) => p.reactions + p.comments * 2 + p.shares * 3;
  const withAds = posts.filter((p) => used.has(p.id)).sort((a, b) => (adStats(a.id)!.cpr ?? Infinity) - (adStats(b.id)!.cpr ?? Infinity));
  const order = [...posts.filter((p) => picked.has(p.id)), ...withAds.slice(0, 10), ...[...posts].sort((a, b) => score(b) - score(a)).slice(0, 8), ...posts.slice(0, 12)];
  const list = [...new Map(order.map((p) => [p.id, p])).values()].slice(0, 25);

  const byId = new Map<string, PlannerPost>(
    list.map((p) => [p.id, { message: p.message, picture: p.picture, permalink: p.permalink, type: p.type, created: p.createdTime.toISOString() }]),
  );
  if (!list.length) return { text: "# Existing posts available for ads\nNo Page posts synced yet: write new content.", byId };

  const fmt = (v: number) => round(v).toLocaleString("vi-VN");
  const lines = list.map((p) => {
    const st = adStats(p.id);
    const ad = st ? ` | already run as an ad: spend ${fmt(st.spend)}, ${st.results} results${st.cpr != null ? `, ${fmt(st.cpr)}/result` : ""}` : "";
    return `${picked.has(p.id) ? "★ CHOSEN BY USER | " : ""}${p.id} | ${p.createdTime.toISOString().slice(0, 10)} | ${p.type || "post"} | ${p.reactions} reactions · ${p.comments} comments · ${p.shares} shares${ad} | ${p.message.replace(/\s+/g, " ").slice(0, 160)}`;
  });
  // Format: a few recent posts that are long enough, verbatim (keeping line breaks, signature, hashtags).
  const samples = posts.filter((p) => p.message.trim().length >= 120).slice(0, 3);
  const missing = nums.length && !picked.size ? "\nThe brief has a post link / ID that is not in the synced data: write new content and remind the user to pick the post in the editor (or Sync again)." : "";
  return {
    text:
      `# Existing posts available for ads (id | date | type | engagement | ad results if already run | start of post)${missing}\n${lines.join("\n")}` +
      (samples.length ? `\n\n# Page post format samples (${samples.length} most recent posts, verbatim)\n${samples.map((p, i) => `--- Post ${i + 1} (${p.createdTime.toISOString().slice(0, 10)})\n${p.message.slice(0, 1500)}`).join("\n")}` : ""),
    byId,
  };
}
