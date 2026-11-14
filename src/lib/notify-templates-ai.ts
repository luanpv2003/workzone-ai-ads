import { z } from "zod";
import { db } from "./db";
import { generateStructured } from "./ai/claude";
import { clientProfile } from "./ai/context";
import { NOTIFY_TEMPLATE_SYSTEM } from "./ai/prompts";
import { TEMPLATE_DEF, TEMPLATE_MAX, VAR_LABEL, unknownVars, type TemplateKey } from "./notify-templates";
import { getT } from "@/i18n/server";

// "Claude gợi ý mẫu" (Claude suggests a template) button (bot message templates): Claude rewrites a template; the user reviews / edits before saving.

const Schema = z.object({ text: z.string().min(1), why: z.string() });

export async function suggestNotifyTemplate(clientId: string | null, key: TemplateKey, current: string, request: string) {
  const d = TEMPLATE_DEF[key];
  const client = clientId ? await db.client.findUniqueOrThrow({ where: { id: clientId } }) : null;
  const prompt = [
    client ? `# Client\n${clientProfile(client)}` : "# Scope\nShared template for all of the agency's clients (not written for any particular industry).",
    `# Message type\n${d.label}: ${d.hint}`,
    `# Variables available\n${d.vars.map((v) => `{${v}}: ${VAR_LABEL[v]}`).join("\n")}`,
    `# Default template\n${d.default}`,
    `# Current template\n${current.trim() || d.default}`,
    `# User request\n${request.trim() || "(none: make it clearer and easier for sales staff to read, keep it short)"}`,
  ].join("\n\n");
  const res = await generateStructured({ clientId: clientId, system: NOTIFY_TEMPLATE_SYSTEM, prompt, schema: Schema, effort: "low" });
  const text = res.data.text.replace(/\r\n?/g, "\n").trim().slice(0, TEMPLATE_MAX);
  const bad = unknownVars(key, text);
  return { text, why: res.data.why + (bad.length ? ` ${(await getT())("notify.templatesAi.unknownVars", { vars: bad.map((b) => `{${b}}`).join(", ") })}` : "") };
}
