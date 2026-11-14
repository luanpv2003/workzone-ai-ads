import { translator, type T } from "@/i18n/translate";
import { DEFAULT_LOCALE } from "@/i18n/config";

export type Metrics = {
  spend: number;
  impressions: number;
  reach?: number;
  clicks: number;
  results: number;
  revenue: number;
};

export function derive(m: Metrics) {
  return {
    ctr: m.impressions ? (m.clicks / m.impressions) * 100 : 0,
    cpc: m.clicks ? m.spend / m.clicks : 0,
    cpm: m.impressions ? (m.spend / m.impressions) * 1000 : 0,
    cpr: m.results ? m.spend / m.results : null,
    roas: m.spend && m.revenue ? m.revenue / m.spend : null,
    frequency: m.reach ? m.impressions / m.reach : null,
  };
}

export function sumMetrics<T extends Metrics>(rows: T[]): Metrics {
  return rows.reduce(
    (a, r) => ({
      spend: a.spend + r.spend,
      impressions: a.impressions + r.impressions,
      reach: (a.reach ?? 0) + (r.reach ?? 0),
      clicks: a.clicks + r.clicks,
      results: a.results + r.results,
      revenue: a.revenue + r.revenue,
    }),
    { spend: 0, impressions: 0, reach: 0, clicks: 0, results: 0, revenue: 0 },
  );
}

// Budgets by currency: VND (and small-denomination currencies) round to 1,000; USD, EUR... round to 1.
const BIG_UNIT = new Set(["VND", "IDR", "KRW"]);

/** Budget rounding step (also the minimum floor when auto-calculated). */
export function budgetStep(currency = "VND") {
  return BIG_UNIT.has(currency.toUpperCase()) ? 1000 : 1;
}

export function roundBudget(v: number, currency = "VND") {
  const step = budgetStep(currency);
  return Math.round(v / step) * step;
}

/** Default daily budget when there is no figure yet: 200,000 VND, or 10 USD/EUR... (never misuse a VND figure for a USD account). */
export function defaultDailyBudget(currency = "VND", vnd = 200000) {
  return budgetStep(currency) === 1000 ? vnd : Math.round(vnd / 20000);
}

export function money(v: number | null | undefined, currency = "VND") {
  if (v == null || Number.isNaN(v)) return "—";
  try {
    return new Intl.NumberFormat("vi-VN", {
      style: "currency",
      currency,
      maximumFractionDigits: currency === "VND" ? 0 : 2,
    }).format(v);
  } catch {
    // Unknown currency code (old data): still show the number instead of crashing the page.
    return `${new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 2 }).format(v)} ${currency}`;
  }
}

export function num(v: number | null | undefined, digits = 0) {
  if (v == null || Number.isNaN(v)) return "—";
  return new Intl.NumberFormat("vi-VN", { maximumFractionDigits: digits }).format(v);
}

export function pct(v: number | null | undefined, digits = 2) {
  if (v == null) return "—";
  return `${num(v, digits)}%`;
}

export function dateTime(d: Date | string | null | undefined) {
  if (!d) return "—";
  return new Intl.DateTimeFormat("vi-VN", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Asia/Ho_Chi_Minh",
  }).format(new Date(d));
}

/** Date only, fixed to the VN timezone so the server (UTC) and browser render identically (avoids hydration errors). */
export function dateOnly(d: Date | string | null | undefined) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
}

/** Vietnamese translator: default for sync helpers that have no request context. */
export const viT = translator(DEFAULT_LOCALE);

/** Result-type labels in the UI language of `t`. */
export function resultLabels(t: T): Record<string, string> {
  return {
    messages: t("core.format.result.messages"),
    leads: t("core.format.result.leads"),
    purchases: t("core.format.result.purchases"),
    link_clicks: t("core.format.result.link_clicks"),
    reach: t("core.format.result.reach"),
    engagement: t("core.format.result.engagement"),
    profile_visits: t("core.format.result.profile_visits"),
    video_views: t("core.format.result.video_views"),
  };
}

/** Contact-stage labels in the UI language of `t`. */
export function stageLabels(t: T): Record<string, string> {
  return {
    new: t("core.format.stage.new"),
    interested: t("core.format.stage.interested"),
    considering: t("core.format.stage.considering"),
    ready_to_buy: t("core.format.stage.ready_to_buy"),
    purchased: t("core.format.stage.purchased"),
    lost: t("core.format.stage.lost"),
    spam: t("core.format.stage.spam"),
  };
}

/** Ad status labels in the UI language of `t`. */
export function statusLabels(t: T): Record<string, string> {
  return {
    ACTIVE: t("core.format.status.ACTIVE"),
    PAUSED: t("core.format.status.PAUSED"),
    ARCHIVED: t("core.format.status.ARCHIVED"),
  };
}

// Vietnamese maps kept for existing importers (AI prompts, exports); UI code should use the functions above.
export const RESULT_LABEL: Record<string, string> = resultLabels(viT);
export const STAGE_LABEL: Record<string, string> = stageLabels(viT);

/**
 * datetime-local input for "2026-10-01T08:00" (no timezone). Converted to ISO using the client's timezone,
 * not the server's (VPS usually runs UTC, which would be 7 hours off for clients in VN).
 */
export function zonedToIso(local: string, timeZone: string, t: T = viT) {
  if (/(z|[+-]\d\d:?\d\d)$/i.test(local)) return new Date(local).toISOString();
  const wall = new Date(`${local.length === 16 ? `${local}:00` : local}Z`); // wall-clock time, temporarily treated as UTC
  if (Number.isNaN(wall.getTime())) throw new Error(t("core.format.invalidTime", { time: local }));
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(wall)
      .map((p) => [p.type, Number(p.value)]),
  );
  const offset = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - wall.getTime();
  return new Date(wall.getTime() - offset).toISOString();
}
