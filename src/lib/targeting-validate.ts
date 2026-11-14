import { db } from "./db";
import { metaFetch } from "./meta/rate-limit";
import { catalog, targetingKey, typeLabel, TYPED_ID_TYPES } from "./targeting";
import { getT } from "@/i18n/server";
import { DETAIL_TYPES, publishSnapshot } from "./targeting-store";

// Check whether detailed targeting items are usable in ads: act_<id>/targetingvalidation, sending the TYPE (targeting_list).
// Don't use id_list: id_list only validates as interests, so Workplace / Job title / Field of study items always come back valid=false.
// Common error: items stored with the wrong type (e.g. "Laundry" is a Workplace but the library stores it as an Interest) → on publish Meta reports
// "Mối quan tâm có ID … không hợp lệ" (interest ID … invalid). The same ID with the right type works: fix the type automatically; if no type is valid, drop it.

type TItem = { id: string; type: string; name?: string };
/** ok: usable; retype: right ID but the type must change; invalid: no type works. */
type Verdict = { kind: "ok" } | { kind: "retype"; type: string; name: string; path: string } | { kind: "invalid" };
export type Auth = { act: string; token: string };

type Row = { id?: string | number; type?: string; name?: string; path?: string[]; valid?: boolean };
const CHUNK = 50;
const actOf = (id: string) => (id.startsWith("act_") ? id : `act_${id}`);

async function validateList(auth: Auth, list: { type: string; id: string }[]): Promise<(Row | undefined)[]> {
  const out: (Row | undefined)[] = [];
  for (let i = 0; i < list.length; i += CHUNK) {
    const chunk = list.slice(i, i + CHUNK);
    const qs = new URLSearchParams({ targeting_list: JSON.stringify(chunk), access_token: auth.token });
    const res = await metaFetch(`https://graph.facebook.com/v23.0/${actOf(auth.act)}/targetingvalidation?${qs}`);
    const json = (await res.json().catch(() => ({}))) as { data?: Row[]; error?: { message?: string } };
    if (!res.ok || json.error || !Array.isArray(json.data)) throw new Error((await getT())("targeting.validate.cannotCheck", { detail: json.error?.message ?? `HTTP ${res.status}` }));
    const data = json.data;
    // Meta returns results in the order sent; invalid items carry no type, so match them by position.
    if (data.length === chunk.length) out.push(...data);
    else out.push(...chunk.map((c) => data.find((d) => String(d.id) === c.id && (!d.type || d.type === c.type))));
  }
  return out;
}

/** Type Ads Manager shows for this item: search by name, take the row with the same ID (the same ID may be valid in several work-related types). */
async function searchedType(auth: Auth, id: string, name?: string): Promise<string | null> {
  if (!name) return null;
  for (const locale of ["vi_VN", "en_US"]) {
    const qs = new URLSearchParams({ q: name.replace(/\s*\([^)]*\)\s*$/, ""), locale, access_token: auth.token });
    const res = await metaFetch(`https://graph.facebook.com/v23.0/${actOf(auth.act)}/targetingsearch?${qs}`).catch(() => null);
    const json = res ? ((await res.json().catch(() => ({}))) as { data?: Row[] }) : {};
    const hit = (json.data ?? []).find((r) => String(r.id) === id && r.type && DETAIL_TYPES.has(r.type));
    if (hit?.type) return hit.type;
  }
  return null;
}

