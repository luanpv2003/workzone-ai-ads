import { publicUrl } from "./zalo";

/**
 * Is this installation reachable from the internet over HTTPS? Claude.ai (web), ChatGPT and Claude Desktop's custom connectors
 * call the MCP endpoint from their own servers, so they only work with a public https:// PUBLIC_URL.
 * "local" = http://, localhost, a private / link-local IP or a *.local / *.lan name (a computer at home or in the office).
 */
export function isLocalAddress(url: string = publicUrl()): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return true;
  }
  if (u.protocol !== "https:") return true;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h.includes(":")) return h === "::1" || /^(fc|fd|fe8|fe9|fea|feb)/.test(h); // IPv6: loopback, unique-local, link-local
  if (h === "localhost" || !h.includes(".") || /\.(localhost|local|lan|internal|home\.arpa)$/.test(h)) return true;
  const ip = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)?.slice(1).map(Number);
  if (!ip) return false;
  const [a, b] = ip;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}
