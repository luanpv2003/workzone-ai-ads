import type { TargetingRun } from "@prisma/client";
import { db } from "./db";
import { getT } from "@/i18n/server";
import type { MessageKey, T } from "@/i18n/translate";
import { decrypt } from "./crypto";
import { metaFetch } from "./meta/rate-limit";
import { TYPED_ID_TYPES } from "./targeting";
import { DETAIL_TYPES, publishSnapshot, toInt, upsertItems, whereUsed, type FoundItem } from "./targeting-store";

// Run one update pass of the Targeting library (called from scripts/targeting-worker.ts).

const VERSION = process.env.META_API_VERSION || "v23.0";
const BASE = `https://graph.facebook.com/${VERSION}`;
const LOCALE = "vi_VN";

export type RunKind = "catalog" | "expand" | "reach" | "import" | "find";
/** Translated name of a run kind (shown in the run list and activity log). */
export const runLabel = (t: T, kind: string) => (kind in RUN_KINDS ? t(RUN_KINDS[kind]) : kind);
const RUN_KINDS: Record<string, MessageKey> = {
  catalog: "targeting.crawl.run.catalog",
  expand: "targeting.crawl.run.expand",
  reach: "targeting.crawl.run.reach",
  import: "targeting.crawl.run.import",
  find: "targeting.crawl.run.find",
};

class Cancelled extends Error {}

// ------------------------------------------------------------ Context for one run: progress, log, checkpoint, cancel

class RunCtx {
  progress: Record<string, unknown>;
  private lines: string[];
  private lastSave = 0;
  constructor(public run: TargetingRun) {
    this.progress = JSON.parse(run.progress || "{}");
    this.lines = run.log ? run.log.split("\n") : [];
  }
  get params() {
    return JSON.parse(this.run.params || "{}");
  }
  get checkpoint() {
    return this.run.checkpoint ? JSON.parse(this.run.checkpoint) : null;
  }
  log(msg: string) {
    const line = `${new Date().toISOString().slice(11, 19)} ${msg}`;
    console.log(`[${this.run.kind}] ${line}`);
    this.lines.push(line);
    if (this.lines.length > 200) this.lines = this.lines.slice(-200);
  }
  /** Save progress (at most once / 3 seconds unless forced) and check whether the user clicked cancel. */
  async save(opts: { checkpoint?: unknown; force?: boolean } = {}) {
    if (!opts.force && Date.now() - this.lastSave < 3000) return;
    this.lastSave = Date.now();
    const cur = await db.targetingRun.findUnique({ where: { id: this.run.id }, select: { status: true } });
    if (cur?.status === "cancelled") throw new Cancelled();
    await db.targetingRun.update({
      where: { id: this.run.id },
      data: {
        progress: JSON.stringify(this.progress),
        log: this.lines.join("\n"),
        ...(opts.checkpoint !== undefined && { checkpoint: opts.checkpoint === null ? null : JSON.stringify(opts.checkpoint) }),
      },
    });
  }
}

// ------------------------------------------------------------ Graph API calls with spacing + waiting when rate-limited

type Json = Record<string, unknown> & { data?: unknown[]; paging?: { next?: string }; error?: { code?: number; message?: string } };
const RATE_LIMIT = new Set([4, 17, 32, 613, 80004]);

class Scanner {
  calls = 0;
  constructor(
    private token: string,
    private ctx: RunCtx,
    private paceMs = 300,
  ) {}

