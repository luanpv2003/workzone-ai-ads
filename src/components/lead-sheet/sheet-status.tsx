"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { useLocale, useT } from "@/i18n/client";
import type { T } from "@/i18n/translate";

const hhmm = (ms: number, loc = "vi-VN") => new Date(ms).toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit" });
const ago = (t: T, s: number) =>
  s < 60 ? t("customers.sheetStatus.sec", { n: s }) : s < 3600 ? t("customers.sheetStatus.min", { n: Math.floor(s / 60) }) : s < 86400 ? t("customers.sheetStatus.hour", { n: Math.floor(s / 3600) }) : t("customers.sheetStatus.day", { n: Math.floor(s / 86400) });
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/**
 * Google Sheet link status: the Sheet's last call + countdown to the next one (Apps Script runs roughly every `everyMin` minutes).
 * No call for more than 2 cycles = link lost (trigger deleted, Sheet permission error, or the link changed and the code wasn't re-pasted).
 * Auto-refreshes the page every 30 seconds to show new runs.
 */
export function SheetStatus({
  linkedAt,
  seenAt,
  rows,
  feedbackAt,
  feedbackTotal,
  everyMin,
  scriptV,
  latestV,
  auto,
}: {
  linkedAt: string | null;
  seenAt: string | null;
  rows: number | null;
  feedbackAt: string | null;
  feedbackTotal: number;
  everyMin: number;
  scriptV: number | null;
  latestV: number;
  auto: boolean | null;
}) {
  const router = useRouter();
  const t = useT();
  const locale = useLocale();
  const time = (ms: number) => hhmm(ms, locale === "en" ? "en-GB" : "vi-VN");
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const tickId = setInterval(tick, 1000);
    const r = setInterval(() => document.visibilityState === "visible" && router.refresh(), 30_000);
    return () => {
      clearInterval(tickId);
      clearInterval(r);
    };
  }, [router]);

  // Times are shown in the viewer's local time (the server is in another timezone): only render after running in the browser.
  if (now == null) return <div className="h-16 rounded-lg border border-line bg-slate-50" />;
  const every = everyMin * 60;
  const seen = seenAt ? new Date(seenAt).getTime() : null;
  const since = seen != null && now != null ? Math.max(0, Math.round((now - seen) / 1000)) : null;
  const left = since != null ? every - since : null;

  let tone: "good" | "warn" | "bad";
  let title: string;
  let detail: React.ReactNode;
  if (seen == null) {
    tone = "warn";
    title = t("customers.sheetStatus.waitingTitle");
    detail = t("customers.sheetStatus.waitingDetail", { time: linkedAt ? time(new Date(linkedAt).getTime()) : "—" });
  } else if (since != null && since > every * 2) {
    tone = "bad";
    title = t("customers.sheetStatus.lostTitle");
    detail = (
      <>
        {t("customers.sheetStatus.lost1", { time: time(seen), ago: ago(t, since) })}<b>{t("customers.sheetStatus.lostTriggers")}</b>{t("customers.sheetStatus.lost2")}<code>dongBo</code>{t("customers.sheetStatus.lost3")}<code>caiDat</code>{t("customers.sheetStatus.lost4")}
      </>
    );
  } else {
    tone = "good";
    title = t("customers.sheetStatus.okTitle");
    detail = (
      <>
        {t("customers.sheetStatus.okDetail", { time: time(seen) })}
        {rows != null && t("customers.sheetStatus.okRows", { n: rows })}
      </>
    );
  }
  const cls = { good: "border-emerald-200 bg-emerald-50 text-emerald-800", warn: "border-amber-200 bg-amber-50 text-amber-800", bad: "border-rose-200 bg-rose-50 text-rose-800" }[tone];
  const dot = { good: "bg-emerald-500", warn: "bg-amber-500", bad: "bg-rose-500" }[tone];

  return (
    <div className={`rounded-lg border px-3 py-2.5 text-sm ${cls}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="inline-flex items-center gap-1.5 font-semibold">
          <span className={`size-2 rounded-full ${dot} ${tone === "good" ? "animate-pulse" : ""}`} />
          {title}
        </span>
        {tone === "good" && left != null && (
          <span className="ml-auto inline-flex items-center gap-1 text-xs tabular-nums">
            <RefreshCw className={`size-3.5 ${left <= 0 ? "animate-spin" : ""}`} />
            {left > 0 ? t("customers.sheetStatus.next", { time: mmss(left) }) : t("customers.sheetStatus.due")}
          </span>
        )}
      </div>
      <div className="mt-1 text-xs">{detail}</div>
      {seen != null && (scriptV ?? 0) < latestV && (
        <div className="mt-1 text-xs font-medium">{t("customers.sheetStatus.oldCode")}</div>
      )}
      {seen != null && scriptV != null && auto === false && (
        <div className="mt-1 text-xs font-medium">{t("customers.sheetStatus.noTrigger")}</div>
      )}
      {seen != null && (
        <div className="mt-1 text-xs opacity-80">
          {t("customers.sheetStatus.feedback", { n: feedbackTotal })}
          {feedbackAt && t("customers.sheetStatus.feedbackLast", { time: time(new Date(feedbackAt).getTime()) })}
        </div>
      )}
    </div>
  );
}
