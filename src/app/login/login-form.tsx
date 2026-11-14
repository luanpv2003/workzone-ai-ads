"use client";

import { useActionState } from "react";
import { loginAction } from "@/app/auth-actions";
import { btnClass, Field, inputClass } from "@/components/ui";
import { Spinner } from "@/components/action-button";
import { useT } from "@/i18n/client";

export function LoginForm({ next }: { next: string }) {
  const t = useT();
  const [state, action, pending] = useActionState(loginAction, null);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="next" value={next} />
      <Field label="Email">
        <input name="email" type="email" autoComplete="username" required autoFocus className={inputClass} />
      </Field>
      <Field label={t("system.login.password")}>
        <input name="password" type="password" autoComplete="current-password" required className={inputClass} />
      </Field>
      {state?.error && <p className="rounded-lg bg-rose-50 p-2.5 text-sm text-rose-700">{state.error}</p>}
      <button className={`${btnClass("primary")} w-full`} disabled={pending}>
        {pending && <Spinner />}{t("system.login.submit")}
      </button>
    </form>
  );
}
