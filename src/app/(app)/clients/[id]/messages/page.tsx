import Link from "next/link";
import { msgImageUrl, parseImages } from "@/lib/msg-images";
import { pageInboxUrl } from "@/lib/inbox-link";
import { InboxLink } from "@/components/inbox-link";
import { connection } from "next/server";
import { db, findPaged } from "@/lib/db";
import { PageFilter } from "@/components/page-filter";
import { clientPages, pageLabel, pageWhere } from "@/lib/client-pages";
import { dateTime, stageLabels } from "@/lib/format";
import { getT } from "@/i18n/server";
import { CopyButton } from "@/components/copy-button";
import { Badge, Card, Empty, type Tone } from "@/components/ui";
import { SyncCountdown } from "@/components/sync-countdown";
import { convSourceWhere, isAdSource, ownAds, sourceOptions } from "@/lib/own-ads";
import { requirePageClient } from "@/lib/access";

const STAGE_TONE: Record<string, Tone> = {
  new: "gray",
  interested: "blue",
  considering: "amber",
  ready_to_buy: "green",
  purchased: "green",
  lost: "red",
  spam: "red",
};

const FILTER_KEYS = ["all", "reply", "hot", "new"] as const;

function scoreTone(s: number): Tone {
  return s >= 75 ? "green" : s >= 50 ? "amber" : s >= 20 ? "gray" : "red";
}

