"use client";

import { Command } from "cmdk";
import { BookOpen, Home, Inbox, Plus, RefreshCw, Search, Sparkles, Target, Users, Contact, History, KeyRound, ListChecks, Plug, UserCog } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { syncAction, analyzeAction } from "@/app/actions";
import { localizedSections } from "@/lib/client-sections";
import { useT } from "@/i18n/client";


type CmdClient = { id: string; name: string; meta: boolean };

/** Open the command palette from anywhere (search button in the sidebar, mobile bottom bar). */
export const openCommandMenu = () => window.dispatchEvent(new Event("wz:cmdk"));

/**
 * Ctrl+K / ⌘K: type a client name to jump to it, or run safe commands (refresh data, analyze messages).
 * No command here changes ads on Meta.
 */
export function CommandMenu({ clients }: { clients: CmdClient[] }) {
  const t = useT();
  const SUB = localizedSections(t).flatMap((g) => g.items).filter((s) => s.path !== "");
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("wz:cmdk", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("wz:cmdk", onOpen);
    };
  }, []);

  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };
  const run = (label: string, fn: () => Promise<unknown>) =>
    start(async () => {
      setMsg(t("system.cmd.queuing", { label }));
      const r = (await fn()) as { error?: string } | undefined;
      setMsg(r?.error ? t("system.cmd.error", { error: r.error }) : t("system.cmd.queued", { label }));
      router.refresh();
    });

  if (!open) return null;
  const item = "flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-ink aria-selected:bg-hover [&_svg]:size-4 [&_svg]:text-mut";
  const group = "px-1 pb-1 text-ink [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-mut2 [&_[cmdk-group-heading]]:uppercase";
  const pages: [string, string, typeof Home][] = [
    [t("system.shell.today"), "/", Home],
    [t("system.shell.pending"), "/recommendations", Inbox],
    [t("system.cmd.pageContacts"), "/contacts", Contact],
    [t("system.shell.targeting"), "/targeting", Target],
    [t("playbook.nav"), "/playbook", BookOpen],
    [t("system.settingsNav.connectAi"), "/connect-ai", Plug],
    [t("system.shell.gettingStarted"), "/getting-started", ListChecks],
    [t("system.cmd.sysTokens"), "/connections", KeyRound],
    [t("system.cmd.sysWebhook"), "/connections/webhook", KeyRound],
    [t("system.cmd.sysClaude"), "/connections/claude", Sparkles],
    [t("system.cmd.sysGoogle"), "/connections/google", KeyRound],
    [t("system.cmd.sysChannels"), "/connections/channels", KeyRound],
    [t("system.cmd.sysTemplates"), "/connections/templates", KeyRound],
    [t("system.settingsNav.activity"), "/activity", History],
    [t("system.settingsNav.users"), "/users", UserCog],
    [t("system.shell.addClient"), "/clients/new", Plus],
  ];

  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center bg-[var(--overlay)] px-4 pt-[12vh]" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <Command label={t("system.cmd.label")} className="w-full max-w-xl overflow-hidden rounded-[14px] border border-line bg-panel shadow-pop" loop>
        <div className="flex items-center gap-2 border-b border-line px-4">
          <Search className="size-4 text-mut" />
          <Command.Input autoFocus placeholder={t("system.cmd.placeholder")} className="h-12 w-full bg-transparent text-sm text-ink outline-none placeholder:text-mut2" />
          <kbd className="rounded border border-line px-1.5 text-[11px] text-mut">Esc</kbd>
        </div>
        <Command.List className="max-h-[60vh] overflow-y-auto pb-2" onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
          <Command.Empty className="px-4 py-6 text-center text-sm text-mut">{t("system.cmd.noResults")}</Command.Empty>
          <Command.Group heading={t("system.shell.crumbClients")} className={group}>
            {clients.map((c) => (
              <Command.Item key={c.id} value={`khach ${c.name}`} onSelect={() => go(`/clients/${c.id}`)} className={item}>
                <Users />
                {c.name}
              </Command.Item>
            ))}
          </Command.Group>
          <Command.Group heading={t("system.cmd.groupPages")} className={group}>
            {pages.map(([label, href, Icon]) => (
              <Command.Item key={href} value={`trang ${label}`} onSelect={() => go(href)} className={item}>
                <Icon />
                {label}
              </Command.Item>
            ))}
          </Command.Group>
          <Command.Group heading={t("system.cmd.groupClientPages")} className={group}>
            {clients.flatMap((c) =>
              SUB.map((s) => (
                <Command.Item key={c.id + s.path} value={`${c.name} ${s.label}`} onSelect={() => go(`/clients/${c.id}${s.path}`)} className={item}>
                  <s.icon />
                  {s.label} <span className="text-mut">· {c.name}</span>
                </Command.Item>
              )),
            )}
          </Command.Group>
          <Command.Group heading={t("system.cmd.groupActions")} className={group}>
            {clients
              .filter((c) => c.meta)
              .flatMap((c) => [
                <Command.Item key={`s${c.id}`} value={`cap nhat du lieu dong bo ${c.name}`} onSelect={() => run(t("system.cmd.syncLabel", { name: c.name }), () => syncAction(c.id))} className={item}>
                  <RefreshCw />
                  {t("system.cmd.sync")} <span className="text-mut">· {c.name}</span>
                  <span className="ml-auto text-xs text-mut2">{t("system.cmd.about1min")}</span>
                </Command.Item>,
                <Command.Item key={`a${c.id}`} value={`phan tich tin nhan ${c.name}`} onSelect={() => run(t("system.cmd.analyzeLabel", { name: c.name }), () => analyzeAction(c.id))} className={item}>
                  <Sparkles />
                  {t("system.cmd.analyze")} <span className="text-mut">· {c.name}</span>
                  <span className="ml-auto text-xs text-mut2">{t("system.cmd.about5min")}</span>
                </Command.Item>,
              ])}
          </Command.Group>
        </Command.List>
        {(msg || pending) && <div className="border-t border-line px-4 py-2 text-xs text-mut">{msg}</div>}
      </Command>
    </div>
  );
}

/** The "Tìm nhanh… Ctrl K" (Quick search… Ctrl K) box in the sidebar. */
export function CommandTrigger() {
  const t = useT();
  return (
    <button type="button" onClick={openCommandMenu} className="flex h-8 w-full items-center gap-2 rounded-lg border border-line bg-panel px-2.5 text-sm text-mut2 hover:bg-hover">
      <Search className="size-4" />
      <span className="flex-1 text-left">{t("system.cmd.trigger")}</span>
      <kbd className="rounded border border-line px-1 text-[11px] text-mut">Ctrl K</kbd>
    </button>
  );
}
