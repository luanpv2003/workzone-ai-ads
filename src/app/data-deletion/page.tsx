import { BRAND } from "@/lib/brand";
import { getT } from "@/i18n/server";

// Public page: data deletion instructions (Meta requires a separate URL in the app settings).
export async function generateMetadata() {
  const t = await getT();
  return { title: t("system.dataDeletion.metaTitle", { app: BRAND.app }) };
}

export default async function DataDeletionPage() {
  const t = await getT();
  const via = BRAND.site ? t("system.dataDeletion.viaSite", { site: BRAND.site }) : "";
  return (
    <main className="mx-auto max-w-2xl px-4 py-12 text-sm leading-6 text-slate-800">
      <h1 className="text-2xl font-semibold text-slate-900">{t("system.dataDeletion.title", { app: BRAND.app })}</h1>
      <p className="mt-1 text-slate-500">{t("system.dataDeletion.subtitle")}</p>
      <ol className="mt-8 list-decimal space-y-2 pl-5">
        <li>{t("system.dataDeletion.step1", { operator: BRAND.operator })}</li>
        <li>{t("system.dataDeletion.step2", { operator: BRAND.operator, via })}</li>
        <li>{t("system.dataDeletion.step3")}</li>
      </ol>
      <p className="mt-6">
        {t("system.dataDeletion.seeAlso")} <a href="/privacy" className="text-indigo-600 hover:underline">{t("system.dataDeletion.privacyLink")}</a>.
      </p>
    </main>
  );
}
