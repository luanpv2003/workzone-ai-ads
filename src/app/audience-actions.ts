"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { getT } from "@/i18n/server";
import { requireUser } from "@/lib/auth";
import { requireClient } from "@/lib/access";
import { errorMessage, logActivity } from "@/lib/activity";
import {
  analyzeContacts,
  createCustomerListAudience,
  createLookalikeAudience,
  createPageEngagementAudience,
  extractContacts,
  readContactFile,
  type ContactStats,
  type CreatedAudience,
  type PageAudienceEvent,
  type SheetStats,
} from "@/lib/meta/audiences";

const MAX_FILE_BYTES = 30 * 1024 * 1024;

async function fileFrom(form: FormData) {
  const file = form.get("file");
  if (!(file instanceof File) || !file.size) throw new Error((await getT())("targeting.audienceActions.noFile"));
  if (file.size > MAX_FILE_BYTES) throw new Error((await getT())("targeting.audienceActions.fileTooBig"));
  return readContactFile(file.name, Buffer.from(await file.arrayBuffer()));
}

/** Step 1: read the file, count valid phones/emails per sheet. Doesn't store the file or return real data. */
export async function analyzeContactFileAction(
  form: FormData,
): Promise<{ ok: true; sheets: SheetStats[]; unique: ContactStats } | { ok: false; error: string }> {
  try {
    await requireUser();
    return { ok: true, ...analyzeContacts(await fileFrom(form)) };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** Step 2: create a Custom Audience on Meta from the selected sheets (re-read the file, hash with SHA-256, then send). */
export async function createCustomAudienceAction(clientId: string, form: FormData): Promise<{ ok: true; audience: CreatedAudience } | { ok: false; error: string }> {
  try {
    await requireClient(clientId, "edit");
    const t = await getT();
    const client = await db.client.findUniqueOrThrow({ where: { id: clientId } });
    const name = String(form.get("name") ?? "").trim();
    if (!name) throw new Error(t("targeting.audienceActions.noName"));
    const sheets = await fileFrom(form);
    const use = form.getAll("sheets").map(String);
    if (!use.length) throw new Error(t("targeting.audienceActions.noSheet"));
    const { phones, emails } = extractContacts(sheets, use);
    if (form.get("usePhones") !== "1") phones.clear();
    if (form.get("useEmails") !== "1") emails.clear();
    const audience = await createCustomerListAudience(client, { name, description: String(form.get("description") ?? "").trim(), phones, emails });
    await logActivity(clientId, "publish", t("targeting.audienceActions.logCustom", { name, phones: audience.phones, emails: audience.emails }));
    revalidatePath(`/clients/${clientId}/audiences`);
    return { ok: true, audience };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function createLookalikeAction(
  clientId: string,
  input: { name: string; originId: string; country: string; startPct: number; endPct: number },
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  try {
    await requireClient(clientId, "edit");
    const t = await getT();
    const client = await db.client.findUniqueOrThrow({ where: { id: clientId } });
    const name = input.name.trim();
    if (!name) throw new Error(t("targeting.audienceActions.noName"));
    if (!input.originId) throw new Error(t("targeting.audienceActions.noSource"));
    const r = await createLookalikeAudience(client, { ...input, name, country: input.country.trim().toUpperCase() });
    await logActivity(clientId, "publish", t("targeting.audienceActions.logLookalike", { name, start: input.startPct, end: input.endPct, country: input.country }));
    revalidatePath(`/clients/${clientId}/audiences`);
    return { ok: true, id: r.id };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** Page audience: people who messaged / engaged with the Page, optionally with a VN Lookalike. If the source audience is created but the Lookalike fails, still report the source audience as created. */
export async function createPageAudienceAction(
  clientId: string,
  input: { name: string; pageIds: string[]; events: PageAudienceEvent[]; days: number; lookalike: { name: string; pct: number } | null },
): Promise<
  { ok: true; audience: { id: string; name: string }; lookalike: { id: string; name: string } | null; lookalikeError: string | null } | { ok: false; error: string }
> {
  try {
    await requireClient(clientId, "edit");
    const t = await getT();
    const client = await db.client.findUniqueOrThrow({ where: { id: clientId } });
    const name = input.name.trim();
    if (!name) throw new Error(t("targeting.audienceActions.noName"));
    const lal = input.lookalike ? { name: input.lookalike.name.trim(), pct: Math.round(input.lookalike.pct) } : null;
    if (lal && !lal.name) throw new Error(t("targeting.audienceActions.noLookalikeName"));
    if (lal && !(lal.pct >= 1 && lal.pct <= 10)) throw new Error(t("targeting.audienceActions.lookalikePct"));
    const audience = await createPageEngagementAudience(client, { name, pageIds: input.pageIds, events: input.events, days: input.days });
    await logActivity(clientId, "publish", t("targeting.audienceActions.logPage", { name, events: input.events.join(" + "), days: input.days }));
    let lookalike: { id: string; name: string } | null = null;
    let lookalikeError: string | null = null;
    if (lal) {
      try {
        lookalike = await createLookalikeAudience(client, { name: lal.name, originId: audience.id, country: "VN", startPct: 0, endPct: lal.pct });
        await logActivity(clientId, "publish", t("targeting.audienceActions.logPageLookalike", { name: lal.name, pct: lal.pct, source: name }));
      } catch (err) {
        lookalikeError = errorMessage(err);
      }
    }
    revalidatePath(`/clients/${clientId}/audiences`);
    return { ok: true, audience, lookalike, lookalikeError };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
