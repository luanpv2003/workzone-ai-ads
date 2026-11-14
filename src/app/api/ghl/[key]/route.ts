import { db } from "@/lib/db";
import { getT } from "@/i18n/server";

// Webhook from a HighLevel workflow (Pipeline Stage Changed / Opportunity Status Changed → Webhook POST to /api/ghl/<key>).
// No login required: the secret key in the link replaces the session (created / rotated in Client settings → HighLevel CRM).
// The payload is not trusted: it only queues a sync request; the worker reads the real stage from the HighLevel API within ~1 minute.

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

async function hit(key: string) {
  const t = await getT();
  if (!/^[\w-]{20,64}$/.test(key)) return json({ error: t("system.hooks.invalidLink") }, 404);
  const r = await db.client.updateMany({ where: { ghlHookKey: key, ghlToken: { not: null } }, data: { ghlRequestAt: new Date() } });
  return r.count ? json({ ok: true }) : json({ error: t("system.hooks.invalidOrChanged") }, 404);
}

export async function POST(_req: Request, ctx: { params: Promise<{ key: string }> }) {
  return hit((await ctx.params).key);
}

// HighLevel's "Test" button may call GET.
export async function GET(_req: Request, ctx: { params: Promise<{ key: string }> }) {
  return hit((await ctx.params).key);
}
