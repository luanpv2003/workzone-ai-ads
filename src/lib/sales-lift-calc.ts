import { norm } from "./text";
import { DEFAULT_LOCALE } from "@/i18n/config";
import { translator, type T } from "@/i18n/translate";

// Reasons and flags are text for the user: pass the translator of the request; callers without one get the default language.
const defaultT = () => translator(DEFAULT_LOCALE);

// Pure computation (no DB reads) for "Đo hiệu quả theo mã hàng" (per-SKU performance): suggest SKUs from post names, suggest control SKUs,
// detect order comments, compute growth difference (difference-in-differences). Numbers come from code, never from AI.

export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
export const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

/** Run period and baseline period each need 7 days with sales before concluding (one full weekly cycle). */
export const MIN_DAYS = 7;

// ------------------------------------------------------------------ Tokenization

const UNIT_WORDS = "kg ki ky can lang g gr gram con tui bich goi hop chai lo khay set combo cb cai chiec doi thung loc vi bo phan suat xuat lit l ml bao qua trai hu cap mieng".split(" ");
const STOP = new Set([
  ...UNIT_WORDS,
  ..."va cua cho voi cac nhung mot khi la thi ma nay do tai o hang gia chi em anh a oi nhe k ko khong co duoc rat qua lam the tu sx cty nha e c ah a nhe ne roi ve den di len xuong moi cung con them chuan ngon re dep loai size mau vi huong".split(" "),
]);

/** Meaningful words for comparing product names: strip diacritics, drop numbers / prices / units / filler words. */
function words(s: string): string[] {
  return norm(s)
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w.length >= 2 && !/\d/.test(w) && !STOP.has(w));
}

/** Ad names like "Nước giặt Blue 49k | B2" → "Nước giặt Blue 49k". */
export const adLabel = (name: string) => name.split("|")[0].trim();

// ------------------------------------------------------------------ Suggesting advertised SKUs

export type ProductRef = { id: string; code: string; name: string; baseQty: number; baseRevenue: number; baseDaysSold: number; recentQty: number };
type AdText = { label: string; text: string };
type ProductPick = { id: string; score: number; reason: string };

/** Rarity weight of each word in the product catalog: "blue", "shm" weigh more than "nước", "gà". */
export function idfOf(products: { name: string }[]) {
  const df = new Map<string, number>();
  for (const p of products) for (const w of new Set(words(p.name))) df.set(w, (df.get(w) ?? 0) + 1);
  const n = Math.max(1, products.length);
  return (w: string) => {
    const d = df.get(w);
    return d ? Math.log(n / d) + 1 : 0;
  };
}

/**
 * SKUs matching the ad name (primary) and post content (secondary).
 * Name score = share of the ad name (weighted by word rarity) found in the product name; post score = share of the product name found in the post.
 * Each ad label takes at most 3 SKUs close to the best one. Suggestions only: the user edits them on screen.
 */