  private async fetchJson(url: string, init?: RequestInit): Promise<Json> {
    for (let a = 0; a < 7; a++) {
      await new Promise((r) => setTimeout(r, this.paceMs));
      this.calls++;
      this.ctx.progress.calls = (Number(this.ctx.progress.calls) || 0) + 1;
      try {
        const res = await metaFetch(url, init);
        const json = (await res.json().catch(() => ({}))) as Json;
        const code = json.error?.code;
        if (code != null && RATE_LIMIT.has(code)) {
          const wait = 30 * (a + 1);
          this.ctx.log((await getT())("targeting.crawl.rateLimited", { code, wait }));
          await this.ctx.save({ force: true });
          await new Promise((r) => setTimeout(r, wait * 1000));
          continue;
        }
        if (code === 190) throw new Error((await getT())("targeting.crawl.tokenExpired", { detail: json.error?.message ?? "" }));
        if (res.status >= 500 && a < 6) {
          await new Promise((r) => setTimeout(r, 2000 * 1.5 ** a));
          continue;
        }
        return json;
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("Token")) throw err;
        if (a === 6) throw err;
        await new Promise((r) => setTimeout(r, 2000 * 1.5 ** a));
      }
    }
    return { data: [] };
  }

  get(pathname: string, params: Record<string, string | number>) {
    const qs = new URLSearchParams({ ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])), access_token: this.token });
    return this.fetchJson(`${BASE}${pathname}?${qs}`);
  }

  async paged(pathname: string, params: Record<string, string | number>, cap = 20000) {
    const out: Record<string, unknown>[] = [];
    let res = await this.get(pathname, { limit: 1000, ...params });
    while (true) {
      if (res.error) {
        this.ctx.log(`! ${pathname}: ${res.error.message}`);
        return out;
      }
      out.push(...((res.data ?? []) as Record<string, unknown>[]));
      const next = res.paging?.next;
      if (!next || out.length >= cap) return out;
      res = await this.fetchJson(next);
    }
  }

  batch(requests: { method: string; relative_url: string }[]) {
    const body = new URLSearchParams({ access_token: this.token, include_headers: "false", batch: JSON.stringify(requests) });
    return this.fetchJson(`${BASE}/`, { method: "POST", body }) as unknown as Promise<({ code: number; body: string } | null)[] | Json>;
  }
}

const pathOf = (p: unknown) => (Array.isArray(p) ? p.join(" > ") : typeof p === "string" ? p : "");

function toFound(r: Record<string, unknown>, fallbackType: string, source: string, industry?: string): FoundItem {
  return {
    id: String(r.id ?? ""),
    name: String(r.name ?? ""),
    type: String(r.type || fallbackType),
    path: pathOf(r.path),
    description: r.description ? String(r.description) : undefined,
    topic: String(r.topic || r.disambiguation_category || "") || undefined,
    globalLo: toInt(r.audience_size_lower_bound ?? r.audience_size),
    globalHi: toInt(r.audience_size_upper_bound),
    industry,
    source,
  };
}

// ------------------------------------------------------------ Account used for crawling

export async function scanAccount(clientId?: string | null) {
  // Prefer the agency's own API (Settings → Dedicated crawl API), so the client account's quota isn't used.
  if (!clientId) {
    const [act, token, owner] = await Promise.all(
      ["targeting.scanAct", "targeting.scanToken", "targeting.scanOwner"].map((key) => db.setting.findUnique({ where: { key } })),
    );
    if (act?.value && token?.value) {
      return { act: act.value, token: decrypt(token.value), client: { name: (await getT())("targeting.crawl.ownApi", { owner: owner?.value ? ` (${owner.value})` : "" }) } };
    }
  }
  const setting = clientId ?? (await db.setting.findUnique({ where: { key: "targeting.scanClientId" } }))?.value;
  const client = setting
    ? await db.client.findUnique({ where: { id: setting } })
    : // Fallback only to the root workspace's own clients:
      // another workspace's token must never be borrowed for the shared catalogue scans.
      await db.client.findFirst({
        where: { dataSource: "meta", metaAccessToken: { not: null }, metaAdAccountId: { not: null }, workspace: { platform: true } },
        orderBy: { createdAt: "asc" },
      });
  if (!client?.metaAccessToken || !client.metaAdAccountId) {
    throw new Error((await getT())("targeting.crawl.noAccount"));
  }
  const act = client.metaAdAccountId.startsWith("act_") ? client.metaAdAccountId : `act_${client.metaAdAccountId}`;
  return { client, act, token: decrypt(client.metaAccessToken) };
}

// ------------------------------------------------------------ 1. Crawl the full catalog

const CATEGORY_CLASSES = ["interests", "behaviors", "demographics", "life_events", "industries", "income", "family_statuses"];
const SEARCH_TYPES: Record<string, string> = {
  adworkposition: "work_positions",
  adworkemployer: "work_employers",
  adeducationschool: "education_schools",
  adeducationmajor: "education_majors",
};

