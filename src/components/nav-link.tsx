"use client";

import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/** Small blinking dot on the just-clicked link while the new page loads. */
function Pending() {
  const { pending } = useLinkStatus();
  return <span aria-hidden className={`size-1.5 shrink-0 rounded-full bg-indigo-500 transition-opacity ${pending ? "animate-pulse opacity-100" : "opacity-0"}`} />;
}

/** Sidebar item: icon + label + trailing content on the right (count badge). */
export function NavLink({ href, children, exact, icon, end, title }: { href: string; children: ReactNode; exact?: boolean; icon?: ReactNode; end?: ReactNode; title?: string }) {
  const path = usePathname();
  const active = exact ? path === href : path === href || path.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      title={title}
      aria-current={active ? "page" : undefined}
      className={`flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-sm [&>svg]:size-4 [&>svg]:shrink-0 ${active ? "bg-hover font-medium text-ink [&>svg]:text-ink" : "text-ink2 hover:bg-hover [&>svg]:text-mut"}`}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <Pending />
      {end}
    </Link>
  );
}

export function TabLink({ href, children, exact }: { href: string; children: ReactNode; exact?: boolean }) {
  const path = usePathname();
  const active = exact ? path === href : path === href || path.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm whitespace-nowrap ${active ? "border-ink font-medium text-ink" : "border-transparent text-mut hover:text-ink"}`}
    >
      {children}
      <Pending />
    </Link>
  );
}