export function suggestTestProducts(ads: AdText[], products: ProductRef[], idf = idfOf(products), tr: T = defaultT()): ProductPick[] {
  const out = new Map<string, ProductPick>();
  const byLabel = new Map<string, string>();
  for (const a of ads) {
    const k = norm(a.label);
    if (!byLabel.has(k)) byLabel.set(k, "");
    byLabel.set(k, `${byLabel.get(k)} ${a.text}`);
  }
  // Prefer SKUs with sales in the baseline period (a baseline is needed to compare); if none have baseline sales, consider SKUs with recent sales.
  const hasBase = products.some((p) => p.baseQty > 0);
  const prodWords = products.filter((p) => (hasBase ? p.baseQty > 0 : p.recentQty > 0)).map((p) => ({ p, w: new Set(words(p.name)) }));
  for (const [label, text] of byLabel) {
    const lw = [...new Set(words(label))].filter((w) => idf(w) > 0);
    if (!lw.length) continue;
    const lTotal = lw.reduce((s, w) => s + idf(w), 0);
    const tw = new Set(words(text));
    const scored = prodWords
      .map(({ p, w }) => {
        const nameScore = lw.reduce((s, x) => s + (w.has(x) ? idf(x) : 0), 0) / lTotal;
        const pTotal = [...w].reduce((s, x) => s + idf(x), 0) || 1;
        const postScore = [...w].reduce((s, x) => s + (tw.has(x) || lw.includes(x) ? idf(x) : 0), 0) / pTotal;
        return { p, nameScore, score: 0.7 * nameScore + 0.3 * postScore };
      })
      .filter((x) => x.nameScore >= 0.6)
      .sort((a, b) => b.score - a.score || b.p.recentQty - a.p.recentQty);
    const best = scored[0]?.score ?? 0;
    for (const x of scored.filter((x) => x.score >= best * 0.9).slice(0, 3)) {
      const prev = out.get(x.p.id);
      if (!prev || prev.score < x.score) out.set(x.p.id, { id: x.p.id, score: x.score, reason: tr("settings.salesLiftCalc.matchAdName", { label }) });
    }
  }
  return [...out.values()].sort((a, b) => b.score - a.score);
}

/** KiotViet product group of each advertised SKU: group name + SKUs in the same group. */
export type SameCategory = Map<string, { name: string; ids: Set<string> }>;

/**
 * Control SKUs: not in any ad, selling steadily in the baseline period (≥ 80% of days, to avoid sporadic SKUs making numbers jump), similar in scale to the advertised SKU.
 * Prefer the same KiotViet product group as the advertised SKU; without a group, the same kind by the first 2 words of the name (e.g. "nước giặt", "gà trống"; must mostly overlap).
 * If short, add the store's steadiest-selling products (tracking the overall trend).
 */
export function suggestControls(
  testIds: string[],
  products: ProductRef[],
  advertised: Set<string>,
  baseDays: number,
  opts: { idf?: (w: string) => number; categories?: SameCategory; tr?: T } = {},
): ProductPick[] {
  const tr = opts.tr ?? defaultT();
  const idf = opts.idf ?? idfOf(products);
  const test = products.filter((p) => testIds.includes(p.id));
  const stable = products.filter((p) => !testIds.includes(p.id) && !advertised.has(p.id) && p.baseQty > 0 && p.baseDaysSold >= Math.max(1, baseDays * 0.8));
  const out = new Map<string, ProductPick>();
  const size = (c: ProductRef, t: ProductRef) => Math.abs(Math.log((c.baseRevenue + 1) / (t.baseRevenue + 1)));
  for (const t of test) {
    const cat = opts.categories?.get(t.id);
    if (cat) {
      const same = stable.filter((c) => cat.ids.has(c.id) && !out.has(c.id)).sort((a, b) => size(a, t) - size(b, t));
      for (const c of same.slice(0, 2)) out.set(c.id, { id: c.id, score: 1, reason: tr("settings.salesLiftCalc.sameGroup", { group: cat.name, name: t.name }) });
      if (same.length) continue;
    }
    const head = [...new Set(words(t.name).slice(0, 2))];
    const hTotal = head.reduce((s, w) => s + idf(w), 0);
    if (!hTotal) continue;
    const scored = stable
      .map((c) => {
        const cw = new Set(words(c.name));
        const shared = head.filter((w) => cw.has(w));
        return { c, shared, share: shared.reduce((s, w) => s + idf(w), 0) / hTotal };
      })
      .filter((x) => x.share >= 0.5 && !out.has(x.c.id))
      .sort((a, b) => b.share - a.share || size(a.c, t) - size(b.c, t));
    for (const x of scored.slice(0, 2)) out.set(x.c.id, { id: x.c.id, score: x.share, reason: tr("settings.salesLiftCalc.sameKind", { kind: x.shared.join(" "), name: t.name }) });
  }
  if (out.size < 3) {
    const steady = stable.filter((p) => !out.has(p.id) && p.baseDaysSold >= baseDays).sort((a, b) => b.baseRevenue - a.baseRevenue);
    for (const p of steady.slice(0, 3 - out.size)) out.set(p.id, { id: p.id, score: 0, reason: tr("settings.salesLiftCalc.steady") });
  }
  return [...out.values()];
}

