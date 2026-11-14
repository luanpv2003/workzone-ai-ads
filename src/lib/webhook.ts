import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "./db";
import { decrypt } from "./crypto";
import { getMetaClient } from "./meta";
import { clientPages } from "./client-pages";
import { extractContacts } from "./pii";
import { markAdReplies } from "./own-ads";
import { saveImagesFor } from "./msg-images";

// Meta messaging webhook: learn which ad a customer entered the conversation from (referral of click-to-Messenger ads)
// and write new messages into the system as soon as the customer / Page messages (full sync + 2-minute fast sync still run as backup).
// Does not reply to messages.

const TOKEN_KEY = "webhook.verifyToken";

/** Verification code to paste into the "Verify token" field when configuring the webhook in the Meta app (generated once). */
export async function verifyToken() {
  const s = await db.setting.findUnique({ where: { key: TOKEN_KEY } });
  if (s) return s.value;
  const value = randomBytes(16).toString("hex");
  await db.setting.upsert({ where: { key: TOKEN_KEY }, create: { key: TOKEN_KEY, value }, update: {} });
  return (await db.setting.findUniqueOrThrow({ where: { key: TOKEN_KEY } })).value;
}

/** Verify the X-Hub-Signature-256 signature against the App Secrets of the declared apps. Returns the matching appId or null. */
export async function verifySignature(raw: string, header: string | null) {
  if (!header?.startsWith("sha256=")) return null;
  const got = Buffer.from(header.slice(7), "hex");
  for (const app of await db.webhookApp.findMany()) {
    const want = createHmac("sha256", decrypt(app.secretEnc)).update(raw).digest();
    if (want.length === got.length && timingSafeEqual(want, got)) return app.appId;
  }
  return null;
}

type Referral = { ad_id?: string; source?: string };
type Messaging = {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  referral?: Referral;
  message?: { mid?: string; text?: string; is_echo?: boolean; attachments?: { type?: string; payload?: { url?: string; sticker_id?: number } }[]; referral?: Referral };
  postback?: { referral?: Referral };
};
type Payload = { object?: string; entry?: { id?: string; time?: number; messaging?: Messaging[] }[] };

/** Webhook event time: Meta sends milliseconds, but some events (messaging_referrals) send seconds. */
function eventTime(ts?: number) {
  if (!ts) return new Date();
  return new Date(ts < 1e12 ? ts * 1000 : ts);
}

/** Save the ad-referral entries contained in one Meta webhook delivery. */
export async function saveReferrals(payload: Payload, appId: string) {
  if (payload.object !== "page" && payload.object !== "instagram") return 0;
  const rows: { appId: string; pageId: string; psid: string; adId: string; source: string; at: Date }[] = [];
  for (const e of payload.entry ?? []) {
    for (const m of e.messaging ?? []) {
      const ref = m.referral ?? m.message?.referral ?? m.postback?.referral;
      if (!ref?.ad_id || !m.sender?.id || !e.id) continue;
      rows.push({ appId, pageId: e.id, psid: m.sender.id, adId: String(ref.ad_id), source: ref.source ?? "ADS", at: eventTime(m.timestamp ?? e.time) });
    }
  }
  if (rows.length) await db.adReferral.createMany({ data: rows });
  await db.webhookApp.update({ where: { appId }, data: { lastEventAt: new Date() } }).catch(() => {});
  return rows.length;
}

/** Attach the source ad to conversations (after each sync): the latest ad referral before the last message. */
export async function attributeConversations(clientId: string) {
  await markAdReplies(clientId);
  const convs = await db.conversation.findMany({ where: { clientId, psid: { not: null } }, select: { id: true, pageId: true, psid: true, updatedTime: true, sourceAdId: true } });
  if (!convs.length) return 0;
  const refs = await db.adReferral.findMany({ where: { psid: { in: convs.map((c) => c.psid!) } }, orderBy: { at: "desc" } });
  let n = 0;
  for (const c of convs) {
    const r = refs.find((x) => x.psid === c.psid && (!c.pageId || x.pageId === c.pageId) && x.at.getTime() <= c.updatedTime.getTime() + 60_000);
    if (r && r.adId !== c.sourceAdId) {
      await db.conversation.update({ where: { id: c.id }, data: { sourceAdId: r.adId } });
      n++;
    }
  }
  return n;
}

