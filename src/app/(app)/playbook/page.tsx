import { getT } from "@/i18n/server";
import type { MessageKey } from "@/i18n/translate";
import { Badge, PageHeader } from "@/components/ui";
import { RULES, RULE_AREAS, type RuleStatus } from "@/lib/playbook";

export async function generateMetadata() {
  return { title: (await getT())("playbook.title") };
}

const TONE: Record<RuleStatus, "green" | "violet" | "amber"> = { code: "green", prompt: "violet", partial: "amber" };

// Hồ Quốc Bảo's playbook: every numbered rule, grouped by where it runs, with how the app applies it.
export default async function PlaybookPage() {
  const t = await getT();
  const count = (s: RuleStatus) => RULES.filter((r) => r.status === s).length;
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title={t("playbook.title")} subtitle={t("playbook.subtitle")} />
      <div className="mb-6 flex flex-wrap items-center gap-4 rounded-xl border border-line bg-panel p-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/bao.jpg" alt="Hồ Quốc Bảo" width={56} height={56} className="size-14 rounded-full object-cover" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-ink">Hồ Quốc Bảo</p>
          <p className="text-sm text-mut">{t("playbook.author")}</p>
        </div>
        <p className="w-full text-xs text-mut">{t("playbook.count", { code: count("code"), prompt: count("prompt"), partial: count("partial") })}</p>
      </div>
      <div className="space-y-8">
        {RULE_AREAS.map((area) => (
          <section key={area}>
            <h2 className="mb-3 text-base font-semibold text-ink">{t(`playbook.area.${area}` as MessageKey)}</h2>
            <ol className="space-y-2">
              {RULES.filter((r) => r.area === area).map((r) => {
                const base = `playbook.rules.r${r.n}`;
                return (
                  <li key={r.n} id={`r${r.n}`} className="scroll-mt-20 rounded-xl border border-line bg-panel p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs font-semibold text-indigo-700">{t("playbook.badge", { n: r.n })}</span>
                      <Badge tone={TONE[r.status]}>{t(`playbook.status.${r.status}` as MessageKey)}</Badge>
                    </div>
                    <p className="mt-2 text-sm text-ink">{t(`${base}.rule` as MessageKey)}</p>
                    <p className="mt-1 text-xs text-mut">
                      {t("playbook.why")}: {t(`${base}.why` as MessageKey)}
                    </p>
                    {r.status === "partial" && <p className="mt-1 text-xs text-amber-700">{t(`${base}.note` as MessageKey)}</p>}
                  </li>
                );
              })}
            </ol>
          </section>
        ))}
      </div>
    </div>
  );
}
