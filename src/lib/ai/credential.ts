import { spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { db } from "../db";
import { decrypt, encrypt } from "../crypto";
import { DEFAULT_TIER, TIERS, type Tier } from "./model-tiers";

// The system's Claude account, changeable right on the web (System settings → Claude AI), with no need to edit .env or log in on the server.
// - "oauth": a Claude.ai Pro/Max plan token, created with `claude setup-token` (sk-ant-oat…, valid 1 year) → called via Claude Code.
// - "api": an API key from console.anthropic.com (sk-ant-api…) → calls the Anthropic API, billed per token.
// Nothing saved on the web → use the server configuration as before (.env / account already /login'ed on the server).
// Businesses (Workspaces) other than the platform workspace can paste their own Claude (Users & permissions → Business Claude): every call
// for that business's clients uses its own account. If none is pasted, the platform's Claude is used.

export type ClaudeCredKind = "oauth" | "api";
type ClaudeCred = { kind: ClaudeCredKind; token: string; label: string; savedAt: string; savedBy: string };
/** How Claude is called for this call. token is only present when taken from the web. */
export type ClaudeConn = {
  provider: "api" | "cli";
  /** web / server: the platform's Claude (pasted on the web / server configuration). workspace: the business's own Claude. */
  source: "web" | "server" | "workspace";
  kind: ClaudeCredKind | null;
  token: string | null;
  label: string | null;
  /** Business of this call (for recording usage). */
  workspaceId?: string | null;
};

const KEY = "claude.credential";
let cache: { at: number; value: ClaudeCred | null } | null = null;

export function credKind(token: string): ClaudeCredKind | null {
  if (/^sk-ant-oat\d*-[\w-]{20,}$/.test(token)) return "oauth";
  if (/^sk-ant-api\d*-[\w-]{20,}$/.test(token)) return "api";
  return null;
}

/** Re-read at most every 30 seconds (web and background are 2 separate processes, both reading from the DB). */
export async function storedCredential(): Promise<ClaudeCred | null> {
  if (cache && Date.now() - cache.at < 30_000) return cache.value;
  const row = await db.setting.findUnique({ where: { key: KEY } });
  let value: ClaudeCred | null = null;
  try {
    value = row ? (JSON.parse(decrypt(row.value)) as ClaudeCred) : null;
  } catch {
    value = null; // ENCRYPTION_KEY changed / data corrupted: treat as not saved
  }
  cache = { at: Date.now(), value };
  return value;
}

export async function saveCredential(c: Omit<ClaudeCred, "savedAt">) {
  const value = encrypt(JSON.stringify({ ...c, savedAt: new Date().toISOString() }));
  await db.setting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } });
  cache = null;
}

export async function clearCredential() {
  await db.setting.deleteMany({ where: { key: KEY } });
  cache = null;
}

/** Server configuration (.env): use the API if an API key exists, otherwise Claude Code. Forced by CLAUDE_PROVIDER. */
function serverProvider(): "api" | "cli" {
  const p = process.env.CLAUDE_PROVIDER;
  if (p === "api" || p === "cli") return p;
  return process.env.ANTHROPIC_API_KEY ? "api" : "cli";
}

export function connFor(c: ClaudeCred | null): ClaudeConn {
  if (!c) return { provider: serverProvider(), source: "server", kind: null, token: null, label: null };
  return { provider: c.kind === "api" ? "api" : "cli", source: "web", kind: c.kind, token: c.token, label: c.label };
}

export async function claudeConn(): Promise<ClaudeConn> {
  return connFor(await storedCredential());
}

// ------------------------------------------------------------ Claude per business

/** Which client / business this call is for. Background jobs set it for the whole run (runWithAiScope); a value passed directly by the caller takes priority. */
type AiScope = { clientId?: string | null; workspaceId?: string | null };
const scopeStore = new AsyncLocalStorage<AiScope>();
export const runWithAiScope = <T>(scope: AiScope, fn: () => Promise<T>) => scopeStore.run(scope, fn);
export const currentAiScope = () => scopeStore.getStore() ?? {};

type WsInfo = { id: string; name: string; cred: ClaudeCred | null };
const wsCache = new Map<string, { at: number; value: WsInfo | null }>();
const clientWsCache = new Map<string, { at: number; value: string | null }>();

async function workspaceIdOf(scope: AiScope): Promise<string | null> {
  if (scope.workspaceId) return scope.workspaceId;
  if (!scope.clientId) return null;
  const hit = clientWsCache.get(scope.clientId);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  const c = await db.client.findUnique({ where: { id: scope.clientId }, select: { workspaceId: true } });
  const value = c?.workspaceId ?? null;
  clientWsCache.set(scope.clientId, { at: Date.now(), value });
  return value;
}

