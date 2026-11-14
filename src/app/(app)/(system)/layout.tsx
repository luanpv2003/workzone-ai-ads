import type { ReactNode } from "react";
import { connection } from "next/server";
import { db } from "@/lib/db";
import { requirePageUser } from "@/lib/auth";
import { clientWhere, isPlatformStaff, isSystemAdmin, manageableWorkspaces } from "@/lib/access";
import { tokenLevel } from "@/lib/token-status";
import { SystemNav } from "@/components/shell/settings-tabs";
import { getT } from "@/i18n/server";

// Shared frame for "Cài đặt hệ thống" (System settings): title + group menu on the left, each section's content on the right.
export default async function SystemLayout({ children }: { children: ReactNode }) {
  const user = await requirePageUser();
  await connection();
  const t = await getT();
  const [staff, people] = await Promise.all([isPlatformStaff(user), manageableWorkspaces(user).then((w) => w.length > 0)]);
  const meta = await db.client.findMany({
    where: { ...(await clientWhere(user)), dataSource: "meta" },
    select: { dataSource: true, metaAccessToken: true, metaTokenExpiresAt: true, metaTokenError: true, metaTokenMissing: true, metaTokenCheckedAt: true },
  });
  const tokenIssues = meta.filter((c) => ["expired", "error", "missing", "warning"].includes(tokenLevel(c))).length;
  return (
    <>
      <div className="mb-5">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{t("system.layout.title")}</h1>
        <p className="mt-1 text-sm text-mut">{t("system.layout.subtitle")}</p>
      </div>
      <div className="grid grid-cols-1 gap-6 md:grid-cols-[13.5rem_minmax(0,1fr)]">
        <aside className="md:sticky md:top-16 md:self-start">
          <SystemNav admin={isSystemAdmin(user)} staff={staff} people={people} tokenIssues={tokenIssues} />
        </aside>
        <div className="min-w-0">{children}</div>
      </div>
    </>
  );
}
