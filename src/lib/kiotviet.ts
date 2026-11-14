import { decrypt } from "./crypto";
import { getT } from "@/i18n/server";

// KiotViet Public API (Retail edition), READ ONLY: branches, customers, invoices, products.
// Docs: https://www.kiotviet.vn/huong-dan-su-dung-public-api-retail/
// - Get a token: POST id.kiotviet.vn/connect/token (client_credentials, scope PublicApi.Access), valid 24 hours.
// - API calls: public.kiotapi.com, header Retailer = store name + Authorization Bearer.
// - Limit 5,000 GETs/hour per store → background jobs space calls ≥ 1.2 seconds apart (~3,000 calls/hour, leaving room for the client's other apps).
// - Pagination: pageSize at most 100, currentItem = start position.
// Client ID / Secret come from KiotViet: Store settings → API connection settings (users paste them on the web; the Secret is stored encrypted).

// Override via environment variables only for local testing against a mock server.
const TOKEN_URL = process.env.KIOTVIET_TOKEN_URL || "https://id.kiotviet.vn/connect/token";
const API = process.env.KIOTVIET_API_URL || "https://public.kiotapi.com";
const GAP_MS = Number(process.env.KIOTVIET_GAP_MS ?? 1200);
const PAGE = 100;

export type KiotCreds = { retailer: string; clientId: string; secret: string };

class KiotError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

/** The client's connection info (Secret decrypted); null if not connected. */
export function kiotCreds(c: { kiotRetailer: string | null; kiotClientId: string | null; kiotSecret: string | null }): KiotCreds | null {
  if (!c.kiotRetailer || !c.kiotClientId || !c.kiotSecret) return null;
  return { retailer: c.kiotRetailer, clientId: c.kiotClientId, secret: decrypt(c.kiotSecret) };
}

// Access token reused for 24 hours (each web / worker process has its own memory).
const tokens = new Map<string, { token: string; until: number }>();
const tokenKey = (c: KiotCreds) => `${c.retailer}|${c.clientId}`;

async function accessToken(c: KiotCreds, fresh = false): Promise<string> {
  const t = await getT();
  const k = tokenKey(c);
  const hit = tokens.get(k);
  if (!fresh && hit && hit.until > Date.now()) return hit.token;
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ scopes: "PublicApi.Access", grant_type: "client_credentials", client_id: c.clientId, client_secret: c.secret }),
    signal: AbortSignal.timeout(30_000),
  }).catch((err) => {
    throw new KiotError(t("settings.kiotviet.loginUnreachable", { error: String(err instanceof Error ? err.message : err) }));
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !body.access_token) {
    throw new KiotError(
      body.error === "invalid_client" ? t("settings.kiotviet.invalidClient") : t("settings.kiotviet.tokenDenied", { detail: `${res.status}${body.error ? ` ${body.error}` : ""}` }),
      res.status,
    );
  }
  tokens.set(k, { token: body.access_token, until: Date.now() + Math.max(60, (body.expires_in ?? 86400) - 600) * 1000 });
  return body.access_token;
}

// Space out calls per store (background jobs only; web actions call rarely and don't wait).
const lastCall = new Map<string, number>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type GetOpts = { throttle?: boolean };

