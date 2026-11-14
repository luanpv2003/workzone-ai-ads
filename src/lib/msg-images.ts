import { mkdir, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import { db } from "./db";

// Images customers send in Messenger (only when the client enables "Đọc ảnh khách gửi" (read customer images)): small compressed copies stored in data/msg-images/<clientId>/,
// served via /api/msg-images/..., viewed by Claude when analyzing messages. Only keeps images of the KEEP_CONVERSATIONS most recent conversations.
const ROOT = path.join(process.cwd(), "data", "msg-images");
const KEEP_CONVERSATIONS = 1000;
const MAX_SIDE = 512; // enough to tell what the image is (product, bank transfer, error…), ~20–40KB/image, ~350 tokens when Claude views it
const MAX_PER_MESSAGE = 4;
const MAX_DOWNLOAD = 15 * 1024 * 1024;

function msgImagePath(rel: string) {
  const p = path.normalize(path.join(ROOT, rel));
  if (!p.startsWith(ROOT + path.sep)) throw new Error("Invalid image path.");
  return p;
}

export const msgImageUrl = (rel: string) => `/api/msg-images/${rel}`;

export function parseImages(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Download an image from Meta and compress it: long edge ≤ 512px, low-quality JPEG. Errors (expired link, not an image) → null. */
async function fetchSmall(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    if (Number(res.headers.get("content-length") ?? 0) > MAX_DOWNLOAD) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_DOWNLOAD) return null;
    return await sharp(buf, { animated: false })
      .rotate()
      .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 50, mozjpeg: true })
      .toBuffer();
  } catch {
    return null;
  }
}

/** Download + compress a message's images, write filenames to Message.images. Returns the number of images saved. */
async function saveMessageImages(clientId: string, messageId: string, urls: string[]) {
  const dir = msgImagePath(clientId.replace(/[^a-zA-Z0-9_-]/g, ""));
  const names: string[] = [];
  for (const [i, url] of urls.slice(0, MAX_PER_MESSAGE).entries()) {
    const data = await fetchSmall(url);
    if (!data) continue;
    await mkdir(dir, { recursive: true });
    const name = `${createHash("sha1").update(messageId).digest("hex").slice(0, 20)}-${i}.jpg`;
    await writeFile(path.join(dir, name), data);
    names.push(`${path.basename(dir)}/${name}`);
  }
  if (names.length) await db.message.update({ where: { id: messageId }, data: { images: JSON.stringify(names) } }).catch(() => {});
  return names.length;
}

/** Download images for new messages (sync / webhook), 3 messages at a time. Only messages in the 1000 most recent conversations. */
export async function saveImagesFor(clientId: string, items: { messageId: string; conversationId: string; urls: string[] }[]) {
  if (!items.length) return 0;
  const keep = new Set(await keptConversationIds(clientId));
  const todo = items.filter((x) => x.urls.length && keep.has(x.conversationId));
  let saved = 0;
  for (let i = 0; i < todo.length; i += 3) {
    const n = await Promise.all(todo.slice(i, i + 3).map((x) => saveMessageImages(clientId, x.messageId, x.urls).catch(() => 0)));
    saved += n.reduce((a, b) => a + b, 0);
  }
  return saved;
}

async function keptConversationIds(clientId: string) {
  const rows = await db.conversation.findMany({ where: { clientId }, orderBy: [{ updatedTime: "desc" }, { id: "asc" }], take: KEEP_CONVERSATIONS, select: { id: true } });
  return rows.map((r) => r.id);
}

/**
 * Clear the image column of a client's messages (except conversations in keep). Find ids first (read, no write lock held) then update by id:
 * an updateMany filtered by conversation would scan the Message table while holding the write lock (Prisma opens BEGIN IMMEDIATE), see own-ads.ts markAdReplies.
 */
async function clearImages(clientId: string, keep?: string[]) {
  const ids = (
    await db.message.findMany({
      where: { images: { not: null }, conversation: { clientId }, ...(keep && { conversationId: { notIn: keep } }) },
      select: { id: true },
    })
  ).map((m) => m.id);
  for (let i = 0; i < ids.length; i += 500) {
    await db.message.updateMany({ where: { id: { in: ids.slice(i, i + 500) } }, data: { images: null } });
  }
}

/**
 * Clean up images to save VPS disk: client has image reading off → delete all; on → delete images outside the 1000 most recent conversations
 * and files no message points to anymore (deleted conversations). Returns the number of files deleted.
 */
export async function pruneMessageImages(clientId: string) {
  const client = await db.client.findUnique({ where: { id: clientId }, select: { readImages: true } });
  const dir = msgImagePath(clientId.replace(/[^a-zA-Z0-9_-]/g, ""));
  if (!client?.readImages) {
    await clearImages(clientId);
    const n = (await readdir(dir).catch(() => [])).length;
    await rm(dir, { recursive: true, force: true });
    return n;
  }
  const keep = await keptConversationIds(clientId);
  await clearImages(clientId, keep);
  const used = new Set(
    (await db.message.findMany({ where: { images: { not: null }, conversation: { clientId } }, select: { images: true } })).flatMap((m) => parseImages(m.images).map((r) => path.basename(r))),
  );
  let n = 0;
  for (const f of await readdir(dir).catch(() => [] as string[])) {
    if (used.has(f)) continue;
    await unlink(path.join(dir, f)).catch(() => {});
    n++;
  }
  return n;
}

/** Clean up images for all clients (hourly schedule). Including folders of deleted clients. */
export async function pruneAllMessageImages() {
  const ids = new Set((await db.client.findMany({ select: { id: true } })).map((c) => c.id));
  let n = 0;
  for (const id of ids) n += await pruneMessageImages(id).catch(() => 0);
  for (const d of await readdir(ROOT).catch(() => [] as string[])) {
    if (!ids.has(d)) await rm(path.join(ROOT, d), { recursive: true, force: true });
  }
  return n;
}

export async function readMessageImage(rel: string) {
  return readFile(msgImagePath(rel));
}
