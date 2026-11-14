import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { norm } from "./text";
import type { MessageKey, T } from "@/i18n/translate";

// Meta's real targeting catalog (data/targeting.json: bundled seed, republished by the Targeting library after each scan).

/** name: Vietnamese Ads Manager name; en: original name (usually English); copy: text that finds it when pasted into Ads Manager search; ok: verified findable. */
export type TargetingItem = { id: string; name: string; type: string; path: string; vnLo: number | null; vnHi: number | null; desc?: string; en?: string; copy?: string; ok?: boolean };

/** Text to paste into Ads Manager's search box: the verified text, or otherwise the name without the trailing "(note)" (Ads Manager doesn't search that part). */
export const copyTextOf = (i: { name: string; copy?: string | null; copyText?: string | null }) => i.copy || i.copyText || i.name.replace(/\s*\([^)]*\)\s*$/, "").trim() || i.name;
export type GeoItem = { key: string; name: string; type: "region" | "city"; region: string };

export const TYPE_LABEL: Record<string, string> = {
  interests: "Sở thích",
  behaviors: "Hành vi",
  life_events: "Sự kiện trong đời",
  family_statuses: "Tình trạng gia đình",
  industries: "Ngành nghề",
  income: "Thu nhập",
  education_statuses: "Học vấn",
  relationship_statuses: "Tình trạng mối quan hệ",
  work_positions: "Chức danh",
  work_employers: "Nơi làm việc",
  education_schools: "Trường học",
  education_majors: "Ngành học",
};

/** Translated type label ("Sở thích" / "Interests"); unknown types are shown as-is. */
export const typeLabel = (t: T, type: string) => (type in TYPE_LABEL ? t(`targeting.type.${type}` as MessageKey) : type);

let _items: TargetingItem[] | null = null;
let _byId: Map<string, TargetingItem> | null = null;
let _byKey: Map<string, TargetingItem> | null = null;
let _mtime = 0;
let _checkedAt = 0;

/** Types whose ids are small numbers that overlap across types: the key must include the type. */
export const TYPED_ID_TYPES = new Set(["education_statuses", "relationship_statuses"]);
export const targetingKey = (type: string, id: string) => (TYPED_ID_TYPES.has(type) ? `${type}:${id}` : id);
let _geo: GeoItem[] | null = null;

function load<T>(file: string): T[] {
  try {
    return JSON.parse(readFileSync(path.join(process.cwd(), "data", file), "utf8"));
  } catch {
    return []; // file missing or unreadable
  }
}

/**
 * The targeting catalog in use (data/targeting.json, published by the Targeting library).
 * The crawl process runs separately and writes a new file → check the file mtime at most every 5 seconds to reload, no restart needed.
 */
export function catalog() {
  const now = Date.now();
  if (_items && now - _checkedAt > 5000) {
    _checkedAt = now;
    try {
      if (statSync(path.join(process.cwd(), "data", "targeting.json")).mtimeMs !== _mtime) _items = null;
    } catch {}
  }
  if (!_items) {
    try {
      _mtime = statSync(path.join(process.cwd(), "data", "targeting.json")).mtimeMs;
    } catch {}
    _checkedAt = now;
    _items = load<TargetingItem>("targeting.json");
    // Items with ids shared across types: byId keeps the first item; look up exactly by type via lookupTargeting().
    _byId = new Map();
    for (const i of _items) if (!_byId.has(i.id)) _byId.set(i.id, i);
    _byKey = new Map(_items.map((i) => [targetingKey(i.type, i.id), i]));
    _normCache.clear();
  }
  return { items: _items, byId: _byId!, byKey: _byKey! };
}

/** Look up an item by id (+ type if known, to distinguish education / relationship status sharing an id). */
export function lookupTargeting(id: string, type?: string) {
  const c = catalog();
  return (type && c.byKey.get(targetingKey(type, id))) || c.byId.get(id);
}

