import { geoList, norm, type GeoItem } from "./targeting";

// Vietnam merged down to 34 provinces/cities from 01/07/2025 (Resolution 202/2025/QH15), but Meta still targets the 63 old provinces.
// Choosing a new province = choosing all corresponding old provinces on Meta.

export const NEW_PROVINCES: { name: string; old: string[] }[] = [
  { name: "Hà Nội", old: ["Hà Nội"] },
  { name: "Huế", old: ["Thừa Thiên Huế"] },
  { name: "Lai Châu", old: ["Lai Châu"] },
  { name: "Điện Biên", old: ["Điện Biên"] },
  { name: "Sơn La", old: ["Sơn La"] },
  { name: "Lạng Sơn", old: ["Lạng Sơn"] },
  { name: "Quảng Ninh", old: ["Quảng Ninh"] },
  { name: "Thanh Hóa", old: ["Thanh Hóa"] },
  { name: "Nghệ An", old: ["Nghệ An"] },
  { name: "Hà Tĩnh", old: ["Hà Tĩnh"] },
  { name: "Cao Bằng", old: ["Cao Bằng"] },
  { name: "Tuyên Quang", old: ["Tuyên Quang", "Hà Giang"] },
  { name: "Lào Cai", old: ["Lào Cai", "Yên Bái"] },
  { name: "Thái Nguyên", old: ["Thái Nguyên", "Bắc Kạn"] },
  { name: "Phú Thọ", old: ["Phú Thọ", "Vĩnh Phúc", "Hòa Bình"] },
  { name: "Bắc Ninh", old: ["Bắc Ninh", "Bắc Giang"] },
  { name: "Hưng Yên", old: ["Hưng Yên", "Thái Bình"] },
  { name: "Hải Phòng", old: ["Hải Phòng", "Hải Dương"] },
  { name: "Ninh Bình", old: ["Ninh Bình", "Hà Nam", "Nam Định"] },
  { name: "Quảng Trị", old: ["Quảng Trị", "Quảng Bình"] },
  { name: "Đà Nẵng", old: ["Đà Nẵng", "Quảng Nam"] },
  { name: "Quảng Ngãi", old: ["Quảng Ngãi", "Kon Tum"] },
  { name: "Gia Lai", old: ["Gia Lai", "Bình Định"] },
  { name: "Khánh Hòa", old: ["Khánh Hòa", "Ninh Thuận"] },
  { name: "Lâm Đồng", old: ["Lâm Đồng", "Đắk Nông", "Bình Thuận"] },
  { name: "Đắk Lắk", old: ["Đắk Lắk", "Phú Yên"] },
  { name: "TP. Hồ Chí Minh", old: ["Thành phố Hồ Chí Minh", "Bình Dương", "Bà Rịa - Vũng Tàu"] },
  { name: "Đồng Nai", old: ["Đồng Nai", "Bình Phước"] },
  { name: "Tây Ninh", old: ["Tây Ninh", "Long An"] },
  { name: "Cần Thơ", old: ["Cần Thơ", "Sóc Trăng", "Hậu Giang"] },
  { name: "Vĩnh Long", old: ["Vĩnh Long", "Bến Tre", "Trà Vinh"] },
  { name: "Đồng Tháp", old: ["Đồng Tháp", "Tiền Giang"] },
  { name: "Cà Mau", old: ["Cà Mau", "Bạc Liêu"] },
  { name: "An Giang", old: ["An Giang", "Kiên Giang"] },
];

/** Compare province names without diacritics, dropping "tỉnh/thành phố/province/city", collapsing whitespace and hyphens. */
const key = (n: string) =>
  norm(n)
    .replace(/\b(province|city|tinh|thanh pho|tp\.?)\b/g, "")
    .replace(/[-–.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
// English names Meta often returns in region breakdowns.
const ALIAS: Record<string, string> = { "ho chi minh": "ho chi minh", hanoi: "ha noi", "da nang": "da nang", haiphong: "hai phong", "can tho": "can tho", "thua thien hue": "thua thien hue", hue: "thua thien hue" };

function regions() {
  return geoList().filter((g) => g.type === "region");
}

/** Old province (exact Meta key) from any name (Vietnamese / English, with or without "Province"). */
function oldRegionByName(name: string): GeoItem | null {
  const k0 = key(name);
  const k = ALIAS[k0] ?? k0;
  return regions().find((r) => key(r.name) === k) ?? null;
}

/** Vietnamese name of a province in Meta reports (e.g. "Bình Dương Province" → "Bình Dương", "Hanoi" → "Hà Nội"). */
export function viRegionName(metaName: string) {
  if (/^unknown$/i.test(metaName)) return "Không rõ";
  const r = oldRegionByName(metaName);
  return r ? r.name.replace(/^Thành phố Hồ Chí Minh$/, "TP. Hồ Chí Minh") : metaName.replace(/\s+(Province|City)$/i, "");
}

/** New province (of 34) containing this old province. */
export function newProvinceOf(oldName: string) {
  const k = key(oldRegionByName(oldName)?.name ?? oldName);
  return NEW_PROVINCES.find((p) => p.old.some((o) => key(o) === k))?.name ?? null;
}

const AKA: Record<string, string[]> = { "TP. Hồ Chí Minh": ["hcm", "tphcm", "tp hcm", "sai gon", "saigon"], "Hà Nội": ["hn"], "Huế": ["hue"] };

/** New provinces matching the typed text, with Meta keys of the old provinces inside. */
export function searchNewProvinces(q: string) {
  const k = key(q);
  if (k.length < 2) return [];
  return NEW_PROVINCES.filter((p) => p.old.length > 1 && (key(p.name).includes(k) || (AKA[p.name] ?? []).some((a) => a.startsWith(k) || k.startsWith(a)) || p.old.some((o) => key(o).includes(k))))
    .map((p) => ({ name: p.name, regions: p.old.map((o) => oldRegionByName(o)).filter((x): x is GeoItem => !!x) }))
    .filter((p) => p.regions.length);
}

type BRow = { key: string; spend: number; impressions: number; clicks: number; results: number; estimated?: boolean };

/** Aggregate per-province metrics (Meta names, English) into the 34 new provinces; unrecognized provinces keep their names. */
export function groupByNewProvince<T extends BRow>(rows: T[]): (BRow & { parts: string[] })[] {
  const by = new Map<string, BRow & { parts: string[] }>();
  for (const r of rows) {
    const vi = viRegionName(r.key);
    const name = newProvinceOf(r.key) ?? vi;
    const g = by.get(name) ?? { key: name, spend: 0, impressions: 0, clicks: 0, results: 0, estimated: false, parts: [] };
    g.spend += r.spend;
    g.impressions += r.impressions;
    g.clicks += r.clicks;
    g.results += r.results;
    g.estimated ||= !!r.estimated;
    if (r.spend > 0) g.parts.push(vi);
    by.set(name, g);
  }
  return [...by.values()].map((g) => ({ ...g, parts: g.parts.length > 1 ? g.parts : [] }));
}
