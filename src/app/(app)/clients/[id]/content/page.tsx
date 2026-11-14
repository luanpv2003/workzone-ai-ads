import Link from "next/link";
import { connection } from "next/server";
import { db } from "@/lib/db";
import { Badge, Card, type Tone } from "@/components/ui";
import { dateTime } from "@/lib/format";
import { parseItems, parsePlans } from "@/lib/content-review";
import { NewReview } from "@/components/content-review/new-review";
import { requirePageClient } from "@/lib/access";
import { getT } from "@/i18n/server";
import type { MessageKey } from "@/i18n/translate";

const STATUS: Record<string, { label: MessageKey; tone: Tone }> = {
  new: { label: "targeting.contentList.status.new", tone: "mut" },
  checking: { label: "targeting.contentList.status.checking", tone: "ai" },
  checked: { label: "targeting.contentList.status.checked", tone: "info" },
  planning: { label: "targeting.contentList.status.planning", tone: "ai" },
  planned: { label: "targeting.contentList.status.planned", tone: "pri" },
  final: { label: "targeting.contentList.status.final", tone: "good" },
  failed: { label: "targeting.contentList.status.failed", tone: "bad" },
};

// Content review → run ads: each batch is a set of posts / images / videos the user wants to run.
export default async function ContentReviewsPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  const t = await getT();
  await requirePageClient(id); // check access right on the page: the layout may not re-run on client-side navigation
  const reviews = await db.contentReview.findMany({ where: { clientId: id }, orderBy: { updatedAt: "desc" }, take: 50 });
  return (
    <div className="space-y-6">
      <Card>
        <h2 className="text-[15px] font-semibold text-ink">{t("targeting.contentList.title")}</h2>
        <p className="mt-1 text-sm text-mut">
          {t("targeting.contentList.intro")}
        </p>
        <NewReview clientId={id} />
      </Card>
      {reviews.length > 0 && (
        <Card title={t("targeting.contentList.batches")}>
          <ul className="divide-y divide-line">
            {reviews.map((r) => {
              const s = STATUS[r.status] ?? STATUS.new;
              const n = parseItems(r.items).length;
              const v = parsePlans(r.plans).length;
              return (
                <li key={r.id}>
                  <Link href={`/clients/${id}/content/${r.id}`} className="flex flex-wrap items-center justify-between gap-2 py-3 hover:bg-hover">
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-ink">{r.title}</span>
                      <span className="text-xs text-mut">
                        {t("targeting.contentList.counts", { n, versions: v ? t("targeting.contentList.versions", { v }) : "", when: dateTime(r.updatedAt) })}
                      </span>
                    </span>
                    <Badge tone={s.tone}>{t(s.label)}</Badge>
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}
