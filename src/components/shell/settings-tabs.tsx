"use client";

import { BarChart3, Gauge, History, KeyRound, MessageSquareText, Plug, Search, Send, Sparkles, UserCog, Webhook, type LucideIcon } from "lucide-react";
import { NavLink, TabLink } from "@/components/nav-link";
import { useT } from "@/i18n/client";
import type { MessageKey } from "@/i18n/translate";

/**
 * "Cài đặt hệ thống" (System settings) menu: configuration shared by all clients, grouped by task.
 * Desktop: vertical column on the left; mobile: horizontally scrollable row.
 */
// staff: only people of the root business (shared settings); people: people who can manage the business (add people, assign permissions).
type Item = { href: string; label: MessageKey; icon: LucideIcon; admin?: boolean; staff?: boolean; people?: boolean; badge?: "tokens" };
const GROUPS: { label: MessageKey; items: Item[] }[] = [
  {
    label: "system.settingsNav.groupMeta",
    items: [
      { href: "/connections", label: "system.settingsNav.tokens", icon: KeyRound, badge: "tokens" },
      { href: "/connections/webhook", label: "system.settingsNav.webhook", icon: Webhook, staff: true },
      { href: "/connections/meta-api", label: "system.settingsNav.metaApi", icon: Gauge, staff: true },
    ],
  },
  {
    label: "system.settingsNav.groupAi",
    items: [
      { href: "/connections/claude", label: "system.settingsNav.claude", icon: Sparkles, staff: true },
      { href: "/connections/google", label: "system.settingsNav.google", icon: Search, staff: true },
      { href: "/connections/mcp", label: "system.settingsNav.connectAi", icon: Plug },
    ],
  },
  {
    label: "system.settingsNav.groupSend",
    items: [
      { href: "/connections/channels", label: "system.settingsNav.channels", icon: Send, staff: true },
      { href: "/connections/templates", label: "system.settingsNav.templates", icon: MessageSquareText, staff: true },
    ],
  },
  {
    label: "system.settingsNav.groupAdmin",
    items: [
      { href: "/activity", label: "system.settingsNav.activity", icon: History },
      { href: "/usage", label: "system.settingsNav.usage", icon: BarChart3, staff: true },
      { href: "/users", label: "system.settingsNav.users", icon: UserCog, people: true },
    ],
  },
];

export function SystemNav({ admin, staff, people, tokenIssues }: { admin: boolean; staff: boolean; people: boolean; tokenIssues: number }) {
  const t = useT();
  const items = (g: (typeof GROUPS)[number]) => g.items.filter((i) => (!i.admin || admin) && (!i.staff || staff) && (!i.people || people));
  const badge = (i: Item) =>
    i.badge === "tokens" && tokenIssues ? <span className="rounded-full bg-rose-600 px-1.5 text-[11px] font-semibold text-white tabular-nums">{tokenIssues}</span> : null;
  return (
    <>
      <nav className="space-y-4 max-md:hidden">
        {GROUPS.filter((g) => items(g).length).map((g) => (
          <div key={g.label}>
            <p className="mb-0.5 px-2.5 text-[11px] font-medium text-mut2">{t(g.label)}</p>
            <div className="space-y-0.5">
              {items(g).map((i) => (
                <NavLink key={i.href} href={i.href} exact={i.href === "/connections"} icon={<i.icon />} end={badge(i)}>
                  {t(i.label)}
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>
      <nav className="-mx-4 flex gap-1 overflow-x-auto border-b border-line px-4 [scrollbar-width:none] md:hidden">
        {GROUPS.flatMap(items).map((i) => (
          <TabLink key={i.href} href={i.href} exact={i.href === "/connections"}>
            {t(i.label)}
            {badge(i)}
          </TabLink>
        ))}
      </nav>
    </>
  );
}
