"use client";

import { useEffect, useState, useTransition } from "react";
import { reviseAction } from "@/app/actions";
import { btnClass, inputClass } from "./ui";
import { Spinner } from "./action-button";
import { useT } from "@/i18n/client";

export function ReviseForm({
  draftId,
  canStart = true,
  onPendingChange,
}: {
  draftId: string;
  /** false when the editor has unsaved changes: wait for the save before letting Claude redraft. */
  canStart?: boolean;
  /** Tell the editor to lock while Claude drafts (any edits made meanwhile would be replaced by Claude's version). */
  onPendingChange?: (pending: boolean) => void;
}) {
  const t = useT();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  useEffect(() => onPendingChange?.(pending), [pending, onPendingChange]);
  return (
    <div className="space-y-2">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        className={inputClass}
        placeholder={t("core.briefForm.placeholder")}
      />
      <div className="flex items-center gap-3">
        <button
          className={btnClass("secondary")}
          disabled={pending || !text.trim() || !canStart}
          title={canStart ? "" : t("core.briefForm.saving")}
          onClick={() =>
            start(async () => {
              setError(null);
              const res = await reviseAction(draftId, text);
              if (!res.ok) setError(res.error);
              else setText("");
            })
          }
        >
          {pending && <Spinner />}
          {pending ? t("core.briefForm.revising") : t("core.briefForm.revise")}
        </button>
        {error && <span className="text-sm text-rose-600">{error}</span>}
      </div>
    </div>
  );
}
