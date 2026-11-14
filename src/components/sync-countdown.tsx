"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { useT } from "@/i18n/client";

/**
 * Messages page corner: last message scan + countdown to the next scan (background worker, every `every` seconds).
 * Auto-refreshes the page when a scan is due and every 30 seconds (webhook messages arrive instantly, without waiting for a scan).
 */
export function SyncCountdown({ lastAt, every, error }: { lastAt: string | null; every: number; error?: string | null }) {
  const router = useRouter();
  const t = useT();
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const timer = setInterval(tick, 1000);
    const r = setInterval(() => document.visibilityState === "visible" && router.refresh(), 30_000);
    return () => {
      clearInterval(timer);
      clearInterval(r);
    };
  }, [router]);
  const last = lastAt ? new Date(lastAt).getTime() : null;
  const left = last != null && now != null ? Math.round((last + every * 1000 - now) / 1000) : null;
  // Scan due: refresh a few times until a new timestamp appears.
  useEffect(() => {
    if (left != null && left <= 0 && left > -60 && -left % 5 === 0) router.refresh();
  }, [left, router]);

  const time = last ? new Date(last).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : null;
  const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const stale = left != null && left < -180; // background worker not running / stuck
  return (
    <div
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs tabular-nums ${error || stale ? "border-amber-200 bg-amber-50 text-amber-800" : "border-line bg-panel text-mut"}`}
      title={t("core.syncCountdown.title")}
    >
      <RefreshCw className={`size-3.5 ${left != null && left <= 0 && !stale ? "animate-spin" : ""}`} />
      {!time ? (
        t("core.syncCountdown.none")
      ) : error ? (
        <>{t("core.syncCountdown.error", { time, error: error.slice(0, 80) })}</>
      ) : stale ? (
        <>{t("core.syncCountdown.stale", { time })}</>
      ) : (
        <>
          {t("core.syncCountdown.updated", { time })} · {left != null && left > 0 ? t("core.syncCountdown.nextScan", { time: mmss(left) }) : t("core.syncCountdown.scanning")}
        </>
      )}
    </div>
  );
}
