import { headers } from "next/headers";

// Small in-memory rate limiter (per process) and the client IP as seen behind a trusted reverse proxy.

/**
 * Client IP, or null when unknown. Forwarded headers are only trusted when TRUST_PROXY=true, i.e. a reverse proxy
 * in front of the app sets them (the bundled Caddy and the nginx sample in docs/server.md do). Without a proxy any
 * client could send a fake X-Real-IP / X-Forwarded-For, so they are ignored and callers fall back to other keys.
 */
export async function clientIp(): Promise<string | null> {
  if (!/^(1|true|yes)$/i.test(process.env.TRUST_PROXY ?? "")) return null;
  const h = await headers();
  // X-Real-IP is overwritten by the proxy; otherwise the rightmost X-Forwarded-For entry is the one the proxy appended.
  const ip = h.get("x-real-ip")?.trim() || h.get("x-forwarded-for")?.split(",").pop()?.trim();
  return ip ? ip.slice(0, 64) : null;
}

const MAX_KEYS = 50_000;

/** Fixed-window counter: `hit` counts one event, `blocked` says whether the key is over its limit. Expired entries are evicted. */
export function limiter(limit: number, windowMs: number) {
  const map = new Map<string, { n: number; until: number }>();
  const sweep = () => {
    const now = Date.now();
    for (const [k, v] of map) if (v.until <= now) map.delete(k);
    // Still too many live keys (flood of distinct keys): drop the oldest ones rather than grow without bound.
    if (map.size > MAX_KEYS) for (const k of [...map.keys()].slice(0, map.size - MAX_KEYS)) map.delete(k);
  };
  return {
    blocked(key: string) {
      const f = map.get(key);
      return !!f && f.n >= limit && f.until > Date.now();
    },
    hit(key: string) {
      const now = Date.now();
      const f = map.get(key);
      if (f && f.until > now) f.n++;
      else {
        if (map.size >= MAX_KEYS) sweep();
        map.set(key, { n: 1, until: now + windowMs });
      }
    },
    reset(key: string) {
      map.delete(key);
    },
  };
}
