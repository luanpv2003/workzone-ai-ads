import { BrandMark } from "@/components/brand-mark";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { hasUsers, MIN_PASSWORD } from "@/lib/auth";
import { BRAND } from "@/lib/brand";
import { getT } from "@/i18n/server";
import { LocaleSwitch } from "@/components/shell/locale-switch";
import { SetupForm } from "./setup-form";

export async function generateMetadata() {
  const t = await getT();
  return { title: t("system.setup.metaTitle", { app: BRAND.app }) };
}

// First-run setup: only open while the database has no account at all. Afterwards it sends everyone to /login.
export default async function SetupPage() {
  await connection();
  if (await hasUsers()) redirect("/login");
  const t = await getT();
  return (
    <div className="grid min-h-full place-items-center bg-slate-50 px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <BrandMark size={36} />
            <span className="text-lg font-semibold text-slate-900">{BRAND.app}</span>
          </div>
          <LocaleSwitch />
        </div>
        <div className="rounded-xl border border-slate-200 bg-panel p-6 shadow-sm">
          <h1 className="text-base font-semibold text-slate-900">{t("system.setup.title")}</h1>
          <p className="mt-1 mb-4 text-sm text-mut">{t("system.setup.intro")}</p>
          <SetupForm minPassword={MIN_PASSWORD} />
        </div>
        <p className="mt-4 text-center text-xs text-slate-500">{t("system.setup.footnote")}</p>
      </div>
    </div>
  );
}
