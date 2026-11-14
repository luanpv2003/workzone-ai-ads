import { db } from "../db";
import { decrypt } from "../crypto";
import { metaFetch } from "./rate-limit";
import { norm } from "../text";
import { viRegionName } from "../vn-geo";

// Search locations directly on Meta (like the "Location" box in Ads Manager): province, city, district, ward — Vietnamese names, exact Meta keys.

type MetaGeo = { key: string; name: string; type: "region" | "city" | "subcity" | "neighborhood"; region: string; regionKey: string | null };

const cache = new Map<string, { at: number; rows: MetaGeo[] }>();
const seen = new Map<string, MetaGeo>();

/** Locations seen in Meta search results (to accept keys Claude picks from the provided list). */
export const seenMetaGeo = (key: string) => seen.get(key) ?? null;
const TTL = 24 * 3600_000;

async function geoToken() {
  const scan = await db.setting.findUnique({ where: { key: "targeting.scanToken" } });
  if (scan?.value) return decrypt(scan.value);
  const c = await db.client.findFirst({ where: { dataSource: "meta", metaAccessToken: { not: null } }, select: { metaAccessToken: true } });
  return c?.metaAccessToken ? decrypt(c.metaAccessToken) : null;
}

export async function searchMetaGeo(q: string): Promise<MetaGeo[] | null> {
  const text = q.trim();
  if (text.length < 2) return [];
  const hit = cache.get(text.toLowerCase());
  if (hit && Date.now() - hit.at < TTL) return hit.rows;
  const token = await geoToken();
  if (!token) return null;
  const u = new URL("https://graph.facebook.com/v23.0/search");
  u.searchParams.set("type", "adgeolocation");
  u.searchParams.set("q", text);
  u.searchParams.set("country_code", "VN");
  u.searchParams.set("location_types", JSON.stringify(["region", "city", "subcity", "neighborhood"]));
  u.searchParams.set("limit", "15");
  u.searchParams.set("locale", "vi_VN");
  u.searchParams.set("access_token", token);
  try {
    const res = await metaFetch(u.toString());
    const json = (await res.json()) as { data?: { key: string; name: string; type: string; region?: string; region_id?: number | string; country_code?: string }[]; error?: unknown };
    if (json.error || !json.data) return null;
    const rows = json.data
      .filter((x) => (!x.country_code || x.country_code === "VN") && ["region", "city", "subcity", "neighborhood"].includes(x.type))
      .map((x) => ({ key: String(x.key), name: x.name.replace(/,\s*Vietnam$/i, ""), type: x.type as MetaGeo["type"], region: x.region ? viRegionName(x.region) : "", regionKey: x.region_id != null ? String(x.region_id) : null }));
    // Meta mixes in many unrelated names: put exact matches of the typed text first, provinces before districts/wards.
    const q = norm(text);
    const score = (g: MetaGeo) => {
      const n = norm(g.name);
      return (n === q ? 6 : n.startsWith(q) ? 4 : n.includes(q) ? 2 : 0) + { region: 1, subcity: 0.6, city: 0.4, neighborhood: 0.2 }[g.type];
    };
    rows.sort((a, b) => score(b) - score(a));
    for (const g of rows) seen.set(g.key, g);
    cache.set(text.toLowerCase(), { at: Date.now(), rows });
    return rows;
  } catch {
    return null;
  }
}
