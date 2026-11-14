import { connection } from "next/server";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { clientPages } from "@/lib/client-pages";
import { dbBuckets, inSendHours } from "@/lib/nurture";
import { repliedSet } from "@/lib/nurture-stats";
import { parsePolicy, parseStages } from "@/lib/nurture-rules";
import { NurtureFlowView } from "@/components/nurture/nurture-flow-view";
import { requirePageClient } from "@/lib/access";

export default async function NurtureFlowPage({ params }: { params: Promise<{ id: string; flowId: string }> }) {
  await connection();
  const { id, flowId } = await params;
  await requirePageClient(id); // check access right on the page: the layout may not re-run on client-side navigation
  const flow = await db.nurtureFlow.findUnique({ where: { id: flowId }, include: { client: true } });
  if (!flow || flow.clientId !== id) notFound();
  const client = flow.client;
  const [buckets, sends, job] = await Promise.all([
    dbBuckets(flow, client),
    db.nurtureSend.findMany({ where: { flowId }, orderBy: { sentAt: "desc" }, take: 50 }),
    db.clientJob.findFirst({ where: { clientId: id, kind: { in: ["nurture_write", "nurture_check"] }, params: { contains: flowId } }, orderBy: { createdAt: "desc" } }),
  ]);
  const replied = await repliedSet(sends);
  let suggestions: { message: string; why: string }[] = [];
  try {
    suggestions = JSON.parse(flow.suggestions);
  } catch {}
  return (
    <NurtureFlowView
      clientId={id}
      isMeta={client.dataSource === "meta"}
      inHours={inSendHours(client)}
      pages={clientPages(client).map((p) => ({ id: p.id, name: p.name }))}
      flow={{
        id: flow.id,
        name: flow.name,
        pageId: flow.pageId,
        status: flow.status,
        stages: parseStages(flow.stages),
        minScore: flow.minScore,
        waitHours: flow.waitHours,
        cooldownDays: flow.cooldownDays,
        maxPerRun: flow.maxPerRun,
        auto: flow.auto,
        everyHours: flow.everyHours,
        message: flow.message,
        brief: flow.brief,
        approvedBy: flow.approvedBy,
        approvedAt: flow.approvedAt?.toISOString() ?? null,
        runRequested: !!flow.runRequestedAt,
        lastRunAt: flow.lastRunAt?.toISOString() ?? null,
        lastRunNote: flow.lastRunNote,
      }}
      policy={parsePolicy(flow.policy)}
      suggestions={suggestions}
      job={job ? { kind: job.kind, status: job.status, error: job.error, finishedAt: job.finishedAt?.toISOString() ?? null } : null}
      buckets={{ in24: buckets.in24, d7: buckets.d7, older: buckets.older, phones: buckets.phones }}
      sends={sends.map((s) => ({ id: s.id, at: s.sentAt.toISOString(), name: s.customerName, text: s.text, status: s.status, error: s.error, by: s.sentBy, replied: replied.has(s.id) }))}
    />
  );
}
