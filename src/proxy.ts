import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, sessionUser } from "@/lib/auth";
import { clientRoleOf } from "@/lib/access";

// Check the real session in the DB (not expired, account still active) before any page: not logged in → /login.
// Every page, Server Action and API route still checks again on its own (never rely only on the proxy or layout).
export default async function proxy(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  // DB lỗi/bận: cho qua, trang tự kiểm tra lại phiên + quyền (tránh cả web trả lỗi 500 chỉ vì một lần tra chậm).
  const user = token ? await sessionUser(token).catch(() => true as const) : null;
  if (user === true) return NextResponse.next();
  if (user) {
    // Trang của một khách: không có quyền xem thì về trang chủ (trang/layout vẫn tự kiểm tra lại).
    const id = req.nextUrl.pathname.match(/^\/clients\/([^/]+)/)?.[1];
    if (id && id !== "new" && (await clientRoleOf(user, decodeURIComponent(id)).catch(() => "admin" as const)) === null)
      return NextResponse.redirect(new URL("/", req.nextUrl));
    return NextResponse.next();
  }
  const url = new URL("/login", req.nextUrl);
  const next = req.nextUrl.pathname + req.nextUrl.search;
  if (next !== "/") url.searchParams.set("next", next);
  const res = NextResponse.redirect(url);
  if (token) res.cookies.delete(SESSION_COOKIE); // cookie hết hạn / giả: xóa luôn
  return res;
}

export const config = {
  // Skip: login, first-run /setup (closes itself once an account exists), the public privacy and data-deletion pages,
  // client report links /r/<code>, lead-claim links /l/<code>, invites /invite/<code> (secret codes stand in for a
  // session), OAuth discovery /.well-known/* (MCP), static files (Next assets, brand logos, favicon) and the API
  // (API routes check the session themselves and return 401).
  matcher: ["/((?!login|setup|privacy|data-deletion|api|r/|l/|invite/|\\.well-known|_next/static|_next/image|brand/|icon\\.svg).*)"],
};
