import { BrandMark } from "@/components/brand-mark";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { currentUser, hasUsers } from "@/lib/auth";
import { LoginForm } from "./login-form";
import { getT } from "@/i18n/server";
import { BRAND } from "@/lib/brand";

export async function generateMetadata() {
  const t = await getT();
  return { title: t("system.login.metaTitle", { app: BRAND.app }) };
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  await connection(); // per-request page: it reads the DB, so it must never be prerendered at build time (no DB in Docker builds)
  const t = await getT();
  if (!(await hasUsers())) redirect("/setup"); // fresh installation: create the first admin in the browser
  if (await currentUser()) redirect("/");
  const { next } = await searchParams;
  return (
    <div className="grid min-h-full place-items-center bg-slate-50 px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2">
          <BrandMark size={36} />
          <span className="text-lg font-semibold text-slate-900">{BRAND.app}</span>
        </div>
        <div className="rounded-xl border border-slate-200 bg-panel p-6 shadow-sm">
          <h1 className="mb-4 text-base font-semibold text-slate-900">{t("system.login.submit")}</h1>
          <LoginForm next={next ?? "/"} />
        </div>
        <p className="mt-4 text-center text-xs text-slate-500">{t("system.login.noAccount")}</p>
      </div>
    </div>
  );
}
