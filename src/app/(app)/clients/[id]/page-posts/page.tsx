import { connection } from "next/server";
import { db } from "@/lib/db";
import { maskPii } from "@/lib/pii";
import { dateTime, num } from "@/lib/format";
import { Card, Empty } from "@/components/ui";
import { PageFilter } from "@/components/page-filter";
import { clientPages, pageWhere } from "@/lib/client-pages";
import { requirePageClient } from "@/lib/access";
import { getT } from "@/i18n/server";

export default async function PagePostsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ p?: string }> }) {
  await connection();
  const { id } = await params;
  const t = await getT();
  await requirePageClient(id); // check access right on the page: the layout may not re-run on client-side navigation
  const { p: pageId } = await searchParams;
  const client = await db.client.findUniqueOrThrow({ where: { id } });
  const pages = clientPages(client);
  const byPage = pageWhere(pages, pageId);
  const [posts, comments] = await Promise.all([
    db.pagePost.findMany({ where: { clientId: id, ...byPage }, orderBy: { createdTime: "desc" }, take: 60, include: { _count: { select: { commentList: true } } } }),
    db.postComment.findMany({ where: { clientId: id, fromPage: false, post: byPage }, orderBy: { createdTime: "desc" }, take: 80, include: { post: { select: { message: true, permalink: true } } } }),
  ]);
  const filter = <PageFilter pages={pages} active={pageId} href={(p) => (p ? `?p=${p}` : "?")} />;
  if (!posts.length) {
    return (
      <>
      {filter}
      <Empty>
        {client.metaPageId ? t("targeting.pagePosts.empty") : t("targeting.pagePosts.noPage")}
      </Empty>
      </>
    );
  }
  const score = (p: (typeof posts)[number]) => p.reactions + p.comments * 2 + p.shares * 3;
  const avg = posts.reduce((a, p) => a + score(p), 0) / posts.length;
  return (
    <>
    {filter}
    <div className="grid gap-6 @5xl:grid-cols-[minmax(0,1fr)_380px]">
      <Card title={<>{t("targeting.pagePosts.recent")} <span className="font-normal text-slate-400">{t("targeting.pagePosts.summary", { n: posts.length, avg: num(avg) })}</span></>}>
        <ul className="-my-5 divide-y divide-slate-100">
          {posts.map((p) => {
            const hot = score(p) >= avg * 1.5;
            return (
              <li key={p.id} className="flex gap-3 py-3">
                {p.picture ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={p.picture} alt="" className="size-16 shrink-0 rounded-lg object-cover" />
                ) : (
                  <div className="grid size-16 shrink-0 place-items-center rounded-lg bg-slate-100 text-xs text-slate-400">{p.type.includes("video") ? t("targeting.pagePosts.video") : t("targeting.pagePosts.post")}</div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-sm text-slate-800">{p.message || <i className="text-slate-400">{t("targeting.pagePosts.noText")}</i>}</p>
                  <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-slate-500">
                    <span>{dateTime(p.createdTime)}</span>
                    <span>❤ {num(p.reactions)}</span>
                    <span>💬 {num(p.comments)}</span>
                    <span>↗ {num(p.shares)}</span>
                    {hot && <span className="font-medium text-emerald-700">{t("targeting.pagePosts.hot")}</span>}
                    <a href={p.permalink} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">{t("targeting.pagePosts.open")}</a>
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      </Card>
      <Card title={<>{t("targeting.pagePosts.comments")} <span className="font-normal text-slate-400">{t("targeting.pagePosts.latest", { n: comments.length })}</span></>} className="@5xl:self-start">
        {!comments.length ? (
          <p className="text-sm text-slate-500">{t("targeting.pagePosts.noComments")}</p>
        ) : (
          <ul className="-my-2 space-y-3">
            {comments.map((c) => (
              <li key={c.id} className="text-sm">
                <p className="text-slate-800">{maskPii(c.message)}</p>
                <p className="mt-0.5 truncate text-xs text-slate-400">
                  {dateTime(c.createdTime)}
                  {c.likes > 0 && t("targeting.pagePosts.likes", { n: c.likes })}{t("targeting.pagePosts.on", { text: c.post.message.slice(0, 60) || t("targeting.pagePosts.postFallback") })}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
    </>
  );
}
