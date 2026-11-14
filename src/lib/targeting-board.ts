import { db } from "@/lib/db";
import type { AudienceAnalysis } from "@/lib/ai/schemas";
import { CUSTOM_TYPE, isVerified, type FitItem, type RankedTargeting } from "@/lib/audience";
import type { BoardItem, BoardSection } from "@/components/targeting-board";
import { norm } from "@/lib/text";
import { copyTextOf, formatSize, targetingKey, TYPE_LABEL, typeLabel } from "@/lib/targeting";
import { getT } from "@/i18n/server";
import type { MessageKey, T } from "@/i18n/translate";

// Groups shown in the targeting table per persona.
const TYPE_GROUP: Record<string, MessageKey> = {
  behaviors: "targeting.board.group.behaviors",
  life_events: "targeting.board.group.lifeEvents",
  family_statuses: "targeting.board.group.family",
  relationship_statuses: "targeting.board.group.family",
  income: "targeting.board.group.income",
  education_statuses: "targeting.board.group.education",
  education_schools: "targeting.board.group.education",
  education_majors: "targeting.board.group.education",
  work_positions: "targeting.board.group.education",
  work_employers: "targeting.board.group.education",
  industries: "targeting.board.group.education",
  [CUSTOM_TYPE]: "targeting.board.group.custom",
};

// Meta interest topics (English or Vietnamese names, sometimes with a disambiguation in parentheses) → translated group names.
const TOPIC_VI: [RegExp, MessageKey][] = [
  [/^business|kinh doanh|doanh nghiệp/i, "targeting.board.topic.business"],
  [/^education|giáo dục|trường|đại học/i, "targeting.board.topic.education"],
  [/^(news and )?entertainment|giải trí|phim|chương trình tv|nghệ sỹ|tạp chí/i, "targeting.board.topic.entertainment"],
  [/^family|gia đình/i, "targeting.board.topic.family"],
  [/^fitness|thể hình|sức khỏe/i, "targeting.board.topic.fitness"],
  [/^food|ẩm thực|nhà hàng|thực phẩm/i, "targeting.board.topic.food"],
  [/^hobbies|sở thích và hoạt động/i, "targeting.board.topic.hobbies"],
  [/^shopping|mua sắm|quần áo|thương mại điện tử|bán lẻ/i, "targeting.board.topic.shopping"],
  [/^sports|thể thao/i, "targeting.board.topic.sports"],
  [/^technology|công nghệ/i, "targeting.board.topic.technology"],
  [/^travel|du lịch/i, "targeting.board.topic.travel"],
  [/^lifestyle|phong cách sống/i, "targeting.board.topic.lifestyle"],
  [/^people|con người/i, "targeting.board.topic.people"],
];
const topicVi = (tr: T, t: string | null | undefined) => {
  const key = t ? TOPIC_VI.find(([re]) => re.test(t.trim()))?.[1] : undefined;
  return key ? tr(key) : null;
};

/**
 * Interests are split into cards by topic: take level 2 of Meta's path; items in the generic "Sở thích bổ sung" (additional interests) group
 * use the topic Meta assigns to that item. Other types are split by type.
 */
function cardTitle(t: T, type: string, path: string, topic?: string | null) {
  if (type === "interests") {
    const seg = path.split(" > ")[1]?.trim();
    const generic = !seg || /sở thích bổ sung|additional interests/i.test(seg);
    const name = (generic ? topicVi(t, topic) : (topicVi(t, seg) ?? seg)) ?? t("targeting.board.otherInterest");
    return t("targeting.board.interestCard", { name });
  }
  return TYPE_GROUP[type] ? t(TYPE_GROUP[type]) : type in TYPE_LABEL ? typeLabel(t, type) : t("targeting.board.other");
}

export const samePersona = (a: string | null | undefined, b: string) => {
  if (!a) return false;
  const x = norm(a);
  const y = norm(b);
  return x === y || x.includes(y) || y.includes(x);
};

function toCards(items: (BoardItem & { cardTitle: string })[]) {
  const map = new Map<string, BoardItem[]>();
  for (const i of [...items].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))) {
    if (!map.has(i.cardTitle)) map.set(i.cardTitle, []);
    map.get(i.cardTitle)!.push(i);
  }
  // Cards with more high-scoring items first
  return [...map.entries()].map(([title, list]) => ({ title, items: list })).sort((a, b) => (b.items[0]?.score ?? 0) - (a.items[0]?.score ?? 0));
}

const GENDER_KEY: Record<string, MessageKey> = { all: "targeting.board.gender.all", female: "targeting.board.gender.female", male: "targeting.board.gender.male" };