export function geoList() {
  _geo ??= load<GeoItem>("geo-vn.json");
  return _geo;
}

export { norm };

const _normCache = new Map<string, string>();
/** Normalized name for search: Vietnamese name + original English name (either spelling finds it). */
function normName(i: { name: string; en?: string }) {
  const k = i.en ? `${i.name}\u0000${i.en}` : i.name;
  let n = _normCache.get(k);
  if (n === undefined) _normCache.set(k, (n = i.en ? `${norm(i.name)} | ${norm(i.en)}` : norm(i.name)));
  return n;
}

/** Name with Vietnamese diacritics. */
export const isVietnamese = (s: string) => /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(s);

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function score(nameN: string, q: string) {
  if (nameN === q) return 4;
  if (nameN.startsWith(q)) return 3;
  if (new RegExp(`(^|[^a-z0-9])${esc(q)}($|[^a-z0-9])`).test(nameN)) return 2; // whole-word match
  if (new RegExp(`(^|[^a-z0-9])${esc(q)}`).test(nameN)) return 1; // word-prefix match
  return nameN.includes(q) ? 0.5 : 0;
}

/** Bonus when the user types with diacritics and the name matches them exactly (so "mẹ" isn't confused with "men"). */
function accentBonus(name: string, raw: string) {
  return raw !== norm(raw) && name.toLowerCase().includes(raw.toLowerCase()) ? 2 : 0;
}

/** Library name match: exact name (without note) > starts with whole word > contains whole word > starts with > word prefix > mid-word. */
function libScore(name: string, q: string) {
  const n = norm(name);
  const bare = norm(name.replace(/\s*\([^)]*\)\s*$/, ""));
  const e = esc(q);
  if (bare === q || n === q) return 6;
  if (new RegExp(`^${e}($|[^a-z0-9])`).test(n)) return 4.5;
  if (new RegExp(`(^|[^a-z0-9])${e}($|[^a-z0-9])`).test(n)) return 3.5;
  if (n.startsWith(q)) return 2.5;
  if (new RegExp(`(^|[^a-z0-9])${e}`).test(n)) return 1.5;
  return n.includes(q) ? 0.5 : 0;
}

/**
 * Match level of an item against the user's text (0 = no match), for the Library page: Vietnamese / original name first,
 * then path, description, ID. With multiple words, every word must be present.
 */
export function matchScore(i: { name: string; en?: string | null; path?: string | null; desc?: string | null; id?: string }, raw: string) {
  const q = norm(raw.trim());
  if (!q) return 1;
  if (i.id === raw.trim()) return 10;
  const name = Math.max(libScore(i.name, q), i.en ? libScore(i.en, q) * 0.9 : 0);
  const accent = accentBonus(i.name, raw);
  // Typed with diacritics but the name lacks those exact marks: drop Vietnamese names ("mẹ" ≠ "mê"); English names only match on whole words
  // ("mẹ" doesn't match "Men's clothing", "home").
  const wholeWord = (n: string) => !isVietnamese(n) && new RegExp(`(^|[^a-z0-9])${esc(q)}($|[^a-z0-9])`).test(norm(n));
  const loose = raw.trim() !== norm(raw.trim()) && !accent && !wholeWord(i.name) && !(i.en && wholeWord(i.en));
  if (name && !loose) return name + accent;
  // Multiple words: every word must appear at the start of a word (name first, then path / description). With diacritics typed, compare them exactly.
  const accented = raw.trim() !== norm(raw.trim());
  const fold = (s: string) => (accented ? s.toLowerCase().normalize("NFC") : norm(s));
  const words = fold(raw).split(/\s+/).filter((w) => w.length >= 2);
  // The last word may be partially typed (prefix match); earlier words must be whole ("du học" doesn't match "Mỹ dung học").
  const has = (text: string) =>
    words.length > 0 && words.every((w, k) => new RegExp(`(^|[\\s>(),.&/-])${esc(w)}${k < words.length - 1 ? "($|[\\s>(),.&/-])" : ""}`).test(` ${fold(text)}`));
  const all = `${i.name} ${i.en ?? ""}`;
  if (words.length > 1 && has(all)) return 0.4;
  return has(`${all} ${i.path ?? ""} ${i.desc ?? ""}`) ? 0.2 : 0;
}

