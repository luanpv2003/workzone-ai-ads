import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "./db";
import { getT } from "@/i18n/server";
import { clientIp, limiter } from "./throttle";

// Login for the agency team: passwords hashed with scrypt, sessions stored in the DB (the cookie only holds a random token).

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, keylen: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;
const PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const SESSION_COOKIE = "wz_session";
const SESSION_DAYS = 30;
export const MIN_PASSWORD = 10;

export async function hashPassword(pw: string) {
  if (pw.length < MIN_PASSWORD) throw new Error((await getT())("system.auth.passwordShort", { n: MIN_PASSWORD }));
  const salt = randomBytes(16);
  const hash = await scrypt(pw, salt, 64, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

async function verifyPassword(pw: string, stored: string) {
  const [alg, N, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const got = await scrypt(pw, Buffer.from(salt, "base64"), expected.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: PARAMS.maxmem });
  return got.length === expected.length && timingSafeEqual(got, expected);
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// ------------------------------------------------------------ Brute-force protection
// Two counters: 5 failures / 15 minutes per email + client IP (only when the IP is trustworthy, see clientIp),
// and 20 failures / hour per email whatever the IP, so rotating (or faking) IPs does not lift the limit.

const PER_IP = limiter(5, 15 * 60_000);
const PER_EMAIL = limiter(20, 60 * 60_000);

// ------------------------------------------------------------ Login sessions

/** Check email + password, create a session and set the cookie. Returns a readable error or null. */
export async function login(email: string, password: string): Promise<string | null> {
  const ip = await clientIp();
  const e = email.trim().toLowerCase().slice(0, 320);
  const ipKey = ip ? `${e}|${ip}` : null;
  if (PER_EMAIL.blocked(e) || (ipKey && PER_IP.blocked(ipKey))) return (await getT())("system.auth.tooManyFails");
  const user = await db.user.findUnique({ where: { email: e } });
  // Still hash when the user doesn't exist so response times are identical (does not reveal which emails exist).
  const ok = user ? await verifyPassword(password, user.passwordHash) : (await hashPassword("x".repeat(MIN_PASSWORD)), false);
  if (!user || !ok || !user.active) {
    PER_EMAIL.hit(e);
    if (ipKey) PER_IP.hit(ipKey);
    return (await getT())(user && ok && !user.active ? "system.auth.locked" : "system.auth.badCredentials");
  }
  if (ipKey) PER_IP.reset(ipKey);
  await startSession(user.id);
  return null;
}

/** Create a session for this user and set the cookie (after a successful login, or right after first-run setup). */
export async function startSession(userId: string) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000);
  await db.session.create({ data: { id: sha256(token), userId, expiresAt, userAgent: (await headers()).get("user-agent")?.slice(0, 200) } });
  await db.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    // Served over HTTPS: the cookie is only sent over encrypted connections. Disabled when running on http://localhost.
    secure: process.env.NODE_ENV === "production" && process.env.COOKIE_SECURE !== "false",
    path: "/",
    expires: expiresAt,
  });
  // Clean up expired sessions.
  await db.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
}

// ------------------------------------------------------------ First run

let anyUser = false;
/** False only on a fresh installation (no account yet): every page then leads to /setup. Once true it stays true for the process. */
export async function hasUsers() {
  if (anyUser) return true;
  anyUser = (await db.user.count()) > 0;
  return anyUser;
}

export async function logout() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await db.session.deleteMany({ where: { id: sha256(token) } });
  store.delete(SESSION_COOKIE);
}

export type CurrentUser = { id: string; email: string; name: string; role: string };

/** The logged-in user (verified against the DB), null if not logged in. Called multiple times in one request, the DB is queried only once. */
export const currentUser = cache(async (): Promise<CurrentUser | null> => {
  let token: string | undefined;
  try {
    token = (await cookies()).get(SESSION_COOKIE)?.value;
  } catch {
    return null; // outside a request (background job)
  }
  return token ? sessionUser(token) : null;
});

/** Look up the session by the cookie token (also used in the proxy, where the page's cookies() is unavailable). */
export async function sessionUser(token: string): Promise<CurrentUser | null> {
  const s = await db.session.findUnique({ where: { id: sha256(token) }, include: { user: true } });
  if (!s || s.expiresAt < new Date() || !s.user.active) return null;
  return { id: s.user.id, email: s.user.email, name: s.user.name, role: s.user.role };
}

/** For Server Actions / Route Handlers: throws when not logged in. */
export async function requireUser() {
  const u = await currentUser();
  if (!u) throw new Error((await getT())("system.auth.sessionExpired"));
  return u;
}

export async function requireAdmin() {
  const u = await requireUser();
  if (u.role !== "admin") throw new Error((await getT())("system.auth.adminOnly"));
  return u;
}

/** For pages/layouts: redirects to the login page when not logged in. */
export async function requirePageUser() {
  const u = await currentUser();
  if (!u) redirect("/login");
  return u;
}

/** Name of the acting user for the activity log; null for automatic jobs. */
export async function actorName() {
  return (await currentUser())?.name ?? null;
}
