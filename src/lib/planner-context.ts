import type { Client } from "@prisma/client";
import { db } from "./db";
import { extractTargetingItems } from "./audience";
import { qualityByAd, type AdQuality } from "./lead-quality";
import { creativePromptSection } from "./creative-analysis";
import { RESULT_LABEL } from "./format";
import { targetCprOf } from "./target-cpr";
import { getT } from "@/i18n/server";
import { translator, type T } from "@/i18n/translate";

// Extra data for Claude when COMPOSING campaigns (create campaign, suggest ideas, review content) — like the existing optimization part:
// 1. History of each ad set over the whole analysis window (default 90 days, including paused ad sets), not just the last 7 days.
// 2. Customer quality from ads (scored messages, forms with phone/email), not just cost/results.
// 3. Winning / losing creative formulas from the latest ad content analysis.
// Only data synced from Meta and analyzed in the system; if absent, that section is omitted.

const r0 = (v: number) => Math.round(v).toLocaleString("vi-VN");

function sumQuality(adIds: string[], q: Map<string, AdQuality>) {
  const s: AdQuality = { n: 0, good: 0, hot: 0, spam: 0, conv: 0, form: 0, rated: 0 };
  for (const id of adIds) {
    const x = q.get(id);
    if (!x) continue;
    for (const k of Object.keys(s) as (keyof AdQuality)[]) s[k] += x[k];
  }
  return s;
}

const qualityText = (q: AdQuality) =>
  q.n ? `customers: ${q.n} (${[q.conv && `${q.conv} messages`, q.form && `${q.form} forms`].filter(Boolean).join(", ")}) · good ${q.good} (${Math.round((q.good / q.n) * 100)}%) · hot ${q.hot} · junk ${q.spam}` : "no customers scored yet";

function targetingText(json: string) {
  let t: { age_min?: number; age_max?: number; genders?: number[]; geo_locations?: { countries?: string[]; regions?: { name?: string; key: string }[]; cities?: { name?: string; key: string }[]; custom_locations?: unknown[] } };
  try {
    t = JSON.parse(json || "{}");
  } catch {
    return "";
  }
  const items = extractTargetingItems(json).map((i) => i.name);
  const g = t.geo_locations ?? {};
  const geo = [...(g.regions ?? []), ...(g.cities ?? [])].map((x) => x.name ?? x.key);
  const parts = [
    t.age_min || t.age_max ? `age ${t.age_min ?? 18}–${t.age_max ?? 65}` : null,
    t.genders?.length ? (t.genders[0] === 1 ? "men" : "women") : null,
    geo.length ? geo.slice(0, 4).join(", ") : g.custom_locations?.length ? `${g.custom_locations.length} pinned locations` : g.countries?.length ? g.countries.join(",") : null,
    items.length ? `detailed: ${items.slice(0, 6).join(", ")}${items.length > 6 ? ` +${items.length - 6}` : ""}` : "broad / Advantage+",
  ];
  return parts.filter(Boolean).join(" · ");
}

