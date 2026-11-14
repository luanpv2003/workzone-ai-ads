import { createHash, randomBytes } from "node:crypto";
import { db } from "./db";
import { decrypt, encrypt } from "./crypto";
import { getT } from "@/i18n/server";

// The platform's Zalo OA: send template messages (ZBS Template Message, formerly ZNS) to customers' phone numbers.
// - Connect: an admin pastes the Zalo app's App ID + Secret key (developers.zalo.me) on the web, then clicks "Kết nối OA" (connect OA)
//   (OAuth v4 + PKCE, Zalo redirects to /api/zalo/callback) or pastes a Refresh Token obtained from the API Explorer.
// - Access tokens live 25 hours, refresh tokens 3 months and are single-use: scripts/daily.ts refreshes hourly when near expiry,
//   so reconnecting is only needed if the system stops running for over 3 months.
// - Templates are created and approved on the ZBS Account (account.zalo.solutions); the system only reads the parameter list and sends.
// Docs: developers.zalo.me/docs/zbs-template-message, developers.zalo.me/docs/official-account/bat-dau/xac-thuc-va-uy-quyen-cho-ung-dung-new

const OA_KEY = "zalo.oa"; // encrypted: app, secret, token
const PKCE_KEY = "zalo.pkce"; // encrypted: code verifier of the pending authorization
const TEMPLATE_KEY = "zalo.template"; // report message templates + how to fill parameters (not secret)

const OAUTH = "https://oauth.zaloapp.com/v4/oa";
const BUSINESS = "https://business.openapi.zalo.me";

type ZaloOa = {
  appId: string;
  secretKey: string;
  oaId: string | null;
  oaName: string | null;
  accessToken: string | null;
  accessExpiresAt: string | null;
  refreshToken: string | null;
  refreshExpiresAt: string | null;
  connectedAt: string | null;
  connectedBy: string | null;
  lastError: string | null;
};

/** Template parameters, read from the Get Template details API. */
export type ZaloParam = { name: string; require: boolean; type: string; maxLength: number; minLength: number; acceptNull: boolean };
export type ZaloTemplate = {
  templateId: string;
  templateName: string;
  status: string;
  params: ZaloParam[];
  buttons: { type: number; title: string; content: string }[];
  previewUrl: string | null;
  price: string | null;
  /** parameter name → "var:<variable>" (from the report) or "text:<fixed text>" */
  map: Record<string, string>;
  savedAt: string;
};

export const callbackUrl = () => `${publicUrl()}/api/zalo/callback`;
/** Public web address (report links sent to clients, Zalo callback). Cron runs outside a request so it can't read Host. */
export const publicUrl = () => (process.env.PUBLIC_URL || "http://localhost:3000").replace(/\/$/, "");

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

export const loadOa = () => readSecret<ZaloOa>(OA_KEY);
const saveOa = (oa: ZaloOa) => writeSecret(OA_KEY, oa);

/** Connection status to show on the web (no tokens returned). */
export async function oaStatus() {
  const oa = await loadOa();
  if (!oa) return null;
  return {
    appId: oa.appId,
    oaId: oa.oaId,
    oaName: oa.oaName,
    connected: !!oa.refreshToken,
    accessExpiresAt: oa.accessExpiresAt,
    refreshExpiresAt: oa.refreshExpiresAt,
    connectedAt: oa.connectedAt,
    connectedBy: oa.connectedBy,
    lastError: oa.lastError,
  };
}
export type OaStatus = Awaited<ReturnType<typeof oaStatus>>;

/** Save App ID + Secret key. Changing the app drops the old token (tokens are tied to the app). */
export async function saveApp(appId: string, secretKey: string | null) {
  const old = await loadOa();
  if (!/^\d{6,25}$/.test(appId)) throw new Error((await getT())("notify.zalo.appIdFormat"));
  const secret = secretKey?.trim() || old?.secretKey;
  if (!secret || secret.length < 10) throw new Error((await getT())("notify.zalo.missingSecret"));
  const same = old?.appId === appId;
  await saveOa({
    appId,
    secretKey: secret,
    oaId: same ? old.oaId : null,
    oaName: same ? old.oaName : null,
    accessToken: same ? old.accessToken : null,
    accessExpiresAt: same ? old.accessExpiresAt : null,
    refreshToken: same ? old.refreshToken : null,
    refreshExpiresAt: same ? old.refreshExpiresAt : null,
    connectedAt: same ? old.connectedAt : null,
    connectedBy: same ? old.connectedBy : null,
    lastError: null,
  });
}

export async function disconnectOa() {
  await db.setting.deleteMany({ where: { key: { in: [OA_KEY, PKCE_KEY] } } });
}

