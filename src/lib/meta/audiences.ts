import { createHash } from "node:crypto";
import { getT } from "@/i18n/server";
import type { Client } from "@prisma/client";
import { clientPages } from "../client-pages";
import { decrypt } from "../crypto";
import { MetaApiError } from "./graph";
import { metaFetch } from "./rate-limit";

// Create audiences on Meta: Custom Audience from a customer file (phone/email), from Page engagement, and Lookalike.
// The raw list only lives in memory during processing: no file saved, no logging; sent to Meta as SHA-256.

const VERSION = process.env.META_API_VERSION || "v23.0";
const BASE = `https://graph.facebook.com/${VERSION}`;
const BATCH = 10_000; // Meta accepts at most 10,000 rows per request
const MAX_CONTACTS = 500_000;
const CONTACT_FILE_EXT = ["xlsx", "csv", "tsv", "txt"];

// ------------------------------------------------------------------ Read file

type SheetCells = { name: string; cells: string[] };

async function xlsxCells(buf: Buffer): Promise<SheetCells[]> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buf);
  const read = (p: string) => zip.file(p)?.async("string") ?? Promise.resolve("");
  const decode = (t: string) =>
    t.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
      e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[e.toLowerCase()]!,
    );
  const text = (x: string) => [...x.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decode(m[1])).join("");
  const shared = [...(await read("xl/sharedStrings.xml")).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => text(m[1]));
  const rels = new Map([...(await read("xl/_rels/workbook.xml.rels")).matchAll(/<Relationship\b[^>]*>/g)].map((m) => [/Id="([^"]+)"/.exec(m[0])?.[1], /Target="([^"]+)"/.exec(m[0])?.[1]]));
  const out: SheetCells[] = [];
  for (const m of (await read("xl/workbook.xml")).matchAll(/<sheet\b[^>]*>/g)) {
    const target = rels.get(/r:id="([^"]+)"/.exec(m[0])?.[1]);
    if (!target) continue;
    const xml = await read(target.startsWith("/") ? target.slice(1) : `xl/${target}`);
    const cells: string[] = [];
    for (const c of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const type = /\bt="([^"]+)"/.exec(c[1])?.[1];
      const inner = c[2] ?? "";
      if (type === "inlineStr") cells.push(text(inner));
      else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        if (v != null) cells.push(type === "s" ? (shared[Number(v)] ?? "") : decode(v));
      }
    }
    out.push({ name: decode(/name="([^"]*)"/.exec(m[0])?.[1] ?? ""), cells });
  }
  return out;
}

function delimitedCells(buf: Buffer, name: string): SheetCells[] {
  const t = buf.toString("utf8").replace(/^﻿/, "");
  return [{ name, cells: t.split(/\r?\n|[,;\t]/) }];
}

export async function readContactFile(fileName: string, buf: Buffer): Promise<SheetCells[]> {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "xlsx") return xlsxCells(buf);
  if (["csv", "tsv", "txt"].includes(ext)) return delimitedCells(buf, fileName);
  throw new Error((await getT())("targeting.metaAud.unreadableFile", { ext, supported: CONTACT_FILE_EXT.join(", ") }));
}

