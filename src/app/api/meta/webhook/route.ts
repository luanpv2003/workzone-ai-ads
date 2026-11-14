import { after } from "next/server";
import { saveReferrals, saveWebhookMessages, verifySignature, verifyToken } from "@/lib/webhook";

// Meta webhook (Messenger / Instagram): GET = verification when configuring the Meta app; POST = message events.
// No login required (Meta calls in), but POST must carry a valid signature for the App Secret declared in System settings.

export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  if (p.get("hub.mode") === "subscribe" && p.get("hub.verify_token") === (await verifyToken())) {
    return new Response(p.get("hub.challenge") ?? "", { status: 200 });
  }
  return new Response("Forbidden", { status: 403 });
}

export async function POST(req: Request) {
  const raw = await req.text();
  const appId = await verifySignature(raw, req.headers.get("x-hub-signature-256"));
  if (!appId) return new Response("Invalid signature", { status: 401 });
  let payload;
  try {
    payload = JSON.parse(raw);
    await saveReferrals(payload, appId);
  } catch (err) {
    console.error("Meta webhook error:", err);
  }
  // Store messages after responding to Meta (may need to ask Meta for a new customer's conversation id).
  if (payload) after(() => saveWebhookMessages(payload).catch((err) => console.error("Webhook: failed to save messages:", err)));
  // Always return 200 quickly so Meta doesn't retry.
  return new Response("OK", { status: 200 });
}
