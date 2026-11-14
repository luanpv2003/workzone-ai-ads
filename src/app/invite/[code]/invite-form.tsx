"use client";

import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { acceptInviteAction, joinInviteAction } from "@/app/auth-actions";
import { btnClass, Field, inputClass } from "@/components/ui";
import { Spinner } from "@/components/action-button";
import { useT } from "@/i18n/client";

/** No account yet: set your own name + password, then log in right away. */
export function AcceptInviteForm({ code, email }: { code: string; email: string }) {
  const t = useT();
  const [state, action, pending] = useActionState(acceptInviteAction, null);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="code" value={code} />
      <Field label="Email">
        <input value={email} readOnly autoComplete="username" className={`${inputClass} bg-slate-50`} />
      </Field>
      <Field label={t("system.invite.fullName")}>
        <input name="name" required autoFocus className={inputClass} />
      </Field>
      <Field label={t("system.invite.password")} hint={t("system.invite.passwordHint")}>
        <input name="password" type="password" required minLength={10} autoComplete="new-password" className={inputClass} />
      </Field>
      <Field label={t("system.invite.confirmPassword")}>
        <input name="confirm" type="password" required minLength={10} autoComplete="new-password" className={inputClass} />
      </Field>
      {state?.error && <p className="rounded-lg bg-rose-50 p-2.5 text-sm text-rose-700">{state.error}</p>}
      <button className={`${btnClass("primary")} w-full`} disabled={pending}>
        {pending && <Spinner />}{t("system.invite.createAndJoin")}
      </button>
    </form>
  );
}

/** Logged in with the invited email: click to accept. */
export function JoinInviteButton({ code }: { code: string }) {
  const t = useT();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();
  return (
    <div className="space-y-3">
      <button
        type="button"
        className={`${btnClass("primary")} w-full`}
        disabled={pending}
        onClick={() =>
          start(async () => {
            const res = await joinInviteAction(code);
            if (res.ok) router.push("/");
            else setErr(res.error);
          })
        }
      >
        {pending && <Spinner />}{t("system.invite.accept")}
      </button>
      {err && <p className="rounded-lg bg-rose-50 p-2.5 text-sm text-rose-700">{err}</p>}
    </div>
  );
}