async function runCatalog(ctx: RunCtx, s: Scanner, act: string) {
  const tr = await getT();
  const phases = ["browse", ...CATEGORY_CLASSES, ...Object.keys(SEARCH_TYPES)];
  const cp = ctx.checkpoint ?? { phase: 0, found: [] as FoundItem[] };
  ctx.progress.total = phases.length;
  for (let i = cp.phase; i < phases.length; i++) {
    const ph = phases[i];
    ctx.progress.phase = ph;
    ctx.progress.done = i;
    ctx.log(tr("targeting.crawl.step", { i: i + 1, n: phases.length, phase: ph }));
    let rows: FoundItem[] = [];
    if (ph === "browse") {
      rows = (await s.paged(`/${act}/targetingbrowse`, { locale: LOCALE })).map((r) => toFound(r, String(r.type ?? ""), "browse"));
    } else if (CATEGORY_CLASSES.includes(ph)) {
      rows = (await s.paged("/search", { type: "adTargetingCategory", class: ph, locale: LOCALE })).map((r) => toFound(r, ph, "category"));
    } else {
      for (const q of "abcdefghijklmnopqrstuvwxyz") {
        const res = await s.get("/search", { type: ph, q, limit: 1000, locale: LOCALE });
        rows.push(...((res.data ?? []) as Record<string, unknown>[]).map((r) => toFound(r, SEARCH_TYPES[ph], "search")));
      }
    }
    rows = rows.filter((r) => DETAIL_TYPES.has(r.type));
    ctx.log(tr("targeting.crawl.rows", { n: rows.length }));
    cp.found.push(...rows);
    cp.phase = i + 1;
    ctx.progress.found = cp.found.length;
    await ctx.save({ checkpoint: cp, force: true });
  }
  ctx.progress.done = phases.length;
  ctx.log(tr("targeting.crawl.writing"));
  return upsertItems(ctx.run.id, cp.found);
}

// ------------------------------------------------------------ 2. Expand by industry (seed keywords, then follow suggestions)

async function runExpand(ctx: RunCtx, s: Scanner) {
  const tr = await getT();
  const p = ctx.params as { seedSetIds?: string[]; rounds?: number; maxCalls?: number; minGlobal?: number };
  const rounds = Math.min(5, Math.max(1, p.rounds ?? 2));
  const maxCalls = Math.min(10000, Math.max(100, p.maxCalls ?? 3000));
  const minGlobal = p.minGlobal ?? 1000;
  const sets = await db.targetingSeedSet.findMany({ where: p.seedSetIds?.length ? { id: { in: p.seedSetIds } } : { active: true } });
  if (!sets.length) throw new Error(tr("targeting.crawl.noSeedSets"));

  type Cp = { round: number; seedDone: number; found: Record<string, FoundItem>; queue: { name: string; industry: string }[]; done: string[]; calls: number };
  const cp: Cp = ctx.checkpoint ?? { round: 0, seedDone: 0, found: {}, queue: [], done: [], calls: 0 };
  const done = new Set(cp.done);
  const add = (rows: Record<string, unknown>[], industry: string) => {
    for (const r of rows) {
      const f = toFound(r, "interests", "snowball", industry);
      if (!f.id || (f.globalHi != null && f.globalHi < minGlobal)) continue;
      if (!cp.found[f.id]) {
        cp.found[f.id] = f;
        cp.queue.push({ name: f.name, industry });
      }
    }
  };
  const seeds = sets.flatMap((st) => (JSON.parse(st.keywords) as string[]).map((k) => ({ q: k, industry: st.name })));
  ctx.progress.total = maxCalls;

  // Round 0: seed keywords
  if (cp.round === 0) {
    ctx.log(tr("targeting.crawl.seeding", { seeds: seeds.length, sets: sets.length }));
    for (let i = cp.seedDone; i < seeds.length; i++) {
      const res = await s.get("/search", { type: "adinterest", q: seeds[i].q, limit: 100, locale: LOCALE });
      add((res.data ?? []) as Record<string, unknown>[], seeds[i].industry);
      cp.seedDone = i + 1;
      cp.calls++;
      ctx.progress.found = Object.keys(cp.found).length;
      ctx.progress.done = cp.calls;
      if (i % 10 === 0) await ctx.save({ checkpoint: { ...cp, done: [...done] } });
    }
    cp.round = 1;
    ctx.log(tr("targeting.crawl.afterSeeding", { n: Object.keys(cp.found).length }));
  }

  // Rounds spreading via Meta's suggestions
  for (; cp.round <= rounds; cp.round++) {
    const wave = cp.queue.filter((n) => n.name && !done.has(n.name));
    cp.queue = [];
    if (!wave.length) break;
    ctx.log(tr("targeting.crawl.round", { round: cp.round, n: wave.length }));
    for (let i = 0; i < wave.length; i++) {
      if (cp.calls >= maxCalls) {
        ctx.log(tr("targeting.crawl.callCap", { max: maxCalls }));
        cp.queue.push(...wave.slice(i));
        cp.round = rounds + 1;
        break;
      }
      done.add(wave[i].name);
      const res = await s.get("/search", { type: "adinterestsuggestion", interest_list: JSON.stringify([wave[i].name]), limit: 45, locale: LOCALE });
      add((res.data ?? []) as Record<string, unknown>[], wave[i].industry);
      cp.calls++;
      ctx.progress.found = Object.keys(cp.found).length;
      ctx.progress.done = cp.calls;
      if (i % 20 === 0) await ctx.save({ checkpoint: { ...cp, done: [...done] } });
    }
  }
  ctx.progress.done = ctx.progress.total = cp.calls;
  ctx.log(tr("targeting.crawl.foundWriting", { n: Object.keys(cp.found).length }));
  return upsertItems(ctx.run.id, Object.values(cp.found));
}

