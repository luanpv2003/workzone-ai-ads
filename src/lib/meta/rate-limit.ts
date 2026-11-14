import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { db } from "../db";

// Shared gate for every Graph API call: reads the usage Meta reports in headers and slows down before getting blocked.
// Headers Meta returns (percent used of the 1-hour window, 100 = blocked):
//   x-app-usage / x-page-usage            {"call_count":28,"total_time":25,"total_cputime":25}
//   x-ad-account-usage                    {"acc_id_util_pct":9.6,"reset_time_duration":0,"ads_api_access_tier":"development_access"}
//   x-business-use-case-usage             {"<id>":[{"type":"ads_management","call_count":95,...,"estimated_time_to_regain_access":0}]}
// One gate per token (web and worker are 2 processes: state shared via the Setting table, re-read every 30 seconds).

const SETTING_KEY = "meta.apiUsage";
const SLOW_PCT = 75; // from this level background jobs slow down
const STOP_PCT = 90; // from this level background jobs pause until Meta recovers
const LIMIT_CODES = new Set([4, 17, 32, 613]);

export type UsageEntry = {
  id: string; // app | page:<id> | account:<act> | buc:<id>:<type>
  kind: "app" | "page" | "account" | "buc";
  objectId: string | null;
  type: string | null; // BUC limit type (ads_management, ads_insights, pages, messenger...)
  pct: number;
  tier: string | null; // development_access | standard_access
  regainAt: number | null; // ms: when Meta says access recovers (currently blocked)
  at: number;
  gate: string; // which token this limit applies to
};
export type UsageSnapshot = { updatedAt: number; entries: UsageEntry[] };

/** Background jobs (worker): wait when near the limit. User-triggered web actions: don't make them wait long. */
const background = new AsyncLocalStorage<boolean>();
export const runInBackground = <T>(fn: () => Promise<T>) => background.run(true, fn);
const isBackground = () => background.getStore() === true;

type Gate = { entries: Map<string, UsageEntry>; last: number; running: number; waiters: (() => void)[] };
const gates = new Map<string, Gate>();
let shared: { at: number; snap: UsageSnapshot | null } = { at: 0, snap: null };
let lastPersist = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const gateId = (token: string) => createHash("sha256").update(token).digest("hex").slice(0, 12);

function tokenOf(url: string, init?: RequestInit) {
  const fromUrl = new URL(url).searchParams.get("access_token");
  if (fromUrl) return fromUrl;
  const body = init?.body;
  if (body instanceof URLSearchParams) return body.get("access_token") ?? "";
  if (typeof body === "string") return new URLSearchParams(body).get("access_token") ?? "";
  return "";
}

function gateFor(id: string) {
  let g = gates.get(id);
  if (!g) gates.set(id, (g = { entries: new Map(), last: 0, running: 0, waiters: [] }));
  return g;
}

async function sharedEntries(id: string) {
  if (Date.now() - shared.at > 30_000) {
    shared = { at: Date.now(), snap: null };
    const row = await db.setting.findUnique({ where: { key: SETTING_KEY } }).catch(() => null);
    try {
      shared.snap = row ? (JSON.parse(row.value) as UsageSnapshot) : null;
    } catch {
      shared.snap = null;
    }
  }
  return (shared.snap?.entries ?? []).filter((e) => e.gate === id);
}

/** Worst level for a token: highest % in the past hour + the latest recovery time (if currently blocked). */
async function worst(id: string) {
  const g = gateFor(id);
  const fresh = (e: UsageEntry) => Date.now() - e.at < 3600_000;
  const all = [...g.entries.values(), ...(await sharedEntries(id))].filter(fresh);
  // Once the recovery time has passed, the old % from the block is no longer valid.
  const pct = (e: UsageEntry) => (e.regainAt && e.regainAt < Date.now() ? 0 : e.pct);
  return { pct: Math.max(0, ...all.map(pct)), regainAt: Math.max(0, ...all.map((e) => e.regainAt ?? 0)) };
}

async function acquire(id: string) {
  const g = gateFor(id);
  const bg = isBackground();
  // Background jobs run 2 calls in parallel per token, web up to 4 (fetchAccount fires 7 calls at once).
  const max = bg ? 2 : 4;
  while (g.running >= max) await new Promise<void>((r) => g.waiters.push(r));
  g.running++;
  try {
    for (;;) {
      const w = await worst(id);
      const now = Date.now();
      if (w.regainAt > now) {
        // While blocked: background jobs wait (in steps of at most 5 minutes so cancellation can still be checked); web only waits briefly then lets Meta return the error.
        if (bg) {
          await sleep(Math.min(w.regainAt - now, 300_000));
          continue;
        }
        await sleep(Math.min(w.regainAt - now, 5_000));
        break;
      }
      const gap = bg ? (w.pct >= STOP_PCT ? 60_000 : w.pct >= SLOW_PCT ? 5_000 : w.pct >= 50 ? 1_000 : 200) : w.pct >= STOP_PCT ? 2_000 : w.pct >= SLOW_PCT ? 500 : 0;
      const wait = g.last + gap - now;
      if (wait > 0) await sleep(wait);
      break;
    }
    g.last = Date.now();
  } catch (err) {
    release(id);
    throw err;
  }
}

