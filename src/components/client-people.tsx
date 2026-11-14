"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { moveClientAction, setClientAccessAction } from "@/app/auth-actions";
import { clientRoleHints, clientRoleLabels, CLIENT_ROLES, workspaceRoleLabels, type ClientRole, type WorkspaceRole } from "@/lib/access-roles";
import { Badge, btnClass, Card, inputClass } from "./ui";
import { useT } from "@/i18n/client";

type Person = { id: string; name: string; email: string; active: boolean; wsRole: WorkspaceRole; role: ClientRole | null };

/** Who has access to this client. Owners / business admins always have full access; staff have the permissions they were granted. */
export function ClientPeople({
  clientId,
  meId,
  canManage,
  workspace,
  people,
  moveTo = [],
}: {
  clientId: string;
  meId: string;
  canManage: boolean;
  workspace: string | null;
  people: Person[];
  /** Businesses the client can be moved to (the user manages both sides). */
  moveTo?: { id: string; name: string }[];
}) {
  const t = useT();
  const CLIENT_ROLE_LABEL = clientRoleLabels(t);
  const CLIENT_ROLE_HINT = clientRoleHints(t);
  const WORKSPACE_ROLE_LABEL = workspaceRoleLabels(t);
  const [pending, start] = useTransition();
  const [dest, setDest] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const router = useRouter();
  const set = (p: Person, role: ClientRole | "") =>
    start(async () => {
      const res = await setClientAccessAction(clientId, p.id, role || null);
      setMsg(res.ok ? { ok: true, text: t("core.people.updated", { name: p.name }) } : { ok: false, text: res.error });
      if (res.ok) router.refresh();
    });
  const withAccess = people.filter((p) => p.wsRole !== "member" || p.role);

  return (
    <Card title={t("core.people.title")}>
      <p className="-mt-1 mb-3 text-xs text-slate-500">
        {workspace ? t("core.people.belongsTo", { workspace }) : ""}
        {t("core.people.ownersFull")} {canManage ? t("core.people.addHint") : ""}
      </p>
      <ul className="divide-y divide-slate-100 text-sm">
        {(canManage ? people : withAccess).map((p) => (
          <li key={p.id} className={`flex flex-wrap items-center gap-2 py-2 ${p.active ? "" : "opacity-60"}`}>
            <span className="min-w-0 flex-1">
              <span className="font-medium text-slate-900">{p.name}</span>
              {p.id === meId && <span className="text-xs text-slate-400"> {t("core.people.you")}</span>}
              <span className="block truncate text-xs text-slate-500">{p.email}</span>
            </span>
            {p.wsRole !== "member" ? (
              <Badge tone="violet">{WORKSPACE_ROLE_LABEL[p.wsRole]} · {t("core.people.fullAccess")}</Badge>
            ) : canManage && p.id !== meId ? (
              <select value={p.role ?? ""} disabled={pending} onChange={(e) => set(p, e.target.value as ClientRole | "")} className={`${inputClass} h-8 w-40 py-0 text-xs`}>
                <option value="">{t("core.people.noAccess")}</option>
                {CLIENT_ROLES.map((r) => (
                  <option key={r} value={r} title={CLIENT_ROLE_HINT[r]}>
                    {CLIENT_ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
            ) : (
              <Badge>{p.role ? CLIENT_ROLE_LABEL[p.role] : t("core.people.noAccess")}</Badge>
            )}
          </li>
        ))}
      </ul>
      {moveTo.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3 text-sm">
          <span className="text-slate-600">{t("core.people.moveLabel")}</span>
          <select value={dest} disabled={pending} onChange={(e) => setDest(e.target.value)} className={`${inputClass} h-8 w-56 py-0 text-xs`}>
            <option value="">{t("core.people.pickBusiness")}</option>
            {moveTo.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={btnClass("secondary")}
            disabled={pending || !dest}
            onClick={() => {
              const w = moveTo.find((x) => x.id === dest);
              if (!w || !confirm(t("core.people.confirmMove", { name: w.name }))) return;
              start(async () => {
                const res = await moveClientAction(clientId, w.id);
                setMsg(res.ok ? { ok: true, text: t("core.people.moved", { name: w.name }) } : { ok: false, text: res.error });
                if (!res.ok) return;
                setDest("");
                router.refresh();
              });
            }}
          >
            {t("core.people.move")}
          </button>
        </div>
      )}
      {msg && <p className={`mt-2 text-sm ${msg.ok ? "text-emerald-600" : "text-rose-600"}`}>{msg.text}</p>}
    </Card>
  );
}
