import type { Metadata } from "next";
import { connection } from "next/server";
import { confirmView } from "@/lib/lead-confirm";
import { FEEDBACK_FIELDS } from "@/lib/lead-sheet";
import { LeadConfirm } from "@/components/lead-confirm";
import { getT } from "@/i18n/server";

// Link in the bot's lead notification (Zalo / Telegram group): claim the lead, report the result after calling. No login required (secret code in the link).

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("notify.confirmPage.title"), robots: { index: false, follow: false } };
}

export default async function LeadConfirmPage({ params }: { params: Promise<{ code: string }> }) {
  await connection();
  const t = await getT();
  const { code } = await params;
  const v = await confirmView(code);
  if (!v) {
    return (
      <div data-theme="light" className="grid min-h-full place-items-center bg-slate-100 p-6 text-center text-ink">
        <div className="max-w-sm rounded-2xl bg-panel p-8 shadow-sm">
          <p className="text-lg font-semibold">{t("notify.confirmPage.notFound")}</p>
          <p className="mt-2 text-sm text-slate-600">{t("notify.confirmPage.notFoundDesc")}</p>
        </div>
      </div>
    );
  }
  const fmt = (d: Date) => d.toLocaleString("vi-VN", { timeZone: v.tz, hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
  const p = v.person;
  return (
    <div data-theme="light" className="min-h-full bg-slate-100 text-ink">
      <main className="mx-auto max-w-md space-y-4 px-4 py-5">
        <header>
          <p className="text-xs text-slate-500">
            {v.client} · {p.source === "Form" ? t("notify.confirmPage.sourceForm") : t("notify.confirmPage.sourceMessage")} · {fmt(p.at)}
          </p>
          <h1 className="mt-0.5 text-xl font-semibold">{p.name}</h1>
        </header>

        <section className="space-y-2 rounded-2xl bg-panel p-4 shadow-sm">
          {p.phones.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {p.phones.map((ph) => (
                <a key={ph} href={`tel:${ph}`} className="inline-flex h-11 items-center gap-2 rounded-xl bg-emerald-600 px-4 text-base font-semibold text-white">
                  📞 {ph}
                </a>
              ))}
            </div>
          ) : (
            <p className="text-sm text-slate-500">{t("notify.confirmPage.noPhone")}</p>
          )}
          {p.email && <p className="text-sm">{t("notify.confirmPage.email", { v: p.email })}</p>}
          {p.form && <p className="text-sm text-slate-600">{t("notify.confirmPage.form", { v: p.form })}</p>}
          {p.ad && <p className="text-sm text-slate-600">{t("notify.confirmPage.ad", { v: p.ad })}</p>}
          {p.lines.length > 0 && (
            <div className="space-y-1 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">
              {p.lines.map((l, i) => (
                <p key={i} className="break-words">
                  {p.source === "Tin nhắn" ? `“${l}”` : l}
                </p>
              ))}
            </div>
          )}
          {p.inbox && (
            <a href={p.inbox} target="_blank" rel="noreferrer" className="inline-block text-sm text-indigo-600 underline">
              {t("notify.confirmPage.openInbox")}
            </a>
          )}
        </section>

        <LeadConfirm
          code={code}
          ack={v.ack ? { by: v.ack.by, at: fmt(v.ack.at) } : null}
          feedback={v.feedback}
          feedbackBy={v.feedbackBy ? { by: v.feedbackBy.by, at: fmt(v.feedbackBy.at) } : null}
          fields={FEEDBACK_FIELDS.map((f) => ({ field: f.field, label: t(f.labelKey), options: [...f.options] }))}
        />

        <p className="text-center text-[11px] text-slate-400">{t("notify.confirmPage.footer")}</p>
      </main>
    </div>
  );
}
