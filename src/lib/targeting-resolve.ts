import { db } from "./db";
import { getT } from "@/i18n/server";
import { metaFetch } from "./meta/rate-limit";
import { catalog, lookupTargeting, norm, searchTargeting, targetingKey, type TargetingItem } from "./targeting";
import { DETAIL_TYPES, publishSnapshot } from "./targeting-store";
import { scanAccount } from "./targeting-crawl";
import { checkPlanTargeting, checkTargeting, repairLibrary, type Auth } from "./targeting-validate";

// Claude leads: Claude proposes targeting by NAME (free-form, not limited to a pre-filtered list),
// the system keeps just one hard rule — the item must really exist on Meta and be findable by pasting into Ads Manager's search box:
// 1. Look in the Targeting library (already checked as findable in Ads Manager).
// 2. Not there → search directly via Ads Manager's search (targetingsearch, Vietnamese). Found → add to the library (source "claude").
// 3. Not found → report back, never invent an ID.
// 4. Every returned item goes through targetingvalidation (by type + ID): wrong type gets fixed, items Meta disallows are dropped (targeting-validate.ts).

type Idea = { name: string; type?: string | null };
type Resolved = { item: TargetingItem; source: "library" | "meta"; exact: boolean } | null;

const clean = (s: string) => norm(s.replace(/\s*\([^)]*\)\s*$/, "")).trim();

/** Name match level: 3 = exact, 2 = starts with, 1 = contains, 0 = different. */
function nameMatch(candidate: { name: string; en?: string }, q: string) {
  const want = clean(q);
  let best = 0;
  for (const n of [candidate.name, candidate.en].filter((x): x is string => !!x)) {
    const c = clean(n);
    best = Math.max(best, c === want ? 3 : c.startsWith(want) || want.startsWith(c) ? 2 : c.includes(want) || want.includes(c) ? 1 : 0);
  }
  return best;
}

function fromLibrary(idea: Idea): Resolved {
  const list = searchTargeting(idea.name, 15);
  const scored = list
    .map((i) => ({ i, m: nameMatch(i, idea.name) + (idea.type && i.type === idea.type ? 0.5 : 0) }))
    .filter((x) => x.m >= 2)
    .sort((a, b) => b.m - a.m || (b.i.vnHi ?? 0) - (a.i.vnHi ?? 0));
  const hit = scored[0];
  return hit ? { item: hit.i, source: "library", exact: hit.m >= 3 } : null;
}

type MetaRow = { id: string; name: string; type: string; path?: string[]; audience_size_lower_bound?: number; audience_size_upper_bound?: number; description?: string };

let scanCtx: Promise<Auth> | null = null;

/** The Targeting library's crawl account (used to search and check items). */
async function scanAuth(): Promise<Auth | null> {
  scanCtx ??= scanAccount().then((s) => ({ act: s.act, token: s.token }));
  try {
    return await scanCtx;
  } catch {
    scanCtx = null;
    return null;
  }
}

async function fromMeta(idea: Idea): Promise<{ resolved: Resolved; row?: MetaRow; rank?: number; vi?: boolean }> {
  const s = await scanAuth();
  if (!s) return { resolved: null };
  // Search like Ads Manager's Vietnamese search box; if no match, try English (Claude often writes the original English name).
  const search = async (locale: string) => {
    const qs = new URLSearchParams({ q: idea.name, locale, access_token: s.token });
    const res = await metaFetch(`https://graph.facebook.com/v23.0/${s.act}/targetingsearch?${qs}`).catch(() => null);
    const json = res ? ((await res.json().catch(() => ({}))) as { data?: MetaRow[] }) : {};
    return (json.data ?? [])
      .filter((r) => DETAIL_TYPES.has(r.type))
      .map((r, k) => ({ r, k, m: nameMatch({ name: r.name }, idea.name) + (idea.type && r.type === idea.type ? 0.5 : 0) }))
      .filter((x) => x.m >= 1)
      .sort((a, b) => b.m - a.m || a.k - b.k);
  };
  let scored = await search("vi_VN");
  let vi = true;
  if (!scored.length) [scored, vi] = [await search("en_US"), false];
  const hit = scored[0];
  if (!hit) return { resolved: null };
  const r = hit.r;
  const item: TargetingItem = { id: String(r.id), name: r.name, type: r.type, path: (r.path ?? []).join(" > "), vnLo: null, vnHi: null, copy: idea.name, ok: true };
  return { resolved: { item, source: "meta", exact: hit.m >= 3 }, row: r, rank: hit.k + 1, vi };
}

