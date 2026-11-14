"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { requireClient } from "@/lib/access";
import { errorMessage, logActivity } from "@/lib/activity";
import { db } from "@/lib/db";
import { getT } from "@/i18n/server";
import { parseLeadNotify } from "@/lib/lead-notify-config";
import { botAnswer, resolveNote, saveBotSettings } from "@/lib/lead-bot-report";

// Bot replies in groups (lib/lead-bot-report.ts): enable Claude, bot instructions (global / per client), test questions on the web.

/** clientId null = global instructions for all clients (admins only). */
export async function saveBotSettingsAction(clientId: string | null, v: { ai: boolean; guide: string }) {
  try {
    const t = await getT();
    if (clientId) await requireClient(clientId, "edit");
    else await requireAdmin();
    await saveBotSettings(clientId, { ai: !!v.ai, guide: String(v.guide ?? "") });
    await logActivity(clientId, "notify", clientId ? t("customers.botActions.settingsGroup", { state: t(v.ai ? "customers.botActions.on" : "customers.botActions.off") }) : t("customers.botActions.settingsGlobal"));
    revalidatePath("/", "layout");
    return { ok: true as const };
  } catch (err) {
    return { ok: false as const, error: errorMessage(err) };
  }
}

/** Test the bot on the web: answers as in the group but doesn't send or store history. */
export async function testBotAnswerAction(clientId: string, question: string) {
  try {
    const { user: u } = await requireClient(clientId, "edit");
    const tr = await getT();
    const q = String(question ?? "").trim().slice(0, 1000);
    if (!q) throw new Error(tr("customers.botActions.questionRequired"));
    const c = await db.client.findUniqueOrThrow({ where: { id: clientId }, select: { id: true, name: true, timezone: true, leadNotify: true } });
    const t0 = Date.now();
    const a = await botAnswer(c, parseLeadNotify(c.leadNotify), q, u.name);
    return { ok: true as const, ...a, ms: Date.now() - t0 };
  } catch (err) {
    return { ok: false as const, error: errorMessage(err) };
  }
}

/** Group memory suggestions (duty roster…): add to the per-client instructions (editable first) or dismiss. */
export async function resolveBotNoteAction(clientId: string, id: string, action: "add" | "dismiss", text?: string) {
  try {
    await requireClient(clientId, "edit");
    await resolveNote(clientId, String(id), action === "add" ? "add" : "dismiss", typeof text === "string" ? text.slice(0, 1000) : undefined);
    if (action === "add") await logActivity(clientId, "notify", (await getT())("customers.botActions.noteAdded"));
    revalidatePath("/", "layout");
    return { ok: true as const };
  } catch (err) {
    return { ok: false as const, error: errorMessage(err) };
  }
}
