"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { NavLink } from "@/components/nav-link";
import { localizedSections, type CountKey } from "@/lib/client-sections";
import { useT } from "@/i18n/client";

export type SideClient = {
  id: string;
  name: string;
  meta: boolean;
  health: "red" | "amber" | "green";
  /** Number of urgent items (pending proposals + hot leads not yet answered), shown next to the client name. */
  count: number;
  counts: Record<CountKey, number>;
  google: boolean;
  kiot: boolean;
};

const DOT: Record<SideClient["health"], string> = { red: "bg-rose-600", amber: "bg-amber-400", green: "bg-emerald-500" };
const short = (name: string) => name.split(" – ")[0];

/** Open the "Khách / các mục của khách" (Client / client sections) panel on mobile (button at the top of the client page). */
export const openClientMenu = () => window.dispatchEvent(new Event("wz:clientmenu"));

const Dot = ({ h }: { h: SideClient["health"] }) => <span className={`size-2 shrink-0 rounded-full ${DOT[h]}`} />;

function ClientList({ list }: { list: SideClient[] }) {
  const t = useT();
  return (
    <nav className="space-y-0.5">
      {list.map((c) => (
        <NavLink key={c.id} href={`/clients/${c.id}`} icon={<Dot h={c.health} />} end={c.count ? <span className="text-xs text-mut tabular-nums">{c.count}</span> : null}>
          {short(c.name)}
        </NavLink>
      ))}
      <NavLink href="/clients/new" icon={<Plus />}>
        <span className="text-mut">{t("system.shell.addClient")}</span>
      </NavLink>
    </nav>
  );
}

/** Current client picker: click to switch to another client (replaces the long list while inside a client page). */
function Switcher({ cur, list }: { cur: SideClient; list: SideClient[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative md:sticky md:top-0 md:z-10 md:-mx-1 md:bg-side md:px-1 md:py-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title={t("system.shell.switchClient")}
        className="flex h-10 w-full items-center gap-2.5 rounded-lg border border-line bg-panel px-2.5 text-left text-sm font-semibold text-ink hover:bg-hover"
      >
        <Dot h={cur.health} />
        <span className="min-w-0 flex-1 truncate">{short(cur.name)}</span>
        <ChevronsUpDown className="size-4 shrink-0 text-mut" />
      </button>
      {open && (
        <div className="absolute inset-x-0 z-40 mt-1 max-h-[60vh] overflow-y-auto rounded-[12px] border border-line bg-panel p-1.5 shadow-pop" onClick={(e) => (e.target as HTMLElement).closest("a") && setOpen(false)}>
          <p className="px-2.5 pt-1 pb-1.5 text-[11px] font-semibold tracking-wide text-mut2 uppercase">{t("system.shell.switchClient")}</p>
          {list.map((c) => (
            <Link key={c.id} href={`/clients/${c.id}`} className="flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-sm text-ink2 hover:bg-hover">
              <Dot h={c.health} />
              <span className="min-w-0 flex-1 truncate">{short(c.name)}</span>
              {c.id === cur.id ? <Check className="size-4 text-ink" /> : c.count ? <span className="text-xs text-mut tabular-nums">{c.count}</span> : null}
            </Link>
          ))}
          <Link href="/clients/new" className="mt-1 flex h-8 items-center gap-2.5 rounded-lg border-t border-line px-2.5 text-sm text-mut hover:bg-hover">
            <Plus className="size-4" /> {t("system.shell.addClient")}
          </Link>
        </div>
      )}
    </div>
  );
}

function Count({ n, urgent }: { n: number; urgent?: boolean }) {
  if (!n) return null;
  return <span className={`rounded-full px-1.5 text-[11px] font-semibold tabular-nums ${urgent ? "bg-rose-600 text-white" : "bg-hover text-mut"}`}>{n}</span>;
}

/** A client's sections, grouped by task. Sections that require a connection (Google Ads, KiotViet) only show once connected. */
function Sections({ c, rel }: { c: SideClient; rel: string }) {
  const t = useT();
  const base = `/clients/${c.id}`;
  return (
    <div className="mt-2 space-y-3">
      {localizedSections(t).map((g) => {
        const items = g.items.filter((s) => !s.needs || c[s.needs] || rel === s.path || rel.startsWith(`${s.path}/`));
        return (
          <div key={g.key}>
            <p className="mb-0.5 px-2.5 text-[11px] font-medium text-mut2">{g.label}</p>
            <nav className="space-y-0.5">
              {items.map((s) => (
                <NavLink key={s.path} href={`${base}${s.path}`} exact={s.path === ""} icon={<s.icon />} title={s.desc} end={s.count ? <Count n={c.counts[s.count]} urgent={s.urgent} /> : null}>
                  {s.label}
                </NavLink>
              ))}
            </nav>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The "Khách hàng" (Clients) part of the sidebar, which changes with the current page:
 * outside client pages → client list; inside a client page → client switcher + all of that client's sections.
 */
export function SidebarClients({ list }: { list: SideClient[] }) {
  const t = useT();
  const path = usePathname();
  const m = path.match(/^\/clients\/([^/]+)(.*)$/);
  const cur = m ? list.find((c) => c.id === m[1]) : undefined;
  const ref = useRef<HTMLDivElement>(null);
  // Menu taller than the screen: scroll the sidebar to the active item.
  useEffect(() => {
    ref.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest" });
  }, [path]);
  return (
    <div ref={ref}>
      <p className="mt-5 mb-1.5 px-2.5 text-[11px] font-semibold tracking-wide text-mut2 uppercase">{t("system.shell.crumbClients")}</p>
      {cur && m ? (
        <>
          <Switcher cur={cur} list={list} />
          <Sections c={cur} rel={m[2]} />
        </>
      ) : (
        <ClientList list={list} />
      )}
    </div>
  );
}
