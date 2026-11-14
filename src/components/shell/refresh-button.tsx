"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { btnClass } from "@/components/ui";
import { useT } from "@/i18n/client";

/** "Làm mới" (Refresh): reload the data already in the system (does not call Meta). */
export function RefreshButton({ label }: { label?: string }) {
  const t = useT();
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button type="button" className={btnClass("secondary")} disabled={pending} onClick={() => start(() => router.refresh())}>
      <RefreshCw className={pending ? "animate-spin" : ""} />
      {pending ? t("system.shell.refreshing") : (label ?? t("system.shell.refresh"))}
    </button>
  );
}
