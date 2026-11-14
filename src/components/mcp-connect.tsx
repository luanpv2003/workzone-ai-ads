"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, Loader2 } from "lucide-react";
import { Badge, btnClass, inputClass } from "./ui";
import { CopyButton } from "./copy-button";
import { createMcpTokenAction, revokeMcpTokenAction } from "@/app/mcp-actions";
import { useLocale, useT } from "@/i18n/client";
import { BRAND } from "@/lib/brand";

type Token = { id: string; kind: "personal" | "oauth"; name: string; createdAt: string; lastUsedAt: string | null };
type Msg = { ok: boolean; text: string } | null;

const SERVER = "workzone-ai-ads";
const DOCS = "docs/server.md";

/** Claude Desktop config for a local install: mcp-remote bridges stdio to the HTTP endpoint, the token goes in an env var (no spaces in args, works on Windows too). */
function desktopConfig(url: string, token: string) {
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  })();
  // mcp-remote refuses plain http except for localhost unless told otherwise (e.g. http://192.168.1.10).
  const allowHttp = url.startsWith("http://") && host !== "localhost" && host !== "127.0.0.1";
  const args = ["-y", "mcp-remote", url, "--header", "Authorization:${AUTH_HEADER}", ...(allowHttp ? ["--allow-http"] : [])];
  return JSON.stringify({ mcpServers: { [SERVER]: { command: "npx", args, env: { AUTH_HEADER: `Bearer ${token}` } } } }, null, 2);
}

/** Name input + "Create token"; once created, shows the ready-to-use snippet a single time. */
function TokenMaker({ placeholder, fallbackName, snippet, note, onMsg }: { placeholder: string; fallbackName?: string; snippet: (token: string) => string; note: string; onMsg: (m: Msg) => void }) {
  const t = useT();
  const router = useRouter();
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <input className={`${inputClass} max-w-xs`} placeholder={placeholder} value={name} onChange={(e) => setName(e.target.value)} />
        <button
          type="button"
          className={btnClass("primary")}
          disabled={pending}
          onClick={() =>
            start(async () => {
              onMsg(null);
              const r = await createMcpTokenAction(name.trim() || fallbackName || "");
              if (!r.ok) return onMsg({ ok: false, text: r.error });
              setFresh(r.token);
              setName("");
              router.refresh();
            })
          }
        >
          {pending ? <Loader2 className="animate-spin" /> : <KeyRound />} {t("system.mcp.createToken")}
        </button>
      </div>
      {fresh && (
        <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-900">
          <p className="font-medium">{note}</p>
          <div className="flex items-start gap-2">
            <pre className="min-w-0 flex-1 overflow-x-auto rounded bg-white/70 px-2 py-1 text-xs whitespace-pre-wrap break-all">{snippet(fresh)}</pre>
            <CopyButton text={snippet(fresh)} />
          </div>
          <button type="button" className="text-xs underline" onClick={() => setFresh(null)}>
            {t("system.mcp.savedClose")}
          </button>
        </div>
      )}
    </div>
  );
}

function Section({ title, tag, children }: { title: string; tag?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2 rounded-lg border border-line p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold text-ink">{title}</h3>
        {tag}
      </div>
      {children}
    </section>
  );
}

function Steps({ items }: { items: ReactNode[] }) {
  return (
    <ol className="list-decimal space-y-1 pl-5 text-mut">
      {items.map((x, i) => (
        <li key={i}>{x}</li>
      ))}
    </ol>
  );
}

/**
 * "Nối AI của bạn" (Connect your AI): the MCP address, then one section per AI app. A local install (http / private address) can only be
 * reached from the same computer or network: Claude Code + Claude Desktop (via mcp-remote) with a personal token. A public HTTPS install
 * also works with Claude.ai, Claude Desktop connectors and ChatGPT (OAuth, no token).
 */
