"use client";

import { btnClass } from "@/components/ui";
import { useT } from "@/i18n/client";

// Shared error page: shows a readable error and a retry instead of Next's default error screen.
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useT();
  return (
    <div className="mx-auto max-w-xl space-y-4 rounded-xl border border-rose-200 bg-rose-50 p-6 text-sm text-rose-800">
      <h2 className="text-base font-semibold">{t("customers.errorPage.title")}</h2>
      <p className="whitespace-pre-line">{error.message || t("customers.errorPage.unknown")}</p>
      {error.digest && <p className="text-xs text-rose-600">{t("customers.errorPage.code", { digest: error.digest })}</p>}
      <button type="button" onClick={reset} className={btnClass("secondary")}>
        {t("customers.errorPage.retry")}
      </button>
    </div>
  );
}
