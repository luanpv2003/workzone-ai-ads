"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, Plug, RotateCcw } from "lucide-react";
import { Badge, btnClass, Card, inputClass } from "./ui";
import { useT } from "@/i18n/client";
import { clearWorkspaceClaudeAction, saveWorkspaceClaudeAction, testWorkspaceClaudeAction } from "@/app/claude-actions";

type Cred = { label: string; kind: "oauth" | "api"; savedBy: string; savedAt: string };

/**
 * The business's own Claude: paste its own API key → all Claude work for the business's clients uses that account (self-paid).
 * Not pasted: uses the platform's Claude.
 */
export function WorkspaceClaude({ workspaceId, cred }: { workspaceId: string; cred: Cred | null }) {
  const [token, setToken] = useState("");
  const [label, setLabel] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const t = useT();
  const run = (fn: () => Promise<{ ok: true; message: string } | { ok: false; error: string }>, clear = false) =>
    start(async () => {
      setMsg(null);
      const r = await fn();
      setMsg(r.ok ? { ok: true, text: r.message } : { ok: false, text: r.error });
      if (r.ok && clear) setToken("");
      router.refresh();
    });

  return (
    <Card title={t("ai.workspaceClaude.title")} className="mt-6">
      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-mut">{t("ai.connect.inUse")}</span>
          {cred ? (
            <>
              <Badge tone="good">{t("ai.workspaceClaude.badgeOwn")}</Badge>
              <span className="text-ink2">
                {t("ai.workspaceClaude.savedBy", {
                  label: cred.label,
                  kind: t(cred.kind === "api" ? "ai.workspaceClaude.kindApi" : "ai.workspaceClaude.kindOauth"),
                  by: cred.savedBy,
                  at: new Date(cred.savedAt).toLocaleString("vi-VN"),
                })}
              </span>
            </>
          ) : (
            <Badge tone="info">{t("ai.workspaceClaude.badgePlatform")}</Badge>
          )}
        </div>
        <p className="text-xs text-mut">
          {t("ai.workspaceClaude.helpA")} <code>sk-ant-api…</code>
          {t("ai.workspaceClaude.helpB")}
        </p>
        <div className="grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
          <input className={inputClass} placeholder={t("ai.workspaceClaude.labelPlaceholder")} value={label} onChange={(e) => setLabel(e.target.value)} />
          <input className={inputClass} type="password" autoComplete="off" placeholder="sk-ant-api…" value={token} onChange={(e) => setToken(e.target.value)} />
          <button type="button" className={btnClass("primary")} disabled={pending || !token.trim()} onClick={() => run(() => saveWorkspaceClaudeAction(workspaceId, token, label), true)}>
            {pending ? <Loader2 className="animate-spin" /> : <Check />} {t("ai.connect.testSave")}
          </button>
        </div>
        {cred && (
          <div className="flex flex-wrap gap-2">
            <button type="button" className={btnClass("secondary")} disabled={pending} onClick={() => run(() => testWorkspaceClaudeAction(workspaceId))}>
              <Plug /> {t("ai.workspaceClaude.testOwn")}
            </button>
            <button
              type="button"
              className={btnClass("ghost")}
              disabled={pending}
              onClick={() => confirm(t("ai.workspaceClaude.confirmClear")) && run(() => clearWorkspaceClaudeAction(workspaceId))}
            >
              <RotateCcw /> {t("ai.workspaceClaude.clearOwn")}
            </button>
          </div>
        )}
        {msg && <p className={msg.ok ? "text-emerald-700" : "text-rose-600"}>{msg.text}</p>}
      </div>
    </Card>
  );
}
