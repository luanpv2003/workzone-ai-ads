import { currentUser } from "@/lib/auth";
import { clientRoleOf } from "@/lib/access";
import { db } from "@/lib/db";
import { getT } from "@/i18n/server";
import { FEEDBACK_FIELDS, SHEET_COLUMNS, sheetRows, sheetValues } from "@/lib/lead-sheet";

const csv = (v: unknown) => {
  const s = v == null ? "" : String(v);
  const safe = /^[=+\-@]/.test(s) && !s.startsWith("'") ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};

/** Download a CSV of the merged lead list (Form + Messages) with sales ratings. Full access on the client only; logged. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const t = await getT();
  const user = await currentUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const { id } = await ctx.params;
  const role = await clientRoleOf(user, id);
  if (!role) return new Response("Not found", { status: 404 });
  if (role !== "admin") return new Response(t("system.exports.leadsAdminOnly"), { status: 403 });
  const client = await db.client.findUnique({ where: { id }, select: { name: true } });
  if (!client) return new Response("Not found", { status: 404 });
  const rows = await sheetRows(id);
  const head = [...SHEET_COLUMNS, ...FEEDBACK_FIELDS.map((f) => t(f.labelKey))];
  const lines = rows.map((r) => [...sheetValues(r), ...FEEDBACK_FIELDS.map((f) => r.fb[f.field])].map(csv).join(","));
  await db.activity.create({ data: { clientId: id, kind: "pii", message: t("system.exports.leadsLog", { n: rows.length }), actor: user.name } });
  const date = new Date().toISOString().slice(0, 10);
  return new Response(`﻿${[head.map(csv).join(","), ...lines].join("\r\n")}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${t("system.exports.leadsFile")}-${date}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
