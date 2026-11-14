import { BrandMark } from "@/components/brand-mark";
import { createHash } from "node:crypto";
import Link from "next/link";
import { connection } from "next/server";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { workspaceRoleLabels, asWorkspaceRole } from "@/lib/access";
import { getT } from "@/i18n/server";
import { BRAND } from "@/lib/brand";
import { AcceptInviteForm, JoinInviteButton } from "./invite-form";

export async function generateMetadata() {
  const t = await getT();
  return { title: t("system.invite.metaTitle", { app: BRAND.app }) };
}

// Public page (the proxy skips /invite/): the code in the link is the secret; the DB stores only its SHA-256.
export default async function InvitePage({ params }: { params: Promise<{ code: string }> }) {
  await connection();
  const t = await getT();
  const { code } = await params;
  const inv = await db.invite.findUnique({ where: { id: createHash("sha256").update(code).digest("hex") }, include: { workspace: true } });
  const valid = inv && !inv.usedAt && inv.expiresAt > new Date();
  const me = valid ? await currentUser() : null;
  const hasAccount = valid ? !!(await db.user.findUnique({ where: { email: inv.email }, select: { id: true } })) : false;

  return (
    <div className="grid min-h-full place-items-center bg-slate-50 px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2">
          <BrandMark size={36} />
          <span className="text-lg font-semibold text-slate-900">{BRAND.app}</span>
        </div>
        <div className="rounded-xl border border-slate-200 bg-panel p-6 shadow-sm">
          {!valid ? (
            <>
              <h1 className="mb-2 text-base font-semibold text-slate-900">{t("system.invite.unusableTitle")}</h1>
              <p className="text-sm text-slate-600">{t("system.invite.unusableBody")}</p>
            </>
          ) : (
            <>
              <h1 className="text-base font-semibold text-slate-900">{t("system.invite.join", { name: inv.workspace.name })}</h1>
              <p className="mt-1 mb-4 text-sm text-slate-600">
                {t("system.invite.invitedBy", { by: inv.createdBy })} <b>{inv.email}</b> {t("system.invite.withRole", { role: workspaceRoleLabels(t)[asWorkspaceRole(inv.role)] })}
              </p>
              {me?.email === inv.email ? (
                <JoinInviteButton code={code} />
              ) : me ? (
                <p className="text-sm text-slate-600">{t("system.invite.wrongAccount", { me: me.email, invited: inv.email })}</p>
              ) : hasAccount ? (
                <Link href={`/login?next=${encodeURIComponent(`/invite/${code}`)}`} className="text-sm text-indigo-600 hover:underline">
                  {t("system.invite.hasAccount")}
                </Link>
              ) : (
                <AcceptInviteForm code={code} email={inv.email} />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
