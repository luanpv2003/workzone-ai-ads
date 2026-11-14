import { randomBytes } from "node:crypto";
import { db } from "./db";
import { decrypt, encrypt } from "./crypto";
import { publicUrl } from "./zalo";
import { BRAND } from "./brand";
import { getT } from "@/i18n/server";
import type { T } from "@/i18n/translate";

// The platform's Google Ads: one shared connection for the whole system.
// - The platform's MCC (manager account) contains the clients' ad accounts; each client just picks its account ID in Settings.
// - An admin pastes the OAuth Client ID + Secret (from your own Google Cloud project) and Developer token (MCC → Admin → API Center)
//   on the web (System settings → Google Ads), then clicks "Connect Google" → Google redirects to /api/google-ads/callback.
// - Google refresh tokens don't expire (app is Published, not in Testing mode); access tokens live 1 hour and are refreshed on call.
// - Explorer access level: 2,880 calls/day on real accounts; each sync of 1 client ~16 calls (searchStream), each edit 1–2 calls.
// - Writes (edits) on Google: only via lib/google-ads-write.ts (mutate), approved / clicked by the user.
// Docs: developers.google.com/google-ads/api/rest/overview

const CONN_KEY = "google.ads"; // encrypted: client id/secret, developer token, refresh token
const STATE_KEY = "google.ads.state";

const GOOGLE_ADS_VERSION = process.env.GOOGLE_ADS_API_VERSION || "v26";
const API = `https://googleads.googleapis.com/${GOOGLE_ADS_VERSION}`;
const SCOPE = "https://www.googleapis.com/auth/adwords openid email";

type GoogleAdsConn = {
  clientId: string;
  clientSecret: string;
  developerToken: string;
  mccId: string; // 10 digits, sent in the login-customer-id header
  refreshToken: string | null;
  email: string | null;
  accessToken: string | null;
  accessExpiresAt: string | null;
  connectedAt: string | null;
  connectedBy: string | null;
  lastError: string | null;
};

export const googleCallbackUrl = () => `${publicUrl()}/api/google-ads/callback`;
/** "123-456-7890" / "1234567890" → "1234567890"; invalid format → null. */
export const normalizeCustomerId = (v: string) => {
  const d = v.replace(/[\s-]/g, "");
  return /^\d{10}$/.test(d) ? d : null;
};
export const formatCustomerId = (d: string) => (d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : d);

async function readSecret<T>(key: string): Promise<T | null> {
  const row = await db.setting.findUnique({ where: { key } });
  if (!row) return null;
  try {
    return JSON.parse(decrypt(row.value)) as T;
  } catch {
    return null;
  }
}
async function writeSecret(key: string, value: unknown) {
  const v = encrypt(JSON.stringify(value));
  await db.setting.upsert({ where: { key }, create: { key, value: v }, update: { value: v } });
}

export const loadGoogleAds = () => readSecret<GoogleAdsConn>(CONN_KEY);
const saveConn = (c: GoogleAdsConn) => writeSecret(CONN_KEY, c);

/** Status for display on the web (does not return secrets). */
export async function googleAdsStatus() {
  const c = await loadGoogleAds();
  if (!c) return null;
  return {
    clientId: c.clientId,
    mccId: c.mccId,
    hasDeveloperToken: !!c.developerToken,
    connected: !!c.refreshToken,
    email: c.email,
    connectedAt: c.connectedAt,
    connectedBy: c.connectedBy,
    lastError: c.lastError,
  };
}
export type GoogleAdsStatus = Awaited<ReturnType<typeof googleAdsStatus>>;

/** Save OAuth client + developer token + MCC. Empty secret fields = keep the old values. Changing the OAuth client requires reconnecting. */
export async function saveGoogleAdsApp(input: { clientId: string; clientSecret: string; developerToken: string; mccId: string }) {
  const t = await getT();
  const old = await loadGoogleAds();
  const clientId = input.clientId.trim();
  if (!/^[\w-]+\.apps\.googleusercontent\.com$/.test(clientId)) throw new Error(t("settings.googleLib.clientIdFormat"));
  const clientSecret = input.clientSecret.trim() || old?.clientSecret || "";
  if (clientSecret.length < 10) throw new Error(t("settings.googleLib.noSecret"));
  const developerToken = input.developerToken.trim() || old?.developerToken || "";
  if (developerToken.length < 10) throw new Error(t("settings.googleLib.noDevToken"));
  const mccId = normalizeCustomerId(input.mccId);
  if (!mccId) throw new Error(t("settings.googleLib.badMcc"));
  const same = old?.clientId === clientId && old?.clientSecret === clientSecret;
  await saveConn({
    clientId,
    clientSecret,
    developerToken,
    mccId,
    refreshToken: same ? old.refreshToken : null,
    email: same ? old.email : null,
    accessToken: same ? old.accessToken : null,
    accessExpiresAt: same ? old.accessExpiresAt : null,
    connectedAt: same ? old.connectedAt : null,
    connectedBy: same ? old.connectedBy : null,
    lastError: null,
  });
}