const ATTACHMENT: Record<string, string> = { image: "[Ảnh]", video: "[Video]", audio: "[Ghi âm]", file: "[Tệp]", sticker: "[Nhãn dán]" };

/**
 * Write Messenger messages from the webhook into the DB (customer messages + Page replies if the app subscribes to message_echoes).
 * Conversation not in the DB: ask Meta for the conversation id + customer name by PSID. Messages already present (same id) are skipped.
 */
export async function saveWebhookMessages(payload: Payload) {
  if (payload.object !== "page") return 0;
  const events: { pageId: string; psid: string; mid: string; text: string; at: Date; fromCustomer: boolean; imageUrls: string[] }[] = [];
  for (const e of payload.entry ?? []) {
    for (const m of e.messaging ?? []) {
      const msg = m.message;
      if (!msg?.mid || !e.id) continue;
      const echo = !!msg.is_echo;
      const psid = echo ? m.recipient?.id : m.sender?.id;
      if (!psid) continue;
      const att = msg.attachments ?? [];
      const text = msg.text?.trim() || att.map((a) => (a.payload?.sticker_id ? ATTACHMENT.sticker : (ATTACHMENT[a.type ?? ""] ?? "[Tệp]"))).join(" ");
      if (!text) continue;
      // Customer-sent images (stickers excluded): only downloaded when the client enables "Đọc ảnh khách gửi" (read customer images).
      const imageUrls = echo ? [] : att.flatMap((a) => (a.type === "image" && !a.payload?.sticker_id && a.payload?.url ? [a.payload.url] : []));
      events.push({ pageId: e.id, psid, mid: msg.mid, text, at: eventTime(m.timestamp ?? e.time), fromCustomer: !echo, imageUrls });
    }
  }
  if (!events.length) return 0;
  const clients = await db.client.findMany({ where: { dataSource: "meta" } });
  const byPage = new Map<string, (typeof clients)[number]>();
  for (const c of clients) for (const p of clientPages(c)) if (!byPage.has(p.id)) byPage.set(p.id, c);
  let saved = 0;
  for (const ev of events) {
    const client = byPage.get(ev.pageId);
    if (!client) continue;
    if (await db.message.findUnique({ where: { id: ev.mid }, select: { id: true } })) continue;
    const primary = ev.pageId === client.metaPageId;
    let conv = await db.conversation.findFirst({
      where: { clientId: client.id, psid: ev.psid, OR: [{ pageId: ev.pageId }, ...(primary ? [{ pageId: null }] : [])] },
      orderBy: { updatedTime: "desc" },
      select: { id: true, updatedTime: true, phone: true, phones: true },
    });
    if (!conv) {
      const info = await getMetaClient(client)
        .conversationOf(ev.pageId, ev.psid)
        .catch((err) => void console.error("Webhook: could not read conversation", err instanceof Error ? err.message : err));
      if (!info) continue;
      conv = await db.conversation.upsert({
        where: { id: info.id },
        create: { id: info.id, clientId: client.id, pageId: ev.pageId, psid: ev.psid, customerName: info.customerName, link: info.link, updatedTime: ev.at },
        update: {},
        select: { id: true, updatedTime: true, phone: true, phones: true },
      });
    }
    await db.message.create({ data: { id: ev.mid, conversationId: conv.id, fromCustomer: ev.fromCustomer, text: ev.text, createdTime: ev.at } }).catch(() => {}); // duplicate id from 2 simultaneous webhooks
    const data: { updatedTime?: Date; analyzedAt?: null; phone?: string; phones?: string } = {};
    if (ev.at > conv.updatedTime) data.updatedTime = ev.at;
    if (ev.fromCustomer) {
      data.analyzedAt = null; // new customer message → Claude re-analyzes on the next run
      const found = extractContacts([ev.text]).phones;
      if (found.length) {
        let old: string[] = [];
        try {
          old = JSON.parse(conv.phones);
        } catch {}
        data.phones = JSON.stringify([...new Set([...found, ...old])]);
        data.phone = found[0];
      }
    }
    await db.conversation.update({ where: { id: conv.id }, data });
    if (client.readImages && ev.imageUrls.length) {
      await saveImagesFor(client.id, [{ messageId: ev.mid, conversationId: conv.id, urls: ev.imageUrls }]).catch((err) => void console.error("Webhook: image download failed", err instanceof Error ? err.message : err));
    }
    saved++;
  }
  return saved;
}
