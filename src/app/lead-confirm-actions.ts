"use server";

import { errorMessage } from "@/lib/activity";
import { ackLead, reportLeadResult } from "@/lib/lead-confirm";
import type { Feedback } from "@/lib/lead-sheet";

// /l/<code> page (link in the bot's lead notification): no login required, the secret code in the link replaces the session. See lib/lead-confirm.ts.

export async function ackLeadAction(code: string, name: string) {
  try {
    const r = await ackLead(String(code), String(name ?? ""));
    return { ok: true as const, by: r.by, at: r.at.toISOString(), already: r.already, posted: r.posted };
  } catch (err) {
    return { ok: false as const, error: errorMessage(err) };
  }
}

export async function reportLeadResultAction(code: string, name: string, patch: Partial<Feedback>) {
  try {
    const r = await reportLeadResult(String(code), String(name ?? ""), patch && typeof patch === "object" ? patch : {});
    return { ok: true as const, changed: r.changed, posted: r.posted };
  } catch (err) {
    return { ok: false as const, error: errorMessage(err) };
  }
}