export function searchTargeting(query: string, limit = 30): TargetingItem[] {
  const raw = query.trim();
  const q = norm(raw);
  if (q.length < 2) return [];
  return catalog()
    .items.map((i) => {
      const s = Math.max(score(norm(i.name), q), i.en ? score(norm(i.en), q) : 0);
      return { i, s: s && s + accentBonus(i.name, raw) };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || (b.i.vnHi ?? 0) - (a.i.vnHi ?? 0))
    .slice(0, limit)
    .map((x) => x.i);
}

export function searchGeo(query: string, limit = 20): GeoItem[] {
  const q = norm(query.trim());
  if (!q) return geoList().filter((g) => g.type === "region").slice(0, limit);
  return geoList()
    .map((g) => ({ g, s: score(norm(g.name), q) + (g.type === "region" ? 0.2 : 0) }))
    .filter((x) => x.s > 0.2)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.g);
}

// Per-industry suggested keywords for filtering the catalog for Claude (catalog names mix English and Vietnamese).
const INDUSTRY_KEYWORDS: [RegExp, string[]][] = [
  [/spa|tham my|lam dep|my pham|da lieu|nail|toc|salon/, ["spa", "beauty", "skin care", "cosmetics", "lam dep", "cham soc da", "tham my", "my pham", "hair removal", "facial", "massage", "makeup", "salon", "acne"]],
  [/noi that|go|furniture|sofa|tu bep|nha/, ["furniture", "interior", "noi that", "home", "kitchen", "sofa", "real estate", "bat dong san", "nha", "can ho", "architecture", "kien truc"]],
  [/thoi trang|quan ao|vay|dam|fashion|giay|tui/, ["fashion", "thoi trang", "clothing", "dress", "shopping", "mua sam", "online shopping", "boutique", "shoes", "handbag", "quan ao"]],
  [/an uong|nha hang|cafe|ca phe|do an|f&b|fnb|tra sua|banh/, ["food", "restaurant", "cafe", "coffee", "am thuc", "do an", "nha hang", "tra sua", "bakery", "fast food", "cooking"]],
  [/dao tao|giao duc|khoa hoc|tieng anh|hoc/, ["education", "giao duc", "hoc", "english", "tieng anh", "course", "university", "dai hoc", "online learning", "khoa hoc"]],
];

/**
 * Candidate targeting list for Claude when planning: matches industry/product keywords
 * + common demographic/behavior/life-event groups in VN. At most `limit` items.
 */
