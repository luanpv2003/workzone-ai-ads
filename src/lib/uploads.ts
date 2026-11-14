import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { getT } from "@/i18n/server";
import { viT } from "./format";
import type { T } from "@/i18n/translate";

// Creative images uploaded by users are stored in data/uploads/<draftId>/..., served via /api/uploads/...
const ROOT = path.join(process.cwd(), "data", "uploads");
const ALLOWED = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024; // Meta's image limit

export function uploadFilePath(rel: string) {
  const p = path.normalize(path.join(ROOT, rel));
  if (!p.startsWith(ROOT + path.sep)) throw new Error("Invalid image path.");
  return p;
}

export function uploadUrl(rel: string) {
  return `/api/uploads/${rel}`;
}

/** Detect the image type from the file's first bytes (don't trust the type the browser sends). */
function sniffImage(b: Buffer): string | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return null;
}

export async function saveUpload(folder: string, file: File): Promise<string> {
  const t = await getT();
  if (!ALLOWED.has(file.type)) throw new Error(t("core.uploads.typeOnly"));
  if (file.size > MAX_UPLOAD_BYTES) throw new Error(t("core.uploads.tooBig"));
  const data = Buffer.from(await file.arrayBuffer());
  const ext = sniffImage(data);
  if (!ext) throw new Error(t("core.uploads.notImageRenamed"));
  const safeFolder = folder.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safeFolder) throw new Error(t("core.uploads.missingDraft"));
  const rel = `${safeFolder}/${randomUUID()}.${ext}`;
  mkdirSync(path.join(ROOT, safeFolder), { recursive: true });
  writeFileSync(uploadFilePath(rel), data);
  return rel;
}

/** Save an image from existing data (e.g. an image downloaded from a Page post) — with the same file type check as user uploads. */
export function saveUploadBuffer(folder: string, data: Buffer, t: T = viT): string {
  if (data.length > MAX_UPLOAD_BYTES) throw new Error(t("core.uploads.tooBig"));
  const ext = sniffImage(data);
  if (!ext) throw new Error(t("core.uploads.notImage"));
  const safeFolder = folder.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safeFolder) throw new Error(t("core.uploads.missingFolder"));
  const rel = `${safeFolder}/${randomUUID()}.${ext}`;
  mkdirSync(path.join(ROOT, safeFolder), { recursive: true });
  writeFileSync(uploadFilePath(rel), data);
  return rel;
}
