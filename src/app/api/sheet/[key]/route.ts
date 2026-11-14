import { db } from "@/lib/db";
import { getT } from "@/i18n/server";
import { clientBySheetKey, FEEDBACK_FIELDS, saveFeedback, SHEET_COLUMNS, sheetRows, sheetValues } from "@/lib/lead-sheet";

// Google Sheet (Apps Script) reads the lead list and sends back sales ratings. No login required: the secret key in the link
// replaces the session (created / rotated / revoked on each client's Lead list page).

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

export async function GET(req: Request, ctx: { params: Promise<{ key: string }> }) {
  const t = await getT();
  const client = await clientBySheetKey((await ctx.params).key);
  if (!client) return json({ error: t("system.hooks.invalidOrRevoked") }, 404);
  const since = client.sheetSince?.getTime() ?? 0;
  const rows = (await sheetRows(client.id)).filter((r) => r.date.getTime() >= since);
  const p = new URL(req.url).searchParams;
  const v = Number(p.get("v")) || null;
  await db.client.update({ where: { id: client.id }, data: { sheetSeenAt: new Date(), sheetRows: rows.length, sheetScriptV: v, sheetAuto: v ? p.get("auto") === "1" : null } });
  return json({
    client: client.name,
    since: client.sheetSince?.toISOString() ?? null,
    columns: SHEET_COLUMNS,
    feedback: FEEDBACK_FIELDS,
    rows: rows.map((r) => ({ key: r.key, values: sheetValues(r), fb: r.fb })),
  });
}

export async function POST(req: Request, ctx: { params: Promise<{ key: string }> }) {
  const t = await getT();
  const client = await clientBySheetKey((await ctx.params).key);
  if (!client) return json({ error: t("system.hooks.invalidOrRevoked") }, 404);
  const body = (await req.json().catch(() => null)) as { feedback?: unknown } | null;
  if (!body || !Array.isArray(body.feedback) || body.feedback.length > 20000) return json({ error: t("system.hooks.badData") }, 400);
  const changed = await saveFeedback(client.id, body.feedback as { key: string }[], "sheet", "Google Sheet");
  await db.client.update({ where: { id: client.id }, data: { sheetFeedbackAt: new Date() } });
  if (changed) await db.activity.create({ data: { clientId: client.id, kind: "sheet", message: t("system.hooks.sheetLog", { n: changed }), actor: "Google Sheet" } });
  return json({ ok: true, changed });
}
