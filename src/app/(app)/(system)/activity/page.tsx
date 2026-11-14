import Link from "next/link";
import { connection } from "next/server";
import { db } from "@/lib/db";
import { dateTime } from "@/lib/format";
import { Badge, Card, Empty, PageHeader, type Tone } from "@/components/ui";
import { requirePageUser } from "@/lib/auth";
import { visibleClientIds } from "@/lib/access";
import { getT } from "@/i18n/server";
import type { MessageKey } from "@/i18n/translate";

const KIND: Record<string, { label: MessageKey; tone: Tone }> = {
  sync: { label: "system.activity.kind.sync", tone: "gray" },
  audit: { label: "system.activity.kind.audit", tone: "violet" },
  analyze: { label: "system.activity.kind.analyze", tone: "blue" },
  execute: { label: "system.activity.kind.execute", tone: "green" },
  reject: { label: "system.activity.kind.reject", tone: "gray" },
  publish: { label: "system.activity.kind.publish", tone: "green" },
  error: { label: "system.activity.kind.error", tone: "red" },
  nurture: { label: "system.activity.kind.nurture", tone: "blue" },
  audience: { label: "system.activity.kind.audience", tone: "blue" },
  sheet: { label: "system.activity.kind.sheet", tone: "green" },
};

export default async function ActivityPage() {
  await connection();
  const t = await getT();
  const user = await requirePageUser();
  // Regular users: only see the log for their own clients (skip system-wide jobs, clientId null).
  const scope = await visibleClientIds(user);
  const rows = await db.activity.findMany({ where: scope ? { clientId: { in: scope } } : {}, orderBy: { createdAt: "desc" }, take: 200, include: { client: { select: { id: true, name: true } } } });
  return (
    <>
      <PageHeader title={t("system.activity.title")} subtitle={t("system.activity.subtitle")} />
      <Card>
        {!rows.length ? (
          <Empty>{t("system.activity.empty")}</Empty>
        ) : (
          <ul className="-my-5 divide-y divide-slate-100">
            {rows.map((r) => (
              <li key={r.id} className="flex items-start gap-3 py-3 text-sm">
                <span className="w-28 shrink-0 text-xs text-slate-400">{dateTime(r.createdAt)}</span>
                <Badge tone={KIND[r.kind]?.tone}>{KIND[r.kind] ? t(KIND[r.kind].label) : r.kind}</Badge>
                {r.client && (
                  <Link href={`/clients/${r.client.id}`} className="shrink-0 font-medium text-indigo-600 hover:underline">
                    {r.client.name}
                  </Link>
                )}
                <span className="min-w-0 flex-1 text-slate-700">{r.message}</span>
                <span className="shrink-0 text-xs text-slate-400">{r.actor ?? t("system.activity.system")}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