// ------------------------------------------------------------ 3. VN audience size + detect dead IDs (delivery_estimate, 50 items / call)

const BATCH = 50;

function reachSpec(id: string, name: string, type: string) {
  const t: Record<string, unknown> = { geo_locations: { countries: ["VN"] }, age_min: 18, age_max: 65 };
  if (TYPED_ID_TYPES.has(type)) t[type] = [Number(id)];
  else t.flexible_spec = [{ [type]: [{ id, name }] }];
  return JSON.stringify(t);
}

async function reachTargets(scope: string) {
  const month = new Date(Date.now() - 30 * 86400000);
  if (scope === "new") return db.targetingItem.findMany({ where: { status: "active", reachCheckedAt: null } });
  if (scope === "all") return db.targetingItem.findMany({ orderBy: { key: "asc" } });
  // weekly: items in use (always checked) + up to 1,500 items unchecked the longest
  const active = await db.targetingItem.findMany({ where: { status: "active" }, select: { id: true } });
  const used = await whereUsed(active.map((a) => a.id));
  const stale = await db.targetingItem.findMany({
    where: { status: "active", OR: [{ reachCheckedAt: null }, { reachCheckedAt: { lt: month } }] },
    orderBy: { reachCheckedAt: { sort: "asc", nulls: "first" } },
    take: 1500,
  });
  const usedItems = used.size ? await db.targetingItem.findMany({ where: { id: { in: [...used.keys()] } } }) : [];
  return [...new Map([...usedItems, ...stale].map((i) => [i.key, i])).values()];
}

