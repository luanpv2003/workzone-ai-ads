import { notFound } from "next/navigation";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { db } from "@/lib/db";
import { analyzeAction, audienceAction, auditAction, creativeAnalysisAction, fullAnalysisAction, refreshRankingAction, syncAction } from "@/app/actions";
import { JobPanel } from "@/components/job-panel";
import { ActionButton } from "@/components/action-button";
import { ClientPageIntro } from "@/components/client-nav";
import { MoreMenu } from "@/components/more-menu";
import { AlertTriangle, ChevronRight, Eye, ImageIcon, MessageSquare, RefreshCw, Sparkles, Users, Zap } from "lucide-react";
import { Badge, LinkButton } from "@/components/ui";
import { dateOnly, dateTime } from "@/lib/format";
import { clientPipeline, type Pipeline } from "@/lib/pipeline";
import { PipelineBar } from "@/components/pipeline-bar";
import { nextSyncAt } from "@/lib/schedule";
import { NextSyncCountdown } from "@/components/next-sync-countdown";
import { requirePageClient } from "@/lib/access";
import { getT } from "@/i18n/server";
import type { T } from "@/i18n/translate";

const jobCutoff = () => Date.now() - 2 * 3600_000;

/** Warn when the token has fewer than 7 days left or has expired. */
function tokenWarning(expiresAt: Date | null, t: T): string | null {
  if (!expiresAt) return null;
  const left = expiresAt.getTime() - Date.now();
  if (left < 0) return t("customers.clientLayout.tokenExpired");
  if (left < 7 * 86400000) return t("customers.clientLayout.tokenExpiring", { date: dateOnly(expiresAt) });
  return null;
}

/** Primary button in the page header: do the next workflow step right away (or approve suggestions if some are pending). */
function NextStep({ id, base, p, pending, t }: { id: string; base: string; p: Pipeline; pending: number; t: T }) {
  const cur = p.current;
  if (pending && (!cur || cur.key === "optimize"))
    return (
      <LinkButton href={`${base}/recommendations`} variant="primary">
        <ChevronRight /> {t("customers.clientLayout.approve", { n: pending })}
      </LinkButton>
    );
  if (!cur)
    return (
      <ActionButton action={syncAction.bind(null, id)} variant="primary" pending={t("customers.clientLayout.queuing")}>
        <RefreshCw /> {t("customers.clientLayout.updateData")}
      </ActionButton>
    );
  const label = (
    <>
      <Sparkles /> {cur.action ?? cur.label}
    </>
  );
  switch (cur.key) {
    case "collect":
      return <ActionButton action={syncAction.bind(null, id)} variant="primary" pending={t("customers.clientLayout.syncing")}>{label}</ActionButton>;
    case "analyze":
      return <ActionButton action={analyzeAction.bind(null, id)} variant="primary" pending={t("customers.clientLayout.queuing")}>{label}</ActionButton>;
    case "audience":
      return <ActionButton action={audienceAction.bind(null, id)} variant="primary" pending={t("customers.clientLayout.audienceBusy")}>{label}</ActionButton>;
    case "review":
      return <ActionButton action={refreshRankingAction.bind(null, id)} variant="primary" pending={t("customers.clientLayout.rescoring")}>{label}</ActionButton>;
    case "optimize":
      return <ActionButton action={auditAction.bind(null, id)} variant="primary" pending={t("customers.clientLayout.auditBusy")} redirectTo={`${base}/audits?a=`}>{label}</ActionButton>;
    default:
      return (
        <LinkButton href={cur.href} variant="primary">
          {label}
        </LinkButton>
      );
  }
}

