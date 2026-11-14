import { connection } from "next/server";
import { requirePlatformPage } from "@/lib/access";
import { db } from "@/lib/db";
import { Card, PageHeader } from "@/components/ui";
import { ClaudeConnect } from "@/components/claude-connect";
import { serverCliAccount, storedCredential, connFor, tierFor } from "@/lib/ai/credential";
import { TASK_TIERS } from "@/lib/ai/model-tiers";
import { getT } from "@/i18n/server";

export default async function ClaudePage() {
  const user = await requirePlatformPage(); // shared settings: only members of the platform workspace
  await connection();
  const t = await getT();
  return (
    <>
      <PageHeader title="Claude AI" subtitle={t("ai.claudePage.subtitle")} />
      <Card>
        <ClaudeConnect current={await claudeCurrent()} isAdmin={user?.role === "admin"} {...await claudeTiers()} />
      </Card>
    </>
  );
}

async function claudeCurrent() {
  const cred = await storedCredential();
  const conn = connFor(cred);
  const acc = conn.source === "server" && conn.provider === "cli" ? await serverCliAccount() : null;
  return {
    source: conn.source === "web" ? ("web" as const) : ("server" as const),
    provider: conn.provider,
    label: cred?.label ?? null,
    savedBy: cred?.savedBy ?? null,
    savedAt: cred?.savedAt ?? null,
    serverAccount: acc?.email ?? (acc?.method ? acc.method : null),
  };
}

/** Model used for each task + call count / tokens over 7 days (AiUsage). */
async function claudeTiers() {
  const tiers = Object.fromEntries(await Promise.all(TASK_TIERS.map(async (x) => [x.task, await tierFor(x.task)] as const)));
  const rows = await db.aiUsage.groupBy({
    by: ["task"],
    where: { at: { gt: new Date(Date.now() - 7 * 86400_000) } },
    _count: true,
    _sum: { inputTokens: true, outputTokens: true },
  });
  const stats = Object.fromEntries(rows.map((r) => [r.task, { calls: r._count, tokens: (r._sum.inputTokens ?? 0) + (r._sum.outputTokens ?? 0) }]));
  return { tiers, stats };
}
