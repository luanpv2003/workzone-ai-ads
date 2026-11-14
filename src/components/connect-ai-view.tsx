import { connection } from "next/server";
import { requirePageUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { mcpUrl } from "@/lib/mcp/auth";
import { TOOLS } from "@/lib/mcp/tools";
import { isLocalAddress } from "@/lib/public-address";
import { Card, PageHeader } from "@/components/ui";
import { McpConnect } from "@/components/mcp-connect";
import { getT } from "@/i18n/server";
import type { MessageKey } from "@/i18n/translate";
import { BRAND } from "@/lib/brand";

/**
 * "Nối AI của bạn" (Connect your AI): each user connects their own Claude / ChatGPT to the MCP endpoint, with exactly their web permissions.
 * Rendered at /connect-ai (main menu) and /connections/mcp (System settings tab).
 */
export async function ConnectAiView() {
  await connection();
  const user = await requirePageUser();
  const t = await getT();
  // OAuth connections: each refresh creates a new token; only show the ones still usable.
  const rows = await db.mcpToken.findMany({
    where: { userId: user.id, revokedAt: null, OR: [{ kind: "personal" }, { refreshExpiresAt: { gt: new Date() } }] },
    orderBy: { createdAt: "desc" },
    select: { id: true, kind: true, name: true, createdAt: true, lastUsedAt: true },
  });
  return (
    <>
      <PageHeader title={t("system.mcpPage.title")} subtitle={t("system.mcpPage.subtitle", { app: BRAND.app })} />
      <Card>
        <McpConnect
          url={mcpUrl()}
          local={isLocalAddress()}
          tokens={rows.map((r) => ({ id: r.id, kind: r.kind as "personal" | "oauth", name: r.name, createdAt: r.createdAt.toISOString(), lastUsedAt: r.lastUsedAt?.toISOString() ?? null }))}
          tools={TOOLS.map((tool) => ({ name: tool.name, title: t(`system.mcpPage.tools.${tool.name}` as MessageKey), readOnly: tool.readOnly }))}
        />
      </Card>
    </>
  );
}
