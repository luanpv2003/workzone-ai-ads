import Link from "next/link";
import { connection } from "next/server";
import { db } from "@/lib/db";
import { dateOnly, dateTime } from "@/lib/format";
import { tokenLevel, type TokenLevel } from "@/lib/token-status";
import { checkAllTokensAction } from "@/app/actions";
import { ActionButton } from "@/components/action-button";
import { TokenRowActions } from "@/components/token-row-actions";
import { Badge, Card, Empty, PageHeader, Stat, type Tone } from "@/components/ui";
import { REQUIRED_PERMISSIONS } from "@/lib/meta/inspect";
import { requirePageUser } from "@/lib/auth";
import { clientWhere, isSystemAdmin } from "@/lib/access";
import { getT } from "@/i18n/server";
import type { MessageKey } from "@/i18n/translate";

const LEVEL: Record<TokenLevel, { label: MessageKey; tone: Tone }> = {
  ok: { label: "system.connections.level.ok", tone: "green" },
  warning: { label: "system.connections.level.warning", tone: "amber" },
  expired: { label: "system.connections.level.expired", tone: "red" },
  error: { label: "system.connections.level.error", tone: "red" },
  missing: { label: "system.connections.level.missing", tone: "gray" },
  unchecked: { label: "system.connections.level.unchecked", tone: "blue" },
};
const ORDER: TokenLevel[] = ["expired", "error", "warning", "missing", "unchecked", "ok"];

function daysLeft(d: Date, now: number) {
  return Math.ceil((d.getTime() - now) / 86400000);
}

