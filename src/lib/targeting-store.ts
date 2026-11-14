import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { db } from "./db";
import { getT } from "@/i18n/server";
import { isVietnamese, targetingKey } from "./targeting";

// Targeting library: the DB is the source of truth; data/targeting.json is the published copy the rest of the system reads quickly.

export const DETAIL_TYPES = new Set([
  "interests",
  "behaviors",
  "life_events",
  "family_statuses",
  "industries",
  "income",
  "education_statuses",
  "relationship_statuses",
  "work_positions",
  "work_employers",
  "education_schools",
  "education_majors",
]);

export type FoundItem = {
  id: string;
  type: string;
  name: string;
  path?: string;
  description?: string;
  topic?: string;
  globalLo?: number | null;
  globalHi?: number | null;
  vnLo?: number | null;
  vnHi?: number | null;
  industry?: string; // name of the industry keyword set that found this item
  source: string;
};

/**
 * Meta returns names in an unstable locale (the same item is sometimes "Nấu ăn (ẩm thực)", sometimes "Cooking (food & drink)").
 * Merge newly crawled names into the stored ones: original name (usually English) in `name`, Vietnamese name in `nameVi`.
 * A language-only difference isn't a rename; only log "renamed" when the same language has different text.
 */
function mergeName(e: { name: string; nameVi: string | null }, incoming: string) {
  if (isVietnamese(incoming)) {
    // The name stored in `name` is also Vietnamese (old imported data with no original name): keep it there and compare as a Vietnamese name.
    const oldVi = e.nameVi ?? (isVietnamese(e.name) ? e.name : null);
    return { data: { nameVi: incoming }, renamedFrom: oldVi && oldVi !== incoming ? oldVi : null };
  }
  const oldEn = isVietnamese(e.name) ? null : e.name;
  return {
    data: { name: incoming, ...(!e.nameVi && isVietnamese(e.name) && { nameVi: e.name }) },
    renamedFrom: oldEn && oldEn !== incoming ? oldEn : null,
  };
}

const int = (v: unknown) => {
  const n = Number(v);
  return v === "" || v == null || !Number.isFinite(n) ? null : Math.round(n);
};
export { int as toInt };

// ------------------------------------------------------------ Writing items + change log

/** Add/update items found in a crawl pass. Logs "new" / "revived" / "renamed" changes. */
export async function upsertItems(runId: string, found: FoundItem[]) {
  const now = new Date();
  const stats = { seen: 0, added: 0, revived: 0, renamed: 0 };
  const byKey = new Map<string, FoundItem>();
  for (const f of found) {
    if (!f.id || !f.name || !DETAIL_TYPES.has(f.type)) continue;
    // The same item appears multiple times in one pass (multiple sources/industries): keep the first name, fill in missing fields.
    const k = targetingKey(f.type, f.id);
    const prev = byKey.get(k);
    byKey.set(k, prev ? { ...f, ...Object.fromEntries(Object.entries(prev).filter(([, v]) => v != null && v !== "")), industry: f.industry ?? prev.industry } : f);
  }
  const keys = [...byKey.keys()];
  const existing = new Map<string, Awaited<ReturnType<typeof db.targetingItem.findMany>>[number]>();
  for (let i = 0; i < keys.length; i += 500) {
    for (const e of await db.targetingItem.findMany({ where: { key: { in: keys.slice(i, i + 500) } } })) existing.set(e.key, e);
  }

  const changes: { runId: string; itemKey: string; name: string; type: string; change: string; before?: string; after?: string }[] = [];
  const ops = [];
  for (const [key, f] of byKey) {
    stats.seen++;
    const e = existing.get(key);
    const industries = (prev: string | null | undefined) => {
      const list = new Set<string>(prev ? JSON.parse(prev) : []);
      if (f.industry) list.add(f.industry);
      return list.size ? JSON.stringify([...list]) : null;
    };
    const common = {
      ...(f.path && { path: f.path }),
      ...(f.description && { description: f.description }),
      ...(f.topic && { topic: f.topic }),
      ...(f.globalHi != null && { globalLo: f.globalLo ?? null, globalHi: f.globalHi }),
      ...(f.vnHi != null && { vnLo: f.vnLo ?? null, vnHi: f.vnHi }),
      lastSeenAt: now,
    };
    if (!e) {
      const names = { name: f.name, ...(isVietnamese(f.name) && { nameVi: f.name }) };
      stats.added++;
      ops.push(db.targetingItem.create({ data: { key, id: f.id, type: f.type, source: f.source, industries: industries(null), ...names, ...common, ...(f.vnHi != null && { reachCheckedAt: now }) } }));
      changes.push({ runId, itemKey: key, name: f.name, type: f.type, change: "added", after: JSON.stringify({ path: f.path, globalHi: f.globalHi, vnHi: f.vnHi }) });
      continue;
    }
    // A re-crawl finds an item marked dead: queue it for a size re-check;
    // only treat it as revived once the VN size check succeeds (recorded in the check step).
    const recheck = e.status === "dead";
    const named = mergeName(e, f.name);
    if (named.renamedFrom) {
      stats.renamed++;
      changes.push({ runId, itemKey: key, name: f.name, type: f.type, change: "renamed", before: JSON.stringify({ name: named.renamedFrom }), after: JSON.stringify({ name: f.name }) });
    }
    ops.push(db.targetingItem.update({ where: { key }, data: { ...named.data, ...common, industries: industries(e.industries), ...(recheck && { reachCheckedAt: null }) } }));
  }
  for (let i = 0; i < ops.length; i += 200) await db.$transaction(ops.slice(i, i + 200));
  for (let i = 0; i < changes.length; i += 500) await db.targetingChange.createMany({ data: changes.slice(i, i + 500) });
  return stats;
}

