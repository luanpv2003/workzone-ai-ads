import { decrypt } from "./crypto";
import { getT } from "@/i18n/server";

// HighLevel (GoHighLevel / LeadConnector, including white-labeled domains like crm.ellacyglobal.com) API 2021-07-28.
// Docs: https://marketplace.gohighlevel.com/docs/ (Private Integrations, Contacts, Opportunities, Locations).
// - Auth: the sub-account's Private Integration token (Settings → Private Integrations), Authorization Bearer + Version headers.
// - Required scopes: contacts.readonly, contacts.write, opportunities.readonly, opportunities.write, locations.readonly.
// - Rate limit (OAuth, PIT shares the same level): 100 calls / 10 seconds per sub-account → space calls ≥ 150 ms apart.
// - Opportunity search: snake_case params (location_id, pipeline_id, contact_id), at most 100 / page, paginated with page.
// Users paste the Location ID + token on the web themselves (Client settings → HighLevel CRM); the token is stored encrypted.

const API = process.env.HIGHLEVEL_API_URL || "https://services.leadconnectorhq.com";
const VERSION = "2021-07-28";
const GAP_MS = Number(process.env.HIGHLEVEL_GAP_MS ?? 150);
export const GHL_PAGE = 100;

export type GhlCreds = { locationId: string; token: string };
export type GhlStage = { id: string; name: string };
export type GhlPipeline = { id: string; name: string; stages: GhlStage[] };
type GhlOpportunity = { id: string; pipelineId: string; pipelineStageId: string; status: string; contactId: string };

class GhlError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

/** The client's connection info (token decrypted); null if not connected. */
export function ghlCreds(c: { ghlLocationId: string | null; ghlToken: string | null }): GhlCreds | null {
  if (!c.ghlLocationId || !c.ghlToken) return null;
  return { locationId: c.ghlLocationId, token: decrypt(c.ghlToken) };
}

let last = 0;
async function pace() {
  const wait = last + GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
}

