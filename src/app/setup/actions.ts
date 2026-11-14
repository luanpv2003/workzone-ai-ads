"use server";

import { redirect } from "next/navigation";
import { startSession } from "@/lib/auth";
import { createFirstAdmin, SetupClosedError } from "@/lib/setup";
import { errorMessage } from "@/lib/activity";
import { getT } from "@/i18n/server";

/** First-run setup: create the first admin, log in, then show the Getting started checklist. */
export async function setupAction(_prev: { error: string } | null, form: FormData): Promise<{ error: string } | null> {
  try {
    const password = String(form.get("password") ?? "");
    if (password !== String(form.get("confirm") ?? "")) throw new Error((await getT())("system.authActions.pwMismatch"));
    const user = await createFirstAdmin({ name: String(form.get("name") ?? ""), email: String(form.get("email") ?? ""), password });
    await startSession(user.id);
  } catch (err) {
    if (err instanceof SetupClosedError) redirect("/login");
    return { error: errorMessage(err) };
  }
  redirect("/getting-started");
}