/** GET one page. Fetches a new token on expiry (401) and waits when over the rate limit (429). */
export async function kiotGet<T>(c: KiotCreds, path: string, params: Record<string, string | number | boolean | undefined> = {}, opts: GetOpts = {}): Promise<T> {
  const t = await getT();
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, String(v));
  const url = `${API}${path}${qs.size ? `?${qs}` : ""}`;
  for (let attempt = 0; ; attempt++) {
    if (opts.throttle) {
      const wait = (lastCall.get(c.retailer) ?? 0) + GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      lastCall.set(c.retailer, Date.now());
    }
    const token = await accessToken(c, attempt > 0 && attempt < 2);
    let res: Response;
    try {
      res = await fetch(url, { headers: { Retailer: c.retailer, Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(60_000) });
    } catch (err) {
      if (attempt < 3) {
        await sleep(5_000 * (attempt + 1));
        continue;
      }
      throw new KiotError(t("settings.kiotviet.connectionLost", { error: String(err instanceof Error ? err.message : err) }));
    }
    if (res.ok) return (await res.json()) as T;
    const text = (await res.text().catch(() => "")).slice(0, 300);
    if (res.status === 401 && attempt === 0) continue; // token expired early: get a new token, retry once
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      await sleep(res.status === 429 ? 60_000 : 10_000 * (attempt + 1));
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      throw new KiotError(`${t("settings.kiotviet.accessDenied", { status: res.status })} ${text}`.trim(), res.status);
    }
    throw new KiotError(t("settings.kiotviet.readError", { status: res.status, path, text }), res.status);
  }
}

type Page<T> = { total?: number; pageSize?: number; data?: T[] };

/**
 * Read all pages. onPage receives each page (to save incrementally / record progress); start = start position (resume from a checkpoint).
 * Returns the total record count KiotViet reports.
 */
export async function kiotPaged<T>(
  c: KiotCreds,
  path: string,
  params: Record<string, string | number | boolean | undefined>,
  onPage: (rows: T[], next: number, total: number) => Promise<void>,
  opts: GetOpts & { start?: number; shouldStop?: () => boolean } = {},
): Promise<number> {
  const t = await getT();
  let at = opts.start ?? 0;
  for (;;) {
    if (opts.shouldStop?.()) throw new KiotError(t("settings.kiotviet.stopped"));
    const page = await kiotGet<Page<T>>(c, path, { ...params, pageSize: PAGE, currentItem: at }, opts);
    const rows = page.data ?? [];
    const total = page.total ?? 0;
    at += rows.length;
    await onPage(rows, at, total);
    if (!rows.length || rows.length < PAGE || at >= total) return total;
  }
}

// ------------------------------------------------------------ Data types (only the fields used)

export type KvBranchRow = { id: number; branchName: string; address?: string | null };
export type KvCustomerRow = {
  id: number | string;
  code?: string;
  name?: string;
  gender?: boolean | null;
  birthDate?: string | null;
  contactNumber?: string | null;
  locationName?: string | null;
  wardName?: string | null;
  totalRevenue?: number | null;
  totalInvoiced?: number | null;
  createdDate?: string | null;
  modifiedDate?: string | null;
};
export type KvInvoiceRow = {
  id: number | string;
  code?: string;
  purchaseDate: string;
  branchId: number;
  branchName?: string;
  customerId?: number | string | null;
  total?: number | null;
  status?: number;
  invoiceDetails?: { productId: number | string; productCode?: string; productName?: string; quantity?: number; price?: number; discount?: number | null }[];
};

/** KiotViet invoice status: 1 completed, 2 cancelled, 3 processing, 5 undeliverable. Drop 2 and 5. */
export const invoiceCounts = (status: number | undefined) => status !== 2 && status !== 5;

/** KiotViet returns VN time, sometimes without a timezone: treat as +07:00. */
export function kvDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}+07:00`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Date YYYY-MM-DD in VN time. */
export const vnDay = (d: Date) => new Date(d.getTime() + 7 * 3600_000).toISOString().slice(0, 10);

/** Test the connection: get a token + read branches, count customers and invoices. */
export async function testKiot(c: KiotCreds) {
  tokens.delete(tokenKey(c));
  const [branches, customers, invoices] = await Promise.all([
    kiotGet<Page<KvBranchRow>>(c, "/branches", { pageSize: PAGE }),
    kiotGet<Page<KvCustomerRow>>(c, "/customers", { pageSize: 1 }),
    kiotGet<Page<KvInvoiceRow>>(c, "/invoices", { pageSize: 1 }),
  ]);
  return { branches: (branches.data ?? []).map((b) => b.branchName), customers: customers.total ?? 0, invoices: invoices.total ?? 0 };
}