function release(id: string) {
  const g = gateFor(id);
  g.running--;
  g.waiters.shift()?.();
}

function parse(v: string | null) {
  if (!v) return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

const pctOf = (u: Record<string, unknown>) => Math.max(0, ...["call_count", "total_time", "total_cputime", "acc_id_util_pct"].map((k) => Number(u[k]) || 0));

function readHeaders(res: Response, gate: string, url: string): UsageEntry[] {
  const at = Date.now();
  const out: UsageEntry[] = [];
  const app = parse(res.headers.get("x-app-usage"));
  if (app) out.push({ id: "app", kind: "app", objectId: null, type: null, pct: pctOf(app), tier: null, regainAt: null, at, gate });
  const page = parse(res.headers.get("x-page-usage"));
  if (page) {
    const pageId = new URL(url).pathname.split("/")[2] ?? null;
    out.push({ id: `page:${pageId}`, kind: "page", objectId: pageId, type: null, pct: pctOf(page), tier: null, regainAt: Number(page.estimated_time_to_regain_access) > 0 ? at + Number(page.estimated_time_to_regain_access) * 60_000 : null, at, gate });
  }
  const acc = parse(res.headers.get("x-ad-account-usage"));
  if (acc) {
    const act = new URL(url).pathname.match(/act_\d+/)?.[0] ?? null;
    const reset = Number(acc.reset_time_duration) || 0;
    out.push({ id: `account:${act}`, kind: "account", objectId: act, type: null, pct: pctOf(acc), tier: acc.ads_api_access_tier ?? null, regainAt: reset > 0 && pctOf(acc) >= 100 ? at + reset * 1000 : null, at, gate });
  }
  const buc = parse(res.headers.get("x-business-use-case-usage"));
  if (buc && typeof buc === "object") {
    for (const [objectId, list] of Object.entries(buc as Record<string, Record<string, unknown>[]>)) {
      for (const u of Array.isArray(list) ? list : []) {
        const regain = Number(u.estimated_time_to_regain_access) || 0;
        out.push({
          id: `buc:${objectId}:${u.type}`,
          kind: "buc",
          objectId,
          type: String(u.type ?? ""),
          pct: pctOf(u),
          tier: (u.ads_api_access_tier as string) ?? null,
          regainAt: regain > 0 ? at + regain * 60_000 : null,
          at,
          gate,
        });
      }
    }
  }
  return out;
}

/** Persist state so the Meta Token page (System settings) can display it and the other process can read it (at most once / 20 seconds, unless blocked). */
async function persist(force: boolean) {
  if (!force && Date.now() - lastPersist < 20_000) return;
  lastPersist = Date.now();
  const row = await db.setting.findUnique({ where: { key: SETTING_KEY } }).catch(() => null);
  const merged = new Map<string, UsageEntry>();
  for (const e of (parse(row?.value ?? null) as UsageSnapshot | null)?.entries ?? []) merged.set(`${e.gate}|${e.id}`, e);
  for (const g of gates.values()) for (const e of g.entries.values()) {
    const k = `${e.gate}|${e.id}`;
    if (!merged.has(k) || merged.get(k)!.at < e.at) merged.set(k, e);
  }
  const entries = [...merged.values()].filter((e) => Date.now() - e.at < 6 * 3600_000);
  const value = JSON.stringify({ updatedAt: Date.now(), entries } satisfies UsageSnapshot);
  await db.setting.upsert({ where: { key: SETTING_KEY }, create: { key: SETTING_KEY, value }, update: { value } }).catch(() => {});
  shared = { at: Date.now(), snap: { updatedAt: Date.now(), entries } };
}

/** Replacement for fetch() when calling graph.facebook.com. Returns a Response like fetch; the caller reads the body. */
export async function metaFetch(url: string, init?: RequestInit): Promise<Response> {
  const gate = gateId(tokenOf(url, init));
  await acquire(gate);
  let res: Response;
  try {
    res = await fetch(url, init);
  } finally {
    release(gate);
  }
  const g = gateFor(gate);
  const found = readHeaders(res, gate, url);
  for (const e of found) g.entries.set(e.id, e);
  let blocked = found.some((e) => e.regainAt || e.pct >= STOP_PCT);
  if (!res.ok) {
    // Blocked without a recovery time in the headers: assume 5 minutes so background jobs don't pile up calls.
    const code = Number((await res.clone().json().catch(() => ({})))?.error?.code);
    if (LIMIT_CODES.has(code) || (code >= 80000 && code <= 80014)) {
      blocked = true;
      if (!found.some((e) => e.regainAt)) g.entries.set("limited", { id: "limited", kind: "app", objectId: null, type: `mã ${code}`, pct: 100, tier: null, regainAt: Date.now() + 300_000, at: Date.now(), gate });
    }
  }
  await persist(blocked);
  return res;
}

export async function readUsage(): Promise<UsageSnapshot | null> {
  const row = await db.setting.findUnique({ where: { key: SETTING_KEY } });
  return (parse(row?.value ?? null) as UsageSnapshot | null) ?? null;
}
