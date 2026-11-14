"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { requireWorkspaceAdmin } from "@/lib/access";
import { db } from "@/lib/db";
import { errorMessage, logActivity } from "@/lib/activity";
import { generateStructured } from "@/lib/ai/claude";
import { claudeConn, clearCredential, connFor, credKind, saveCredential, saveTierOverrides, saveWorkspaceCredential, workspaceAi, type ClaudeConn } from "@/lib/ai/credential";
import { DEFAULT_TIER, TIERS, taskLabel, type Tier } from "@/lib/ai/model-tiers";
import { getT } from "@/i18n/server";

// Claude connection (admins only). Codes / keys are never returned to the browser.

type R = { ok: true; message: string } | { ok: false; error: string };

/** Make a very short Claude call to ensure the code / key works. */
async function ping(conn: ClaudeConn) {
  const t0 = Date.now();
  const r = await generateStructured({
    system: "You are a connection test. Return ok = true.",
    prompt: "Connection test.",
    schema: z.object({ ok: z.boolean() }),
    effort: "low",
    conn,
  });
  return (await getT())("ai.actions.pingOk", { seconds: Math.round((Date.now() - t0) / 1000), model: r.model });
}

export async function saveClaudeAction(token: string, label: string): Promise<R> {
  try {
    const u = await requireAdmin();
    const tr = await getT();
    const t = token.trim().replace(/\s+/g, "");
    const kind = credKind(t);
    if (!kind) throw new Error(tr("ai.actions.badToken"));
    const name = label.trim() || tr(kind === "oauth" ? "ai.actions.defaultOauthLabel" : "ai.actions.defaultApiLabel");
    // Test before saving: if the code is wrong, keep the account currently in use.
    const msg = await ping(connFor({ kind, token: t, label: name, savedAt: "", savedBy: u.name }));
    await saveCredential({ kind, token: t, label: name, savedBy: u.name });
    await logActivity(null, "sync", tr("ai.actions.logSwitched", { name, kind: tr(kind === "oauth" ? "ai.actions.kindOauth" : "ai.actions.kindApi") }));
    revalidatePath("/", "layout");
    return { ok: true, message: tr("ai.actions.savedUsing", { name, msg }) };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function testClaudeAction(): Promise<R> {
  try {
    await requireAdmin();
    return { ok: true, message: await ping(await claudeConn()) };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function clearClaudeAction(): Promise<R> {
  try {
    await requireAdmin();
    const t = await getT();
    await clearCredential();
    await logActivity(null, "sync", t("ai.actions.logCleared"));
    revalidatePath("/", "layout");
    return { ok: true, message: t("ai.actions.cleared") };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** Model per task: only store tasks that differ from the default. */
export async function saveTiersAction(map: Record<string, Tier>): Promise<R> {
  try {
    await requireAdmin();
    const tr = await getT();
    await saveTierOverrides(map);
    const changed = Object.entries(map).filter(([task, t]) => DEFAULT_TIER[task] && DEFAULT_TIER[task] !== t);
    await logActivity(null, "sync", tr("ai.actions.logTiers", { list: changed.length ? changed.map(([task, t]) => `${taskLabel(task, tr)} → ${TIERS[t].label}`).join(", ") : tr("ai.actions.tiersDefault") }));
    revalidatePath("/", "layout");
    return { ok: true, message: tr("ai.actions.tiersSaved") };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

// ------------------------------------------------------------ Workspace's own Claude (Users & permissions)

/** Workspaces other than the platform workspace: Owner / Admin paste their own Claude. The platform workspace uses System settings → Claude AI. */
async function externalWorkspace(workspaceId: string) {
  const { user } = await requireWorkspaceAdmin(workspaceId);
  const ws = await db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { id: true, name: true, platform: true } });
  if (ws.platform) throw new Error((await getT())("ai.actions.platformWorkspace"));
  return { user, ws };
}

const wsConn = (workspaceId: string, kind: "oauth" | "api", token: string, label: string): ClaudeConn => ({
  provider: kind === "api" ? "api" : "cli",
  source: "workspace",
  kind,
  token,
  label,
  workspaceId,
});

export async function saveWorkspaceClaudeAction(workspaceId: string, token: string, label: string): Promise<R> {
  try {
    const { user, ws } = await externalWorkspace(workspaceId);
    const tr = await getT();
    const t = token.trim().replace(/\s+/g, "");
    const kind = credKind(t);
    if (!kind) throw new Error(tr("ai.actions.badTokenWorkspace"));
    const name = label.trim() || tr(kind === "oauth" ? "ai.actions.defaultOauthLabel" : "ai.actions.defaultApiLabel");
    const msg = await ping(wsConn(ws.id, kind, t, name)); // if the code is wrong, keep the account currently in use
    await saveWorkspaceCredential(ws.id, { kind, token: t, label: name, savedBy: user.name });
    await logActivity(null, "sync", tr("ai.actions.logWsConnected", { ws: ws.name, name, kind: tr(kind === "oauth" ? "ai.actions.kindOauth" : "ai.actions.kindApi") }));
    revalidatePath("/users");
    return { ok: true, message: tr("ai.actions.wsSaved", { ws: ws.name, name, msg }) };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function testWorkspaceClaudeAction(workspaceId: string): Promise<R> {
  try {
    const { ws } = await externalWorkspace(workspaceId);
    const info = await workspaceAi(ws.id);
    if (!info?.cred) throw new Error((await getT())("ai.actions.wsNoOwn"));
    return { ok: true, message: await ping(wsConn(ws.id, info.cred.kind, info.cred.token, info.cred.label)) };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function clearWorkspaceClaudeAction(workspaceId: string): Promise<R> {
  try {
    const { ws } = await externalWorkspace(workspaceId);
    const t = await getT();
    await saveWorkspaceCredential(ws.id, null);
    await logActivity(null, "sync", t("ai.actions.logWsCleared", { ws: ws.name }));
    revalidatePath("/users");
    return { ok: true, message: t("ai.actions.wsCleared") };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