async function runReach(ctx: RunCtx, s: Scanner, act: string) {
  const tr = await getT();
  const scope = String(ctx.params.scope ?? "new");
  const cp: { doneKeys: string[] } = ctx.checkpoint ?? { doneKeys: [] };
  const doneKeys = new Set(cp.doneKeys);
  const items = (await reachTargets(scope)).filter((i) => !doneKeys.has(i.key));
  ctx.progress.total = items.length + doneKeys.size;
  ctx.progress.done = doneKeys.size;
  ctx.log(tr("targeting.crawl.checking", { n: items.length, scope }));
  const stats = { ok: 0, dead: 0, revived: 0, sizeChanged: 0, errors: 0 };
  const newlyDead: { key: string; id: string; name: string; type: string }[] = [];

  for (let start = 0; start < items.length; start += BATCH) {
    const chunk = items.slice(start, start + BATCH);
    const reqs = chunk.map((i) => ({
      method: "GET",
      relative_url: `${act}/delivery_estimate?optimization_goal=REACH&targeting_spec=${encodeURIComponent(reachSpec(i.id, i.name, i.type))}`,
    }));
    const res = await s.batch(reqs);
    if (!Array.isArray(res)) {
      stats.errors += chunk.length;
      ctx.log(tr("targeting.crawl.batchError", { batch: start / BATCH + 1, detail: (res as Json).error?.message ?? tr("targeting.crawl.unknown") }));
      continue;
    }
    let otherErrors = 0;
    const now = new Date();
    const ops = [];
    const changes = [];
    for (const [k, item] of chunk.entries()) {
      const r = res[k];
      let body: Json = {};
      try {
        body = r?.body ? JSON.parse(r.body) : {};
      } catch {}
      if (!r || r.code !== 200 || body.error) {
        const msg = body.error?.message ?? "";
        if (/invalid parameter/i.test(msg)) {
          if (item.status !== "dead") {
            stats.dead++;
            newlyDead.push(item);
            ops.push(db.targetingItem.update({ where: { key: item.key }, data: { status: "dead", deadAt: now, reachCheckedAt: now } }));
          } else ops.push(db.targetingItem.update({ where: { key: item.key }, data: { reachCheckedAt: now } }));
        } else {
          stats.errors++;
          otherErrors++;
        }
        continue;
      }
      const d = ((body.data as Record<string, unknown>[] | undefined) ?? [{}])[0] ?? {};
      const lo = toInt(d.estimate_mau_lower_bound);
      const hi = toInt(d.estimate_mau_upper_bound);
      stats.ok++;
      if (item.status === "dead") {
        stats.revived++;
        changes.push({ runId: ctx.run.id, itemKey: item.key, name: item.name, type: item.type, change: "revived", after: JSON.stringify({ vnHi: hi }) });
      } else if (item.vnHi && hi != null && Math.max(item.vnHi, hi) >= 5000 && Math.abs(hi - item.vnHi) / item.vnHi >= 0.3) {
        stats.sizeChanged++;
        changes.push({
          runId: ctx.run.id,
          itemKey: item.key,
          name: item.name,
          type: item.type,
          change: hi > item.vnHi ? "size_up" : "size_down",
          before: JSON.stringify({ vnLo: item.vnLo, vnHi: item.vnHi }),
          after: JSON.stringify({ vnLo: lo, vnHi: hi }),
        });
      }
      ops.push(db.targetingItem.update({ where: { key: item.key }, data: { vnLo: lo, vnHi: hi, reachCheckedAt: now, status: "active", deadAt: null } }));
    }
    // Whole batch failed with errors other than "Invalid parameter" → usually the token/account lacks permission: stop, don't mark anything wrong.
    if (otherErrors === chunk.length && start === 0) {
      let msg = "";
      try {
        msg = JSON.parse(res[0]?.body ?? "{}").error?.message ?? "";
      } catch {}
      throw new Error(tr("targeting.crawl.reachFailed", { msg: msg || tr("targeting.crawl.unknownError") }));
    }
    if (ops.length) await db.$transaction(ops);
    if (changes.length) await db.targetingChange.createMany({ data: changes });
    for (const i of chunk) doneKeys.add(i.key);
    ctx.progress.done = doneKeys.size;
    ctx.progress.found = stats.ok;
    await ctx.save({ checkpoint: scope === "all" ? { doneKeys: [...doneKeys] } : null });
  }

  // Item just died: record the change with where it's used, for warnings.
  if (newlyDead.length) {
    const used = await whereUsed(newlyDead.map((d) => d.id));
    await db.targetingChange.createMany({
      data: newlyDead.map((d) => ({ runId: ctx.run.id, itemKey: d.key, name: d.name, type: d.type, change: "dead", usedIn: used.get(d.id) ? JSON.stringify(used.get(d.id)) : null })),
    });
    if (used.size) ctx.log(tr("targeting.crawl.retiredInUse", { n: used.size }));
  }
  ctx.log(tr("targeting.crawl.reachDone", stats));
  return stats;
}

