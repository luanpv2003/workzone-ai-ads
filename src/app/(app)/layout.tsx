import { BrandMark } from "@/components/brand-mark";
import Link from "next/link";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { BookOpen, Contact, Home, Inbox, LogOut, Plug, Settings, Sparkles, Target } from "lucide-react";
import { db } from "@/lib/db";
import { NavLink } from "@/components/nav-link";
import { CommandMenu, CommandTrigger } from "@/components/shell/command-menu";
import { Topbar } from "@/components/shell/topbar";
import { MobileShell } from "@/components/shell/bottom-nav";
import { AskClaude } from "@/components/shell/ask-claude";
import { SidebarClients, type SideClient } from "@/components/shell/client-menu";
import { tokenLevel } from "@/lib/token-status";
import { jobLabels } from "@/lib/client-jobs";
import { requirePageUser, type CurrentUser } from "@/lib/auth";
import { isPlatformStaff, visibleClientIds } from "@/lib/access";
import { logoutAction } from "@/app/auth-actions";
import { getT } from "@/i18n/server";
import { BRAND } from "@/lib/brand";

const DAY = 86400000;

/** Sidebar data: clients (health dot + job count), pending suggestion count, background jobs. Lightweight, runs on every page load. Only clients the user can see. */
async function shellData(user: CurrentUser) {
  await connection();
  const ids = await visibleClientIds(user);
  const mine = ids ? { clientId: { in: ids } } : {};
  const [clients, pending, hot, replies, drafts, docs, jobs, runs] = await Promise.all([
    db.client.findMany({
      where: ids ? { id: { in: ids } } : {},
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        dataSource: true,
        lastSyncedAt: true,
        metaAccessToken: true,
        metaTokenExpiresAt: true,
        metaTokenError: true,
        metaTokenMissing: true,
        metaTokenCheckedAt: true,
        googleCustomerId: true,
        kiotRetailer: true,
      },
    }),
    db.recommendation.groupBy({ by: ["clientId"], where: { ...mine, status: "pending" }, _count: true }),
    db.conversation.groupBy({ by: ["clientId"], where: { ...mine, leadScore: { gte: 75 }, needsReply: true }, _count: true }),
    db.conversation.groupBy({ by: ["clientId"], where: { ...mine, needsReply: true }, _count: true }),
    db.campaignDraft.groupBy({ by: ["clientId"], where: { ...mine, status: "draft" }, _count: true }),
    db.knowledgeDoc.groupBy({ by: ["clientId"], where: mine, _count: true }),
    db.clientJob.findMany({ where: { ...mine, status: { in: ["queued", "running"] } }, orderBy: { createdAt: "asc" }, select: { kind: true, status: true, steps: true, client: { select: { name: true } } } }),
    isPlatformStaff(user).then((s) => (s ? db.targetingRun.count({ where: { status: { in: ["queued", "running"] } } }) : 0)),
  ]);
  const pendingBy = new Map(pending.map((p) => [p.clientId, p._count]));
  const hotBy = new Map(hot.map((h) => [h.clientId, h._count]));
  const by = (rows: { clientId: string; _count: number }[]) => new Map(rows.map((r) => [r.clientId, r._count]));
  const [repliesBy, draftsBy, docsBy] = [by(replies), by(drafts), by(docs)];
  const list: SideClient[] = clients.map((c) => {
    const lv = c.dataSource === "meta" ? tokenLevel(c) : "ok";
    const p = pendingBy.get(c.id) ?? 0;
    const h = hotBy.get(c.id) ?? 0;
    const stale = c.dataSource === "meta" && (!c.lastSyncedAt || Date.now() - c.lastSyncedAt.getTime() > 3 * DAY);
    const health = p || h || ["expired", "error", "missing"].includes(lv) ? "red" : stale || lv === "warning" || c.dataSource !== "meta" ? "amber" : "green";
    return {
      id: c.id,
      name: c.name,
      meta: c.dataSource === "meta",
      health,
      count: p + h,
      counts: { recs: p, replies: repliesBy.get(c.id) ?? 0, drafts: draftsBy.get(c.id) ?? 0, docs: docsBy.get(c.id) ?? 0 },
      google: !!c.googleCustomerId,
      kiot: !!c.kiotRetailer,
    };
  });
  return { list, pendingTotal: pending.reduce((a, p) => a + p._count, 0), jobs, runs };
}