export async function plannerDataSection(client: Client) {
  const [history, quality, creative, ads] = await Promise.all([
    db.adSetHistory.findMany({ where: { clientId: client.id, spend: { gt: 0 } }, orderBy: { spend: "desc" }, take: 120 }),
    qualityByAd(client.id, client.analysisDays),
    creativePromptSection(client.id),
    db.ad.findMany({ where: { clientId: client.id, spend: { gt: 0 } }, select: { id: true, name: true, adSet: { select: { name: true } } } }),
  ]);
  const parts: string[] = [];
  const target = targetCprOf(client);
  // Messages can only be tied to ads via the webhook (referral). If absent, say so explicitly, so Claude doesn't read "0 customers" as poor customers.
  const hasQuality = [...quality.values()].some((q) => q.n > 0);
  const noQualityNote =
    client.primaryResult === "messages" || client.primaryResult === "leads"
      ? `No customer-quality data per ad set / ad yet (${client.primaryResult === "messages" ? "messages cannot be tied to ads because the message webhook is not configured" : "no lead form attached to ads in this period"}): judge by cost per result only, do NOT infer quality.`
      : "";

  // 1 + 2. Ad set history over the whole window, with customer quality per ad set.
  if (history.length) {
    const days = history[0].days;
    const rows = history.map((h) => {
      const q = sumQuality(JSON.parse(h.adIds) as string[], quality);
      return { h, q, cpr: h.results ? h.spend / h.results : null };
    });
    const main = rows.filter((x) => x.h.resultType === client.primaryResult);
    const withCpr = main.filter((x) => x.cpr != null && x.h.results >= 3).sort((a, b) => a.cpr! - b.cpr!);
    const ref = target ?? (main.reduce((a, x) => a + x.h.results, 0) ? main.reduce((a, x) => a + x.h.spend, 0) / main.reduce((a, x) => a + x.h.results, 0) : null);
    const noResult = main.filter((x) => !x.h.results && ref != null && x.h.spend >= ref).slice(0, 4);
    const line = (x: (typeof rows)[number]) =>
      `- [${x.h.status === "ACTIVE" ? "running" : "off"}] ${x.h.campaignName} › ${x.h.name} | ${targetingText(x.h.targeting)} | ${days} days: spent ${r0(x.h.spend)}, ${r0(x.h.results)} results${x.cpr != null ? `, CPR ${r0(x.cpr)}` : ""}${x.h.recentSpend ? ` (last 30 days: spent ${r0(x.h.recentSpend)}, ${r0(x.h.recentResults)} results)` : " (last 30 days: not running)"}${hasQuality ? ` | ${qualityText(x.q)}` : ""}`;
    const best = withCpr.slice(0, 8);
    const worst = withCpr.slice(-5).reverse().filter((x) => !best.includes(x));
    const other = rows.filter((x) => x.h.resultType !== client.primaryResult).slice(0, 5);
    parts.push(
      [
        `# Ad set history, ${days} days (including ad sets that are off; ${main.length} ad sets with the main result type "${RESULT_LABEL[client.primaryResult] ?? client.primaryResult}"${ref ? `, reference CPR ${r0(ref)}` : ""})`,
        hasQuality
          ? "How to use: build on ad sets that are cheap AND bring good customers (including ad sets that are off: they can be run again); avoid repeating ad sets that were expensive, brought no results or brought many junk customers. A cheap ad set with junk customers does NOT count as good."
          : `How to use: build on cheap ad sets (including ad sets that are off: they can be run again); avoid repeating ad sets that were expensive or brought no results. ${noQualityNote}`,
        best.length && `## Cheapest (≥ 3 results)\n${best.map(line).join("\n")}`,
        worst.length && `## Most expensive\n${worst.map(line).join("\n")}`,
        noResult.length && `## High spend with no results\n${noResult.map(line).join("\n")}`,
        other.length && `## Ad sets with other objectives (for reference)\n${other.map(line).join("\n")}`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  // 2. Customer quality per ad with metrics (ad names so Claude knows which content brings real customers).
  const adQ = ads
    .map((a) => ({ a, q: quality.get(a.id) }))
    .filter((x): x is { a: (typeof ads)[number]; q: AdQuality } => !!x.q && x.q.n >= 3)
    .sort((x, y) => y.q.good / y.q.n - x.q.good / x.q.n);
  if (adQ.length) {
    parts.push(
      `# Customer quality per ad (${client.analysisDays} days, from scored messages and forms with a phone number/email; ads with ≥ 3 customers)\n` +
        adQ
          .slice(0, 12)
          .map((x) => `- ${x.a.adSet.name} › ${x.a.name}: ${qualityText(x.q)}`)
          .join("\n") +
        "\nPrefer building on content / audiences with a high share of good customers, even when their CPR is not the cheapest.",
    );
  }

  // 3. Winning / losing creative formulas.
  if (creative) parts.push(creative);
  // 4. Whether previous hypotheses were right / wrong.
  const hyp = await hypothesisSection(client);
  if (hyp) parts.push(hyp);
  return parts.join("\n\n");
}

type HypothesisCheck = { campaign: string; adSet: string; hypothesis: string; targeting: string[]; spend: number; results: number; cpr: number | null; verdict: "right" | "wrong" | "pending" | "not_run"; note: string; quality: AdQuality | null };

/**
 * Learning loop: each ad set published from the system carries a hypothesis (written by Claude when composing). Re-scored with real synced numbers:
 * right = enough results and cost/result within the target threshold; wrong = clearly costly or heavy spend without results; otherwise = not enough data.
 */
/** t: language of the notes (default: the request language). */
export async function hypothesisChecks(client: Client, t?: T): Promise<HypothesisCheck[]> {
  const tr = t ?? (await getT());
  const drafts = await db.campaignDraft.findMany({ where: { clientId: client.id, status: "published" }, orderBy: { updatedAt: "desc" }, take: 20, select: { plan: true, result: true } });
  if (!drafts.length) return [];
  const target = targetCprOf(client);
  const quality = await qualityByAd(client.id, client.analysisDays);
  const out: HypothesisCheck[] = [];
  for (const d of drafts) {
    let plan: { campaign_name?: string; ad_sets?: { name: string; hypothesis?: string; detailed_targeting?: { name: string }[] }[] };
    let ids: { adSetIds?: string[] };
    try {
      plan = JSON.parse(d.plan);
      ids = JSON.parse(d.result ?? "{}");
    } catch {
      continue;
    }
    const hist = await db.adSetHistory.findMany({ where: { id: { in: ids.adSetIds ?? [] } } });
    for (const [i, s] of (plan.ad_sets ?? []).entries()) {
      if (!s.hypothesis) continue;
      const h = hist.find((x) => x.id === ids.adSetIds?.[i]);
      const spend = h?.spend ?? 0;
      const results = h?.results ?? 0;
      const cpr = results ? spend / results : null;
      const q = h ? sumQuality(JSON.parse(h.adIds) as string[], quality) : null;
      let verdict: HypothesisCheck["verdict"] = "pending";
      let note = tr("workflow.hypothesis.pending");
      if (!spend) [verdict, note] = ["not_run", tr("workflow.hypothesis.notRun")];
      else if (target && results >= 5 && cpr! <= target * 1.15) [verdict, note] = ["right", tr("workflow.hypothesis.right", { cpr: r0(cpr!), target: r0(target) })];
      else if (target && ((results >= 5 && cpr! > target * 1.5) || (!results && spend >= 3 * target))) [verdict, note] = ["wrong", results ? tr("workflow.hypothesis.wrongCpr", { cpr: r0(cpr!), target: r0(target) }) : tr("workflow.hypothesis.wrongNoResult", { spend: r0(spend) })];
      if (q?.n && q.spam / q.n > 0.5 && verdict === "right") [verdict, note] = ["wrong", tr("workflow.hypothesis.spam", { spam: q.spam, n: q.n })];
      out.push({ campaign: plan.campaign_name ?? "", adSet: s.name, hypothesis: s.hypothesis, targeting: (s.detailed_targeting ?? []).map((t) => t.name), spend, results, cpr, verdict, note, quality: q?.n ? q : null });
    }
  }
  return out;
}

const VERDICT_EN: Record<HypothesisCheck["verdict"], string> = { right: "RIGHT", wrong: "WRONG", pending: "unclear", not_run: "not run" };

export async function hypothesisSection(client: Client) {
  const checks = (await hypothesisChecks(client, translator("en"))).filter((c) => c.verdict !== "not_run"); // English notes: this feeds the prompt
  if (!checks.length) return "";
  return `# Hypotheses checked (ad sets published from the system, scored with real synced numbers)
Learn from this: repeat the direction of RIGHT hypotheses, avoid or fix the direction of WRONG ones, and draw no conclusion yet from unclear ones.
${checks.map((c) => `- [${VERDICT_EN[c.verdict]}] ${c.campaign} › ${c.adSet}: "${c.hypothesis}" | targeting: ${c.targeting.join(", ") || "broad"} | ${c.note}${c.quality ? ` | ${qualityText(c.quality)}` : ""}`).join("\n")}`;
}
