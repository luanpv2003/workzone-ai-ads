"use client";

import { ActionButton } from "../action-button";
import { optOutAction } from "@/app/nurture-actions";
import { useT } from "@/i18n/client";

/** on: block nurture messages to this customer; off: unblock. */
export function OptOutButton({ clientId, pageId, psid, name, on }: { clientId: string; pageId: string; psid: string; name: string; on: boolean }) {
  const t = useT();
  return (
    <ActionButton action={() => optOutAction(clientId, pageId, psid, name, on)} variant="ghost" pending="..." confirm={on ? t("customers.optOutButton.confirm", { name }) : undefined}>
      {on ? t("customers.optOutButton.block") : t("customers.optOutButton.unblock")}
    </ActionButton>
  );
}
