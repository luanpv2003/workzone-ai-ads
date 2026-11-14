"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { dateTime } from "@/lib/format";
import { useT } from "@/i18n/client";

/**
 * Campaign table: "data as of …" + countdown to the next ads-data refresh
 * (the background worker refreshes every `every` seconds; the timestamp is stored in Setting sync.ads.<clientId>).
 * When it is due, refresh the page a few times until new data arrives.
 */
export function AdsRefreshCountdown({ dataAt, lastAt, every }: { dataAt: string | null; lastAt: string | null; every: number }) {
  const router = useRouter();
  const t = useT();
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);
  const last = lastAt ? new Date(lastAt).getTime() : null;
  const left = last != null && now != null ? Math.round((last + every * 1000 - now) / 1000) : null;
  useEffect(() => {
    if (left != null && left <= 0 && left > -300 && -left % 20 === 0 && document.visibilityState === "visible") router.refresh();
  }, [left, router]);

  const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const stale = left != null && left < -300; // the background worker is busy with another job for this client, or has stopped
  return (
    <span className="tabular-nums" title={t("core.adsRefresh.title")}>
      {t("core.adsRefresh.dataAt", { at: dateTime(dataAt) })}
      {last != null &&
        (left == null ? null : left > 0 ? (
          <>{t("core.adsRefresh.refreshIn", { time: mmss(left) })}</>
        ) : stale ? (
          <>{t("core.adsRefresh.slow")}</>
        ) : (
          <>{t("core.adsRefresh.refreshing")}</>
        ))}
    </span>
  );
}