/**
 * Match a list of ideas. Items newly found on Meta are added to the library (VN size checked later, per the crawl schedule)
 * and the catalog is republished so drafts can use them immediately.
 */
export async function resolveIdeas(ideas: Idea[]): Promise<Resolved[]> {
  const out: Resolved[] = [];
  const added: { row: MetaRow; rank: number; q: string; vi: boolean }[] = [];
  for (const idea of ideas) {
    if (!idea.name?.trim()) {
      out.push(null);
      continue;
    }
    const lib = fromLibrary(idea);
    if (lib?.exact) {
      out.push(lib);
      continue;
    }
    const m = await fromMeta(idea);
    if (m.resolved) {
      // Already in the library (possibly hidden because not yet checked as findable): use the library version if still visible.
      const known = lookupTargeting(m.resolved.item.id, m.resolved.item.type);
      if (known) out.push({ item: known, source: "library", exact: m.resolved.exact });
      else {
        out.push(m.resolved);
        added.push({ row: m.row!, rank: m.rank!, q: idea.name, vi: !!m.vi });
      }
      continue;
    }
    out.push(lib); // approximate name in the library, or null
  }
  // Check the item is usable in ads before returning / adding it to the library.
  const auth = await scanAuth();
  const found = out.flatMap((r) => (r ? [r.item] : []));
  const verdicts = auth && found.length ? await checkTargeting(auth, found).catch(() => null) : null;
  if (verdicts) {
    for (const [k, r] of out.entries()) {
      const v = r && verdicts.get(targetingKey(r.item.type, r.item.id));
      if (!r || !v || v.kind === "ok") continue;
      const row = added.find((a) => String(a.row.id) === r.item.id && a.row.type === r.item.type);
      if (v.kind === "invalid") {
        out[k] = null;
        if (row) added.splice(added.indexOf(row), 1);
      } else {
        out[k] = { ...r, item: { ...r.item, type: v.type, ...(v.path && { path: v.path }) } };
        if (row) row.row.type = v.type;
      }
    }
    await repairLibrary(found, verdicts).catch(() => 0);
  }
  if (added.length) await addToLibrary(added, "claude");
  return out;
}

/** Add items found via Ads Manager search to the library (found, so marked copyable) then republish the catalog. */
async function addToLibrary(added: { row: MetaRow; rank: number; q: string; vi: boolean }[], source: string) {
  const now = new Date();
  for (const a of added) {
    const type = a.row.type;
    const key = targetingKey(type, String(a.row.id));
    const e = await db.targetingItem.findUnique({ where: { key }, select: { status: true, findable: true } });
    // Already present and copyable: keep the verified copy text (usually the right name, clearer than what was just typed).
    if (e?.status === "active" && e.findable) continue;
    await db.targetingItem.upsert({
      where: { key },
      create: {
        key,
        id: String(a.row.id),
        type,
        name: a.row.name,
        nameVi: a.vi ? a.row.name : null, // found by English name: the later findability check will fill in the Vietnamese name
        path: (a.row.path ?? []).join(" > "),
        ...(a.row.description && { description: a.row.description }),
        globalLo: a.row.audience_size_lower_bound ?? null,
        globalHi: a.row.audience_size_upper_bound ?? null,
        source,
        copyText: a.q,
        findable: true,
        findRank: a.rank,
        findCheckedAt: now,
        lastSeenAt: now,
      },
      update: { status: "active", deadAt: null, ...(a.vi && { nameVi: a.row.name }), copyText: a.q, findable: true, findRank: a.rank, findCheckedAt: now, lastSeenAt: now },
    });
  }
  await publishSnapshot();
  catalog(); // reload right away in this process
}

export type LiveHit = { key: string; id: string; name: string; type: string; path: string; copy: string; rank: number; globalHi: number | null; isNew: boolean };

/**
 * User searches Meta directly from the Library page (when the library lacks the needed item): typed like Ads Manager's Vietnamese search box,
 * falling back to English. Items Meta allows in ads are added to the library; invalid items are dropped.
 */
