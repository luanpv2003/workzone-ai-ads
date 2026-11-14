"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createWorkspaceAction,
  inviteMemberAction,
  removeMemberAction,
  renameWorkspaceAction,
  resetPasswordAction,
  revokeInviteAction,
  setClientAccessAction,
  setMemberRoleAction,
  setUserActiveAction,
  setUserRoleAction,
} from "@/app/auth-actions";
import { clientRoleHints, clientRoleLabels, CLIENT_ROLES, workspaceRoleLabels, WORKSPACE_ROLES, type ClientRole, type WorkspaceRole } from "@/lib/access-roles";
import { useT } from "@/i18n/client";
import type { T } from "@/i18n/translate";
import { dateOnly, dateTime } from "@/lib/format";
import { Badge, btnClass, Card, Field, inputClass } from "./ui";
import { Spinner } from "./action-button";

type Member = {
  id: string;
  email: string;
  name: string;
  sysAdmin: boolean;
  active: boolean;
  lastLoginAt: string | null;
  role: WorkspaceRole;
  access: Record<string, ClientRole>;
};
type Invite = { id: string; email: string; role: WorkspaceRole; createdBy: string; expiresAt: string };
type Client = { id: string; name: string };
type Res = { ok: true } | { ok: false; error: string };

const roleHints = (t: T): Record<WorkspaceRole, string> => ({
  owner: t("system.users.hintOwner"),
  admin: t("system.users.hintAdmin"),
  member: t("system.users.hintMember"),
});

/** Role select on a client ("" = no access). */
function ClientRoleSelect({ value, onChange, disabled }: { value: ClientRole | ""; onChange: (v: ClientRole | "") => void; disabled?: boolean }) {
  const t = useT();
  const labels = clientRoleLabels(t);
  const hints = clientRoleHints(t);
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as ClientRole | "")} disabled={disabled} className={`${inputClass} h-8 w-40 py-0 text-xs`}>
      <option value="">{t("system.users.noAccess")}</option>
      {CLIENT_ROLES.map((r) => (
        <option key={r} value={r} title={hints[r]}>
          {labels[r]}
        </option>
      ))}
    </select>
  );
}