// ------------------------------------------------------------------ Normalize per Meta's requirements

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
// Digit strings may include +, spaces, dots, dashes, parentheses (e.g. "+84 911 425 511", "090-313-6499").
const PHONE_RE = /\+?\(?\d[\d\s.()-]{7,16}\d/g;

/** VN numbers → 84xxxxxxxxx; foreign numbers (with +) keep their country code. Invalid → null. */
export function normalizePhone(raw: string): string | null {
  const intl = raw.trim().startsWith("+");
  let d = raw.replace(/\D/g, "");
  if (intl && !d.startsWith("84")) return d.length >= 8 && d.length <= 15 ? d : null;
  if (d.startsWith("84")) d = d.slice(2);
  d = d.replace(/^0+/, "");
  // VN mobile: 9 digits after the country code, starting with 3/5/7/8/9
  return d.length === 9 && /^[35789]/.test(d) ? `84${d}` : null;
}

function cellPhones(cell: string): string[] {
  const v = cell.trim();
  // Excel stores phone numbers as numbers: 912345678 or 9.18339956E8
  if (/^\d+(\.\d+)?(e\+?\d+)?$/i.test(v)) {
    const n = Number(v);
    if (Number.isFinite(n) && Number.isInteger(n)) {
      const p = normalizePhone(String(n));
      return p ? [p] : [];
    }
  }
  return [...v.matchAll(PHONE_RE)].map((m) => normalizePhone(m[0])).filter((p): p is string => !!p);
}

export type ContactStats = { phones: number; emails: number };
export type SheetStats = ContactStats & { name: string; cells: number };

/** Count phones/emails in each sheet (returns no real data). */
export function analyzeContacts(sheets: SheetCells[]): { sheets: SheetStats[]; unique: ContactStats } {
  const all = extractContacts(sheets, sheets.map((s) => s.name));
  return {
    sheets: sheets.map((s) => {
      const one = extractContacts([s], [s.name]);
      return { name: s.name, cells: s.cells.length, phones: one.phones.size, emails: one.emails.size };
    }),
    unique: { phones: all.phones.size, emails: all.emails.size },
  };
}

export function extractContacts(sheets: SheetCells[], use: string[]) {
  const phones = new Set<string>();
  const emails = new Set<string>();
  for (const s of sheets) {
    if (!use.includes(s.name)) continue;
    for (const cell of s.cells) {
      if (!cell) continue;
      for (const e of cell.match(EMAIL_RE) ?? []) emails.add(e.toLowerCase().replace(/\.$/, ""));
      // Strip emails before searching for numbers, to avoid picking up digits inside email addresses
      for (const p of cellPhones(cell.replace(EMAIL_RE, " "))) phones.add(p);
    }
  }
  return { phones, emails };
}

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

// ------------------------------------------------------------------ Call Meta

async function account(client: Client) {
  if (client.dataSource !== "meta" || !client.metaAdAccountId || !client.metaAccessToken) {
    throw new Error((await getT())("targeting.metaAud.notConnected"));
  }
  const act = client.metaAdAccountId.startsWith("act_") ? client.metaAdAccountId : `act_${client.metaAdAccountId}`;
  return { act, token: decrypt(client.metaAccessToken) };
}

async function post<T>(path: string, params: Record<string, unknown>, token: string, act: string): Promise<T> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null) body.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  body.set("access_token", token);
  const res = await metaFetch(`${BASE}${path}`, { method: "POST", body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const e = json.error ?? {};
    const t = await getT();
    const msg: string = e.error_user_msg || e.message || t("targeting.metaAud.httpError", { status: res.status });
    if (/terms|điều khoản/i.test(msg) || e.error_subcode === 1870034) {
      throw new MetaApiError(
        t("targeting.metaAud.termsNotAccepted", { act: act.slice(4) }),
        e.code,
      );
    }
    if (e.code === 200 || e.code === 10) throw new MetaApiError(t("targeting.metaAud.needsPermission", { msg }), e.code);
    throw new MetaApiError(msg, e.code);
  }
  return json as T;
}

export type CreatedAudience = { id: string; name: string; phones: number; emails: number; received: number; invalid: number };

/** Create an empty Custom Audience, then upload hashed phones/emails in batches. */
export async function createCustomerListAudience(
  client: Client,
  input: { name: string; description?: string; phones: Set<string>; emails: Set<string> },
): Promise<CreatedAudience> {
  const { act, token } = await account(client);
  const total = input.phones.size + input.emails.size;
  if (!total) throw new Error((await getT())("targeting.metaAud.noContacts"));
  if (total > MAX_CONTACTS) throw new Error((await getT())("targeting.metaAud.tooMany", { max: MAX_CONTACTS.toLocaleString("vi-VN") }));
  const { id } = await post<{ id: string }>(
    `/${act}/customaudiences`,
    { name: input.name, subtype: "CUSTOM", description: input.description || undefined, customer_file_source: "USER_PROVIDED_ONLY" },
    token,
    act,
  );
  let received = 0;
  let invalid = 0;
  for (const [schema, values] of [["PHONE_SHA256", input.phones], ["EMAIL_SHA256", input.emails]] as const) {
    const hashed = [...values].map(sha256);
    for (let i = 0; i < hashed.length; i += BATCH) {
      const r = await post<{ num_received?: number; num_invalid_entries?: number }>(`/${id}/users`, { payload: { schema, data: hashed.slice(i, i + BATCH) } }, token, act);
      received += r.num_received ?? 0;
      invalid += r.num_invalid_entries ?? 0;
    }
  }
  return { id, name: input.name, phones: input.phones.size, emails: input.emails.size, received, invalid };
}

