"use client";

import { Layers } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ThemeToggle } from "./theme-toggle";
import { localizeSection, sectionFor } from "@/lib/client-sections";
import { useT } from "@/i18n/client";
import type { MessageKey } from "@/i18n/translate";
import { LocaleSwitch } from "./locale-switch";

const PAGE: Record<string, MessageKey> = {
  "": "system.shell.today",
  recommendations: "system.shell.pending",
  contacts: "system.shell.contacts",
  targeting: "system.shell.targeting",
  playbook: "playbook.nav",
  "connect-ai": "system.settingsNav.connectAi",
  "getting-started": "system.shell.gettingStarted",
};
// System settings: /connections/<section> and the admin pages.
const SYSTEM: Record<string, MessageKey> = {
  connections: "system.settingsNav.tokens",
  "connections/webhook": "system.settingsNav.webhook",
  "connections/meta-api": "system.settingsNav.metaApi",
  "connections/claude": "system.settingsNav.claude",
  "connections/google": "system.settingsNav.google",
  "connections/mcp": "system.settingsNav.connectAi",
  "connections/channels": "system.settingsNav.channels",
  "connections/templates": "system.settingsNav.templates",
  activity: "system.settingsNav.activity",
  usage: "system.settingsNav.usage",
  users: "system.settingsNav.users",
};

// Sub-tabs inside the client page (Settings & connections, Notifications & reports).
const TAB: Record<string, MessageKey> = {
  "settings/integrations": "system.tab.integrations",
  "settings/automation": "system.tab.automation",
  "notify/reports": "system.tab.reports",
  "notify/templates": "system.settingsNav.templates",
  "notify/history": "system.tab.history",
};

/** Top bar: breadcrumb, number of background jobs running, light / dark. */
export function Topbar({ clients, running }: { clients: Record<string, string>; running: number }) {
  const t = useT();
  const parts = usePathname().split("/").filter(Boolean);
  const crumbs: { label: string; href?: string }[] = [];
  if (parts[0] === "clients" && parts[1] === "new") crumbs.push({ label: t("system.shell.crumbClients") }, { label: t("system.shell.crumbAddClient") });
  else if (parts[0] === "clients" && parts[1]) {
    crumbs.push({ label: t("system.shell.crumbClients") }, { label: clients[parts[1]] ?? t("system.shell.crumbClientFallback"), href: `/clients/${parts[1]}` }, { label: localizeSection(sectionFor(parts[2] ? `/${parts[2]}` : ""), t)?.label ?? parts[2] });
    if (parts[3]) crumbs[2].href = `/clients/${parts[1]}/${parts[2]}`;
    if (parts[3]) crumbs.push({ label: TAB[`${parts[2]}/${parts[3]}`] ? t(TAB[`${parts[2]}/${parts[3]}`]) : parts[2] === "campaigns" ? t("system.shell.crumbEvaluation") : parts[2] === "drafts" ? t("system.shell.crumbEditor") : parts[3] === "new" ? t("system.shell.crumbStepwise") : parts[2] === "content" ? t("system.shell.crumbBatch") : t("system.shell.crumbDetail") });
  } else if (SYSTEM[parts.join("/")]) crumbs.push({ label: t("system.shell.systemSettings"), href: "/connections" }, { label: t(SYSTEM[parts.join("/")]) });
  else crumbs.push({ label: PAGE[parts[0] ?? ""] ? t(PAGE[parts[0] ?? ""]) : parts[0] });

  return (
    <header className="sticky top-0 z-30 hidden h-12 items-center gap-3 border-b border-line bg-bg/90 px-6 backdrop-blur md:flex">
      <nav className="flex min-w-0 flex-1 items-center gap-2 text-sm">
        {crumbs.map((c, i) => (
          <span key={i} className="flex min-w-0 items-center gap-2">
            {i > 0 && <span className="text-mut2">/</span>}
            {c.href && i < crumbs.length - 1 ? (
              <Link href={c.href} className="truncate text-mut hover:text-ink">
                {c.label}
              </Link>
            ) : (
              <span className={`truncate ${i === crumbs.length - 1 ? "font-medium text-ink" : "text-mut"}`}>{c.label}</span>
            )}
          </span>
        ))}
      </nav>
      {running > 0 && (
        <span className="flex h-8 items-center gap-1.5 rounded-lg border border-line bg-panel px-2.5 text-sm text-ink2" title={t("system.shell.runningJobsTitle")}>
          <Layers className="size-4 text-violet-600" /> {t("system.shell.runningN", { n: running })}
        </span>
      )}
      <LocaleSwitch />
      <ThemeToggle />
    </header>
  );
}