export async function disconnectGoogleAds() {
  await db.setting.deleteMany({ where: { key: { in: [CONN_KEY, STATE_KEY] } } });
}

// ------------------------------------------------------------------ OAuth 2.0

/** Link to Google's consent page. state is kept 15 minutes to prevent forged callbacks. */
export async function googleAuthorizeUrl() {
  const t = await getT();
  const c = await loadGoogleAds();
  if (!c) throw new Error(t("settings.googleLib.notSavedAll"));
  const state = randomBytes(16).toString("hex");
  await writeSecret(STATE_KEY, { state, at: Date.now() });
  const q = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: googleCallbackUrl(),
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent", // always return a refresh token, even if consent was given before
    include_granted_scopes: "true",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number; id_token?: string; error?: string; error_description?: string };

async function tokenRequest(c: GoogleAdsConn, body: Record<string, string>) {
  const t = await getT();
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, ...body }),
    signal: AbortSignal.timeout(20_000),
  });
  const j = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!j.access_token) {
    const why = j.error_description || j.error || `HTTP ${res.status}`;
    throw new Error(j.error === "invalid_grant" ? t("settings.googleLib.revoked") : t("settings.googleLib.noAccessToken", { why }));
  }
  return j;
}

/** Email from the id_token (no signature check needed: the token was just received directly from Google over HTTPS). */
function emailFromIdToken(idToken?: string) {
  try {
    const payload = JSON.parse(Buffer.from(idToken!.split(".")[1], "base64url").toString("utf8")) as { email?: string };
    return payload.email ?? null;
  } catch {
    return null;
  }
}

export async function exchangeGoogleCode(code: string, state: string | null, by: string) {
  const t = await getT();
  const c = await loadGoogleAds();
  const saved = await readSecret<{ state: string; at: number }>(STATE_KEY);
  if (!c) throw new Error(t("settings.googleLib.notSavedIdSecret"));
  if (!saved || saved.state !== state || Date.now() - saved.at > 15 * 60_000) throw new Error(t("settings.googleLib.stateExpired"));
  const tok = await tokenRequest(c, { code, grant_type: "authorization_code", redirect_uri: googleCallbackUrl() });
  await db.setting.deleteMany({ where: { key: STATE_KEY } });
  if (!tok.refresh_token) throw new Error(t("settings.googleLib.noRefreshToken", { app: BRAND.app }));
  await saveConn({
    ...c,
    refreshToken: tok.refresh_token,
    email: emailFromIdToken(tok.id_token),
    accessToken: tok.access_token!,
    accessExpiresAt: new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString(),
    connectedAt: new Date().toISOString(),
    connectedBy: by,
    lastError: null,
  });
}

let refreshing: Promise<string> | null = null;

