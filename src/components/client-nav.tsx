"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronLeft, LayoutGrid } from "lucide-react";
import { localizeSection, sectionFor } from "@/lib/client-sections";
import { useT } from "@/i18n/client";
import { openClientMenu } from "@/components/shell/client-menu";

/**
 * Client page content header: section name + one sentence on "what this page is for" (for newcomers).
 * Detail pages inside a section (e.g. one draft) only show a link back to that section.
 * Navigation between sections lives in the sidebar (mobile: the "Các mục" (Sections) button).
 */
export function ClientPageIntro({ base }: { base: string }) {
  const path = usePathname();
  const rel = path.startsWith(base) ? path.slice(base.length) : path;
  const t = useT();
  const s = localizeSection(sectionFor(rel), t);
  const deep = s && !s.tabs && rel.replace(/\/$/, "") !== s.path;
  const menu = (
    <button type="button" onClick={openClientMenu} className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-line bg-panel px-2.5 text-sm text-ink2 md:hidden">
      <LayoutGrid className="size-4" /> {t("core.clientNav.sections")}
    </button>
  );
  if (!s || deep)
    return (
      <div className="mb-4 flex items-center justify-between gap-3">
        {s ? (
          <Link href={`${base}${s.path}`} className="inline-flex items-center gap-1 text-sm text-mut hover:text-ink">
            <ChevronLeft className="size-4" /> {s.label}
          </Link>
        ) : (
          <span />
        )}
        {menu}
      </div>
    );
  return (
    <div className="mb-5 flex items-start gap-3">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-line bg-panel text-ink2">
        <s.icon className="size-[18px]" />
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="text-lg leading-tight font-semibold text-ink">{s.label}</h2>
        <p className="mt-0.5 text-sm text-mut">{s.desc}</p>
      </div>
      {menu}
    </div>
  );
}
