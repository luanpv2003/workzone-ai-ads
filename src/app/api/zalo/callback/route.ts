import { NextResponse, type NextRequest } from "next/server";
import { currentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { exchangeCode, publicUrl } from "@/lib/zalo";
import { getT } from "@/i18n/server";

// Zalo redirects the OA admin here after clicking "Cho phép" (Allow) (?code=…&oa_id=…&state=…). Logged-in admins only.
// This callback URL must be registered in the Zalo app: developers.zalo.me → app → Official Account → General settings.

export async function GET(req: NextRequest) {
  const t = await getT();
  const back = (q: string) => NextResponse.redirect(`${publicUrl()}/connections/channels?${q}#zalo`);
  const u = await currentUser();
  if (!u || u.role !== "admin") return NextResponse.redirect(`${publicUrl()}/login?next=/connections/channels`);
  const p = req.nextUrl.searchParams;
  const code = p.get("code");
  if (!code) return back(`zalo_error=${encodeURIComponent(p.get("error_description") || p.get("error") || t("system.hooks.zaloNoCode"))}`);
  try {
    await exchangeCode(code, p.get("state"), p.get("oa_id"), u.name);
    await db.activity.create({ data: { clientId: null, kind: "zalo", message: t("system.hooks.zaloConnectedLog"), actor: u.name } });
    return back("zalo=ok");
  } catch (err) {
    return back(`zalo_error=${encodeURIComponent(err instanceof Error ? err.message : String(err))}`);
  }
}