/** Targeting set per persona (shared by the Persona page and the PDF). */
export async function buildBoardSections(report: AudienceAnalysis, fits: FitItem[], items: RankedTargeting[]): Promise<BoardSection[]> {
  const t = await getT();
  const gender = (g: string) => (GENDER_KEY[g] ? t(GENDER_KEY[g]) : g);
  const rankedByKey = new Map(items.map((i) => [i.key, i]));
  const keys = [...new Set([...fits.map((f) => targetingKey(f.type, f.id)), ...items.map((i) => i.key)])];
  const lib = new Map((await db.targetingItem.findMany({ where: { key: { in: keys } } })).map((t) => [t.key, t]));
  const boardItem = (key: string, name: string, type: string, fit: number | null, reason: string | null): BoardItem & { cardTitle: string } => {
    const rk = rankedByKey.get(key);
    const li = lib.get(key);
    const path = li?.path ?? rk?.path ?? "";
    return {
      key,
      name: li?.nameVi || li?.name || name,
      copy: li ? copyTextOf({ name: li.nameVi || li.name, copyText: li.copyText }) : copyTextOf({ name }),
      findable: li?.findable ?? null,
      typeLabel: type === CUSTOM_TYPE ? t("targeting.board.group.custom") : typeLabel(t, type),
      path,
      size: li?.vnHi != null ? formatSize(li.vnLo, li.vnHi) : (rk?.size ?? ""),
      score: rk?.score ?? fit,
      fit: rk?.fit ?? fit,
      perf: rk?.perf ?? null,
      confidence: rk?.confidence ?? 0,
      verified: rk ? isVerified(rk) : false,
      rank: rk?.rank ?? null,
      dead: li?.status === "dead" || li?.findable === false,
      spend: rk?.spend ?? 0,
      reason: rk?.reason ?? reason,
      cardTitle: cardTitle(t, type, path, li?.topic),
    };
  };
  const sections: BoardSection[] = [];
  sections.push({
    id: "demo",
    num: "00",
    title: t("targeting.board.demoTitle"),
    chips: [t("targeting.board.ageRange", { min: report.demographics.age_min, max: report.demographics.age_max }), gender(report.demographics.genders)],
    sub: report.demographics.note,
    cards: [],
  });
  const used = new Set<string>();
  report.personas.forEach((p, idx) => {
    const mine = fits.filter((f) => samePersona(f.persona, p.name));
    mine.forEach((f) => used.add(targetingKey(f.type, f.id)));
    sections.push({
      id: `p${idx}`,
      num: String(idx + 1).padStart(2, "0"),
      title: p.name,
      meta: t("targeting.board.itemsCount", { n: mine.length }),
      share: p.share,
      sub: p.description,
      chips: [t("targeting.board.ageRangeText", { range: p.age_range }), gender(p.gender), p.locations],
      angles: p.message_angles,
      cards: toCards(mine.map((f) => boardItem(targetingKey(f.type, f.id), f.name, f.type, f.fit, f.reason))),
    });
  });
  // Expansion directions: audiences outside the current persona, split into cards by direction.
  const explore = fits.filter((f) => f.explore && !used.has(targetingKey(f.type, f.id)));
  explore.forEach((f) => used.add(targetingKey(f.type, f.id)));
  if (explore.length) {
    sections.push({
      id: "explore",
      num: t("targeting.board.newNum"),
      title: t("targeting.board.exploreTitle"),
      meta: t("targeting.board.itemsCount", { n: explore.length }),
      sub: t("targeting.board.exploreSub"),
      cards: toCards(explore.map((f) => ({ ...boardItem(targetingKey(f.type, f.id), f.name, f.type, f.fit, f.reason), cardTitle: f.direction ?? f.persona }))),
    });
  }
  const rest = fits.filter((f) => !used.has(targetingKey(f.type, f.id)));
  if (rest.length) {
    sections.push({
      id: "rest",
      num: String(report.personas.length + 1).padStart(2, "0"),
      title: t("targeting.board.restTitle"),
      meta: t("targeting.board.itemsCount", { n: rest.length }),
      cards: toCards(rest.map((f) => boardItem(targetingKey(f.type, f.id), f.name, f.type, f.fit, f.reason))),
      muted: true,
    });
  }
  const running = items.filter((i) => i.fit == null);
  if (running.length) {
    sections.push({
      id: "ads",
      num: "ADS",
      title: t("targeting.board.adsTitle"),
      meta: t("targeting.board.itemsCount", { n: running.length }),
      sub: t("targeting.board.adsSub"),
      cards: toCards(running.map((i) => boardItem(i.key, i.name, i.type, null, null))),
      muted: true,
    });
  }

  return sections;
}
