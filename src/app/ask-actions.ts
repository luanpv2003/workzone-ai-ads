"use server";

import { requireUser } from "@/lib/auth";
import { aiWorkspaceOf, requireClient, visibleClientIds } from "@/lib/access";
import { errorMessage } from "@/lib/activity";
import { askClaude, type AskAnswer } from "@/lib/ask";

export async function askClaudeAction(clientId: string | null, question: string): Promise<{ ok: true; data: AskAnswer } | { ok: false; error: string }> {
  try {
    const user = clientId ? (await requireClient(clientId, "view")).user : await requireUser();
    return { ok: true, data: await askClaude(clientId, question, clientId ? null : await visibleClientIds(user), clientId ? null : await aiWorkspaceOf(user)) };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
