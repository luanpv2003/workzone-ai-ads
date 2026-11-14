import Link from "next/link";
import type { ClientPage } from "@/lib/client-pages";
import { getT } from "@/i18n/server";

/** Filter by Facebook Page (only shown when the client has multiple Pages). href(pageId) returns a link that keeps the other params. */
export async function PageFilter({ pages, active, href }: { pages: ClientPage[]; active?: string; href: (pageId?: string) => string }) {
  if (pages.length < 2) return null;
  const t = await getT();
  const cls = (on: boolean) => `rounded-full px-3 py-1 text-xs ${on ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200"}`;
  const current = pages.some((p) => p.id === active) ? active : undefined;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <span className="text-xs text-slate-500">{t("core.pageFilter.label")}</span>
      <Link href={href()} className={cls(!current)}>{t("core.pageFilter.all", { n: pages.length })}</Link>
      {pages.map((p) => (
        <Link key={p.id} href={href(p.id)} className={cls(current === p.id)}>
          {p.name}
          {p.primary && <span className="opacity-70"> · {t("core.pageFilter.primary")}</span>}
        </Link>
      ))}
    </div>
  );
}