export default async function ClientLayout({ children, params }: { children: ReactNode; params: Promise<{ id: string }> }) {
  await connection();
  const t = await getT();
  const { id } = await params;
  const { role } = await requirePageClient(id);
  const readOnly = role === "analyst"; // Analyst: hide job-running buttons (clicking only shows an error)
  const client = await db.client.findUnique({
    where: { id },
    include: {
      _count: { select: { recommendations: { where: { status: "pending" } } } },
    },
  });
  if (!client) notFound();
  const base = `/clients/${id}`;
  const pipeline = await clientPipeline(id);
  // Background jobs: the running job is shown first (this client's other jobs queue behind it, one job per client at a time);
  // otherwise the latest job, shown while pending, or if it finished / failed within 2 hours.
  const [latest, activeJobs] = await Promise.all([
    db.clientJob.findFirst({ where: { clientId: id }, orderBy: { createdAt: "desc" } }),
    db.clientJob.findMany({ where: { clientId: id, status: { in: ["queued", "running"] } }, orderBy: { createdAt: "asc" }, select: { id: true, kind: true, status: true } }),
  ]);
  const runningId = activeJobs.find((j) => j.status === "running")?.id;
  const job = (runningId ? await db.clientJob.findUnique({ where: { id: runningId } }) : null) ?? latest;
  const waiting = activeJobs.filter((j) => j.status === "queued" && j.id !== job?.id).map((j) => j.kind);
  const showJob = job && (["queued", "running"].includes(job.status) || (job.finishedAt && job.finishedAt.getTime() > jobCutoff()));

  const warn = client.dataSource === "meta" ? tokenWarning(client.metaTokenExpiresAt, t) : null;
  const eta = (text: string) => <span className="ml-auto pl-3 text-xs font-normal text-mut2">{text}</span>;
  return (
    <>
      {/* Client page header: name · next step · workflow. The client's sections live in the sidebar. */}
      <section className="-mx-4 -mt-6 mb-6 border-b border-line bg-panel px-4 pt-5 pb-4 md:-mx-8 md:-mt-7 md:px-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-[22px] font-semibold tracking-tight text-ink">{client.name}</h1>
              <Badge tone={client.dataSource === "meta" ? "good" : "warn"}>{client.dataSource === "meta" ? t("customers.clientLayout.connected") : t("customers.clientLayout.notConnected")}</Badge>
            </div>
            <p className="mt-1 text-sm text-mut">
              {t("customers.clientLayout.lastUpdate", { industry: client.industry, at: dateTime(client.lastSyncedAt) })}
              {client.dataSource === "meta" && (
                <>
                  {" · "}
                  <NextSyncCountdown nextAt={nextSyncAt(client)?.toISOString() ?? null} href={`${base}/settings/automation`} syncing={activeJobs.some((j) => ["full_analysis", "sync"].includes(j.kind))} />
                </>
              )}
            </p>
          </div>
          <div className="flex flex-wrap items-start justify-end gap-2">
            {!readOnly && (
              <>
                <NextStep id={id} base={base} p={pipeline} pending={client._count.recommendations} t={t} />
                <MoreMenu label={t("customers.clientLayout.menu")}>
                  <ActionButton action={fullAnalysisAction.bind(null, id)} pending={t("customers.clientLayout.queuing")}>
                    <Zap className="size-4 text-violet-600" /> {t("customers.clientLayout.fullAnalysis")}{eta(t("customers.clientLayout.etaFull"))}
                  </ActionButton>
                  <ActionButton action={syncAction.bind(null, id)} pending={t("customers.clientLayout.queuing")}>
                    <RefreshCw className="size-4 text-mut" /> {t("customers.clientLayout.syncData")}{eta(t("customers.clientLayout.etaSync"))}
                  </ActionButton>
                  <ActionButton action={analyzeAction.bind(null, id)} pending={t("customers.clientLayout.queuing")}>
                    <MessageSquare className="size-4 text-mut" /> {t("customers.clientLayout.analyzeMsgs")}{eta(t("customers.clientLayout.etaMsgs"))}
                  </ActionButton>
                  <ActionButton action={audienceAction.bind(null, id)} pending={t("customers.clientLayout.audienceBusy")}>
                    <Users className="size-4 text-mut" /> {t("customers.clientLayout.redoAudience")}{eta(t("customers.clientLayout.etaAudience"))}
                  </ActionButton>
                  <ActionButton action={auditAction.bind(null, id)} pending={t("customers.clientLayout.auditChecking")} redirectTo={`${base}/audits?a=`}>
                    <Sparkles className="size-4 text-mut" /> {t("customers.clientLayout.audit")}{eta(t("customers.clientLayout.etaAudit"))}
                  </ActionButton>
                  {client.dataSource === "meta" && (
                    <ActionButton action={creativeAnalysisAction.bind(null, id)} pending={t("customers.clientLayout.queuing")}>
                      <ImageIcon className="size-4 text-mut" /> {t("customers.clientLayout.creative")}{eta(t("customers.clientLayout.etaCreative"))}
                    </ActionButton>
                  )}
                </MoreMenu>
              </>
            )}
          </div>
        </div>
        {warn && (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            <AlertTriangle className="size-4 shrink-0" />
            <span className="flex-1">{t("customers.clientLayout.warn", { warn })}</span>
            <a href="/connections" className="font-medium underline">
              {t("customers.clientLayout.pasteToken")}
            </a>
          </div>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
          <PipelineBar p={pipeline} />
          {showJob && <JobPanel job={job} base={base} waiting={waiting} />}
        </div>
      </section>
      <ClientPageIntro base={base} />
      {readOnly && (
        <p className="-mt-2 mb-4 flex items-center gap-1.5 text-xs text-mut">
          <Eye className="size-3.5 shrink-0" /> {t("customers.clientLayout.readOnly")}
        </p>
      )}
      {children}
    </>
  );
}
