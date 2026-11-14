"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Plus } from "lucide-react";
import { btnClass, inputClass } from "../ui";
import { createReviewAction } from "@/app/content-review-actions";
import { useT } from "@/i18n/client";

export function NewReview({ clientId }: { clientId: string }) {
  const t = useT();
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <form
      className="mt-4 flex flex-wrap gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await createReviewAction(clientId, title);
          if (!r.ok) return setError(r.error);
          router.push(`/clients/${clientId}/content/${r.id}`);
        });
      }}
    >
      <input className={`${inputClass} max-w-sm flex-1`} placeholder={t("targeting.newReview.placeholder")} value={title} onChange={(e) => setTitle(e.target.value)} />
      <button className={btnClass("primary")} disabled={pending}>
        <Plus className="size-4" /> {pending ? t("targeting.newReview.creating") : t("targeting.newReview.create")}
      </button>
      {error && <p className="w-full text-sm text-rose-700">{error}</p>}
    </form>
  );
}
