// Header of the client report (PDF print version and the public link /r/<code>).
import { BRAND } from "@/lib/brand";
import { getT } from "@/i18n/server";

const ymd = (s: string) => s.split("-").reverse().join("/");

export async function ReportCover({ name, industry, period, range }: { name: string; industry: string; period: string; range: { since: string; until: string } | null }) {
  const t = await getT();
  return (
    <header className="overflow-hidden rounded-2xl bg-gradient-to-br from-indigo-700 via-indigo-600 to-violet-600 p-6 text-white">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <span className="grid size-7 place-items-center rounded-lg bg-white/15 text-[11px] font-bold ring-1 ring-white/30">{BRAND.agency.slice(0, 2).toUpperCase()}</span>
          <span className="text-sm font-semibold">{BRAND.agency}</span>
        </div>
        {BRAND.site && <span className="text-[11px] text-indigo-100">{BRAND.site}</span>}
      </div>
      <p className="mt-6 text-[11px] font-semibold tracking-[0.18em] text-indigo-100 uppercase">{t("notify.reportCover.title")}</p>
      <h1 className="mt-1 text-[28px] leading-tight font-bold">{name}</h1>
      {range && (
        <p className="mt-1.5 text-[12px] text-indigo-100">
          {period}: {range.since === range.until ? ymd(range.since) : `${ymd(range.since)} – ${ymd(range.until)}`} · {industry}
        </p>
      )}
    </header>
  );
}
