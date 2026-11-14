"use client";

import type { ReactNode } from "react";
import { useT } from "@/i18n/client";

/** Open the Page inbox (new tab) and copy the customer name to paste into the Business Suite Search box. */
export function InboxLink({ href, name, className, children }: { href: string; name: string; className?: string; children: ReactNode }) {
  const t = useT();
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={t("core.inbox.title", { name })}
      onClick={() => void navigator.clipboard?.writeText(name).catch(() => {})}
      className={className}
    >
      {children}
    </a>
  );
}
