"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { ActionResult } from "@/app/actions";
import { btnClass, type BtnVariant } from "./ui";

export function ActionButton({
  action,
  children,
  pending,
  variant = "secondary",
  confirm,
  redirectTo,
}: {
  action: () => Promise<ActionResult>;
  children: ReactNode;
  pending?: string;
  variant?: BtnVariant;
  confirm?: string;
  /** On success, navigate to redirectTo + the returned id. */
  redirectTo?: string;
}) {
  const [isPending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  return (
    <div className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        className={btnClass(variant)}
        disabled={isPending}
        onClick={() => {
          if (confirm && !window.confirm(confirm)) return;
          setError(null);
          start(async () => {
            const res = await action();
            if (!res.ok) setError(res.error);
            else if (redirectTo && res.id) router.push(`${redirectTo}${res.id}`);
          });
        }}
      >
        {isPending && <Spinner />}
        {isPending && pending ? pending : children}
      </button>
      {error && <p className="max-w-sm text-right text-xs text-rose-600">{error}</p>}
    </div>
  );
}

export function Spinner() {
  return <span className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />;
}
