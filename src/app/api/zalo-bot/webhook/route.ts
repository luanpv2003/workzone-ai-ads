import { after } from "next/server";
import { botQuestion, checkWebhookSecret, recordUpdate } from "@/lib/zalo-bot";
import { answerGroupQuestion } from "@/lib/lead-bot-report";

// Zalo Bot webhook: Zalo calls in whenever someone messages the bot (directly or in a group). Records the group / person so it can be chosen as a
// lead notification destination; questions mentioning the bot (not /id) get a bot reply (lib/lead-bot-report.ts, may call Claude ~5–20 seconds).
// No login required, but the secret key set at setWebhook must match (header X-Bot-Api-Secret-Token).

export async function POST(req: Request) {
  if (!(await checkWebhookSecret(req.headers.get("x-bot-api-secret-token")))) return new Response("Forbidden", { status: 403 });
  try {
    const u = await req.json();
    await recordUpdate(u);
    const q = botQuestion(u);
    // Reply after returning 200 to Zalo (Claude is slow; if Zalo waits too long it retries).
    if (q) after(() => answerGroupQuestion("zalobot", q.chatId, q.isGroup, q.text, q.from).catch((err) => console.error("Group answer bot error:", err)));
  } catch (err) {
    console.error("Zalo Bot webhook error:", err);
  }
  return new Response("OK", { status: 200 });
}