// ------------------------------------------------------------ 3b. Whether pasting the name into Ads Manager's search box finds the right item

/**
 * Spellings to try, in order of most likely found (tested on real samples): Vietnamese name without the trailing "(note)",
 * full Vietnamese name, then the original (English) name without / with the note. Ads Manager doesn't search by the note.
 */
function findQueries(nameVi: string | null, name: string) {
  const bare = (n: string) => n.replace(/\s*\([^)]*\)\s*$/, "").trim();
  const out: string[] = [];
  for (const q of [nameVi && bare(nameVi), nameVi, bare(name), name]) if (q && q.length >= 2 && !out.includes(q)) out.push(q);
  return out;
}

/** Items to check first: used in ad sets / drafts, in the ranking table, or scored by Claude. */
async function priorityKeys() {
  const [rankings, analyses] = await Promise.all([
    db.targetingRanking.findMany({ orderBy: { createdAt: "desc" }, take: 30, select: { items: true } }),
    db.audienceAnalysis.findMany({ orderBy: { createdAt: "desc" }, take: 30, select: { candidates: true } }),
  ]);
  const keys = new Set<string>();
  for (const r of rankings) for (const i of JSON.parse(r.items) as { key: string }[]) keys.add(i.key);
  for (const a of analyses) for (const i of JSON.parse(a.candidates) as { id: string; type: string }[]) keys.add(TYPED_ID_TYPES.has(i.type) ? `${i.type}:${i.id}` : i.id);
  const active = await db.targetingItem.findMany({ where: { status: "active" }, select: { id: true, key: true } });
  const used = await whereUsed(active.map((a) => a.id));
  for (const a of active) if (used.has(a.id)) keys.add(a.key);
  return keys;
}

