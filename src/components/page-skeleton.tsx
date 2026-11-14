import { getT } from "@/i18n/server";
/** Loading skeleton shown immediately on page/tab switch while the server renders the content. */
export async function PageSkeleton({ compact }: { compact?: boolean }) {
  const t = await getT();
  const bar = "animate-pulse rounded-lg bg-slate-200/70";
  return (
    <div className="space-y-6" aria-busy="true" aria-label={t("core.skeleton.loading")}>
      {!compact && (
        <div className="space-y-2">
          <div className={`${bar} h-7 w-64`} />
          <div className={`${bar} h-4 w-96 max-w-full`} />
        </div>
      )}
      <div className="grid gap-3 @xl:grid-cols-3 @5xl:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className={`${bar} h-20`} />
        ))}
      </div>
      <div className={`${bar} h-64`} />
      <div className={`${bar} h-40`} />
    </div>
  );
}
