"use client";

import type { ReactNode } from "react";
import { btnClass } from "./ui";

/** Submit button that asks for confirmation before submitting the form (for irreversible actions). */
export function ConfirmButton({ message, variant = "danger", children }: { message: string; variant?: Parameters<typeof btnClass>[0]; children: ReactNode }) {
  return (
    <button className={btnClass(variant)} onClick={(e) => !confirm(message) && e.preventDefault()}>
      {children}
    </button>
  );
}
