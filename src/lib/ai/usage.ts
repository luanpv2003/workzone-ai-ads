import { db } from "../db";
import * as P from "./prompts";

// Records every Claude call to see how much the system uses (Usage tab). A logging error never breaks the call.

/**
 * Task name derived from the system prompt (every call goes through generateStructured, so no call site needs changing).
 * The returned names are stored identifiers (AiUsage.task, per-task model overrides): keep them as is; display them with taskLabel (model-tiers.ts).
 */
export function taskOf(system: string): string {
  if (system.includes(P.CONTENT_PLAN_RULES)) return "Phương án duyệt nội dung";
  const map: [string, string][] = [
    [P.CONVERSATIONS_MERGE_SYSTEM, "Phân tích tin nhắn (gộp)"],
    [P.CONVERSATIONS_SYSTEM, "Phân tích tin nhắn"],
    [P.AUDIT_SYSTEM, "Audit tài khoản"],
    [P.PLANNER_SYSTEM, "Soạn chiến dịch"],
    [P.AUDIENCE_SYSTEM, "Chân dung & targeting"],
    [P.EXPANSION_SYSTEM, "Hướng mở rộng tệp"],
    [P.CLIENT_SETUP_SYSTEM, "Tạo khách từ tài liệu"],
    [P.IDEAS_SYSTEM, "Đề xuất ý tưởng chiến dịch"],
    [P.OPTIMIZE_SYSTEM, "Tối ưu chiến dịch"],
    [P.CREATIVE_SYSTEM, "Phân tích QC thắng / thua"],
    [P.POLICY_SYSTEM, "Kiểm tra chính sách nội dung"],
    [P.TARGET_IDEAS_SYSTEM, "Targeting cho chiến dịch"],
    [P.GUIDE_SYSTEM, "Hướng dẫn từng bước"],
    [P.NURTURE_WRITE_SYSTEM, "Soạn tin chăm sóc lại"],
    [P.NURTURE_CHECK_SYSTEM, "Kiểm tra tin chăm sóc lại"],
    [P.NOTIFY_TEMPLATE_SYSTEM, "Soạn mẫu tin bot"],
    [P.BOT_REPLY_SYSTEM, "Bot trả lời nhóm"],
    [P.DUTY_EXTRACT_SYSTEM, "Đọc lịch trực"],
    [P.GOOGLE_NEGATIVES_SYSTEM, "Lọc từ khóa phủ định Google"],
    [P.GOOGLE_RESTRUCTURE_SYSTEM, "Tách nhóm & viết quảng cáo Google"],
  ];
  for (const [sys, name] of map) if (system === sys || system.startsWith(sys)) return name;
  // Prompts defined outside prompts.ts, recognised by their opening (Vietnamese opening kept for prompts not yet translated).
  if (/^(Bạn là copywriter|You are a copywriter)/.test(system)) return "Gợi ý nội dung quảng cáo";
  if (/^(Bạn là trợ lý quảng cáo Meta|You are the Meta ads assistant)/.test(system)) return "Hỏi Claude";
  return "Khác";
}

let names: { at: number; list: { id: string; name: string }[] } | null = null;
/** Client of the call: the prompt has a line "Client: <name>" (clientProfile) or "Khách hàng: <name>" (prompts written elsewhere). */
async function clientOf(prompt: string) {
  const m = prompt.match(/(?:^|\n)(?:Client|Khách hàng): (.+)/);
  if (!m) return null;
  if (!names || Date.now() - names.at > 10 * 60_000) names = { at: Date.now(), list: await db.client.findMany({ select: { id: true, name: true } }) };
  const want = m[1].trim();
  return names.list.find((c) => c.name === want)?.id ?? null;
}

export async function recordUsage(x: {
  system: string;
  prompt: string;
  provider: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  ms: number;
  images?: number;
  error?: string;
  clientId?: string | null;
  workspaceId?: string | null;
  source?: string;
}) {
  try {
    await db.aiUsage.create({
      data: {
        task: taskOf(x.system),
        clientId: x.clientId ?? (await clientOf(x.prompt)),
        workspaceId: x.workspaceId ?? null,
        source: x.source ?? null,
        provider: x.provider,
        model: x.model ?? "",
        inputTokens: x.inputTokens ?? 0,
        outputTokens: x.outputTokens ?? 0,
        ms: Math.round(x.ms),
        images: x.images ?? 0,
        ok: !x.error,
        error: x.error?.slice(0, 500),
      },
    });
  } catch (err) {
    console.warn("[usage] could not write the usage log:", err instanceof Error ? err.message : err);
  }
}