async function accessToken(): Promise<{ token: string; conn: GoogleAdsConn }> {
  const c = await loadGoogleAds();
  if (!c?.refreshToken) throw new Error((await getT())("settings.googleLib.notConnectedSystem"));
  if (c.accessToken && c.accessExpiresAt && new Date(c.accessExpiresAt).getTime() - Date.now() > 5 * 60_000) return { token: c.accessToken, conn: c };
  refreshing ??= (async () => {
    try {
      const t = await tokenRequest(c, { refresh_token: c.refreshToken!, grant_type: "refresh_token" });
      await saveConn({ ...c, accessToken: t.access_token!, accessExpiresAt: new Date(Date.now() + (t.expires_in ?? 3600) * 1000).toISOString(), lastError: null });
      return t.access_token!;
    } catch (err) {
      await saveConn({ ...c, lastError: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      refreshing = null;
    }
  })();
  return { token: await refreshing, conn: c };
}

// ------------------------------------------------------------------ Google Ads API (REST)

type ApiError = { error?: { code?: number; message?: string; status?: string; details?: { errors?: { errorCode?: Record<string, string>; message?: string }[] }[] } };

function apiErrorText(j: ApiError | null, status: number, t: T) {
  const e = j?.error;
  const inner = e?.details?.flatMap((d) => d.errors ?? []) ?? [];
  const codes = inner.map((x) => Object.values(x.errorCode ?? {}).join("/")).join(", ");
  if (codes.includes("DEVELOPER_TOKEN_NOT_APPROVED")) return t("settings.googleLib.devTokenNotApproved");
  if (codes.includes("USER_PERMISSION_DENIED")) return t("settings.googleLib.permissionDenied");
  if (codes.includes("CUSTOMER_NOT_ENABLED")) return t("settings.googleLib.customerNotEnabled");
  if (codes.includes("RESOURCE_EXHAUSTED") || e?.status === "RESOURCE_EXHAUSTED") return t("settings.googleLib.quotaExhausted");
  const msg = inner.map((x) => x.message).filter(Boolean).join("; ") || e?.message || `HTTP ${status}`;
  return `Google Ads API: ${msg}${codes ? ` (${codes})` : ""}`;
}

async function call<T>(path: string, body: unknown, opts: { customerId?: string; login?: boolean } = {}): Promise<T> {
  const t = await getT();
  const { token, conn } = await accessToken();
  const res = await fetch(`${API}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "developer-token": conn.developerToken,
      ...(opts.login !== false && { "login-customer-id": conn.mccId }),
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const j = (await res.json().catch(() => null)) as unknown;
  // searchStream failing midway returns an array containing an { error } element.
  const err = Array.isArray(j) ? (j.find((x) => (x as ApiError)?.error) as ApiError | undefined) : (j as ApiError | null)?.error ? (j as ApiError) : undefined;
  if (!res.ok || err) throw new Error(apiErrorText(err ?? (j as ApiError), res.status, t));
  return j as T;
}

/** GAQL via searchStream: one call returns all results (no extra calls per page). */
export async function gaql<T = Record<string, unknown>>(customerId: string, query: string): Promise<T[]> {
  const batches = await call<{ results?: T[] }[]>(`/customers/${customerId}/googleAds:searchStream`, { query: query.replace(/\s+/g, " ").trim() });
  return batches.flatMap((b) => b.results ?? []);
}

export type GoogleAccount = { id: string; name: string; currency: string; timeZone: string; manager: boolean; status: string };

/** Ad accounts under the platform MCC (level 1 and sub-levels), to pick for a client in Settings. */
export async function listMccAccounts(): Promise<GoogleAccount[]> {
  const c = await loadGoogleAds();
  if (!c) throw new Error((await getT())("settings.googleLib.notConnected"));
  type Row = { customerClient: { id: string; descriptiveName?: string; currencyCode?: string; timeZone?: string; manager?: boolean; status?: string; level?: string } };
  const rows = await gaql<Row>(
    c.mccId,
    `SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.time_zone,
       customer_client.manager, customer_client.status, customer_client.level
     FROM customer_client WHERE customer_client.level <= 2`,
  );
  return rows
    .map(({ customerClient: x }) => ({
      id: String(x.id),
      name: x.descriptiveName || formatCustomerId(String(x.id)),
      currency: x.currencyCode ?? "",
      timeZone: x.timeZone ?? "",
      manager: !!x.manager,
      status: x.status ?? "",
    }))
    .filter((a) => a.id !== c.mccId && !a.manager)
    .sort((a, b) => a.name.localeCompare(b.name, "vi"));
}

type MutateResponse = { results?: ({ resourceName?: string } | Record<string, never>)[]; partialFailureError?: { message?: string } };

/**
 * Edit on Google Ads: POST /customers/{id}/{service}:mutate (e.g. campaignCriteria, campaigns, campaignBudgets, adGroupCriteria).
 * validateOnly: Google only validates, changes nothing. partialFailure: failed operations don't block others (failed results are {}).
 */
export async function gmutate(customerId: string, service: string, operations: unknown[], opts: { validateOnly?: boolean; partialFailure?: boolean } = {}) {
  return call<MutateResponse>(`/customers/${customerId}/${service}:mutate`, {
    operations,
    ...(opts.validateOnly && { validateOnly: true }),
    ...(opts.partialFailure && { partialFailure: true }),
  });
}

type MutateAllResponse = { mutateOperationResponses?: Record<string, { resourceName?: string }>[] };

/**
 * Several operation types in one atomic call (if one fails nothing is applied): POST /customers/{id}/googleAds:mutate.
 * Uses negative temp names (e.g. customers/1/adGroups/-1) to create an ad group and attach keywords / ads to it within the same call.
 */
export async function gmutateAll(customerId: string, mutateOperations: unknown[], opts: { validateOnly?: boolean } = {}) {
  return call<MutateAllResponse>(`/customers/${customerId}/googleAds:mutate`, { mutateOperations, ...(opts.validateOnly && { validateOnly: true }) });
}