/** Lookalike from a source audience. startPct–endPct are % of the country's population (e.g. 0–1, 1–3), max 10. */
export async function createLookalikeAudience(
  client: Client,
  input: { name: string; originId: string; country: string; startPct: number; endPct: number },
): Promise<{ id: string; name: string }> {
  const { act, token } = await account(client);
  const { startPct, endPct } = input;
  if (!(startPct >= 0 && endPct <= 10 && endPct > startPct)) throw new Error((await getT())("targeting.metaAud.lookalikeRange"));
  if (!/^[A-Z]{2}$/.test(input.country)) throw new Error((await getT())("targeting.metaAud.badCountry"));
  const { id } = await post<{ id: string }>(
    `/${act}/customaudiences`,
    {
      name: input.name,
      subtype: "LOOKALIKE",
      origin_audience_id: input.originId,
      lookalike_spec: { country: input.country, ratio: endPct / 100, ...(startPct > 0 && { starting_ratio: startPct / 100 }) },
    },
    token,
    act,
  );
  return { id, name: input.name };
}

// ------------------------------------------------------------------ Page audiences (engagement custom audience)

// Event names per Meta docs (Engagement Custom Audiences, event_sources type "page").
// page_engaged covers all engagement (Page views, posts, ads, messaging...); page_messaged is only people who messaged the Page.
export const PAGE_AUDIENCE_EVENTS = ["page_messaged", "page_engaged"] as const;
export type PageAudienceEvent = (typeof PAGE_AUDIENCE_EVENTS)[number];
const MAX_PAGE_RETENTION_DAYS = 730;

/** Create an audience of people who messaged / engaged with the client's Pages. Each event is a rule; anyone matching any rule is included. */
export async function createPageEngagementAudience(
  client: Client,
  input: { name: string; pageIds: string[]; events: PageAudienceEvent[]; days: number; description?: string },
): Promise<{ id: string; name: string }> {
  const { act, token } = await account(client);
  const own = new Set(clientPages(client).map((p) => p.id));
  const pageIds = [...new Set(input.pageIds)];
  if (!pageIds.length) throw new Error((await getT())("targeting.metaAud.noPage"));
  // Only use Pages linked to the client in Settings; manually typed IDs are not accepted.
  if (pageIds.some((id) => !own.has(id))) throw new Error((await getT())("targeting.metaAud.pageNotOwned"));
  const events = [...new Set(input.events)];
  if (!events.length || events.some((e) => !PAGE_AUDIENCE_EVENTS.includes(e))) throw new Error((await getT())("targeting.metaAud.noEvent"));
  const days = Math.round(input.days);
  if (!(days >= 1 && days <= MAX_PAGE_RETENTION_DAYS)) throw new Error((await getT())("targeting.metaAud.badDays", { max: MAX_PAGE_RETENTION_DAYS }));
  const rule = {
    inclusions: {
      operator: "or",
      rules: events.map((value) => ({
        event_sources: pageIds.map((id) => ({ id, type: "page" })),
        retention_seconds: days * 86_400,
        filter: { operator: "and", filters: [{ field: "event", operator: "eq", value }] },
      })),
    },
  };
  // No subtype: Meta dropped subtype for engagement audiences (except video). prefill=1: also include people who engaged within the chosen date range.
  const { id } = await post<{ id: string }>(`/${act}/customaudiences`, { name: input.name, description: input.description || undefined, rule, prefill: 1 }, token, act);
  return { id, name: input.name };
}