export function McpConnect({ url, local, tokens, tools }: { url: string; local: boolean; tokens: Token[]; tools: { name: string; title: string; readOnly: boolean }[] }) {
  const t = useT();
  const locale = useLocale();
  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(locale === "en" ? "en-GB" : "vi-VN") : t("system.mcp.neverUsed"));
  const [msg, setMsg] = useState<Msg>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const app = BRAND.app;
  const cmd = (token: string) => `claude mcp add --transport http ${SERVER} ${url} --header "Authorization: Bearer ${token}"`;
  const connectorSteps = [t("system.mcp.step1"), t("system.mcp.step2", { app }), t("system.mcp.step3", { app })];

  return (
    <div className="space-y-4 text-sm">
      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-medium text-ink">{t("system.mcp.address")}</p>
          <Badge tone={local ? "warn" : "good"}>{local ? t("system.mcp.localBadge") : t("system.mcp.publicBadge")}</Badge>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <code className="rounded bg-soft px-2 py-1 break-all">{url}</code>
          <CopyButton text={url} />
        </div>
      </section>

      <Section title="Claude Code" tag={<Badge tone="good">{t("system.mcp.codeTag")}</Badge>}>
        <p className="text-mut">{t("system.mcp.codeBody")}</p>
        <TokenMaker placeholder={t("system.mcp.namePlaceholder")} snippet={cmd} note={t("system.mcp.showOnce")} onMsg={setMsg} />
      </Section>

      <Section title="Claude Desktop">
        {local ? (
          <>
            <p className="text-mut">{t("system.mcp.desktopLocalBody")}</p>
            <Steps
              items={[
                <>
                  {t("system.mcp.desktopStep1")}
                  <span className="mt-1 block space-y-0.5 text-xs">
                    <code className="block w-fit rounded bg-soft px-1.5 py-0.5 break-all">macOS: ~/Library/Application Support/Claude/claude_desktop_config.json</code>
                    <code className="block w-fit rounded bg-soft px-1.5 py-0.5 break-all">Windows: %APPDATA%\Claude\claude_desktop_config.json</code>
                  </span>
                </>,
                t("system.mcp.desktopStep2"),
                t("system.mcp.desktopStep3", { app }),
              ]}
            />
            <TokenMaker
              placeholder={t("system.mcp.desktopTokenPlaceholder")}
              fallbackName={t("system.mcp.desktopTokenPlaceholder")}
              snippet={(tk) => desktopConfig(url, tk)}
              note={t("system.mcp.showOnceJson")}
              onMsg={setMsg}
            />
          </>
        ) : (
          <>
            <p className="text-mut">{t("system.mcp.desktopPublicBody", { app })}</p>
            <Steps items={connectorSteps} />
          </>
        )}
      </Section>

      <Section title={t("system.mcp.webTitle")} tag={<Badge tone={local ? "warn" : "mut"}>{t("system.mcp.publicOnly")}</Badge>}>
        {local ? (
          <div className="space-y-1.5 rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-900">
            <p>{t("system.mcp.webLocal", { app, url })}</p>
            <p>
              {t("system.mcp.webDocs")} <code className="rounded bg-white/70 px-1.5 py-0.5">{DOCS}</code> {t("system.mcp.webDocsWhere")}
            </p>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1">
              <p className="font-medium text-ink2">Claude.ai</p>
              <Steps items={connectorSteps} />
            </div>
            <div className="space-y-1">
              <p className="font-medium text-ink2">ChatGPT</p>
              <Steps items={[t("system.mcp.gptStep1"), t("system.mcp.gptStep2", { app }), t("system.mcp.gptStep3", { app })]} />
            </div>
          </div>
        )}
      </Section>

      <section className="space-y-2 pt-2">
        <p className="font-medium text-ink">{t("system.mcp.inUse")}</p>
        {tokens.length ? (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {tokens.map((tk) => (
              <li key={tk.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <Badge tone={tk.kind === "oauth" ? "ai" : "info"}>{tk.kind === "oauth" ? "OAuth" : "Token"}</Badge>
                <span className="min-w-0 flex-1 truncate text-ink2">{tk.name}</span>
                <span className="text-xs text-mut">{t("system.mcp.createdLastUsed", { created: fmt(tk.createdAt), last: fmt(tk.lastUsedAt) })}</span>
                <button
                  type="button"
                  className="text-xs text-mut hover:text-rose-600"
                  disabled={pending}
                  onClick={() =>
                    confirm(t("system.mcp.confirmRevoke", { name: tk.name })) &&
                    start(async () => {
                      const r = await revokeMcpTokenAction(tk.id);
                      setMsg(r.ok ? { ok: true, text: t("system.mcp.revoked", { name: tk.name }) } : { ok: false, text: r.error });
                      router.refresh();
                    })
                  }
                >
                  {t("system.mcp.revoke")}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-mut">{t("system.mcp.noConnections")}</p>
        )}
        {msg && <p className={msg.ok ? "text-emerald-700" : "text-rose-600"}>{msg.text}</p>}
      </section>

      <section className="space-y-1 border-t border-line pt-4">
        <p className="font-medium text-ink">{t("system.mcp.whatAiDoes")}</p>
        <p className="text-xs text-mut">{t("system.mcp.permsNote")}</p>
        <ul className="flex flex-wrap gap-1.5 pt-1">
          {tools.map((tl) => (
            <li key={tl.name}>
              <Badge tone={tl.readOnly ? "gray" : "warn"}>
                {tl.title}
                {tl.readOnly ? "" : t("system.mcp.doSuffix")}
              </Badge>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