// ------------------------------------------------------------------ Order comments

type BranchKeys = { name: string; keys: string[] }[];

/** Default keywords per branch from the KiotViet branch name: "73A Phương Mai" → Phương Mai, PM, PMai. Warehouses excluded. */
export function defaultBranchKeys(branchNames: string[]): BranchKeys {
  const out: BranchKeys = [];
  for (const raw of branchNames) {
    if (/^\s*kho\b/i.test(raw)) continue;
    const parts = raw.trim().split(/\s+/);
    while (parts.length > 1 && (/\d/.test(parts[0]) || /^(số|so|đường|duong|phố|pho|ngõ|ngo|ngách|ngach|ki[ốo]t)$/i.test(parts[0]))) parts.shift();
    const place = parts.join(" ");
    const keys = [place];
    if (parts.length >= 2) {
      keys.push(parts.map((w) => w[0].toUpperCase()).join(""));
      keys.push(parts[0][0].toUpperCase() + parts.at(-1)!.toLowerCase().replace(/^./, (c) => c.toUpperCase()));
    }
    out.push({ name: raw.trim(), keys: [...new Set(keys)] });
  }
  return out;
}

/** On-screen text form: each line "Branch name: keyword, keyword". */
export const branchKeysToText = (b: BranchKeys) => b.map((x) => `${x.name}: ${x.keys.join(", ")}`).join("\n");
export function parseBranchKeys(text: string): BranchKeys {
  return text
    .split("\n")
    .map((line) => {
      const i = line.indexOf(":");
      const name = (i >= 0 ? line.slice(0, i) : line).trim();
      const keys = (i >= 0 ? line.slice(i + 1) : line)
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean);
      return { name, keys };
    })
    .filter((x) => x.name && x.keys.length);
}

const NUM = String.raw`(?:\d+(?:[.,]\d+)?|1\/2|mot|hai|bon|nam|sau|bay|tam|chin|muoi|nua)`;
const QTY_UNIT = new RegExp(String.raw`(?:^|[^a-z0-9])${NUM}\s*(?:${UNIT_WORDS.join("|")}|xet)(?![a-z])`);
// "Chị 1 sét", "cho c 2", "lấy 3", "M 1con": ordering pronoun / verb + number (excluding "2h", "3:30").
const QTY_PRON = /(?:^|[^a-z0-9])(?:c|chi|e|em|a|anh|m|minh|toi|to|t|co|chu|bac|lay|cho|dat|chot|mua|gui|ship)\s+\d+(?![\d:h.,])/;
const ORDER_VERB = /(?:^|[^a-z])(?:lay|dat|chot|ship|gui)(?![a-z])/;
const QUESTION = /\?|(?:^|[^a-z])(?:con|co)\s+(?:k|ko|khong|kg)(?![a-z])|bao nhieu|gia/;
/** Strip diacritics but keep uppercase (to tell "ĐC" = Đội Cấn from "đc" = được). */
const deaccent = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D");

// Abbreviations colliding with common shorthand: "đc" = được, "pm" / "ib" = private message, "tt" = payment / engagement.
const AMBIGUOUS = new Set(["dc", "pm", "ib", "tt", "tc", "ok", "ko", "kg", "ct", "sp"]);

/** Branch keywords. Easily confused abbreviations (ĐC, PM, TT…): must be uppercase, or follow "ở / tại / lấy / về / qua / sang". */
function keyTest(k: string) {
  const n = norm(k).replace(/[^a-z0-9]+/g, String.raw`\s*`);
  const plain = new RegExp(String.raw`(?:^|[^a-z0-9])${n}(?![a-z0-9])`);
  if (!AMBIGUOUS.has(norm(k).trim())) return (t: string) => plain.test(t);
  const upper = new RegExp(String.raw`(?:^|[^A-Za-z0-9])${deaccent(k.trim()).toUpperCase()}(?![A-Za-z0-9])`);
  const after = new RegExp(String.raw`(?:^|[^a-z0-9])(?:o|tai|lay|ve|qua|sang)\s+${n}(?![a-z0-9])`);
  return (t: string, raw: string) => upper.test(raw) || after.test(t);
}