export default async function ConnectionsPage() {
  const user = await requirePageUser(); // check the session right on the page: the layout may not re-run on client-side navigation
  await connection();
  const t = await getT();
  const now = new Date().getTime();
  const clients = await db.client.findMany({ where: await clientWhere(user), orderBy: { name: "asc" } });
  const meta = clients.filter((c) => c.dataSource === "meta");
  const mock = clients.filter((c) => c.dataSource !== "meta");
  const rows = meta.map((c) => ({ c, level: tokenLevel(c, now) })).sort((a, b) => ORDER.indexOf(a.level) - ORDER.indexOf(b.level));
  const byOwner = new Map<string, number>();
  for (const c of meta) if (c.metaTokenOwnerId) byOwner.set(c.metaTokenOwnerId, (byOwner.get(c.metaTokenOwnerId) ?? 0) + 1);
  const count = (ls: TokenLevel[]) => rows.filter((r) => ls.includes(r.level)).length;

  return (
    <>
      <PageHeader
        title={t("system.connections.title")}
        subtitle={t("system.connections.subtitle")}
        actions={isSystemAdmin(user) && meta.some((c) => c.metaAccessToken) && <ActionButton action={checkAllTokensAction} pending={t("system.connections.checking")}>{t("system.connections.checkAll")}</ActionButton>}
      />
      <div className="mb-6 grid gap-3 @xl:grid-cols-2 @4xl:grid-cols-4">
        <Stat label={t("system.connections.statConnected")} value={meta.length} />
        <Stat label={t("system.connections.statActive")} value={count(["ok"])} tone="good" />
        <Stat label={t("system.connections.statWarning")} value={count(["warning", "unchecked"])} tone={count(["warning", "unchecked"]) ? "bad" : undefined} hint={t("system.connections.statWarningHint")} />
        <Stat label={t("system.connections.statBad")} value={count(["expired", "error", "missing"])} tone={count(["expired", "error", "missing"]) ? "bad" : "good"} />
      </div>

      <Card title={t("system.connections.byClient")}>
        {!rows.length ? (
          <Empty>{t("system.connections.empty")}</Empty>
        ) : (
          <div className="-mx-5 -my-5 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  <th className="min-w-40 px-5 py-2 font-medium">{t("system.connections.colClient")}</th>
                  <th className="px-3 py-2 font-medium">{t("system.connections.colStatus")}</th>
                  <th className="px-3 py-2 font-medium">{t("system.connections.colOwner")}</th>
                  <th className="px-3 py-2 font-medium whitespace-nowrap">{t("system.connections.colExpires")}</th>
                  <th className="min-w-44 px-3 py-2 font-medium">{t("system.connections.colIssue")}</th>
                  <th className="px-5 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map(({ c, level }) => {
                  const missing: string[] = c.metaTokenMissing ? JSON.parse(c.metaTokenMissing) : [];
                  const left = c.metaTokenExpiresAt ? daysLeft(c.metaTokenExpiresAt, now) : null;
                  return (
                    <tr key={c.id} className={level === "expired" || level === "error" ? "bg-rose-50/40" : level === "warning" ? "bg-amber-50/40" : ""}>
                      <td className="px-5 py-3 align-top">
                        <Link href={`/clients/${c.id}/settings`} className="font-medium text-slate-900 hover:text-indigo-600">{c.name}</Link>
                        <div className="text-xs text-slate-400">{c.metaAdAccountId ?? t("system.connections.noAdAccount")}</div>
                      </td>
                      <td className="px-3 py-3 align-top whitespace-nowrap">
                        <Badge tone={LEVEL[level].tone}>{t(LEVEL[level].label)}</Badge>
                        {c.metaTokenCheckedAt && <div className="mt-1 text-[11px] text-slate-400">{t("system.connections.checkedAbbr")} {dateTime(c.metaTokenCheckedAt)}</div>}
                      </td>
                      <td className="px-3 py-3 align-top">{c.metaTokenOwner ?? <span className="text-slate-400">—</span>}</td>
                      <td className="px-3 py-3 align-top whitespace-nowrap">
                        {c.metaTokenExpiresAt ? (
                          <>
                            <div>{dateOnly(c.metaTokenExpiresAt)}</div>
                            <div className={`text-xs ${left! < 0 ? "text-rose-600" : left! <= 7 ? "text-amber-600" : "text-slate-500"}`}>
                              {left! < 0 ? t("system.connections.overdueDays", { n: -left! }) : t("system.connections.daysLeft", { n: left! })}
                            </div>
                          </>
                        ) : c.metaTokenCheckedAt && !c.metaTokenError ? (
                          <span className="text-slate-500">{t("system.connections.noExpiry")}</span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="px-3 py-3 align-top text-xs">
                        {c.metaTokenError && <p className="text-rose-700">{c.metaTokenError}</p>}
                        {missing.length > 0 && <p className="text-amber-700">{t("system.connections.missingPerms", { list: missing.join(", ") })}</p>}
                        {level === "missing" && <p className="text-slate-500">{t("system.connections.noTokenPasted")}</p>}
                        {level === "unchecked" && <p className="text-slate-500">{t("system.connections.recheckHint")}</p>}
                        {!c.metaPageId && c.metaAccessToken && <p className="text-amber-700">{t("system.connections.noPage")}</p>}
                      </td>
                      <td className="px-5 py-3 align-top">
                        <TokenRowActions
                          clientId={c.id}
                          hasToken={!!c.metaAccessToken}
                          owner={c.metaTokenOwner}
                          // Replace the token for every client sharing the token owner: system admins only (may touch clients of other workspaces).
                          sharedCount={isSystemAdmin(user) && c.metaTokenOwnerId ? (byOwner.get(c.metaTokenOwnerId) ?? 1) : 1}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title={t("system.connections.howTitle")} className="mt-6">
        <ol className="list-decimal space-y-2 pl-5 text-sm text-slate-700">
          <li>
            {t("system.connections.how1a")}{" "}
            <a href="https://developers.facebook.com/tools/explorer" target="_blank" rel="noreferrer" className="text-indigo-600 underline">Graph API Explorer</a>
            {t("system.connections.how1b")}<b>{t("system.connections.how1app")}</b>{t("system.connections.how1c")}<b>{t("system.connections.how1d")}</b>{t("system.connections.how1e")}
          </li>
          <li>
            {t("system.connections.how2", { n: REQUIRED_PERMISSIONS.length })} <code className="text-xs">{REQUIRED_PERMISSIONS.join(", ")}</code>.
          </li>
          <li>{t("system.connections.how3a")}<b>Generate Access Token</b>{t("system.connections.how3b")}</li>
          <li>
            {t("system.connections.how4a")}<b>Open in Access Token Tool</b>{t("system.connections.how4b")}{" "}
            <a href="https://developers.facebook.com/tools/debug/accesstoken" target="_blank" rel="noreferrer" className="text-indigo-600 underline">Access Token Debugger</a>
            {t("system.connections.how4c")}<b>Extend Access Token</b>{t("system.connections.how4d")}
          </li>
          <li>{t("system.connections.how5a")}<b>{t("system.connections.how5b")}</b>{t("system.connections.how5c")}</li>
        </ol>
        <p className="mt-3 text-xs text-slate-500">{t("system.connections.warn")}</p>
      </Card>

      {mock.length > 0 && (
        <p className="mt-6 text-xs text-slate-400">
          {t("system.connections.notConnected", { list: mock.map((c) => c.name).join(", ") })}
        </p>
      )}
    </>
  );
}