// ------------------------------------------------------------------ OAuth v4 (PKCE)

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Link to Zalo's authorization page. The verifier is kept 15 minutes (authorization codes only live 10 minutes). */
export async function authorizeUrl() {
  const oa = await loadOa();
  if (!oa) throw new Error((await getT())("notify.zalo.noApp"));
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  // 43 characters with upper, lower and digits (Zalo requirement).
  let verifier = "";
  do verifier = Array.from(randomBytes(43), (x) => alphabet[x % alphabet.length]).join("");
  while (!/[A-Z]/.test(verifier) || !/[a-z]/.test(verifier) || !/\d/.test(verifier));
  const state = b64url(randomBytes(12));
  await writeSecret(PKCE_KEY, { verifier, state, at: Date.now() });
  const challenge = b64url(createHash("sha256").update(verifier, "ascii").digest());
  const q = new URLSearchParams({ app_id: oa.appId, redirect_uri: callbackUrl(), code_challenge: challenge, state });
  return `${OAUTH}/permission?${q}`;
}

type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: string | number; error?: number; error_name?: string; error_reason?: string; error_description?: string; message?: string };

async function tokenRequest(oa: ZaloOa, body: Record<string, string>) {
  const res = await fetch(`${OAUTH}/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", secret_key: oa.secretKey },
    body: new URLSearchParams({ app_id: oa.appId, ...body }),
    signal: AbortSignal.timeout(20_000),
  });
  const j = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!j.access_token || !j.refresh_token) {
    const why = j.error_description || j.error_reason || j.message || j.error_name || `HTTP ${res.status}`;
    throw new Error((await getT())("notify.zalo.noToken", { why, code: j.error ? (await getT())("notify.zalo.codeSuffix", { code: j.error }) : "" }));
  }
  const now = Date.now();
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    accessExpiresAt: new Date(now + (Number(j.expires_in) || 90000) * 1000).toISOString(),
    refreshExpiresAt: new Date(now + 90 * 86400_000).toISOString(),
  };
}

/** Callback: exchange the authorization code for a token. */
export async function exchangeCode(code: string, state: string | null, oaId: string | null, by: string) {
  const oa = await loadOa();
  const pkce = await readSecret<{ verifier: string; state: string; at: number }>(PKCE_KEY);
  if (!oa) throw new Error((await getT())("notify.zalo.noApp"));
  if (!pkce || pkce.state !== state || Date.now() - pkce.at > 15 * 60_000) throw new Error((await getT())("notify.zalo.authExpired"));
  const t = await tokenRequest(oa, { code, grant_type: "authorization_code", code_verifier: pkce.verifier });
  await db.setting.deleteMany({ where: { key: PKCE_KEY } });
  const next: ZaloOa = { ...oa, ...t, oaId: oaId ?? oa.oaId, connectedAt: new Date().toISOString(), connectedBy: by, lastError: null };
  next.oaName = (await oaInfo(t.accessToken))?.name ?? next.oaName;
  await saveOa(next);
}

/** Manual method: paste a Refresh Token from the Zalo API Explorer (developers.zalo.me → Tools → API Explorer). */
export async function connectWithRefreshToken(refreshToken: string, by: string) {
  const oa = await loadOa();
  if (!oa) throw new Error((await getT())("notify.zalo.noApp"));
  const t = await tokenRequest(oa, { refresh_token: refreshToken.trim(), grant_type: "refresh_token" });
  const info = await oaInfo(t.accessToken);
  await saveOa({ ...oa, ...t, oaId: info?.id ?? oa.oaId, oaName: info?.name ?? oa.oaName, connectedAt: new Date().toISOString(), connectedBy: by, lastError: null });
}

/** OA name / ID (to show on the web). Errors are ignored: they don't affect sending. */
async function oaInfo(accessToken: string): Promise<{ id: string; name: string } | null> {
  try {
    const res = await fetch("https://openapi.zalo.me/v2.0/oa/getoa", { headers: { access_token: accessToken }, signal: AbortSignal.timeout(10_000) });
    const j = (await res.json()) as { error?: number; data?: { oa_id?: string | number; name?: string } };
    return j.error === 0 && j.data?.name ? { id: String(j.data.oa_id ?? ""), name: j.data.name } : null;
  } catch {
    return null;
  }
}

let refreshing: Promise<string> | null = null;

/**
 * Access token valid for at least `minMs`; if near expiry, use the refresh token to get a new one.
 * Refresh tokens are single-use: if the web and the background job refresh simultaneously, one fails → re-read the DB, the other has saved the new token.
 */
export async function accessToken(minMs = 10 * 60_000): Promise<string> {
  const oa = await loadOa();
  if (!oa?.refreshToken) throw new Error((await getT())("notify.zalo.notConnected"));
  if (oa.accessToken && oa.accessExpiresAt && new Date(oa.accessExpiresAt).getTime() - Date.now() > minMs) return oa.accessToken;
  refreshing ??= (async () => {
    try {
      const t = await tokenRequest(oa, { refresh_token: oa.refreshToken!, grant_type: "refresh_token" });
      await saveOa({ ...oa, ...t, lastError: null });
      return t.accessToken;
    } catch (err) {
      const again = await loadOa();
      if (again?.accessToken && again.accessExpiresAt && again.refreshToken !== oa.refreshToken && new Date(again.accessExpiresAt).getTime() > Date.now()) return again.accessToken;
      if (again) await saveOa({ ...again, lastError: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

// ------------------------------------------------------------------ ZBS Template Message API

type ZbsResponse<T> = { error: number; message?: string; data?: T; metadata?: { total?: number } };

/** "Access token invalid" error code: token revoked / expired early → get a new one and retry once. */
const TOKEN_INVALID = -124;

async function zbs<T>(path: string, init: RequestInit = {}, retry = true): Promise<ZbsResponse<T>> {
  const token = await accessToken(retry ? undefined : Infinity);
  const res = await fetch(`${BUSINESS}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", access_token: token, ...init.headers },
    signal: AbortSignal.timeout(20_000),
  });
  const j = (await res.json().catch(() => null)) as ZbsResponse<T> | null;
  if (!j) throw new Error((await getT())("notify.zalo.httpError", { status: res.status }));
  if (j.error === TOKEN_INVALID && retry) return zbs<T>(path, init, false);
  return j;
}

