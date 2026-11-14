import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";

// Fetch for URLs that come from users (draft previews, pasted links): blocks private, loopback, link-local and
// cloud-metadata addresses (checked on the address actually connected to, so DNS rebinding does not get around it),
// re-checks every redirect hop, and enforces a timeout and a size limit.

const BLOCKED = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) BLOCKED.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) BLOCKED.addSubnet(net, bits, "ipv6");

/** True for addresses a user-supplied URL must never reach. */
export function isBlockedAddress(ip: string): boolean {
  const addr = ip.replace(/^\[|\]$/g, "");
  const v = isIP(addr);
  if (v === 4) return BLOCKED.check(addr, "ipv4");
  if (v !== 6) return true;
  // IPv4-mapped / -compatible IPv6 (::ffff:10.0.0.1, ::ffff:a00:1): check the embedded IPv4 address.
  const mapped = addr.match(/^::(?:ffff:(?:0:)?)?(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  if (mapped) return BLOCKED.check(mapped, "ipv4");
  const hex = addr.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (hex) {
    const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16);
    return BLOCKED.check([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join("."), "ipv4");
  }
  return BLOCKED.check(addr, "ipv6");
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** DNS lookup that refuses hosts resolving to any blocked address. */
function safeLookup(hostname: string, options: { all?: boolean; family?: number }, cb: LookupCb) {
  dnsLookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err, "");
    const list = addrs as LookupAddress[];
    if (!list.length || list.some((a) => isBlockedAddress(a.address))) return cb(Object.assign(new Error(`Blocked address for ${hostname}`), { code: "EBLOCKED" }), "");
    if (options.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

export type SafeResponse = { ok: boolean; status: number; url: string; location: string | null; contentType: string; body: Buffer };

type Opts = { timeoutMs?: number; maxRedirects?: number; maxBytes?: number; readBody?: boolean };

function once(url: URL, timeoutMs: number, maxBytes: number, readBody: boolean): Promise<SafeResponse> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.get(url, { lookup: safeLookup as never, timeout: timeoutMs, headers: { "user-agent": "Mozilla/5.0 (compatible; workzone-ai-ads)" } }, (res) => {
      res.on("close", () => clearTimeout(timer));
      const status = res.statusCode ?? 0;
      const base = { ok: status >= 200 && status < 300, status, url: url.toString(), location: res.headers.location ?? null, contentType: String(res.headers["content-type"] ?? "") };
      if (!readBody || status < 200 || status >= 300) {
        res.destroy();
        return resolve({ ...base, body: Buffer.alloc(0) });
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) {
          res.destroy();
          reject(new Error("Response too large"));
        } else chunks.push(c);
      });
      res.on("end", () => resolve({ ...base, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    // Hard limit for the whole request (the socket timeout alone does not stop a slow trickle).
    const timer = setTimeout(() => req.destroy(new Error("Request timed out")), timeoutMs);
    req.on("timeout", () => req.destroy(new Error("Request timed out")));
    req.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/**
 * GET a user-supplied http(s) URL safely. Follows at most `maxRedirects` redirects (0 = return the 3xx with `location`),
 * each hop re-validated. Rejects (throws) on blocked addresses, bad schemes, timeouts and oversize bodies.
 */
export async function safeFetch(input: string | URL, opts: Opts = {}): Promise<SafeResponse> {
  const { timeoutMs = 10_000, maxRedirects = 3, maxBytes = 5_000_000, readBody = true } = opts;
  const deadline = Date.now() + timeoutMs;
  let url = new URL(input);
  for (let hop = 0; ; hop++) {
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only http(s) URLs are allowed");
    if (url.username || url.password) throw new Error("Credentials in URL are not allowed");
    // IP literals skip DNS lookup, so check them here.
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) && isBlockedAddress(host)) throw new Error(`Blocked address ${host}`);
    const left = deadline - Date.now();
    if (left <= 0) throw new Error("Request timed out");
    const res = await once(url, left, maxBytes, readBody);
    if (res.status >= 300 && res.status < 400 && res.location && hop < maxRedirects) {
      url = new URL(res.location, url);
      continue;
    }
    return res;
  }
}
