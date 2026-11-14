// Choose the Claude model by task type (shared by browser + server).
// Opus: decision-making / deep synthesis tasks (ad spend, strategy). Sonnet: high-volume tasks with a clear template.
// Haiku: very small tasks. On a Claude.ai plan, Sonnet / Haiku use far less quota than Opus; on the API they are 2.5–5x cheaper.

import type { ai as viAi } from "@/i18n/messages/vi/ai";
import type { T } from "@/i18n/translate";

export type Tier = "opus" | "sonnet" | "haiku";

/** note: catalogue key of the tier's short description (translate with t(note)). */
export const TIERS: Record<Tier, { label: string; cli: string; api: string; note: `ai.tierNotes.${Tier}` }> = {
  opus: { label: "Opus", cli: "opus", api: "claude-opus-5", note: "ai.tierNotes.opus" },
  sonnet: { label: "Sonnet", cli: "sonnet", api: "claude-sonnet-5", note: "ai.tierNotes.sonnet" },
  haiku: { label: "Haiku", cli: "haiku", api: "claude-haiku-4-5", note: "ai.tierNotes.haiku" },
};

/** Catalogue key of each task (ai.tasks.<key>.name / .why). */
type TaskKey = keyof (typeof viAi)["tasks"];

/**
 * task: the task identifier recorded in AiUsage.task and in per-task model overrides (stored data: never translate or rename,
 * usage.ts taskOf returns it). key: its display name / reason in the catalogue, shown with taskLabel / taskWhy.
 */
export const TASK_TIERS: { task: string; key: TaskKey; tier: Tier }[] = [
  { task: "Audit tài khoản", key: "audit", tier: "opus" },
  { task: "Tối ưu chiến dịch", key: "optimize", tier: "opus" },
  { task: "Soạn chiến dịch", key: "plan", tier: "opus" },
  { task: "Phương án duyệt nội dung", key: "contentPlan", tier: "opus" },
  { task: "Đề xuất ý tưởng chiến dịch", key: "ideas", tier: "opus" },
  { task: "Chân dung & targeting", key: "audience", tier: "opus" },
  { task: "Phân tích tin nhắn (gộp)", key: "conversationsMerge", tier: "opus" },
  { task: "Phân tích QC thắng / thua", key: "creative", tier: "opus" },
  { task: "Kiểm tra chính sách nội dung", key: "policy", tier: "opus" },
  { task: "Phân tích tin nhắn", key: "conversations", tier: "sonnet" },
  { task: "Targeting cho chiến dịch", key: "targetIdeas", tier: "sonnet" },
  { task: "Hướng mở rộng tệp", key: "expansion", tier: "sonnet" },
  { task: "Tạo khách từ tài liệu", key: "clientSetup", tier: "sonnet" },
  { task: "Hướng dẫn từng bước", key: "guide", tier: "sonnet" },
  { task: "Gợi ý nội dung quảng cáo", key: "adCopy", tier: "sonnet" },
  { task: "Soạn tin chăm sóc lại", key: "nurtureWrite", tier: "sonnet" },
  { task: "Kiểm tra tin chăm sóc lại", key: "nurtureCheck", tier: "sonnet" },
  { task: "Soạn mẫu tin bot", key: "notifyTemplate", tier: "haiku" },
  { task: "Hỏi Claude", key: "ask", tier: "sonnet" },
  { task: "Bot trả lời nhóm", key: "botReply", tier: "sonnet" },
  { task: "Tách nhóm & viết quảng cáo Google", key: "googleRestructure", tier: "sonnet" },
  { task: "Lọc từ khóa phủ định Google", key: "googleNegatives", tier: "sonnet" },
  { task: "Đọc lịch trực", key: "dutyExtract", tier: "haiku" },
  { task: "Đọc lại file PDF", key: "transcribe", tier: "sonnet" },
  { task: "Khác", key: "other", tier: "haiku" },
];

const KEY_BY_TASK = new Map(TASK_TIERS.map((t) => [t.task, t.key]));

/** Display name of a stored task identifier in the UI language (unknown identifiers are shown as is). */
export const taskLabel = (task: string, t: T) => {
  const k = KEY_BY_TASK.get(task);
  return k ? t(`ai.tasks.${k}.name`) : task;
};
/** Why the task uses its default model, in the UI language. */
export const taskWhy = (key: TaskKey, t: T) => t(`ai.tasks.${key}.why`);

export const DEFAULT_TIER: Record<string, Tier> = Object.fromEntries(TASK_TIERS.map((t) => [t.task, t.tier]));
