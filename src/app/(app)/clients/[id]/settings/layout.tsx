import type { ReactNode } from "react";
import { TabLink } from "@/components/nav-link";
import { requirePageClient } from "@/lib/access";
import { getT } from "@/i18n/server";

// A client's settings are split into 3 tabs (one page per tab, each part saved separately).
export default async function SettingsLayout({ children, params }: { children: ReactNode; params: Promise<{ id: string }> }) {
  const t = await getT();
  const { id } = await params;
  await requirePageClient(id);
  const base = `/clients/${id}/settings`;
  return (
    <>
      <nav className="-mt-1 mb-5 flex gap-1 overflow-x-auto border-b border-line [scrollbar-width:none]">
        <TabLink href={base} exact>
          {t("settings.layout.tabInfo")}
        </TabLink>
        <TabLink href={`${base}/integrations`}>Google Ads, KiotViet & CRM</TabLink>
        <TabLink href={`${base}/automation`}>{t("settings.layout.tabAutomation")}</TabLink>
      </nav>
      {children}
    </>
  );
}
