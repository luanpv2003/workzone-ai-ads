// Public page (no login required): Meta requires a privacy policy link to switch the app to Live mode.
import { BRAND } from "@/lib/brand";
import { getT } from "@/i18n/server";

// Template: whoever runs an installation must review this text and set NEXT_PUBLIC_OPERATOR_* in .env.
export async function generateMetadata() {
  const t = await getT();
  return { title: t("system.privacy.metaTitle", { app: BRAND.app }) };
}

export default async function PrivacyPage() {
  const t = await getT();
  const op = { operator: BRAND.operator, app: BRAND.app };
  const via = BRAND.site ? t("system.privacy.viaSite", { site: BRAND.site }) : "";
  return (
    <main className="mx-auto max-w-2xl px-4 py-12 text-slate-800">
      <h1 className="text-2xl font-semibold text-slate-900">{t("system.privacy.title", { app: BRAND.app })}</h1>
      <p className="mt-1 text-sm text-slate-500">{t("system.privacy.updated")}</p>

      <div className="mt-8 space-y-6 text-sm leading-6">
        <section>
          <h2 className="mb-1 font-semibold text-slate-900">{t("system.privacy.s1Title")}</h2>
          <p>{t("system.privacy.s1Body", { ...op, siteParen: BRAND.site ? ` (${BRAND.site})` : "" })}</p>
        </section>
        <section>
          <h2 className="mb-1 font-semibold text-slate-900">{t("system.privacy.s2Title")}</h2>
          <ul className="list-disc space-y-1 pl-5">
            <li>{t("system.privacy.s2a")}</li>
            <li>{t("system.privacy.s2b")}</li>
            <li>{t("system.privacy.s2c")}</li>
            <li>{t("system.privacy.s2d", op)}</li>
          </ul>
        </section>
        <section>
          <h2 className="mb-1 font-semibold text-slate-900">{t("system.privacy.s3Title")}</h2>
          <p>{t("system.privacy.s3Body")}</p>
        </section>
        <section>
          <h2 className="mb-1 font-semibold text-slate-900">{t("system.privacy.s4Title")}</h2>
          <p>{t("system.privacy.s4Body", op)}</p>
        </section>
        <section id="xoa-du-lieu">
          <h2 className="mb-1 font-semibold text-slate-900">{t("system.privacy.s5Title")}</h2>
          <p>{t("system.privacy.s5Body", { ...op, via })}</p>
        </section>
      </div>
    </main>
  );
}
