"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, Plug, RotateCcw } from "lucide-react";
import { Badge, btnClass, inputClass } from "./ui";
import { CopyButton } from "./copy-button";
import { clearClaudeAction, saveClaudeAction, saveTiersAction, testClaudeAction } from "@/app/claude-actions";
import { TASK_TIERS, TIERS, taskWhy, type Tier } from "@/lib/ai/model-tiers";
import { useT } from "@/i18n/client";

type TaskStat = { calls: number; tokens: number };
type Current = { source: "web" | "server"; provider: "api" | "cli"; label: string | null; savedBy: string | null; savedAt: string | null; serverAccount: string | null };

/** Switch the Claude account for the whole system: paste a token from `claude setup-token` (Claude.ai plan) or an API key. */
export function ClaudeConnect({ current, isAdmin, tiers, stats }: { current: Current; isAdmin: boolean; tiers: Record<string, Tier>; stats: Record<string, TaskStat> }) {
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

  const using =
    current.source === "web"
      ? t("ai.connect.usingWeb", {
          label: current.label ?? "",
          kind: t(current.provider === "cli" ? "ai.connect.kindOauthPlan" : "ai.connect.kindApiPaid"),
          by: current.savedBy ?? "",
          at: current.savedAt ? new Date(current.savedAt).toLocaleString("vi-VN") : "",
        })
      : t("ai.connect.usingServer", { detail: current.provider === "cli" ? `Claude Code${current.serverAccount ? ` (${current.serverAccount})` : ""}` : t("ai.connect.serverApiKey") });

  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-mut">{t("ai.connect.inUse")}</span>
        <Badge tone={current.source === "web" ? "good" : "info"}>{current.source === "web" ? t("ai.connect.badgeWeb") : t("ai.connect.badgeDefault")}</Badge>
        <span className="text-ink2">{using}</span>
      </div>
      {isAdmin ? (
        <>
          <ol className="list-decimal space-y-1 pl-5 text-mut">
            <li>
              <span className="inline-flex flex-wrap items-center gap-2">
                {t("ai.connect.step1")} <code className="rounded bg-soft px-1">claude setup-token</code>
                <CopyButton text="claude setup-token" />
              </span>
            </li>
            <li>{t("ai.connect.step2")}</li>
            <li>
              {t("ai.connect.step3a")} <code>sk-ant-oat01-</code> {t("ai.connect.step3b")} <code>sk-ant-api…</code> {t("ai.connect.step3c")}
            </li>
          </ol>
          <div className="grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
            <input className={inputClass} placeholder={t("ai.connect.labelPlaceholder")} value={label} onChange={(e) => setLabel(e.target.value)} />
            <input className={inputClass} type="password" autoComplete="off" placeholder={t("ai.connect.tokenPlaceholder")} value={token} onChange={(e) => setToken(e.target.value)} />
            <button type="button" className={btnClass("primary")} disabled={pending || !token.trim()} onClick={() => run(() => saveClaudeAction(token, label), true)}>
              {pending ? <Loader2 className="animate-spin" /> : <Check />} {t("ai.connect.testSave")}
            </button>
          </div>
          <p className="text-xs text-mut">{t("ai.connect.note")}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={btnClass("secondary")} disabled={pending} onClick={() => run(testClaudeAction)}>
              <Plug /> {t("ai.connect.testCurrent")}
            </button>
            {current.source === "web" && (
              <button type="button" className={btnClass("ghost")} disabled={pending} onClick={() => confirm(t("ai.connect.confirmClear")) && run(clearClaudeAction)}>
                <RotateCcw /> {t("ai.connect.backDefault")}
              </button>
            )}
          </div>
        </>
      ) : (
        <p className="text-mut">{t("ai.connect.adminOnly")}</p>
      )}
      {msg && <p className={msg.ok ? "text-emerald-700" : "text-rose-600"}>{msg.text}</p>}
      <TierTable tiers={tiers} stats={stats} isAdmin={isAdmin} />
    </div>
  );
}

/** Model per task: by default the system assigns them (Opus for decision-making, Sonnet / Haiku for high-volume work), can be overridden manually. */
function TierTable({ tiers, stats, isAdmin }: { tiers: Record<string, Tier>; stats: Record<string, TaskStat>; isAdmin: boolean }) {
  const [map, setMap] = useState(tiers);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const t = useT();
  const dirty = TASK_TIERS.some((x) => map[x.task] !== tiers[x.task]);
  const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
  return (
    <div className="space-y-2 border-t border-line pt-4">
      <p className="font-medium text-ink">{t("ai.tierTable.title")}</p>
      <p className="text-xs text-mut">{t("ai.tierTable.help")}</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-mut">
            <tr>
              <th className="py-1.5 pr-3 font-medium">{t("ai.tierTable.colTask")}</th>
              <th className="py-1.5 pr-3 font-medium">{t("ai.tierTable.colModel")}</th>
              <th className="py-1.5 pr-3 font-medium whitespace-nowrap">{t("ai.tierTable.col7d")}</th>
              <th className="py-1.5 font-medium">{t("ai.tierTable.colWhy")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {TASK_TIERS.map((x) => {
              const cur = map[x.task] ?? x.tier;
              const st = stats[x.task];
              return (
                <tr key={x.task}>
                  <td className="py-1.5 pr-3 whitespace-nowrap text-ink2">{t(`ai.tasks.${x.key}.name`)}</td>
                  <td className="py-1.5 pr-3">
                    <select
                      disabled={!isAdmin}
                      className={`rounded border px-1.5 py-0.5 text-sm ${cur !== x.tier ? "border-amber-400 bg-amber-50 text-amber-900" : "border-line bg-panel"}`}
                      value={cur}
                      onChange={(e) => setMap((m) => ({ ...m, [x.task]: e.target.value as Tier }))}
                    >
                      {(Object.keys(TIERS) as Tier[]).map((k) => (
                        <option key={k} value={k}>
                          {TIERS[k].label}
                          {k === x.tier ? ` ${t("ai.tierTable.defaultMark")}` : ""}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="py-1.5 pr-3 text-xs whitespace-nowrap text-mut tabular-nums">{st ? t("ai.tierTable.stat", { calls: st.calls, tokens: fmt(st.tokens) }) : "–"}</td>
                  <td className="py-1.5 text-xs text-mut">{taskWhy(x.key, t)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {isAdmin && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={btnClass("primary")}
            disabled={pending || !dirty}
            onClick={() =>
              start(async () => {
                const r = await saveTiersAction(map);
                setMsg(r.ok ? { ok: true, text: r.message } : { ok: false, text: r.error });
                router.refresh();
              })
            }
          >
            {pending ? <Loader2 className="animate-spin" /> : <Check />} {t("ai.tierTable.save")}
          </button>
          <button type="button" className={btnClass("ghost")} disabled={pending} onClick={() => setMap(Object.fromEntries(TASK_TIERS.map((x) => [x.task, x.tier])))}>
            <RotateCcw /> {t("ai.tierTable.reset")}
          </button>
        </div>
      )}
      {msg && <p className={msg.ok ? "text-emerald-700" : "text-rose-600"}>{msg.text}</p>}
    </div>
  );
}
