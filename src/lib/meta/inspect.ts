// Inspect an access token: whose it is, which permissions are missing, when it expires,
// and list the Pages / Instagram / ad accounts the token can access.
import { metaFetch } from "./rate-limit";
import { getT } from "@/i18n/server";
import type { MessageKey } from "@/i18n/translate";

const VERSION = process.env.META_API_VERSION || "v23.0";
const BASE = `https://graph.facebook.com/${VERSION}`;

export const REQUIRED_PERMISSIONS = [
  "ads_management",
  "ads_read",
  "business_management",
  "pages_show_list",
  "pages_read_engagement",
  "pages_read_user_content",
  "pages_manage_ads",
  "pages_manage_metadata",
  "pages_messaging",
  "leads_retrieval", // read Instant Form leads for the customer directory
];

export type TokenInspection = {
  userId: string;
  userName: string;
  expiresAt: string | null | undefined; // ISO; null = never expires; undefined = expiry couldn't be read
  missingPermissions: string[];
  pages: { id: string; name: string; instagramId: string | null; instagramUsername: string | null }[];
  adAccounts: { id: string; name: string; currency: string; active: boolean }[];
};

/** Meta tokens never contain whitespace: strip spaces, newlines, quotes, and a copied-in "access_token=". */
export function cleanToken(raw: string) {
  return raw.replace(/^\s*(access_token=)?/i, "").replace(/["'\s]/g, "");
}

// Specific cause of a token error (code 190) per Meta's error_subcode.
const TOKEN_ERRORS: Record<number, MessageKey> = {
  458: "targeting.inspect.e458",
  459: "targeting.inspect.e459",
  460: "targeting.inspect.e460",
  463: "targeting.inspect.e463",
  464: "targeting.inspect.e464",
  467: "targeting.inspect.e467",
};

async function get<T>(path: string, token: string, params: Record<string, string> = {}): Promise<T> {
  const qs = new URLSearchParams({ ...params, access_token: token });
  const res = await metaFetch(`${BASE}${path}?${qs}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const e = json.error ?? {};
    const t = await getT();
    if (e.code === 190) {
      const reason = TOKEN_ERRORS[e.error_subcode]
        ? t(TOKEN_ERRORS[e.error_subcode])
        : /malformed|parse|cannot be decrypted/i.test(e.message ?? "")
          ? t("targeting.inspect.malformed")
          : t("targeting.inspect.invalid");
      throw new Error(t("targeting.inspect.metaCode", { reason, detail: e.message ?? t("targeting.inspect.code190") }));
    }
    throw new Error(e.error_user_msg || e.message || t("targeting.inspect.httpError", { status: res.status }));
  }
  return json as T;
}

async function all<T>(path: string, token: string, params: Record<string, string>): Promise<T[]> {
  const out: T[] = [];
  let page = await get<{ data: T[]; paging?: { next?: string } }>(path, token, params);
  out.push(...page.data);
  while (page.paging?.next && out.length < 500) {
    const res = await metaFetch(page.paging.next);
    const json = await res.json().catch(() => ({}));
    // If a later page errors, report the error; don't return an incomplete list as if it were complete.
    if (!res.ok || json.error || !Array.isArray(json.data)) throw new Error(json.error?.message || (await getT())("targeting.inspect.nextPage", { status: res.status }));
    page = json;
    out.push(...page.data);
  }
  return out;
}

export async function inspectToken(token: string): Promise<TokenInspection> {
  const me = await get<{ id: string; name: string }>("/me", token, { fields: "id,name" });

  const [perms, pages, adAccounts, debug] = await Promise.all([
    get<{ data: { permission: string; status: string }[] }>("/me/permissions", token),
    all<{ id: string; name: string; instagram_business_account?: { id: string; username?: string } }>("/me/accounts", token, {
      fields: "id,name,instagram_business_account{id,username}",
      limit: "100",
    }),
    all<{ account_id: string; name: string; currency: string; account_status: number }>("/me/adaccounts", token, {
      fields: "account_id,name,currency,account_status",
      limit: "200",
    }),
    // An app admin's token can read its own info; ignore errors.
    get<{ data: { expires_at?: number; data_access_expires_at?: number } }>("/debug_token", token, { input_token: token }).catch(() => null),
  ]);

  const granted = new Set(perms.data.filter((p) => p.status === "granted").map((p) => p.permission));
  // User tokens have 2 expiries: token expiry and data access expiry (90 days). Take whichever comes first.
  const exps = [debug?.data.expires_at, debug?.data.data_access_expires_at].filter((x): x is number => !!x);
  const exp = exps.length ? Math.min(...exps) : null;

  return {
    userId: me.id,
    userName: me.name,
    expiresAt: !debug ? undefined : exp ? new Date(exp * 1000).toISOString() : null,
    missingPermissions: REQUIRED_PERMISSIONS.filter((p) => !granted.has(p)),
    pages: pages.map((p) => ({
      id: p.id,
      name: p.name,
      instagramId: p.instagram_business_account?.id ?? null,
      instagramUsername: p.instagram_business_account?.username ?? null,
    })),
    adAccounts: adAccounts.map((a) => ({ id: `act_${a.account_id}`, name: a.name, currency: a.currency, active: a.account_status === 1 })),
  };
}