export default async function MessagesPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ c?: string; f?: string; n?: string; p?: string; s?: string }>;
}) {
  await connection();
  const t = await getT();
  const stageLabel = stageLabels(t);
  const sources = sourceOptions(t);
  const { id } = await params;
  await requirePageClient(id); // check access right on the page: the layout may not re-run on client-side navigation
  const { c: selectedId, f = "all", n, p: pageId, s: src } = await searchParams;
  const client = await db.client.findUniqueOrThrow({ where: { id } });
  const pages = clientPages(client);
  // The list shows 100 conversations at a time (500 at once made the page slow); click "Xem thêm" (Show more) to expand.
  const limit = Math.min(1000, Math.max(100, Number(n) || 100));

  // Source: our ads (ad belongs to a connected ad account) / other parties' ads / from ads with unknown ad / unknown.
  const own = await ownAds(id);
  const where = {
    clientId: id,
    AND: convSourceWhere(isAdSource(src) ? src : undefined, [...own.keys()]),
    ...pageWhere(pages, pageId),
    ...(f === "reply" && { needsReply: true }),
    ...(f === "hot" && { leadScore: { gte: 75 } }),
    ...(f === "new" && { analyzedAt: null }),
  };
  const [convs, total, ads, quick] = await Promise.all([
    findPaged(
      (skip, take) =>
        db.conversation.findMany({
          where,
          orderBy: [{ updatedTime: "desc" }, { id: "asc" }],
          skip,
          take,
          select: {
            id: true,
            customerName: true,
            updatedTime: true,
            stage: true,
            leadScore: true,
            needsReply: true,
            analyzedAt: true,
            pageId: true,
            sourceAdId: true,
            adReply: true,
            messages: { orderBy: { createdTime: "desc" }, take: 1, select: { fromCustomer: true, text: true } },
          },
        }),
      limit,
    ),
    db.conversation.count({ where }),
    db.ad.findMany({ where: { clientId: id }, select: { id: true, name: true } }),
    db.setting.findUnique({ where: { key: `sync.quick.${id}` } }),
  ]);
  const q = quick ? (JSON.parse(quick.value) as { at: string; every: number; error?: string }) : null;
  const adName = new Map([...[...own.values()].map((a) => [a.id, a.name] as const), ...ads.map((a) => [a.id, a.name] as const)]);
  const selected = selectedId
    ? await db.conversation.findFirst({ where: { id: selectedId, clientId: id }, include: { messages: { orderBy: { createdTime: "asc" } } } })
    : null;
  const inboxLink = selected && pageInboxUrl(selected.pageId ?? client.metaPageId);
  const qs = (o: Record<string, string | undefined>) => {
    const p = new URLSearchParams(Object.entries({ f, c: selectedId, n, p: pageId, s: src, ...o }).filter(([, v]) => v) as [string, string][]);
    return `?${p}`;
  };

  return (
    <>
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="flex flex-wrap items-start gap-3">
        <PageFilter pages={pages} active={pageId} href={(p) => qs({ p, c: undefined, n: undefined })} />
        <div className="mb-4 flex flex-wrap gap-1 text-xs">
          {[{ key: undefined, label: t("customers.ownAds.all"), hint: "" }, ...sources].map((o) => (
            <Link key={o.label} href={qs({ s: o.key, c: undefined, n: undefined })} title={o.hint} className={`rounded-full px-3 py-1 whitespace-nowrap ${src === o.key ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200"}`}>
              {o.label}
            </Link>
          ))}
        </div>
      </div>
      {client.dataSource === "meta" && (
        <div className="mb-4 ml-auto">
          <SyncCountdown lastAt={q?.at ?? null} every={q?.every ?? 120} error={q?.error} />
        </div>
      )}
    </div>
    <div className="grid gap-6 @2xl:grid-cols-[280px_minmax(0,1fr)] @5xl:grid-cols-[360px_minmax(0,1fr)]">
      <Card
        title={t("customers.messagesPage.convs", { n: total })}
        action={
          <div className="flex flex-wrap gap-1">
            {FILTER_KEYS.map((x) => (
              <Link key={x} href={qs({ f: x, c: undefined, n: undefined })} className={`rounded-md px-2 py-0.5 text-xs whitespace-nowrap ${f === x ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-100"}`}>
                {t(`customers.messagesPage.filter.${x}`)}
              </Link>
            ))}
          </div>
        }
        className="@2xl:sticky @2xl:top-0 @2xl:self-start"
      >
        {!convs.length ? (
          <Empty>{t("customers.messagesPage.none")}</Empty>
        ) : (
          <ul className="-mx-5 -my-5 max-h-[70vh] divide-y divide-slate-100 overflow-y-auto">
            {convs.map((c) => (
              <li key={c.id}>
                <Link href={qs({ c: c.id })} className={`block px-5 py-3 hover:bg-slate-50 ${c.id === selectedId ? "bg-indigo-50" : ""}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium text-slate-900">{c.customerName}</span>
                    <span className="shrink-0 text-xs text-slate-400">{dateTime(c.updatedTime)}</span>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-slate-500">
                    {c.messages[0] && (c.messages[0].fromCustomer ? "" : t("customers.messagesPage.pagePrefix"))}
                    {c.messages[0]?.text}
                  </p>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {c.stage && <Badge tone={STAGE_TONE[c.stage]}>{stageLabel[c.stage]}</Badge>}
                    {c.leadScore != null && <Badge tone={scoreTone(c.leadScore)}>{t("customers.messagesPage.lead", { n: c.leadScore })}</Badge>}
                    {c.needsReply && <Badge tone="red">{t("customers.messagesPage.needsReply")}</Badge>}
                    {!c.analyzedAt && <Badge>{t("customers.messagesPage.notAnalyzed")}</Badge>}
                    {pages.length > 1 && <Badge tone="violet">{pageLabel(pages, c.pageId)}</Badge>}
                    {c.sourceAdId ? own.has(c.sourceAdId) ? <Badge tone="green">{t("customers.ownAds.wz.label")}</Badge> : <Badge tone="amber">{t("customers.ownAds.other.label")}</Badge> : c.adReply && <Badge>{t("customers.ownAds.ad.label")}</Badge>}
                  </div>
                </Link>
              </li>
            ))}
            {total > convs.length && (
              <li>
                <Link href={qs({ n: String(limit + 100) })} scroll={false} className="block px-5 py-3 text-center text-sm font-medium text-indigo-600 hover:bg-slate-50">
                  {t("customers.messagesPage.more", { n: total - convs.length })}
                </Link>
              </li>
            )}
          </ul>
        )}
      </Card>

      {selected ? (
        <div className="space-y-4">
          <Card
            title={selected.customerName}
            action={
              <span className="flex flex-wrap items-center justify-end gap-x-3 text-xs">
                {selected.sourceAdId && <span className="text-slate-500">{t("customers.messagesPage.adLine", { source: t(own.has(selected.sourceAdId) ? "customers.ownAds.wz.label" : "customers.ownAds.other.label"), ad: adName.get(selected.sourceAdId) ?? selected.sourceAdId })}</span>}
                {inboxLink && (
                  <InboxLink href={inboxLink} name={selected.customerName} className="font-medium text-indigo-600 hover:underline">
                    {t("customers.messagesPage.openInbox")}
                  </InboxLink>
                )}
              </span>
            }
          >
            <div className="space-y-2">
              {selected.messages.map((m) => (
                <div key={m.id} className={`flex ${m.fromCustomer ? "justify-start" : "justify-end"}`}>
                  <div className={`max-w-[75%] rounded-2xl px-3.5 py-2 text-sm ${m.fromCustomer ? "bg-slate-100 text-slate-900" : "bg-indigo-600 text-white"}`}>
                    {parseImages(m.images).length > 0 && (
                      <div className="mb-1 flex flex-wrap gap-1">
                        {parseImages(m.images).map((rel) => (
                          <a key={rel} href={msgImageUrl(rel)} target="_blank" rel="noreferrer">
                            {/* eslint-disable-next-line @next/next/no-img-element -- private image served via an authenticated API */}
                            <img src={msgImageUrl(rel)} alt={t("customers.messagesPage.imgAlt")} loading="lazy" className="max-h-40 rounded-lg" />
                          </a>
                        ))}
                      </div>
                    )}
                    <p className="whitespace-pre-line">{m.text}</p>
                    <p className={`mt-0.5 text-[10px] ${m.fromCustomer ? "text-slate-400" : "text-indigo-200"}`}>{dateTime(m.createdTime)}</p>
                  </div>
                </div>
              ))}
            </div>
          </Card>
          <Card title={t("customers.messagesPage.analysis")}>
            {selected.analyzedAt ? (
              <div className="space-y-3 text-sm">
                <div className="flex flex-wrap gap-2">
                  {selected.stage && <Badge tone={STAGE_TONE[selected.stage]}>{stageLabel[selected.stage]}</Badge>}
                  {selected.leadScore != null && <Badge tone={scoreTone(selected.leadScore)}>{t("customers.messagesPage.leadScore", { n: selected.leadScore })}</Badge>}
                  {selected.sentiment && <Badge tone={selected.sentiment === "negative" ? "red" : selected.sentiment === "positive" ? "green" : "gray"}>{t(`customers.messagesPage.sentiment.${selected.sentiment as "positive" | "neutral" | "negative"}`)}</Badge>}
                  {(JSON.parse(selected.tags ?? "[]") as string[]).map((tag) => <Badge key={tag} tone="violet">{tag}</Badge>)}
                </div>
                <p><span className="text-slate-500">{t("customers.messagesPage.need")}</span> {selected.intent}</p>
                {selected.analysisNote && <p><span className="text-slate-500">{t("customers.messagesPage.saleNote")}</span> {selected.analysisNote}</p>}
                {selected.suggestedReply && (
                  <div className="rounded-lg border border-indigo-200 bg-indigo-50/50 p-3">
                    <div className="mb-1 flex items-center justify-between">
                      <span className="text-xs font-semibold text-indigo-700">{t("customers.messagesPage.suggestedReply")}</span>
                      <CopyButton text={selected.suggestedReply} />
                    </div>
                    <p className="whitespace-pre-line text-slate-800">{selected.suggestedReply}</p>
                  </div>
                )}
                <p className="text-xs text-slate-400">{t("customers.messagesPage.analyzedAt", { at: dateTime(selected.analyzedAt) })}</p>
              </div>
            ) : (
              <Empty>{t("customers.messagesPage.notYetAnalyzed")}</Empty>
            )}
          </Card>
        </div>
      ) : (
        <Empty>{t("customers.messagesPage.pick")}</Empty>
      )}
    </div>
    </>
  );
}