async function runFind(ctx: RunCtx, s: Scanner, act: string) {
  const tr = await getT();
  const p = ctx.params as { scope?: string; maxCalls?: number };
  const scope = ["all", "unchecked", "priority"].includes(String(p.scope)) ? String(p.scope) : "unchecked";
  const maxCalls = Math.min(20000, Math.max(200, Number(p.maxCalls) || 8000));
  type Cp = { keys: string[]; done: number };
  let cp: Cp | null = ctx.checkpoint;
  if (!cp) {
    const pri = await priorityKeys();
    const month = new Date(Date.now() - 30 * 86400000);
    const rows = await db.targetingItem.findMany({
      where:
        scope === "all"
          ? { status: "active" }
          : scope === "priority"
            ? { status: "active", key: { in: [...pri] }, OR: [{ findCheckedAt: null }, { findCheckedAt: { lt: new Date(Date.now() - 7 * 86400000) } }] }
            : { status: "active", OR: [{ findCheckedAt: null }, { findCheckedAt: { lt: month } }] },
      select: { key: true, vnHi: true },
    });
    rows.sort((a, b) => Number(pri.has(b.key)) - Number(pri.has(a.key)) || (b.vnHi ?? -1) - (a.vnHi ?? -1));
    cp = { keys: rows.map((r) => r.key), done: 0 };
  }
  ctx.progress.total = cp.keys.length;
  ctx.progress.done = cp.done;
  ctx.log(tr("targeting.crawl.findChecking", { n: cp.keys.length - cp.done, scope }));
  const stats = { found: 0, notFound: 0, dead: 0, wrongType: 0, errors: 0 };
  const startCalls = s.calls;

  for (let i = cp.done; i < cp.keys.length; i += 50) {
    if (s.calls - startCalls >= maxCalls) {
      ctx.log(tr("targeting.crawl.findCap", { max: maxCalls }));
      break;
    }
    const chunk = await db.targetingItem.findMany({ where: { key: { in: cp.keys.slice(i, i + 50) } } });
    // Vietnamese name + still valid (interests): 1 call for the whole batch.
    const ints = chunk.filter((c) => c.type === "interests" && /^\d{6,}$/.test(c.id));
    const valid = new Map<string, { name: string; valid: boolean }>();
    if (ints.length) {
      const res = await s.get("/search", { type: "adinterestvalid", interest_fbid_list: JSON.stringify(ints.map((c) => c.id)), locale: LOCALE });
      for (const x of (res.data ?? []) as Record<string, unknown>[]) valid.set(String(x.id), { name: String(x.name ?? ""), valid: !!x.valid });
    }
    const now = new Date();
    for (const it of chunk) {
      const v = valid.get(it.id);
      const nameVi = v?.valid && v.name ? v.name : (it.nameVi ?? null);
      // VN size = 0 → Meta doesn't deliver in VN: no need to search.
      let hit: { q: string; rank: number; row: Record<string, unknown> } | null = null;
      let failed = false;
      if (it.vnHi !== 0) {
        for (const q of findQueries(nameVi, it.name)) {
          const res = await s.get(`/${act}/targetingsearch`, { q, locale: LOCALE });
          if (res.error) {
            failed = true;
            stats.errors++;
            ctx.log(`! "${q}": ${res.error.message}`);
            break;
          }
          const rows = (res.data ?? []) as Record<string, unknown>[];
          const k = rows.findIndex((r) => String(r.id) === it.id);
          if (k >= 0) {
            hit = { q, rank: k + 1, row: rows[k] };
            break;
          }
        }
      }
      if (failed) continue;
      const rowType = hit ? String(hit.row.type ?? "") : "";
      if (hit && rowType && rowType !== it.type) {
        // Stored with the wrong type (e.g. education level stored as interest): drop the wrong item, add the correct type.
        stats.wrongType++;
        const key = TYPED_ID_TYPES.has(rowType) ? `${rowType}:${it.id}` : it.id;
        await db.targetingItem.update({ where: { key: it.key }, data: { status: "dead", deadAt: now, findable: false, findCheckedAt: now } });
        await db.targetingItem.upsert({
          where: { key },
          create: { key, id: it.id, type: rowType, name: String(hit.row.name ?? it.name), nameVi: String(hit.row.name ?? it.name), path: pathOf(hit.row.path), source: "search", vnHi: it.vnHi, vnLo: it.vnLo, copyText: hit.q, findable: true, findRank: hit.rank, findCheckedAt: now },
          update: { status: "active", deadAt: null, nameVi: String(hit.row.name ?? it.name), copyText: hit.q, findable: true, findRank: hit.rank, findCheckedAt: now },
        });
        await db.targetingChange.create({ data: { runId: ctx.run.id, itemKey: it.key, name: it.name, type: it.type, change: "renamed", after: JSON.stringify({ note: tr("targeting.crawl.wrongType", { type: rowType }), key }) } });
        continue;
      }
      // Dead: Meta reports the interest ID is no longer valid. Size 0 and not found: only hide it (don't conclude it's dead).
      const dead = !hit && !!v && !v.valid;
      if (hit) stats.found++;
      else if (dead) stats.dead++;
      else stats.notFound++;
      await db.targetingItem.update({
        where: { key: it.key },
        data: {
          nameVi: hit ? String(hit.row.name ?? nameVi ?? it.name) : nameVi,
          copyText: hit?.q ?? null,
          findable: !!hit,
          findRank: hit?.rank ?? null,
          findCheckedAt: now,
          ...(dead && { status: "dead", deadAt: now }),
        },
      });
      if (dead) await db.targetingChange.create({ data: { runId: ctx.run.id, itemKey: it.key, name: it.name, type: it.type, change: "dead" } });
    }
    cp.done = Math.min(cp.keys.length, i + 50);
    ctx.progress.done = cp.done;
    ctx.progress.found = stats.found;
    ctx.progress.phase = tr("targeting.crawl.findPhase", stats);
    await ctx.save({ checkpoint: cp, force: true });
  }
  ctx.log(tr("targeting.crawl.findDone", stats));
  return stats;
}

// ------------------------------------------------------------ Orchestration