const zbsError = async (j: { error: number; message?: string }) => {
  const t = await getT();
  return `${j.message || t("notify.zalo.unknownError")}${t("notify.zalo.codeSuffix", { code: j.error })}`;
};

/** The OA's templates approved by Zalo (ENABLE). */
export async function listTemplates() {
  const j = await zbs<{ templateId: number | string; templateName: string; status: string; templateQuality?: string }[]>("/template/all?offset=0&limit=100&status=1");
  if (j.error !== 0) throw new Error((await getT())("notify.zalo.listFailed", { err: await zbsError(j) }));
  return (j.data ?? []).map((t) => ({ id: String(t.templateId), name: t.templateName, status: t.status, quality: t.templateQuality ?? null }));
}

export async function templateInfo(templateId: string): Promise<Omit<ZaloTemplate, "map" | "savedAt">> {
  const j = await zbs<{
    templateId: string | number;
    templateName: string;
    status: string;
    listParams?: ZaloParam[];
    listButtons?: { type: number; title: string; content: string }[];
    previewUrl?: string;
    price_sdt?: string;
    price?: string;
  }>(`/template/info/v2?template_id=${encodeURIComponent(templateId)}`);
  if (j.error !== 0 || !j.data) throw new Error((await getT())("notify.zalo.templateFailed", { id: templateId, err: await zbsError(j) }));
  const d = j.data;
  return {
    templateId: String(d.templateId),
    templateName: d.templateName,
    status: d.status,
    params: d.listParams ?? [],
    buttons: d.listButtons ?? [],
    previewUrl: d.previewUrl ?? null,
    price: d.price_sdt ?? d.price ?? null,
  };
}

export async function loadTemplate(): Promise<ZaloTemplate | null> {
  const row = await db.setting.findUnique({ where: { key: TEMPLATE_KEY } });
  try {
    return row ? (JSON.parse(row.value) as ZaloTemplate) : null;
  } catch {
    return null;
  }
}
export async function saveTemplate(t: ZaloTemplate) {
  const value = JSON.stringify(t);
  await db.setting.upsert({ where: { key: TEMPLATE_KEY }, create: { key: TEMPLATE_KEY, value }, update: { value } });
}
export async function clearTemplate() {
  await db.setting.deleteMany({ where: { key: TEMPLATE_KEY } });
}

type SendResult = { ok: true; msgId: string; remaining: number | null } | { ok: false; error: string };

/** Send 1 template message to 1 phone number (charged at the template's unit price, deducted from the ZBS Account). */
export async function sendTemplate(phone: string, templateId: string, data: Record<string, string>, trackingId: string): Promise<SendResult> {
  try {
    const j = await zbs<{ msg_id: string; quota?: { remainingQuota?: string } }>("/message/template", {
      method: "POST",
      body: JSON.stringify({ phone, template_id: templateId, template_data: data, tracking_id: trackingId.replace(/[^\w-]/g, "").slice(0, 48) }),
    });
    if (j.error !== 0 || !j.data) return { ok: false, error: await zbsError(j) };
    const left = Number(j.data.quota?.remainingQuota);
    return { ok: true, msgId: j.data.msg_id, remaining: Number.isFinite(left) ? left : null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
