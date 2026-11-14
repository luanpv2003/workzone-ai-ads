"use client";

import { Home, Inbox, Search, Users } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { openCommandMenu } from "./command-menu";
import { useT } from "@/i18n/client";

/** Mobile: compact top bar + 4-item bottom bar ("Hôm nay · Chờ duyệt · Khách · Tìm", i.e. Today · Pending · Clients · Search). Touch targets ≥ 44px. */
export function MobileShell({ brand, pending, clientList }: { brand: ReactNode; pending: number; clientList: ReactNode }) {
  const t = useT();
  const path = usePathname();
  const [clientsOpen, setClientsOpen] = useState(false);
  useEffect(() => {
    const onOpen = () => setClientsOpen(true);
    window.addEventListener("wz:clientmenu", onOpen);
    return () => window.removeEventListener("wz:clientmenu", onOpen);
  }, []);
  const tab = (active: boolean) => `flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] ${active ? "font-medium text-ink" : "text-mut"}`;
  return (
    <>
      <div className="sticky top-0 z-40 flex h-12 items-center justify-between border-b border-line bg-panel px-4 md:hidden">{brand}</div>
      {clientsOpen && (
        <div className="fixed inset-0 z-50 bg-[var(--overlay)] md:hidden" onClick={() => setClientsOpen(false)}>
          <div className="absolute inset-x-0 bottom-14 max-h-[75vh] overflow-y-auto rounded-t-2xl border-t border-line bg-panel p-3 [&>p:first-child]:mt-0" onClick={(e) => (e.stopPropagation(), (e.target as HTMLElement).closest("a") && setClientsOpen(false))}>
            {clientList}
          </div>
        </div>
      )}
      <nav className="fixed inset-x-0 bottom-0 z-50 flex h-14 border-t border-line bg-panel pb-[env(safe-area-inset-bottom)] md:hidden">
        <Link href="/" className={tab(path === "/")}>
          <Home className="size-5" />
          {t("system.shell.today")}
        </Link>
        <Link href="/recommendations" className={tab(path.startsWith("/recommendations"))}>
          <span className="relative">
            <Inbox className="size-5" />
            {pending > 0 && <span className="absolute -top-1.5 -right-2.5 rounded-full bg-rose-600 px-1 text-[10px] font-semibold text-white">{pending}</span>}
          </span>
          {t("system.shell.pending")}
        </Link>
        <button type="button" className={tab(path.startsWith("/clients"))} onClick={() => setClientsOpen((o) => !o)}>
          <Users className="size-5" />
          {t("system.shell.clients")}
        </button>
        <button type="button" className={tab(false)} onClick={openCommandMenu}>
          <Search className="size-5" />
          {t("system.shell.search")}
        </button>
      </nav>
    </>
  );
}