export async function processRun(run: TargetingRun) {
  const tr = await getT();
  const ctx = new RunCtx(run);
  await db.targetingRun.update({ where: { id: run.id }, data: { status: "running", startedAt: run.startedAt ?? new Date(), error: null } });
  ctx.log(run.checkpoint ? tr("targeting.crawl.resuming") : tr("targeting.crawl.starting", { label: runLabel(tr, run.kind) }));
  try {
    const { act, token, client } = await scanAccount(run.clientId);
    ctx.log(tr("targeting.crawl.scanWith", { name: client.name, act }));
    const s = new Scanner(token, ctx);
    const stats: Record<string, unknown> =
      run.kind === "catalog" ? await runCatalog(ctx, s, act) : run.kind === "expand" ? await runExpand(ctx, s) : run.kind === "find" ? await runFind(ctx, s, act) : await runReach(ctx, s, act);
    stats.calls = s.calls;
    const published = await publishSnapshot();
    ctx.log(tr("targeting.crawl.published", { n: published }));
    await db.targetingRun.update({
      where: { id: run.id },
      data: { status: "done", finishedAt: new Date(), stats: JSON.stringify({ ...stats, published }), progress: JSON.stringify(ctx.progress), log: undefined, checkpoint: null },
    });
    await ctx.save({ force: true }).catch(() => {});
    // Newly found items without a VN size → auto-queue a check pass.
    if ((run.kind === "catalog" || run.kind === "expand") && (await db.targetingItem.count({ where: { status: "active", reachCheckedAt: null } }))) {
      await enqueueRun("reach", { scope: "new" }, tr("targeting.crawl.autoAfterScan"), run.clientId);
    }
    // Items not yet checked for "found in Ads Manager" → queue a check (after the size pass).
    if (run.kind !== "find" && (await db.targetingItem.count({ where: { status: "active", findCheckedAt: null } }))) {
      await enqueueRun("find", { scope: "unchecked" }, tr("targeting.crawl.autoAfterScan"), run.clientId);
    }
    return stats;
  } catch (err) {
    if (err instanceof Cancelled) {
      ctx.log(tr("targeting.crawl.cancelled"));
      await db.targetingRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), checkpoint: null } });
      return null;
    }
    const msg = err instanceof Error ? err.message : String(err);
    ctx.log(tr("targeting.crawl.errorLine", { msg }));
    await ctx.save({ force: true }).catch(() => {});
    await db.targetingRun.update({ where: { id: run.id }, data: { status: "failed", error: msg, finishedAt: new Date() } });
    throw err;
  }
}

/** Queue an update pass. No duplicates if a pass of the same type is already queued / running. */
export async function enqueueRun(kind: RunKind, params: Record<string, unknown>, triggeredBy: string | null, clientId?: string | null) {
  const pending = await db.targetingRun.findFirst({ where: { kind, status: { in: ["queued", "running"] } } });
  if (pending) return pending;
  return db.targetingRun.create({ data: { kind, params: JSON.stringify(params), triggeredBy, clientId: clientId ?? null } });
}

/** Automatic schedule (when enabled): crawl the catalog every 30 days, check sizes / dead IDs every 7 days. */
export async function enqueueScheduled() {
  const tr = await getT();
  const auto = await db.setting.findUnique({ where: { key: "targeting.autoUpdate" } });
  if (auto?.value !== "on") return [];
  // The automatic schedule only queues between 0h–6h VN time: heavy crawls run when nobody uses the web, not competing for API call limits with daytime work.
  const hourVN = (new Date().getUTCHours() + 7) % 24;
  if (hourVN >= 6) return [];
  const since = (days: number) => new Date(Date.now() - days * 86400000);
  const out = [];
  const lastCatalog = await db.targetingRun.findFirst({ where: { kind: "catalog", status: "done", finishedAt: { gt: since(30) } } });
  if (!lastCatalog) out.push(await enqueueRun("catalog", {}, tr("targeting.crawl.schedule")));
  const lastReach = await db.targetingRun.findFirst({ where: { kind: "reach", status: "done", finishedAt: { gt: since(7) }, params: { contains: "weekly" } } });
  if (!lastReach) out.push(await enqueueRun("reach", { scope: "weekly" }, tr("targeting.crawl.schedule")));
  const lastFind = await db.targetingRun.findFirst({ where: { kind: "find", status: "done", finishedAt: { gt: since(7) } } });
  if (!lastFind) out.push(await enqueueRun("find", { scope: "priority" }, tr("targeting.crawl.schedule")));
  return out;
}