export async function searchMetaLive(q: string): Promise<LiveHit[]> {
  const s = await scanAuth();
  const t = await getT();
  if (!s) throw new Error(t("targeting.resolve.noAccount"));
  const search = async (locale: string) => {
    const qs = new URLSearchParams({ q, locale, access_token: s.token });
    const res = await metaFetch(`https://graph.facebook.com/v23.0/${s.act}/targetingsearch?${qs}`);
    const json = (await res.json().catch(() => ({}))) as { data?: MetaRow[]; error?: { message?: string } };
    if (json.error) throw new Error(t("targeting.resolve.metaError", { detail: json.error.message ?? t("targeting.resolve.unknown") }));
    return (json.data ?? []).filter((r) => DETAIL_TYPES.has(r.type)).slice(0, 15);
  };
  let rows = await search("vi_VN");
  let vi = true;
  if (!rows.length) [rows, vi] = [await search("en_US"), false];
  if (!rows.length) return [];
  const verdicts = await checkTargeting(s, rows.map((r) => ({ id: String(r.id), type: r.type, name: r.name }))).catch(() => null);
  const ok: { row: MetaRow; rank: number; q: string; vi: boolean }[] = [];
  for (const [k, r] of rows.entries()) {
    const v = verdicts?.get(targetingKey(r.type, String(r.id)));
    if (v?.kind === "invalid") continue;
    if (v?.kind === "retype") r.type = v.type;
    // Copy text = what was just typed (confirmed to find this item, at position rank in the results).
    ok.push({ row: r, rank: k + 1, q, vi });
  }
  const known = new Set(ok.filter((a) => lookupTargeting(String(a.row.id), a.row.type)).map((a) => targetingKey(a.row.type, String(a.row.id))));
  if (ok.length) await addToLibrary(ok, "manual");
  return ok.map((a) => {
    const key = targetingKey(a.row.type, String(a.row.id));
    return { key, id: String(a.row.id), name: a.row.name, type: a.row.type, path: (a.row.path ?? []).join(" > "), copy: a.q, rank: a.rank, globalHi: a.row.audience_size_upper_bound ?? null, isNew: !known.has(key) };
  });
}

/** Detailed targeting Claude wrote in the plan: items not in the catalog (free-form ideas) → matched on Meta. */
async function resolvePlanItems<T extends { id: string; name: string; type: string }>(items: T[]): Promise<{ items: T[]; notes: string[] }> {
  const tr = await getT();
  const notes: string[] = [];
  const out: T[] = [];
  const pending: { i: number; t: T }[] = [];
  for (const [i, t] of items.entries()) {
    const real = t.id ? lookupTargeting(t.id, t.type) : undefined;
    if (real && (nameMatch(real, t.name) >= 1 || !t.name)) out[i] = { ...t, id: real.id, name: real.name, type: real.type };
    else pending.push({ i, t });
  }
  if (pending.length) {
    const res = await resolveIdeas(pending.map((p) => ({ name: p.t.name, type: p.t.type })));
    for (const [k, p] of pending.entries()) {
      const r = res[k];
      if (!r) {
        notes.push(tr("targeting.resolve.notFound", { name: p.t.name }));
        continue;
      }
      if (!r.exact) notes.push(tr("targeting.resolve.closest", { name: p.t.name, found: r.item.name }));
      else if (r.source === "meta") notes.push(tr("targeting.resolve.added", { name: r.item.name }));
      out[p.i] = { ...p.t, id: r.item.id, name: r.item.name, type: r.item.type };
    }
  }
  // Drop blanks and duplicates.
  const seen = new Set<string>();
  return {
    items: out.filter((x): x is T => !!x && !seen.has(targetingKey(x.type, x.id)) && !!seen.add(targetingKey(x.type, x.id))),
    notes,
  };
}

type Item = { id: string; name: string; type: string };
/** Match every ad set of the plan Claude just composed (before normalization: normalization drops items not in the catalog). */
export async function resolvePlanTargeting<P extends { ad_sets: { name: string; detailed_targeting: Item[]; narrow_targeting?: Item[] }[] }>(plan: P): Promise<{ plan: P; notes: string[] }> {
  const notes: string[] = [];
  const ad_sets = [];
  for (const s of plan.ad_sets) {
    const d = await resolvePlanItems(s.detailed_targeting);
    notes.push(...d.notes);
    const n = s.narrow_targeting ? await resolvePlanItems(s.narrow_targeting) : null;
    if (n) notes.push(...n.notes);
    ad_sets.push({ ...s, detailed_targeting: d.items, ...(n && { narrow_targeting: n.items }) });
  }
  // Items taken directly from the library (not via resolveIdeas) must be checked too: the library may have stored the wrong type.
  let out = { ...plan, ad_sets };
  const auth = await scanAuth();
  if (auth) {
    const checked = await checkPlanTargeting(out, auth, { drop: true }).catch(() => null);
    if (checked) {
      out = checked.plan;
      notes.push(...checked.notes);
    }
  }
  return { plan: out, notes: [...new Set(notes)] };
}