/** Where items are in use (unpublished drafts, synced ad sets), to warn when Meta retires an item. */
export async function whereUsed(ids: string[]) {
  if (!ids.length) return new Map<string, { kind: string; name: string; client: string }[]>();
  const t = await getT();
  const [drafts, adSets] = await Promise.all([
    db.campaignDraft.findMany({ where: { status: "draft" }, select: { plan: true, client: { select: { name: true } } } }),
    db.adSet.findMany({ where: { status: { not: "ARCHIVED" } }, select: { name: true, targeting: true, client: { select: { name: true } } } }),
  ]);
  const out = new Map<string, { kind: string; name: string; client: string }[]>();
  for (const id of ids) {
    const needle = `"${id}"`;
    const uses = [
      ...drafts.filter((d) => d.plan.includes(needle)).map((d) => {
        let name = t("targeting.store.draft");
        try {
          name = JSON.parse(d.plan).campaign_name ?? name;
        } catch {}
        return { kind: t("targeting.store.draft"), name, client: d.client.name };
      }),
      ...adSets.filter((s) => s.targeting.includes(needle)).map((s) => ({ kind: t("targeting.store.adSet"), name: s.name, client: s.client.name })),
    ];
    if (uses.length) out.set(id, uses);
  }
  return out;
}

/** Number of running ad sets / drafts containing each targeting ID (one read, for the Library list). */
export async function usageById() {
  const [drafts, adSets] = await Promise.all([
    db.campaignDraft.findMany({ where: { status: "draft" }, select: { plan: true } }),
    db.adSet.findMany({ where: { status: "ACTIVE" }, select: { targeting: true } }),
  ]);
  const out = new Map<string, { running: number; drafts: number }>();
  const scan = (json: string, field: "running" | "drafts") => {
    for (const id of new Set([...json.matchAll(/"id"\s*:\s*"?(\d{4,})"?/g)].map((m) => m[1]))) {
      const u = out.get(id) ?? out.set(id, { running: 0, drafts: 0 }).get(id)!;
      u[field]++;
    }
  };
  for (const s of adSets) scan(s.targeting, "running");
  for (const d of drafts) scan(d.plan, "drafts");
  return out;
}

// ------------------------------------------------------------ Publishing for the system to read

/** Write data/targeting.json from live items (write a temp file then rename so nobody reads a partial file). */
export async function publishSnapshot() {
  // Only publish items findable by copy-paste in Ads Manager (or not yet checked); items checked and not found aren't handed to the system.
  const items = await db.targetingItem.findMany({ where: { status: "active", OR: [{ findable: true }, { findable: null }] }, orderBy: [{ type: "asc" }, { name: "asc" }] });
  const out = items.map((i) => ({
    id: i.id,
    name: i.nameVi || i.name,
    type: i.type,
    path: i.path,
    vnLo: i.vnLo,
    vnHi: i.vnHi,
    ...(i.description && { desc: i.description }),
    ...(i.nameVi && i.nameVi !== i.name && { en: i.name }),
    ...(i.copyText && { copy: i.copyText }),
    ...(i.findable && { ok: true }),
  }));
  const file = path.join(process.cwd(), "data", "targeting.json");
  writeFileSync(`${file}.tmp`, JSON.stringify(out));
  renameSync(`${file}.tmp`, file);
  return out.length;
}

// ------------------------------------------------------------ First-time initialization

/** Empty DB: load from the existing published copy + default industry keyword sets. Safe to run multiple times. */
export async function bootstrapLibrary() {
  if (!(await db.targetingSeedSet.count())) {
    const file = path.join(process.cwd(), "data", "targeting-seeds.json");
    if (existsSync(file)) {
      const sets: { name: string; keywords: string[] }[] = JSON.parse(readFileSync(file, "utf8"));
      for (const s of sets) await db.targetingSeedSet.create({ data: { name: s.name, keywords: JSON.stringify(s.keywords) } });
    }
  }
  if (await db.targetingItem.count()) return false;
  const file = path.join(process.cwd(), "data", "targeting.json");
  if (!existsSync(file)) return false;
  const snap: { id: string; name: string; type: string; path: string; vnLo: number | null; vnHi: number | null; desc?: string }[] = JSON.parse(readFileSync(file, "utf8"));
  const run = await db.targetingRun.create({
    data: { kind: "import", status: "running", startedAt: new Date(), triggeredBy: (await getT())("targeting.store.seedTrigger"), params: JSON.stringify({ from: "data/targeting.json" }) },
  });
  const now = new Date();
  for (let i = 0; i < snap.length; i += 500) {
    await db.targetingItem.createMany({
      data: snap.slice(i, i + 500).map((s) => ({
        key: targetingKey(s.type, s.id),
        id: s.id,
        type: s.type,
        name: s.name,
        path: s.path,
        description: s.desc ?? null,
        vnLo: s.vnLo,
        vnHi: s.vnHi,
        source: "import",
        reachCheckedAt: s.vnHi != null ? now : null,
      })),
    });
  }
  await db.targetingRun.update({
    where: { id: run.id },
    data: { status: "done", finishedAt: new Date(), stats: JSON.stringify({ added: snap.length, note: (await getT())("targeting.store.seedNote") }) },
  });
  return true;
}
