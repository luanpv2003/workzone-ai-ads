import Link from "next/link";
import { connection } from "next/server";
import { CheckCircle2, Circle, CircleDashed } from "lucide-react";
import type { ReactNode } from "react";
import { requirePageUser } from "@/lib/auth";
import { gettingStartedStatus } from "@/lib/getting-started";
import { Badge, LinkButton, PageHeader } from "@/components/ui";
import { BRAND } from "@/lib/brand";
import { getT } from "@/i18n/server";

export async function generateMetadata() {
  return { title: (await getT())("system.gettingStarted.title") };
}

function Step({ n, state, title, body, label, action }: { n: number; state: "done" | "todo" | "optional"; title: string; body: string; label: string; action?: ReactNode }) {
  const Icon = state === "done" ? CheckCircle2 : state === "optional" ? CircleDashed : Circle;
  return (
    <li className="flex gap-3 px-5 py-4">
      <Icon className={`mt-0.5 size-5 shrink-0 ${state === "done" ? "text-emerald-600" : "text-mut2"}`} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[15px] font-semibold text-ink">
            {n}. {title}
          </h2>
          <Badge tone={state === "done" ? "good" : state === "optional" ? "mut" : "warn"}>{label}</Badge>
        </div>
        <p className="mt-1 text-sm text-mut">{body}</p>
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </li>
  );
}

// "Bắt đầu" (Getting started): where the first admin lands after /setup; also linked from the home page until the required steps are done.
export default async function GettingStartedPage() {
  const user = await requirePageUser();
  await connection();
  const t = await getT();
  const s = await gettingStartedStatus(user);
  const label = { done: t("system.gettingStarted.done"), todo: t("system.gettingStarted.todo"), optional: t("system.gettingStarted.optional") };
  const g = (k: keyof typeof label) => label[k];
  return (
    <div className="max-w-3xl">
      <PageHeader title={t("system.gettingStarted.title")} subtitle={t("system.gettingStarted.subtitle", { app: BRAND.app })} />
      <p className="mb-4 text-sm text-ink2">{t("system.gettingStarted.welcome", { name: user.name })}</p>
      <ol className="divide-y divide-line rounded-xl border border-line bg-panel">
        <Step
          n={1}
          state={s.meta ? "done" : "todo"}
          label={g(s.meta ? "done" : "todo")}
          title={t("system.gettingStarted.metaTitle")}
          body={s.meta ? t("system.gettingStarted.metaDone", { n: s.metaClients }) : s.firstClientId ? t("system.gettingStarted.metaNoToken") : t("system.gettingStarted.metaNoClient")}
          action={
            s.firstClientId ? (
              <LinkButton href={`/clients/${s.firstClientId}/settings`}>{t("system.gettingStarted.metaOpenSettings")}</LinkButton>
            ) : (
              <LinkButton href="/clients/new" variant="primary">
                {t("system.shell.addClient")}
              </LinkButton>
            )
          }
        />
        <Step
          n={2}
          state={s.ai ? "done" : "todo"}
          label={g(s.ai ? "done" : "todo")}
          title={t("system.gettingStarted.aiTitle")}
          body={s.ai ? t("system.gettingStarted.aiDone", { n: s.aiConnections }) : t("system.gettingStarted.aiBody")}
          action={<LinkButton href="/connect-ai" variant={s.ai ? "secondary" : "primary"}>{t("system.gettingStarted.aiCta")}</LinkButton>}
        />
        <Step
          n={3}
          state={s.claudeKey ? "done" : "optional"}
          label={g(s.claudeKey ? "done" : "optional")}
          title={t("system.gettingStarted.claudeTitle")}
          body={s.claudeKey ? t("system.gettingStarted.claudeDone") : s.canSetClaude ? t("system.gettingStarted.claudeBody") : t("system.gettingStarted.claudeNoAccess")}
          action={s.canSetClaude ? <LinkButton href="/connections/claude">{t("system.gettingStarted.claudeCta")}</LinkButton> : undefined}
        />
      </ol>
      {s.left === 0 && (
        <p className="mt-4 flex flex-wrap items-center gap-3 text-sm text-ink2">
          {t("system.gettingStarted.allDone")}
          <Link href="/" className="font-medium text-indigo-600 underline">
            {t("system.gettingStarted.goHome")}
          </Link>
        </p>
      )}
    </div>
  );
}