async function call<T>(c: GhlCreds, method: "GET" | "POST" | "PUT", path: string, opts: { query?: Record<string, string | number>; body?: unknown } = {}): Promise<T> {
  const t = await getT();
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, String(v));
  for (let attempt = 0; ; attempt++) {
    await pace();
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${c.token}`,
        Version: VERSION,
        Accept: "application/json",
        ...(opts.body !== undefined && { "Content-Type": "application/json" }),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(30_000),
    }).catch((err) => {
      throw new GhlError(t("customers.highlevel.errors.connect", { error: err instanceof Error ? err.message : String(err) }));
    });
    if (res.status === 429 && attempt < 4) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    const text = await res.text();
    const body = (text ? JSON.parse(text) : {}) as T & { message?: string | string[]; error?: string };
    if (!res.ok) {
      const msg = [body.message].flat().filter(Boolean).join("; ") || body.error || text.slice(0, 200);
      if (res.status === 401) throw new GhlError(t("customers.highlevel.errors.unauthorized"), 401);
      if (res.status === 403) throw new GhlError(t("customers.highlevel.errors.forbidden", { path: path.split("?")[0], msg }), 403);
      throw new GhlError(t("customers.highlevel.errors.http", { status: res.status, method, path, msg }), res.status);
    }
    return body;
  }
}

/** Test the connection: sub-account name + pipeline list with stages. */
export async function testGhl(c: GhlCreds): Promise<{ location: string; allowDuplicateOpportunity: boolean | null; pipelines: GhlPipeline[] }> {
  const t = await getT();
  const loc = await call<{ location?: { name?: string; settings?: { allowDuplicateOpportunity?: boolean } } }>(c, "GET", `/locations/${encodeURIComponent(c.locationId)}`).catch((err) => {
    if (err instanceof GhlError && (err.status === 400 || err.status === 404)) throw new GhlError(t("customers.highlevel.errors.locationNotFound", { id: c.locationId }), err.status);
    throw err;
  });
  return { location: loc.location?.name ?? c.locationId, allowDuplicateOpportunity: loc.location?.settings?.allowDuplicateOpportunity ?? null, pipelines: await listPipelines(c) };
}

async function listPipelines(c: GhlCreds): Promise<GhlPipeline[]> {
  type Raw = { id: string; name: string; stages?: { id: string; name: string; position?: number }[] };
  const r = await call<{ pipelines?: Raw[] }>(c, "GET", "/opportunities/pipelines", { query: { locationId: c.locationId } });
  return (r.pipelines ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    stages: [...(p.stages ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map((s) => ({ id: s.id, name: s.name })),
  }));
}

/**
 * Create or update a contact (HighLevel dedupes per the sub-account's "Allow Duplicate Contact" setting).
 * Tags are not sent here because upsert overwrites all of the contact's existing tags: add tags with addTags.
 */
export async function upsertContact(c: GhlCreds, input: { name: string; phone: string; email?: string | null; source: string }): Promise<{ id: string; isNew: boolean }> {
  const r = await call<{ new?: boolean; contact?: { id: string } }>(c, "POST", "/contacts/upsert", {
    body: { locationId: c.locationId, name: input.name || undefined, phone: input.phone, ...(input.email && { email: input.email }), source: input.source },
  });
  if (!r.contact?.id) throw new GhlError((await getT())("customers.highlevel.errors.noContact"));
  return { id: r.contact.id, isNew: !!r.new };
}

/** Add tags (keeping existing ones). */
export async function addTags(c: GhlCreds, contactId: string, tags: string[]) {
  if (!tags.length) return;
  await call(c, "POST", `/contacts/${encodeURIComponent(contactId)}/tags`, { body: { tags } });
}

export async function addNote(c: GhlCreds, contactId: string, body: string) {
  await call(c, "POST", `/contacts/${encodeURIComponent(contactId)}/notes`, { body: { body } });
}

type RawOpp = { id: string; pipelineId?: string; pipelineStageId?: string; status?: string; contactId?: string; contact?: { id?: string } };
const toOpp = (o: RawOpp): GhlOpportunity => ({
  id: o.id,
  pipelineId: o.pipelineId ?? "",
  pipelineStageId: o.pipelineStageId ?? "",
  status: o.status ?? "open",
  contactId: o.contactId ?? o.contact?.id ?? "",
});

/** One page of a pipeline's opportunities (newest first), optionally filtered by contact. */
export async function searchOpportunities(c: GhlCreds, q: { pipelineId: string; contactId?: string; page?: number }): Promise<GhlOpportunity[]> {
  const r = await call<{ opportunities?: RawOpp[] }>(c, "GET", "/opportunities/search", {
    query: {
      location_id: c.locationId,
      pipeline_id: q.pipelineId,
      ...(q.contactId && { contact_id: q.contactId }),
      status: "all",
      limit: GHL_PAGE,
      page: q.page ?? 1,
      order: "added_desc",
    },
  });
  return (r.opportunities ?? []).map(toOpp);
}

export async function createOpportunity(c: GhlCreds, input: { pipelineId: string; stageId: string | null; contactId: string; name: string }): Promise<GhlOpportunity> {
  const r = await call<{ opportunity?: RawOpp }>(c, "POST", "/opportunities/", {
    body: {
      locationId: c.locationId,
      pipelineId: input.pipelineId,
      ...(input.stageId && { pipelineStageId: input.stageId }),
      contactId: input.contactId,
      name: input.name,
      status: "open",
    },
  });
  if (!r.opportunity?.id) throw new GhlError((await getT())("customers.highlevel.errors.noOpportunity"));
  return toOpp(r.opportunity);
}

/** Move an opportunity to another stage (same pipeline). */
export async function moveOpportunity(c: GhlCreds, id: string, stageId: string) {
  await call(c, "PUT", `/opportunities/${encodeURIComponent(id)}`, { body: { pipelineStageId: stageId } });
}

/** Change opportunity status: open | won | lost | abandoned. */
export async function setOpportunityStatus(c: GhlCreds, id: string, status: "open" | "won" | "lost" | "abandoned") {
  await call(c, "PUT", `/opportunities/${encodeURIComponent(id)}/status`, { body: { status } });
}

/** Vietnamese phone number in E.164 (+84...) for HighLevel; numbers that already have a country code stay as is. */
export function e164(phone: string): string {
  const d = phone.replace(/[^\d+]/g, "");
  if (d.startsWith("+")) return d;
  if (d.startsWith("84") && d.length >= 11) return `+${d}`;
  if (d.startsWith("0")) return `+84${d.slice(1)}`;
  return `+84${d}`;
}

type GhlContact = { id: string; phones: string[]; emails: string[]; tags: string[] };

/**
 * Iterate over every contact of the sub-account (POST /contacts/search, 500 / page, paginated with the last contact's searchAfter).
 * Only phone / email / tags are kept in memory during processing, nothing is stored.
 */
export async function forEachContact(c: GhlCreds, fn: (batch: GhlContact[]) => void, maxPages = 400): Promise<number> {
  type Raw = { id: string; phone?: string | null; email?: string | null; tags?: string[]; additionalPhones?: (string | { phone?: string })[]; additionalEmails?: (string | { email?: string })[]; searchAfter?: unknown[] };
  let after: unknown[] | undefined;
  let total = 0;
  for (let page = 0; page < maxPages; page++) {
    const r = await call<{ contacts?: Raw[] }>(c, "POST", "/contacts/search", { body: { locationId: c.locationId, pageLimit: 500, ...(after && { searchAfter: after }) } });
    const list = r.contacts ?? [];
    if (!list.length) break;
    fn(
      list.map((x) => ({
        id: x.id,
        phones: [x.phone, ...(x.additionalPhones ?? []).map((p) => (typeof p === "string" ? p : p.phone))].filter((p): p is string => !!p),
        emails: [x.email, ...(x.additionalEmails ?? []).map((e) => (typeof e === "string" ? e : e.email))].filter((e): e is string => !!e),
        tags: x.tags ?? [],
      })),
    );
    total += list.length;
    after = list[list.length - 1].searchAfter;
    if (!after?.length || list.length < 500) break;
  }
  return total;
}
