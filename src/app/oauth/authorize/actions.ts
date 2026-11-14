"use server";

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { createCode, oauthClient } from "@/lib/mcp/auth";
import { logActivity } from "@/lib/activity";
import { getT } from "@/i18n/server";
import { BRAND } from "@/lib/brand";

/** User clicks Allow / Deny on the consent page: re-check client + redirect_uri then return the code to the client. */
export async function decideAuthorize(form: FormData) {
  const t = await getT();
  const user = await requireUser();
  const clientId = String(form.get("client_id") ?? "");
  const redirectUri = String(form.get("redirect_uri") ?? "");
  const challenge = String(form.get("code_challenge") ?? "");
  const state = String(form.get("state") ?? "");
  const client = await oauthClient(clientId);
  if (!client || !client.redirectUris.includes(redirectUri) || !/^[\w-]{43,128}$/.test(challenge)) throw new Error(t("system.oauth.invalidRequest"));
  const back = new URL(redirectUri);
  if (state) back.searchParams.set("state", state);
  if (form.get("decision") !== "allow") {
    back.searchParams.set("error", "access_denied");
    redirect(back.toString());
  }
  back.searchParams.set("code", await createCode(user.id, clientId, redirectUri, challenge));
  await logActivity(null, "sync", t("system.oauth.logAllowed", { user: user.name, client: client.name, app: BRAND.app }));
  redirect(back.toString());
}