type OrderMatch = { order: boolean; qty: boolean; branch: string | null };

/**
 * Order comment = has a quantity (number + unit, or "chị 1", "lấy 2") and one of: branch name, ordering verb (lấy / đặt / chốt / ship),
 * pronoun + number, or a short comment with only a quantity ("2kg", "1 set"). Or has a branch name + ordering verb without a number ("chị e gói lấy ĐC").
 */
export function orderMatcher(branches: BranchKeys) {
  const rx = branches.map((b) => ({ name: b.name, tests: b.keys.map(keyTest) }));
  return (message: string): OrderMatch => {
    const t = ` ${norm(message)} `;
    const raw = ` ${deaccent(message)} `;
    const pron = QTY_PRON.test(t);
    const qty = QTY_UNIT.test(t) || pron;
    const branch = rx.find((b) => b.tests.some((f) => f(t, raw)))?.name ?? null;
    const short = t.trim().split(/\s+/).length <= 4 && !QUESTION.test(t);
    return { qty, branch, order: (qty && (!!branch || ORDER_VERB.test(t) || pron || short)) || (!!branch && ORDER_VERB.test(t)) };
  };
}

// ------------------------------------------------------------------ Computing growth difference

type SaleRow = { productId: string; date: string; qty: number; revenue: number };
export type Period = { start: string; end: string };
type ProductLine = {
  id: string;
  baseQty: number; // avg / day
  runQty: number;
  growth: number | null;
  basePrice: number | null;
  runPrice: number | null;
  priceChange: number | null;
  zeroRunDays: number; // days with data but no sales (run period)
  baseSellRate: number; // share of days with sales in the baseline period
  incQty: number | null; // extra over the whole run period vs expected
  incRevenue: number | null;
  flags: string[];
};
/** value = units converted to money at baseline prices (avg / day), to sum products with different units; revenue = actual revenue avg / day. */
type GroupStat = { baseValue: number; runValue: number; baseRevenue: number; runRevenue: number; growth: number | null };
type LiftResult = {
  baseDays: number;
  runDays: number;
  enough: boolean;
  test: GroupStat;
  control: GroupStat;
  controlKind: "products" | "store";
  store: { baseRevenue: number; runRevenue: number; growth: number | null };
  lift: number | null; // (1 + advertised group growth) / (1 + control growth) − 1
  liftRange: [number, number] | null; // ~90% interval based on day-to-day variation
  incQty: number | null;
  incRevenue: number | null;
  products: ProductLine[];
  daily: { date: string; test: number; control: number; period: "base" | "run" }[];
};

/**
 * Growth difference (ratio-form difference-in-differences):
 * - Each group is measured as "units converted to money at baseline prices" so products with different units (kg, bags…) can be summed without mixing in price changes.
 * - Group growth = run-period avg/day ÷ baseline avg/day − 1. Lift from ads = (1 + advertised group growth) ÷ (1 + control growth) − 1.
 * - Expected sales without ads (per SKU) = baseline avg/day × control factor; extra = actual − expected;
 *   extra revenue = extra units × actual selling price in the run period (including deal prices).
 * - No control SKUs: use whole-store revenue as the control.
 * Only days with KiotViet data (dataDays) are counted. SKUs with no sales in the baseline: excluded from the computation, shown for reference only.
 */
