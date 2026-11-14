import { connection } from "next/server";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { clientPages } from "@/lib/client-pages";
import { briefFor, parseItems, parsePlans, type ReviewBrief } from "@/lib/content-review";
import { PolicyCheckSchema } from "@/lib/ai/schemas";
import { ContentReviewView } from "@/components/content-review/content-review-view";
import { requirePageClient } from "@/lib/access";
import { getT } from "@/i18n/server";

export default async function ContentReviewPage({ params }: { params: Promise<{ id: string; rid: string }> }) {
  await connection();
  const { id, rid } = await params;
  const t = await getT();
  await requirePageClient(id); // check access right on the page: the layout may not re-run on client-side navigation
  const review = await db.contentReview.findUnique({ where: { id: rid }, include: { client: true } });
  if (!review || review.clientId !== id) notFound();
  const client = review.client;
  const items = parseItems(review.items);
  const policy = review.policy ? PolicyCheckSchema.safeParse(JSON.parse(review.policy)) : null;
  const d = review.draftId ? await db.campaignDraft.findUnique({ where: { id: review.draftId }, select: { status: true, plan: true } }) : null;
  const b = briefFor(review, items.length ? items : [], client);
  const brief: ReviewBrief = { goal: b.goal, dailyBudget: b.dailyBudget, locations: b.locations, ageMin: b.ageMin, ageMax: b.ageMax, landingUrl: b.landingUrl, notes: b.notes };
  return (
    <ContentReviewView
      clientId={id}
      review={{ id: review.id, title: review.title, status: review.status, error: review.error, chosen: review.chosen, draftId: review.draftId }}
      items={items}
      policy={policy?.success ? policy.data : null}
      plans={parsePlans(review.plans)}
      brief={brief}
      currency={client.currency}
      isMeta={client.dataSource === "meta"}
      pages={clientPages(client).map((p) => ({ id: p.id, name: p.name }))}
      draft={d ? { status: d.status, name: (JSON.parse(d.plan) as { campaign_name?: string }).campaign_name ?? t("targeting.contentReview.draftDefaultName") } : null}
    />
  );
}
