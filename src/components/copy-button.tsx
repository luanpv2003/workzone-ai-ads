"use client";

import { useState } from "react";
import { btnClass } from "./ui";
import { useT } from "@/i18n/client";

export function CopyButton({ text }: { text: string }) {
  const t = useT();
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={btnClass("secondary")}
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? t("core.copy.done") : t("core.copy.copy")}
    </button>
  );
}
