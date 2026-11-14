"use client";

import { useActionState } from "react";
import { setupAction } from "./actions";
import { btnClass, Field, inputClass } from "@/components/ui";
import { Spinner } from "@/components/action-button";
import { useT } from "@/i18n/client";

export function SetupForm({ minPassword }: { minPassword: number }) {
  const t = useT();
  const [state, action, pending] = useActionState(setupAction, null);
  return (
    <form action={action} className="space-y-4">
      <Field label={t("system.setup.name")}>
        <input name="name" required autoFocus autoComplete="name" maxLength={100} className={inputClass} />
      </Field>
      <Field label="Email">
        <input name="email" type="email" required autoComplete="username" className={inputClass} />
      </Field>
      <Field label={t("system.login.password")} hint={t("system.setup.passwordHint", { n: minPassword })}>
        <input name="password" type="password" required minLength={minPassword} autoComplete="new-password" className={inputClass} />
      </Field>
      <Field label={t("system.setup.confirm")}>
        <input name="confirm" type="password" required minLength={minPassword} autoComplete="new-password" className={inputClass} />
      </Field>
      {state?.error && <p className="rounded-lg bg-rose-50 p-2.5 text-sm text-rose-700">{state.error}</p>}
      <button className={`${btnClass("primary")} w-full`} disabled={pending}>
        {pending && <Spinner />}
        {t("system.setup.submit")}
      </button>
    </form>
  );
}
