import { NextResponse, type NextRequest } from "next/server";
import { currentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { exchangeGoogleCode } from "@/lib/google-ads";
import { publicUrl } from "@/lib/zalo";
import { getT } from "@/i18n/server";

// Google redirects the admin here after consent (?code=…&state=…). Logged-in admins only.
// This URL must be registered in Google Cloud → Google Auth Platform → Clients → Authorized redirect URIs.

export async function GET(req: NextRequest) {
  const t = await getT();
  const back = (q: string) => NextResponse.redirect(`${publicUrl()}/connections/google?${q}`);
  const u = await currentUser();
  if (!u || u.role !== "admin") return NextResponse.redirect(`${publicUrl()}/login?next=/connections/google`);
  const p = req.nextUrl.searchParams;
  const code = p.get("code");
  if (!code) return back(`google_error=${encodeURIComponent(p.get("error_description") || p.get("error") || t("settings.googleCallback.noCode"))}`);
  try {
    await exchangeGoogleCode(code, p.get("state"), u.name);
    await db.activity.create({ data: { clientId: null, kind: "google", message: t("settings.googleCallback.activity"), actor: u.name } });
    return back("google=ok");
  } catch (err) {
    return back(`google_error=${encodeURIComponent(err instanceof Error ? err.message : String(err))}`);
  }
}