export function computeLift(input: {
  base: Period;
  run: Period;
  dataDays: Set<string>;
  testIds: string[];
  controlIds: string[];
  rows: SaleRow[];
  store: { date: string; revenue: number }[];
  tr?: T;
}): LiftResult {
  const tr = input.tr ?? defaultT();
  const inP = (d: string, p: Period) => d >= p.start && d <= p.end && input.dataDays.has(d);
  const baseDates = [...input.dataDays].filter((d) => inP(d, input.base)).sort();
  const runDates = [...input.dataDays].filter((d) => inP(d, input.run)).sort();
  const nb = baseDates.length;
  const nr = runDates.length;

  type Agg = { qty: number; rev: number; days: Set<string>; byDay: Map<string, number> };
  const agg = new Map<string, { base: Agg; run: Agg }>();
  const blank = (): Agg => ({ qty: 0, rev: 0, days: new Set(), byDay: new Map() });
  const ids = new Set([...input.testIds, ...input.controlIds]);
  for (const r of input.rows) {
    if (!ids.has(r.productId)) continue;
    const per = inP(r.date, input.base) ? "base" : inP(r.date, input.run) ? "run" : null;
    if (!per) continue;
    if (!agg.has(r.productId)) agg.set(r.productId, { base: blank(), run: blank() });
    const a = agg.get(r.productId)![per];
    a.qty += r.qty;
    a.rev += r.revenue;
    if (r.qty > 0) a.days.add(r.date);
    a.byDay.set(r.date, (a.byDay.get(r.date) ?? 0) + r.qty);
  }
  const get = (id: string) => agg.get(id) ?? { base: blank(), run: blank() };
  const price = (a: Agg) => (a.qty > 0 ? a.rev / a.qty : null);
  const ratio = (run: number, base: number) => (base > 0 ? run / base - 1 : null);

  // Group: units × baseline price (SKUs without a baseline price are dropped).
  const group = (list: string[]): GroupStat & { members: string[]; day: (d: string) => number } => {
    const members = list.filter((id) => price(get(id).base) != null);
    let bq = 0, rq = 0, br = 0, rr = 0;
    for (const id of members) {
      const a = get(id);
      const p = price(a.base)!;
      bq += a.base.qty * p;
      rq += a.run.qty * p;
      br += a.base.rev;
      rr += a.run.rev;
    }
    const baseValue = nb ? bq / nb : 0;
    const runValue = nr ? rq / nr : 0;
    return {
      members,
      baseValue,
      runValue,
      baseRevenue: nb ? br / nb : 0,
      runRevenue: nr ? rr / nr : 0,
      growth: nb && nr ? ratio(runValue, baseValue) : null,
      day: (d) => members.reduce((s, id) => {
        const a = get(id);
        return s + ((a.base.byDay.get(d) ?? a.run.byDay.get(d) ?? 0) * price(a.base)!);
      }, 0),
    };
  };

  const storeDay = new Map(input.store.map((s) => [s.date, s.revenue]));
  const sum = (dates: string[]) => dates.reduce((s, d) => s + (storeDay.get(d) ?? 0), 0);
  const storeBase = nb ? sum(baseDates) / nb : 0;
  const storeRun = nr ? sum(runDates) / nr : 0;
  const store = { baseRevenue: storeBase, runRevenue: storeRun, growth: nb && nr ? ratio(storeRun, storeBase) : null };

  const T = group(input.testIds);
  const Craw = group(input.controlIds);
  const controlKind: LiftResult["controlKind"] = Craw.members.length ? "products" : "store";
  const C =
    controlKind === "products"
      ? Craw
      : { ...Craw, baseValue: storeBase, runValue: storeRun, baseRevenue: storeBase, runRevenue: storeRun, growth: store.growth, day: (d: string) => storeDay.get(d) ?? 0 };
  const cFactor = C.growth != null ? 1 + C.growth : null;
  const lift = T.growth != null && cFactor ? (1 + T.growth) / cFactor - 1 : null;

  // Interval: daily advertised/control ratio, comparing the run-period mean with the baseline (delta approximation, ~90%).
  let liftRange: [number, number] | null = null;
  const rs = (dates: string[]) => dates.map((d) => (C.day(d) > 0 ? T.day(d) / C.day(d) : null)).filter((x): x is number => x != null);
  const rb = rs(baseDates);
  const rr = rs(runDates);
  if (lift != null && rb.length >= 3 && rr.length >= 3) {
    const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
    const variance = (a: number[], m: number) => a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1);
    const mb = mean(rb);
    const mr = mean(rr);
    if (mb > 0 && mr > 0) {
      const rel = Math.sqrt(variance(rb, mb) / (rb.length * mb * mb) + variance(rr, mr) / (rr.length * mr * mr));
      const half = 1.645 * (1 + lift) * rel;
      liftRange = [lift - half, lift + half];
    }
  }

  const products: ProductLine[] = [];
  let incQty = 0, incRevenue = 0, counted = 0;
  for (const id of input.testIds) {
    const a = get(id);
    const bp = price(a.base);
    const rp = price(a.run);
    const baseQty = nb ? a.base.qty / nb : 0;
    const runQty = nr ? a.run.qty / nr : 0;
    const baseSellRate = nb ? a.base.days.size / nb : 0;
    const zeroRunDays = runDates.filter((d) => !(a.run.byDay.get(d) ?? 0)).length;
    const flags: string[] = [];
    let inc: number | null = null;
    let incR: number | null = null;
    if (!a.base.qty) flags.push(tr("settings.salesLiftCalc.noBaseSales"));
    else if (nr && cFactor) {
      inc = a.run.qty - baseQty * cFactor * nr;
      incR = inc * (rp ?? bp ?? 0);
      incQty += inc;
      incRevenue += incR;
      counted++;
    }
    const priceChange = bp && rp ? rp / bp - 1 : null;
    if (priceChange != null && Math.abs(priceChange) >= 0.1) flags.push(tr(priceChange > 0 ? "settings.salesLiftCalc.priceUp" : "settings.salesLiftCalc.priceDown", { pct: Math.round(Math.abs(priceChange) * 100) }));
    if (baseSellRate >= 0.7 && zeroRunDays >= 2) flags.push(tr("settings.salesLiftCalc.zeroDays", { days: zeroRunDays }));
    products.push({ id, baseQty, runQty, growth: nb && nr ? ratio(runQty, baseQty) : null, basePrice: bp, runPrice: rp, priceChange, zeroRunDays, baseSellRate, incQty: inc, incRevenue: incR, flags });
  }
  for (const id of input.controlIds) {
    const a = get(id);
    const bp = price(a.base);
    const rp = price(a.run);
    const flags: string[] = [];
    if (!a.base.qty) flags.push(tr("settings.salesLiftCalc.noBaseControl"));
    const priceChange = bp && rp ? rp / bp - 1 : null;
    if (priceChange != null && Math.abs(priceChange) >= 0.1) flags.push(tr("settings.salesLiftCalc.priceChanged", { pct: Math.round(priceChange * 100) }));
    products.push({
      id,
      baseQty: nb ? a.base.qty / nb : 0,
      runQty: nr ? a.run.qty / nr : 0,
      growth: nb && nr ? ratio(a.run.qty, (a.base.qty / Math.max(1, nb)) * nr) : null,
      basePrice: bp,
      runPrice: rp,
      priceChange,
      zeroRunDays: runDates.filter((d) => !(a.run.byDay.get(d) ?? 0)).length,
      baseSellRate: nb ? a.base.days.size / nb : 0,
      incQty: null,
      incRevenue: null,
      flags,
    });
  }

  return {
    baseDays: nb,
    runDays: nr,
    enough: nb >= MIN_DAYS && nr >= MIN_DAYS,
    test: T,
    control: C,
    controlKind,
    store,
    lift,
    liftRange,
    incQty: counted && cFactor ? incQty : null,
    incRevenue: counted && cFactor ? incRevenue : null,
    products,
    daily: [...baseDates.map((d) => ({ date: d, period: "base" as const })), ...runDates.map((d) => ({ date: d, period: "run" as const }))].map((x) => ({ ...x, test: T.day(x.date), control: C.day(x.date) })),
  };
}
