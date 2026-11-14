"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Refresh the page every `seconds` seconds while enabled (e.g. during a background sync), only when the tab is visible. */
export function AutoRefresh({ on, seconds = 20 }: { on: boolean; seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => document.visibilityState === "visible" && router.refresh(), seconds * 1000);
    return () => clearInterval(t);
  }, [on, seconds, router]);
  return null;
}
