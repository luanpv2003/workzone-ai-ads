"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { getT } from "@/i18n/server";
import { errorMessage, logActivity } from "@/lib/activity";
import { createPersonalToken } from "@/lib/mcp/auth";

// Connect your Claude (MCP endpoint): the user's own personal token. The token is shown only once at creation.

export async function createMcpTokenAction(name: string): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  try {
    const u = await requireUser();
    const t = await getT();
    if ((await db.mcpToken.count({ where: { userId: u.id, kind: "personal", revokedAt: null } })) >= 10) throw new Error(t("customers.mcpActions.tooMany"));
    const token = await createPersonalToken(u.id, name);
    await logActivity(null, "sync", t("customers.mcpActions.created", { user: u.name, name: name.trim() || "Claude Code" }));
    revalidatePath("/connections/mcp");
    revalidatePath("/connect-ai");
    return { ok: true, token };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function revokeMcpTokenAction(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const u = await requireUser();
    const r = await db.mcpToken.updateMany({ where: { id, userId: u.id, revokedAt: null }, data: { revokedAt: new Date() } });
    if (!r.count) throw new Error((await getT())("customers.mcpActions.notFound"));
    revalidatePath("/connections/mcp");
    revalidatePath("/connect-ai");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
