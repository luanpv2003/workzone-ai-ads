import { BrandMark } from "@/components/brand-mark";
import { connection } from "next/server";
import { requirePageUser } from "@/lib/auth";
import { oauthClient, redirectInfo } from "@/lib/mcp/auth";
import { decideAuthorize } from "./actions";
import { getT } from "@/i18n/server";
import { BRAND } from "@/lib/brand";

export async function generateMetadata() {
  const t = await getT();
  return { title: t("system.oauth.metaTitle", { app: BRAND.app }) };
}

type Q = { response_type?: string; client_id?: string; redirect_uri?: string; code_challenge?: string; code_challenge_method?: string; state?: string };

// OAuth consent step: Claude.ai / Claude Desktop opens this page (logged into the platform; the proxy redirects to /login if not).
export default async function AuthorizePage({ searchParams }: { searchParams: Promise<Q> }) {
  await connection();
  const t = await getT();
  const user = await requirePageUser();
  const q = await searchParams;
  const client = q.client_id ? await oauthClient(q.client_id) : null;
  const problem = !client
    ? t("system.oauth.notRegistered", { app: BRAND.app })
    : !q.redirect_uri || !client.redirectUris.includes(q.redirect_uri)
      ? t("system.oauth.redirectMismatch")
      : q.response_type !== "code"
        ? t("system.oauth.responseType")
        : q.code_challenge_method !== "S256" || !q.code_challenge
          ? t("system.oauth.pkce")
          : null;
  const target = !problem && q.redirect_uri ? redirectInfo(q.redirect_uri) : null;

  return (
    <div className="grid min-h-full place-items-center bg-slate-50 px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center justify-center gap-2">
          <BrandMark size={36} />
          <span className="text-lg font-semibold text-slate-900">{BRAND.app}</span>
        </div>
        <div className="rounded-xl border border-slate-200 bg-panel p-6 shadow-sm">
          {problem ? (
            <>
              <h1 className="mb-2 text-base font-semibold text-slate-900">{t("system.oauth.cannotGrant")}</h1>
              <p className="text-sm text-slate-600">{problem} {t("system.oauth.reconnect")}</p>
            </>
          ) : (
            <form action={decideAuthorize}>
              <h1 className="text-base font-semibold text-slate-900">{t("system.oauth.allowQuestion", { client: client!.name, app: BRAND.app })}</h1>
              {target && (
                <div className={`mt-2 rounded-lg border px-3 py-2 text-sm ${target.known ? "border-slate-200 bg-slate-50 text-slate-700" : "border-amber-300 bg-amber-50 text-amber-900"}`}>
                  {t("system.oauth.redirectTo")} <b className="break-all font-mono">{target.host}</b>
                  {target.local && <> {t("system.oauth.redirectLocal")}</>}
                  {!target.known && <p className="mt-1">{t("system.oauth.unknownHost")}</p>}
                </div>
              )}
              <p className="mt-2 text-sm text-slate-600">
                {t("system.oauth.withAccount")} <b>{user.email}</b>{t("system.oauth.claudeWill")}
              </p>
              <ul className="mt-2 mb-4 list-disc space-y-1 pl-5 text-sm text-slate-600">
                <li>{t("system.oauth.can1")}</li>
                <li>{t("system.oauth.can2")}</li>
                <li>{t("system.oauth.cannot")}</li>
              </ul>
              <input type="hidden" name="client_id" value={q.client_id} />
              <input type="hidden" name="redirect_uri" value={q.redirect_uri} />
              <input type="hidden" name="code_challenge" value={q.code_challenge} />
              <input type="hidden" name="state" value={q.state ?? ""} />
              <div className="flex gap-2">
                <button name="decision" value="allow" className="h-9 flex-1 rounded-lg bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-700">
                  {t("system.oauth.allow")}
                </button>
                <button name="decision" value="deny" className="h-9 rounded-lg border border-slate-200 px-4 text-sm text-slate-700 hover:bg-slate-50">
                  {t("system.oauth.deny")}
                </button>
              </div>
              <p className="mt-3 text-xs text-slate-500">{t("system.oauth.revoke")}</p>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
