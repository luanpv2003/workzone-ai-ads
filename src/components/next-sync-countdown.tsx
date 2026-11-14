"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/i18n/client";

/**
 * Client page header: countdown to the next automatic ads-data update (cron :05 every hour, the background job takes ~2 minutes).
 * When time is up, show "đang cập nhật…" (updating…) and refresh the page every 20 seconds until new data arrives.
 */
export function NextSyncCountdown({ nextAt, href, syncing }: { nextAt: string | null; href: string; syncing?: boolean }) {
  const router = useRouter();
  const t = useT();
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);
  const next = nextAt ? new Date(nextAt).getTime() : null;
  const left = next != null && now != null ? Math.round((next - now) / 1000) : null;
  // Due: the background job takes a few minutes → refresh periodically for 10 minutes to show the new data.
  useEffect(() => {
    if (left != null && ((left <= 0 && left > -600) || syncing) && Math.abs(left) % 20 === 0) router.refresh();
  }, [left, syncing, router]);

  if (!nextAt) return <a href={href} className="text-mut hover:underline">{t("core.nextSync.manual")}</a>;
  const clock = new Date(nextAt).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
  const fmt = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
  };
  return (
    <a href={href} className="text-mut tabular-nums hover:underline" title={t("core.nextSync.title")}>
      {syncing || (left != null && left <= 0) ? t("core.nextSync.updating") : left == null ? t("core.nextSync.at", { clock }) : t("core.nextSync.in", { time: fmt(left), clock })}
    </a>
  );
}