function Brand() {
  return (
    <Link href="/" className="flex items-center gap-2.5">
      <BrandMark size={32} />
      <span className="font-semibold text-ink">{BRAND.app}</span>
    </Link>
  );
}

async function Sidebar({ user, data }: { user: CurrentUser; data: Awaited<ReturnType<typeof shellData>> }) {
  const t = await getT();
  const job = data.jobs[0];
  const steps = job ? (JSON.parse(job.steps) as { label: string; status: string; detail?: string }[]) : [];
  const cur = steps.find((s) => s.status === "running") ?? steps.find((s) => s.status !== "done");
  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-line bg-side md:flex">
      <div className="px-4 pt-4 pb-3">
        <Brand />
      </div>
      <div className="px-3 pb-2">
        <CommandTrigger />
      </div>
      <div className="flex-1 overflow-y-auto px-3 pb-3">
        <nav className="space-y-0.5">
          <NavLink href="/" exact icon={<Home />}>
            {t("system.shell.today")}
          </NavLink>
          <NavLink href="/recommendations" icon={<Inbox />} end={data.pendingTotal ? <span className="rounded-full bg-rose-600 px-1.5 text-[11px] font-semibold text-white tabular-nums">{data.pendingTotal}</span> : null}>
            {t("system.shell.pending")}
          </NavLink>
          <NavLink href="/contacts" icon={<Contact />}>
            {t("system.shell.contacts")}
          </NavLink>
          <NavLink href="/targeting" icon={<Target />}>
            {t("system.shell.targeting")}
          </NavLink>
          <NavLink href="/playbook" icon={<BookOpen />}>
            {t("playbook.nav")}
          </NavLink>
        </nav>
        <SidebarClients list={data.list} />
      </div>
      {job && (
        <div className="mx-3 mb-2 rounded-xl border border-line bg-panel p-3 text-xs">
          <p className="flex items-center gap-1.5 font-medium text-violet-700">
            <Sparkles className="size-3.5" /> {t("system.shell.runningBg")}{data.jobs.length > 1 ? ` (${data.jobs.length})` : ""}
          </p>
          <p className="mt-1 truncate text-ink">
            {jobLabels(t)[job.kind] ?? job.kind} · {job.client.name.split(" – ")[0]}
          </p>
          {cur && <p className="truncate text-mut">{job.status === "queued" ? t("system.shell.waiting") : `${cur.label}${cur.detail ? ` · ${cur.detail}` : ""}`}</p>}
        </div>
      )}
      <div className="space-y-0.5 border-t border-line px-3 py-2">
        <NavLink href="/connect-ai" icon={<Plug />}>
          {t("system.settingsNav.connectAi")}
        </NavLink>
        <NavLink href="/connections" icon={<Settings />}>
          {t("system.shell.systemSettings")}
        </NavLink>
        <form action={logoutAction}>
          <button className="flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-sm text-ink2 hover:bg-hover [&>svg]:size-4 [&>svg]:text-mut" title={user.email}>
            <LogOut />
            <span className="min-w-0 flex-1 truncate text-left">{t("system.shell.logout", { name: user.name })}</span>
          </button>
        </form>
      </div>
    </aside>
  );
}

// Every page in the (app) group requires login (checks the real session in the DB, not just the cookie).
export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requirePageUser();
  const data = await shellData(user);
  const names = Object.fromEntries(data.list.map((c) => [c.id, c.name.split(" – ")[0]]));
  return (
    <div className="flex h-full flex-col md:flex-row">
      <Sidebar user={user} data={data} />
      <MobileShell brand={<Brand />} pending={data.pendingTotal} clientList={<SidebarClients list={data.list} />} />
      <main className="min-w-0 flex-1 overflow-y-auto pb-16 md:pb-0">
        <Topbar clients={names} running={data.jobs.length + data.runs} />
        <div className="@container mx-auto max-w-7xl px-4 py-6 md:px-8 md:py-7">{children}</div>
      </main>
      <CommandMenu clients={data.list.map((c) => ({ id: c.id, name: c.name, meta: c.meta }))} />
      <AskClaude clients={names} />
    </div>
  );
}