export function plannerCandidates(text: string, limit = 350): TargetingItem[] {
  const t = norm(text);
  const kws = new Set<string>();
  for (const [re, words] of INDUSTRY_KEYWORDS) if (re.test(t)) words.forEach((w) => kws.add(w));
  // Vietnamese: use 2-word phrases ("cham soc", "tri mun") to avoid false matches on single words like "phong" in "van phong".
  const words = t.split(/[^a-z0-9]+/).filter(Boolean);
  for (let i = 0; i < words.length - 1; i++) kws.add(`${words[i]} ${words[i + 1]}`);
  for (const w of words) if (w.length >= 6) kws.add(w);

  const picked = new Map<string, TargetingItem>();
  const { items } = catalog();
  const matches = items
    .filter((i) => i.vnHi && i.vnHi >= 20000)
    .map((i) => {
      const n = normName(i);
      let s = 0;
      for (const k of kws) if (new RegExp(`(^|[^a-z0-9])${esc(k)}`).test(n)) s += k.includes(" ") ? 2 : 1;
      return { i, s };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || (b.i.vnHi ?? 0) - (a.i.vnHi ?? 0));
  for (const { i } of matches.slice(0, Math.floor(limit * 0.6))) picked.set(i.id, i);

  // Common groups independent of industry
  const general = items
    .filter((i) => i.type !== "interests" && i.type !== "work_employers" && i.type !== "education_schools" && (i.vnHi ?? 0) >= 50000)
    .sort((a, b) => (b.vnHi ?? 0) - (a.vnHi ?? 0));
  for (const i of general) {
    if (picked.size >= limit) break;
    picked.set(i.id, i);
  }
  return [...picked.values()];
}

export function formatSize(lo: number | null, hi: number | null) {
  if (hi == null) return "";
  const f = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}tr` : v >= 1e3 ? `${Math.round(v / 1e3)}k` : String(v));
  return lo != null && lo !== hi ? `${f(lo)}–${f(hi)}` : f(hi);
}

// ------------------------------------------------------------ Converting to Meta's targeting spec

export type GeoType = "country" | "region" | "city" | "subcity" | "neighborhood";
/** A targeted location on Meta. `parent` = the (old, per Meta) province containing it; `group` = the new province (of 34) chosen to produce this item. */
export type Location = { key: string; name: string; type: GeoType; radius_km?: number | null; parent?: string | null; parentKey?: string | null; group?: string | null };
export type DetailedItem = { id: string; name: string; type: string };

const NUMERIC_ID_TYPES = new Set(["education_statuses", "relationship_statuses"]);

const CITY_RADIUS_MIN_KM = 17;

type CustomLocation = { label: string; latitude: number; longitude: number; radius_km: number };
type LocationTypes = "home_recent" | "home" | "recent";

const LOCATION_TYPES: Record<LocationTypes, string[]> = { home_recent: ["home", "recent"], home: ["home"], recent: ["recent"] };

export function toGeoSpec(locations: Location[], custom: CustomLocation[] = [], locationTypes: LocationTypes = "home_recent") {
  const custom_locations = custom.map((c) => ({ latitude: c.latitude, longitude: c.longitude, radius: c.radius_km, distance_unit: "kilometer" }));
  const countries = locations.filter((l) => l.type === "country").map((l) => l.key);
  const regions = locations.filter((l) => l.type === "region").map((l) => ({ key: l.key }));
  const cities = locations
    .filter((l) => l.type === "city")
    // Meta only accepts city radii of 17–80 km (10–50 miles).
    .map((l) => ({ key: l.key, radius: Math.min(80, Math.max(CITY_RADIUS_MIN_KM, l.radius_km ?? CITY_RADIUS_MIN_KM)), distance_unit: "kilometer" }));
  // Districts, wards: Meta takes the keys directly (no radius).
  const subcities = locations.filter((l) => l.type === "subcity").map((l) => ({ key: l.key }));
  const neighborhoods = locations.filter((l) => l.type === "neighborhood").map((l) => ({ key: l.key }));
  if (!countries.length && !regions.length && !cities.length && !subcities.length && !neighborhoods.length && !custom_locations.length) countries.push("VN");
  return {
    ...(countries.length && { countries }),
    ...(regions.length && { regions }),
    ...(cities.length && { cities }),
    ...(subcities.length && { subcities }),
    ...(neighborhoods.length && { neighborhoods }),
    ...(custom_locations.length && { custom_locations }),
    location_types: LOCATION_TYPES[locationTypes],
  };
}

/** Detailed targeting: items within the same flexible_spec are OR'ed (like Ads Manager). */
export function toFlexibleSpec(items: DetailedItem[]) {
  if (!items.length) return undefined;
  const group: Record<string, unknown[]> = {};
  for (const i of items) {
    (group[i.type] ??= []).push(NUMERIC_ID_TYPES.has(i.type) ? Number(i.id) : { id: i.id, name: i.name });
  }
  return [group];
}