/** Business info (re-read at most every 30 seconds; web and background processes both read from the DB). */
export async function workspaceAi(id: string): Promise<WsInfo | null> {
  const hit = wsCache.get(id);
  if (hit && Date.now() - hit.at < 30_000) return hit.value;
  const w = await db.workspace.findUnique({ where: { id }, select: { id: true, name: true, claudeCred: true } });
  let cred: ClaudeCred | null = null;
  try {
    cred = w?.claudeCred ? (JSON.parse(decrypt(w.claudeCred)) as ClaudeCred) : null;
  } catch {
    cred = null;
  }
  const value = w ? { id: w.id, name: w.name, cred } : null;
  wsCache.set(id, { at: Date.now(), value });
  return value;
}

export async function saveWorkspaceCredential(workspaceId: string, c: Omit<ClaudeCred, "savedAt"> | null) {
  const value = c ? encrypt(JSON.stringify({ ...c, savedAt: new Date().toISOString() })) : null;
  await db.workspace.update({ where: { id: workspaceId }, data: { claudeCred: value } });
  wsCache.delete(workspaceId);
}

/** Claude account for the call: the owning business's own Claude if any; otherwise the platform's Claude. */
export async function claudeConnFor(scope: AiScope = {}): Promise<ClaudeConn> {
  const s = scope.clientId || scope.workspaceId ? scope : currentAiScope();
  const wsId = await workspaceIdOf(s);
  const ws = wsId ? await workspaceAi(wsId) : null;
  if (ws?.cred) {
    const c = ws.cred;
    return { provider: c.kind === "api" ? "api" : "cli", source: "workspace", kind: c.kind, token: c.token, label: c.label, workspaceId: ws.id };
  }
  return { ...(await claudeConn()), workspaceId: ws?.id ?? null };
}

const CLI_ENV_KEYS = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TERM", "TMPDIR", "TZ", "NODE_EXTRA_CA_CERTS", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy"]);

/** Environment variables for Claude Code: a login token from the web takes priority over an account already /login'ed on the server. */
export function cliEnv(conn: ClaudeConn): NodeJS.ProcessEnv {
  // Pass only the variables Claude Code needs. Never pass ENCRYPTION_KEY, DATABASE_URL... because Claude reads messages/images sent by strangers.
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV };
  for (const [k, v] of Object.entries(process.env)) {
    if (CLI_ENV_KEYS.has(k) || /^(ANTHROPIC_|CLAUDE_|DISABLE_|LC_|XDG_)/.test(k)) env[k] = v;
  }
  if (!env.ANTHROPIC_API_KEY) delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDECODE; // avoid being detected as a session nested inside another Claude Code session
  if (conn.kind === "oauth" && conn.token) {
    env.CLAUDE_CODE_OAUTH_TOKEN = conn.token;
    delete env.ANTHROPIC_API_KEY;
  }
  return env;
}

/** Claude Code account logged in on the server (`claude auth status`). null if it cannot be read. */
export async function serverCliAccount(): Promise<{ email: string | null; method: string | null } | null> {
  return new Promise((resolve) => {
    const child = spawn(/*turbopackIgnore: true*/ process.env.CLAUDE_CLI_PATH || "claude", ["auth", "status"], { env: cliEnv(connFor(null)) });
    let out = "";
    const timer = setTimeout(() => (child.kill("SIGTERM"), resolve(null)), 10_000);
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => (clearTimeout(timer), resolve(null)));
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(out) as { loggedIn?: boolean; email?: string; authMethod?: string };
        resolve(j.loggedIn ? { email: j.email ?? null, method: j.authMethod ?? null } : { email: null, method: null });
      } catch {
        resolve(null);
      }
    });
  });
}

// ------------------------------------------------------------ Model per task type (Claude connection → Model per task)

const MODELS_KEY = "claude.models";
let tierCache: { at: number; value: Record<string, Tier> } | null = null;

/** Manual user overrides (only tasks that differ from the default are stored). */
async function tierOverrides(): Promise<Record<string, Tier>> {
  if (tierCache && Date.now() - tierCache.at < 30_000) return tierCache.value;
  const row = await db.setting.findUnique({ where: { key: MODELS_KEY } });
  let value: Record<string, Tier> = {};
  try {
    value = row ? JSON.parse(row.value) : {};
  } catch {}
  tierCache = { at: Date.now(), value };
  return value;
}

export async function tierFor(task: string): Promise<Tier> {
  const o = (await tierOverrides())[task];
  return o && o in TIERS ? o : (DEFAULT_TIER[task] ?? "opus");
}

export async function saveTierOverrides(map: Record<string, Tier>) {
  const clean = Object.fromEntries(Object.entries(map).filter(([task, t]) => t in TIERS && DEFAULT_TIER[task] && DEFAULT_TIER[task] !== t));
  await db.setting.upsert({ where: { key: MODELS_KEY }, create: { key: MODELS_KEY, value: JSON.stringify(clean) }, update: { value: JSON.stringify(clean) } });
  tierCache = null;
}