/** Check by (type, ID). Items Meta can't answer for (order mismatch) are treated as usable, letting the publish step report errors. */
export async function checkTargeting(auth: Auth, items: TItem[]): Promise<Map<string, Verdict>> {
  const uniq = [...new Map(items.filter((i) => i.id && i.type).map((i) => [targetingKey(i.type, i.id), { type: i.type, id: String(i.id), name: i.name }])).values()];
  const verdicts = new Map<string, Verdict>();
  if (!uniq.length) return verdicts;
  const rows = await validateList(auth, uniq.map(({ type, id }) => ({ type, id })));
  const bad = uniq.filter((u, k) => rows[k]?.valid === false);
  for (const u of uniq) verdicts.set(targetingKey(u.type, u.id), { kind: "ok" });
  if (!bad.length) return verdicts;
  // Find the right type: first the type Ads Manager shows when searching by name, then try the same ID with other types
  // (types with small numeric IDs that overlap aren't tried, to avoid matching a different item).
  const alts: { type: string; id: string; of: (typeof bad)[number] }[] = [];
  for (const b of bad) {
    if (TYPED_ID_TYPES.has(b.type)) continue;
    const first = await searchedType(auth, b.id, b.name);
    const order = [...new Set([...(first ? [first] : []), ...DETAIL_TYPES])].filter((t) => t !== b.type && !TYPED_ID_TYPES.has(t));
    alts.push(...order.map((type) => ({ type, id: b.id, of: b })));
  }
  const altRows = alts.length ? await validateList(auth, alts.map(({ type, id }) => ({ type, id }))) : [];
  for (const b of bad) {
    const k = alts.findIndex((a, i) => a.of === b && altRows[i]?.valid === true);
    const hit = k >= 0 ? altRows[k]! : null;
    verdicts.set(
      targetingKey(b.type, b.id),
      hit ? { kind: "retype", type: alts[k].type, name: String(hit.name ?? ""), path: (hit.path ?? []).join(" > ") } : { kind: "invalid" },
    );
  }
  return verdicts;
}

/** Fix the library from check results: switch to the right type, or mark dead (no deletion). Returns the number of items fixed. */
export async function repairLibrary(items: TItem[], verdicts: Map<string, Verdict>): Promise<number> {
  const now = new Date();
  let changed = 0;
  for (const i of items) {
    const v = verdicts.get(targetingKey(i.type, i.id));
    if (!v || v.kind === "ok") continue;
    const key = targetingKey(i.type, i.id);
    const row = await db.targetingItem.findUnique({ where: { key } });
    if (!row || row.type !== i.type) continue; // not in the library, or already fixed
    if (v.kind === "invalid") {
      if (row.status === "dead") continue;
      await db.targetingItem.update({ where: { key }, data: { status: "dead", deadAt: now } });
    } else {
      // Only retype long IDs (key = ID), so the key doesn't change.
      await db.targetingItem.update({ where: { key }, data: { type: v.type, ...(v.path && { path: v.path }), status: "active", deadAt: null } });
    }
    changed++;
  }
  if (changed) {
    await publishSnapshot();
    catalog(); // reload right away in this process
  }
  return changed;
}

type Item = { id: string; name: string; type: string };
type PlanLike = { ad_sets: { name: string; detailed_targeting: Item[]; narrow_targeting?: Item[] }[] };

/**
 * Check all of the plan's detailed targeting against the ad account it will be published to.
 * Wrong-type items: retype automatically (same ID). Unusable items: drop them or report errors by name (for the user to decide).
 */
export async function checkPlanTargeting<P extends PlanLike>(
  plan: P,
  auth: Auth,
  opts: { drop?: boolean } = {},
): Promise<{ plan: P; notes: string[]; errors: string[]; changed: boolean }> {
  const all = plan.ad_sets.flatMap((s) => [...s.detailed_targeting, ...(s.narrow_targeting ?? [])]);
  const t = await getT();
  const verdicts = await checkTargeting(auth, all);
  await repairLibrary(all, verdicts).catch(() => 0); // fixing the library is secondary; errors don't block
  const notes = new Set<string>();
  const errors = new Set<string>();
  let changed = false;
  const fix = (list: Item[], set: string) =>
    list.flatMap((it) => {
      const v = verdicts.get(targetingKey(it.type, it.id));
      if (!v || v.kind === "ok") return [it];
      changed = true;
      if (v.kind === "retype") {
        notes.add(t("targeting.validate.retyped", { name: it.name, from: typeLabel(t, it.type), to: typeLabel(t, v.type) }));
        return [{ ...it, type: v.type }];
      }
      if (opts.drop) notes.add(t("targeting.validate.dropped", { name: it.name, type: typeLabel(t, it.type) }));
      else errors.add(t("targeting.validate.error", { set, name: it.name, type: typeLabel(t, it.type), id: it.id }));
      return opts.drop ? [] : [it];
    });
  const ad_sets = plan.ad_sets.map((s) => ({
    ...s,
    detailed_targeting: fix(s.detailed_targeting, s.name),
    ...(s.narrow_targeting && { narrow_targeting: fix(s.narrow_targeting, s.name) }),
  }));
  return { plan: { ...plan, ad_sets }, notes: [...notes], errors: [...errors], changed };
}