export function UserAdmin({
  meId,
  sysAdmin,
  myRole,
  workspace,
  clients,
  members,
  invites,
}: {
  meId: string;
  sysAdmin: boolean;
  myRole: WorkspaceRole;
  workspace: { id: string; name: string; platform: boolean };
  clients: Client[];
  members: Member[];
  invites: Invite[];
}) {
  const t = useT();
  const WS_LABEL = workspaceRoleLabels(t);
  const ROLE_HINT = roleHints(t);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [form, setForm] = useState<{ email: string; role: WorkspaceRole; grants: Record<string, ClientRole> }>({ email: "", role: "member", grants: {} });
  const [link, setLink] = useState<string | null>(null);
  const router = useRouter();
  const done = (res: Res, text: string) => {
    setMsg(res.ok ? { ok: true, text } : { ok: false, text: res.error });
    if (res.ok) router.refresh();
    return res.ok;
  };
  const roles = WORKSPACE_ROLES.filter((r) => r !== "owner" || myRole === "owner");

  return (
    <div className="space-y-6">
      {msg && <p className={`text-sm ${msg.ok ? "text-emerald-600" : "text-rose-600"}`}>{msg.text}</p>}

      <Card
        title={
          <span className="flex items-center gap-2">
            {t("system.users.peopleIn", { name: workspace.name })} {workspace.platform && <Badge tone="violet">{t("system.users.rootBusiness")}</Badge>}
          </span>
        }
        action={
          <button
            type="button"
            className={btnClass("ghost")}
            disabled={pending}
            onClick={() => {
              const name = prompt(t("system.users.promptWsName"), workspace.name);
              if (name && name !== workspace.name) start(async () => void done(await renameWorkspaceAction(workspace.id, name), t("system.users.renamed")));
            }}
          >
            {t("system.users.rename")}
          </button>
        }
      >
        <div className="-mx-5 -my-5 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500">
              <tr>
                <th className="px-5 py-2 font-medium">{t("system.users.colUser")}</th>
                <th className="px-3 py-2 font-medium">{t("system.users.colRole")}</th>
                <th className="px-3 py-2 font-medium">{t("system.users.colClients")}</th>
                <th className="px-3 py-2 font-medium">{t("system.users.colLastLogin")}</th>
                <th className="px-5 py-2 text-right font-medium">{t("system.users.colActions")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {members.map((u) => {
                const me = u.id === meId;
                const fixed = me || (u.role === "owner" && myRole !== "owner");
                const full = u.role !== "member";
                const n = Object.keys(u.access).length;
                return [
                  <tr key={u.id} className={u.active ? "" : "opacity-60"}>
                    <td className="px-5 py-3">
                      <p className="font-medium text-slate-900">
                        {u.name}
                        {me && <span className="text-xs font-normal text-slate-400"> ({t("system.users.you")})</span>}
                      </p>
                      <p className="text-xs text-slate-500">{u.email}</p>
                      <div className="mt-1 flex gap-1">
                        {u.sysAdmin && <Badge tone="violet">{t("system.users.sysAdmin")}</Badge>}
                        {!u.active && <Badge tone="red">{t("system.users.locked")}</Badge>}
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <select
                        value={u.role}
                        disabled={pending || fixed}
                        title={ROLE_HINT[u.role]}
                        onChange={(e) => start(async () => void done(await setMemberRoleAction(workspace.id, u.id, e.target.value), t("system.users.roleChanged", { name: u.name })))}
                        className={`${inputClass} h-8 w-36 py-0 text-xs`}
                      >
                        {(fixed ? WORKSPACE_ROLES : roles).map((r) => (
                          <option key={r} value={r}>
                            {WS_LABEL[r]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-3 py-3 text-xs">
                      {full ? (
                        <span className="text-slate-500">{t("system.users.allClients")}</span>
                      ) : (
                        <button type="button" className="text-indigo-600 hover:underline" onClick={() => setOpen(open === u.id ? null : u.id)}>
                          {n ? t("system.users.nOfClients", { n, total: clients.length }) : t("system.users.noneAssigned")} · {open === u.id ? t("system.users.close") : t("system.users.edit")}
                        </button>
                      )}
                    </td>
                    <td className="px-3 py-3 text-xs text-slate-500">{dateTime(u.lastLoginAt)}</td>
                    <td className="px-5 py-3">
                      <div className="flex justify-end gap-1 whitespace-nowrap">
                        {sysAdmin && (
                          <button
                            type="button"
                            className={btnClass("ghost")}
                            disabled={pending}
                            onClick={() => {
                              const pw = prompt(t("system.users.promptPassword", { name: u.name }));
                              if (pw) start(async () => void done(await resetPasswordAction(u.id, pw), t("system.users.passwordReset", { name: u.name })));
                            }}
                          >
                            {t("system.users.resetPassword")}
                          </button>
                        )}
                        {!me && sysAdmin && (
                          <>
                            <button
                              type="button"
                              className={btnClass("ghost")}
                              disabled={pending}
                              onClick={() =>
                                (u.sysAdmin || confirm(t("system.users.confirmMakeAdmin", { name: u.name }))) &&
                                start(async () => void done(await setUserRoleAction(u.id, u.sysAdmin ? "member" : "admin"), t("system.users.adminChanged")))
                              }
                            >
                              {u.sysAdmin ? t("system.users.removeSysAdmin") : t("system.users.sysAdmin")}
                            </button>
                            <button
                              type="button"
                              className={`${btnClass("ghost")} ${u.active ? "text-rose-600" : "text-emerald-700"}`}
                              disabled={pending}
                              onClick={() =>
                                (u.active ? confirm(t("system.users.confirmLock", { name: u.name })) : true) &&
                                start(async () => void done(await setUserActiveAction(u.id, !u.active), u.active ? t("system.users.lockedDone") : t("system.users.unlockedDone")))
                              }
                            >
                              {u.active ? t("system.users.lock") : t("system.users.unlock")}
                            </button>
                          </>
                        )}
                        {!fixed && (
                          <button
                            type="button"
                            className={`${btnClass("ghost")} text-rose-600`}
                            disabled={pending}
                            onClick={() =>
                              confirm(t("system.users.confirmRemove", { name: u.name, ws: workspace.name })) &&
                              start(async () => void done(await removeMemberAction(workspace.id, u.id), t("system.users.removed", { name: u.name })))
                            }
                          >
                            {t("system.users.remove")}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>,
                  open === u.id && !full && (
                    <tr key={`${u.id}-access`} className="bg-slate-50/60">
                      <td colSpan={5} className="px-5 py-3">
                        {!clients.length ? (
                          <p className="text-xs text-slate-500">{t("system.users.noClientsYet")}</p>
                        ) : (
                          <div className="grid gap-2 @2xl:grid-cols-2">
                            {clients.map((c) => (
                              <label key={c.id} className="flex items-center justify-between gap-3 text-sm">
                                <span className="min-w-0 truncate">{c.name}</span>
                                <ClientRoleSelect
                                  value={u.access[c.id] ?? ""}
                                  disabled={pending}
                                  onChange={(v) => start(async () => void done(await setClientAccessAction(c.id, u.id, v || null), t("system.users.accessUpdated", { name: u.name, client: c.name })))}
                                />
                              </label>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title={t("system.users.addPerson")}>
        <div className="grid gap-4 @2xl:grid-cols-2">
          <Field label="Email" hint={t("system.users.emailHint")}>
            <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className={inputClass} autoComplete="off" />
          </Field>
          <Field label={t("system.users.roleInBusiness")} hint={ROLE_HINT[form.role]}>
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as WorkspaceRole })} className={inputClass}>
              {roles.map((r) => (
                <option key={r} value={r}>
                  {WS_LABEL[r]}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {form.role === "member" && clients.length > 0 && (
          <div className="mt-4">
            <p className="mb-2 text-xs font-medium text-slate-600">{t("system.users.assignClients")}</p>
            <div className="grid gap-2 @2xl:grid-cols-2">
              {clients.map((c) => (
                <label key={c.id} className="flex items-center justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate">{c.name}</span>
                  <ClientRoleSelect
                    value={form.grants[c.id] ?? ""}
                    onChange={(v) => {
                      const grants = { ...form.grants };
                      if (v) grants[c.id] = v;
                      else delete grants[c.id];
                      setForm({ ...form, grants });
                    }}
                  />
                </label>
              ))}
            </div>
          </div>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            className={btnClass("primary")}
            disabled={pending || !form.email}
            onClick={() =>
              start(async () => {
                setLink(null);
                const res = await inviteMemberAction(workspace.id, { email: form.email, role: form.role, grants: Object.entries(form.grants).map(([clientId, role]) => ({ clientId, role })) });
                if (!res.ok) return void setMsg({ ok: false, text: res.error });
                setMsg({ ok: true, text: res.added ? t("system.users.addedTo", { name: res.added, ws: workspace.name }) : t("system.users.inviteCreated", { email: form.email }) });
                if (res.url) setLink(res.url);
                setForm({ email: "", role: "member", grants: {} });
                router.refresh();
              })
            }
          >
            {pending && <Spinner />}{t("system.users.addInvite")}
          </button>
        </div>
        {link && (
          <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm">
            <p className="text-emerald-800">{t("system.users.sendLinkNote")}</p>
            <div className="mt-2 flex gap-2">
              <input readOnly value={link} className={`${inputClass} font-mono text-xs`} onFocus={(e) => e.target.select()} />
              <button type="button" className={btnClass("secondary")} onClick={() => navigator.clipboard?.writeText(link).then(() => setMsg({ ok: true, text: t("system.users.linkCopied") }))}>
                {t("system.users.copy")}
              </button>
            </div>
          </div>
        )}
      </Card>

      {invites.length > 0 && (
        <Card title={t("system.users.pendingInvites")}>
          <ul className="-my-5 divide-y divide-slate-100">
            {invites.map((i) => (
              <li key={i.id} className="flex items-center gap-3 py-3 text-sm">
                <span className="min-w-0 flex-1 truncate">
                  {i.email} <span className="text-xs text-slate-500">· {WS_LABEL[i.role]} · {t("system.users.invitedByExpires", { by: i.createdBy, date: dateOnly(i.expiresAt) })}</span>
                </span>
                <button type="button" className={`${btnClass("ghost")} text-rose-600`} disabled={pending} onClick={() => start(async () => void done(await revokeInviteAction(i.id), t("system.users.inviteRevoked")))}>
                  {t("system.users.revoke")}
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

/** System admin: list of businesses + create a new business (e.g. another agency / freelancer using the system). */
export function WorkspaceList({ current, items }: { current: string; items: { id: string; name: string; platform: boolean; members: number; clients: number }[] }) {
  const t = useT();
  const [pending, start] = useTransition();
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();
  return (
    <Card title={t("system.users.businesses")} className="mt-6">
      <ul className="-mt-2 mb-4 divide-y divide-slate-100 text-sm">
        {items.map((w) => (
          <li key={w.id} className="flex items-center gap-2 py-2">
            <a href={`/users?w=${w.id}`} className={`min-w-0 flex-1 truncate ${w.id === current ? "font-semibold text-slate-900" : "text-indigo-600 hover:underline"}`}>
              {w.name}
            </a>
            {w.platform && <Badge tone="violet">{t("system.users.root")}</Badge>}
            <span className="text-xs text-slate-500">
              {t("system.users.membersClients", { members: w.members, clients: w.clients })}
            </span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("system.users.newBusinessName")} className={`${inputClass} max-w-xs`} />
        <button
          type="button"
          className={btnClass("secondary")}
          disabled={pending || !name.trim()}
          onClick={() =>
            start(async () => {
              const res = await createWorkspaceAction(name);
              if (!res.ok) return void setErr(res.error);
              setName("");
              setErr(null);
              router.push(`/users?w=${res.id}`);
            })
          }
        >
          {pending && <Spinner />}{t("system.users.createBusiness")}
        </button>
        {err && <span className="text-sm text-rose-600">{err}</span>}
      </div>
      <p className="mt-2 text-xs text-slate-500">{t("system.users.createNote")}</p>
    </Card>
  );
}
