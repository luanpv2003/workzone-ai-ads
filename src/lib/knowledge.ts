import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { db } from "./db";
import { maskPii } from "./pii";
import { categoryLabel, guessCategory, toCategory } from "./knowledge-rules";
import { getT } from "@/i18n/server";

// Each client's Knowledge base: original files stored in data/knowledge/<clientId>/, extracted text stored in the DB.

const ROOT = path.join(process.cwd(), "data", "knowledge");
const MAX_KNOWLEDGE_FILE_BYTES = 25 * 1024 * 1024;
const MAX_CONTENT_CHARS = 300_000; // per document
/** Total document characters sent to Claude per call (≈ 25–30 thousand Vietnamese tokens). */
export const AI_CONTEXT_CHARS = 60_000;

const SUPPORTED_EXT = ["pdf", "docx", "xlsx", "csv", "txt", "md", "html", "htm", "json"];

export function knowledgeFilePath(rel: string) {
  return filePathOf(rel);
}

function filePathOf(rel: string) {
  const p = path.normalize(path.join(ROOT, rel));
  if (!p.startsWith(ROOT + path.sep)) throw new Error("Invalid file path.");
  return p;
}

// ------------------------------------------------------------ Text extraction from files

function cleanText(t: string) {
  return t
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function htmlToText(html: string) {
  const entities: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, "")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) =>
      e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (entities[e.toLowerCase()] ?? m),
    );
}

async function pdfToText(buf: Buffer) {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(pdf, { mergePages: false });
  return (text as string[]).map((t, i) => `--- Trang ${i + 1} ---\n${t}`).join("\n\n");
}

async function docxToText(buf: Buffer) {
  const mammoth = (await import("mammoth")).default;
  const { value } = await mammoth.extractRawText({ buffer: buf });
  return value;
}

const decodeXml = (t: string) =>
  t.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[e.toLowerCase()]!,
  );
/** Join every <t>...</t> in an XML fragment (plain strings or rich text). */
const xmlText = (x: string) => [...x.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1])).join("");

/**
 * Excel (.xlsx) is a zip of XML: read the strings and cells of each sheet directly.
 * (exceljs is not used: it breaks on files containing images/drawings.)
 */
async function xlsxToText(buf: Buffer) {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buf);
  const read = (p: string) => zip.file(p)?.async("string") ?? Promise.resolve("");
  const shared = [...(await read("xl/sharedStrings.xml")).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => xmlText(m[1]));
  const rels = new Map([...(await read("xl/_rels/workbook.xml.rels")).matchAll(/<Relationship\b[^>]*>/g)].map((m) => [/Id="([^"]+)"/.exec(m[0])?.[1], /Target="([^"]+)"/.exec(m[0])?.[1]]));
  const out: string[] = [];
  for (const m of (await read("xl/workbook.xml")).matchAll(/<sheet\b[^>]*>/g)) {
    const name = decodeXml(/name="([^"]*)"/.exec(m[0])?.[1] ?? "");
    const target = rels.get(/r:id="([^"]+)"/.exec(m[0])?.[1]);
    if (!target) continue;
    const xml = await read(target.startsWith("/") ? target.slice(1) : `xl/${target}`);
    out.push(`=== Sheet: ${name} ===`);
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [...row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map((c) => {
        const type = /\bt="([^"]+)"/.exec(c[1])?.[1];
        const inner = c[2] ?? "";
        if (type === "inlineStr") return xmlText(inner);
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        if (v == null) return "";
        return type === "s" ? (shared[Number(v)] ?? "") : decodeXml(v);
      });
      if (cells.some((v) => v.trim())) out.push(cells.join(" | "));
    }
  }
  return out.join("\n");
}

/** PDFs exported from slides/designs often lose accented characters ("H ng d n"): many scattered 1-letter fragments. */
export function looksGarbled(text: string) {
  const words = text.split(/\s+/).filter((w) => /^\p{L}+$/u.test(w));
  if (words.length < 40) return false;
  return words.filter((w) => w.length === 1).length / words.length > 0.28;
}

export async function extractText(fileName: string, buf: Buffer): Promise<string> {
  const t = await getT();
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  let text: string;
  if (ext === "pdf") text = await pdfToText(buf);
  else if (ext === "docx") text = await docxToText(buf);
  else if (ext === "xlsx") text = await xlsxToText(buf);
  else if (ext === "html" || ext === "htm") text = htmlToText(buf.toString("utf8"));
  else if (["txt", "md", "csv", "json"].includes(ext)) text = buf.toString("utf8");
  else throw new Error(t("settings.knowledge.unsupportedExt", { ext, supported: SUPPORTED_EXT.join(", ") }));
  return cleanText(text).slice(0, MAX_CONTENT_CHARS);
}

// ------------------------------------------------------------ Add / edit / delete

type KnowledgeInput = { title: string; category: string; content: string; useForAi?: boolean };

export async function addKnowledgeText(clientId: string, input: KnowledgeInput) {
  const t = await getT();
  const title = input.title.trim();
  const content = cleanText(input.content).slice(0, MAX_CONTENT_CHARS);
  if (!title) throw new Error(t("settings.knowledge.noTitle"));
  if (!content) throw new Error(t("settings.knowledge.noContent"));
  await db.client.findUniqueOrThrow({ where: { id: clientId }, select: { id: true } });
  return db.knowledgeDoc.create({ data: { clientId, title, content, category: toCategory(input.category), useForAi: input.useForAi ?? true } });
}

/** Upload 1 file: store the original + extracted text. If no text can be read (scanned PDF), still save it, with a warning. */
export async function addKnowledgeFile(clientId: string, file: File, category?: string) {
  const t = await getT();
  if (file.size > MAX_KNOWLEDGE_FILE_BYTES) throw new Error(t("settings.knowledge.tooBig", { name: file.name }));
  await db.client.findUniqueOrThrow({ where: { id: clientId }, select: { id: true } });
  const buf = Buffer.from(await file.arrayBuffer());
  const content = await extractText(file.name, buf);
  const ext = file.name.split(".").pop()!.toLowerCase();
  const safeClient = clientId.replace(/[^a-zA-Z0-9_-]/g, "");
  const rel = `${safeClient}/${randomUUID()}.${ext}`;
  mkdirSync(path.join(ROOT, safeClient), { recursive: true });
  writeFileSync(filePathOf(rel), buf);
  const doc = await db.knowledgeDoc.create({
    data: {
      clientId,
      title: file.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim(),
      category: category && category !== "auto" ? toCategory(category) : guessCategory(file.name),
      content,
      fileName: file.name,
      filePath: rel,
      fileSize: file.size,
      // No text or garbled fonts: don't send to Claude yet (avoid misreading prices, KPIs).
      useForAi: content.length >= 50 && !looksGarbled(content),
    },
  });
  const isPdf = ext === "pdf";
  const warning =
    content.length < 50
      ? t("settings.knowledge.warnEmpty", { name: file.name, action: isPdf ? t("settings.knowledge.warnEmptyPdf") : t("settings.knowledge.warnEmptyOther") })
      : looksGarbled(content)
        ? t("settings.knowledge.warnGarbled", { name: file.name, action: isPdf ? t("settings.knowledge.warnGarbledPdf") : "" })
        : null;
  return { doc, warning };
}

export async function updateKnowledge(id: string, input: Partial<KnowledgeInput>) {
  const t = await getT();
  const data: { title?: string; category?: string; content?: string; useForAi?: boolean } = {};
  if (input.title !== undefined) {
    if (!input.title.trim()) throw new Error(t("settings.knowledge.titleEmpty"));
    data.title = input.title.trim();
  }
  if (input.category !== undefined) data.category = toCategory(input.category);
  if (input.content !== undefined) data.content = cleanText(input.content).slice(0, MAX_CONTENT_CHARS);
  if (input.useForAi !== undefined) data.useForAi = input.useForAi;
  return db.knowledgeDoc.update({ where: { id }, data });
}

export async function deleteKnowledge(id: string) {
  const doc = await db.knowledgeDoc.delete({ where: { id } });
  if (doc.filePath) rmSync(filePathOf(doc.filePath), { force: true });
  return doc;
}

export async function readKnowledgeFile(id: string) {
  const doc = await db.knowledgeDoc.findUniqueOrThrow({ where: { id } });
  if (!doc.filePath) throw new Error((await getT())("settings.knowledge.noOriginal"));
  return { doc, data: readFileSync(filePathOf(doc.filePath)) };
}

// ------------------------------------------------------------ Feeding context to Claude

// Priority order when over the limit: product/brand information matters most for audits and ad writing.
const PRIORITY = ["product", "brand", "proposal", "project", "faq", "creative", "report", "other"];

type KnowledgeContext = { text: string; used: number; total: number; truncated: string[]; chars: number };

/** Join documents with "Used by Claude" on into one text block, truncated if over AI_CONTEXT_CHARS. */
export async function knowledgeContext(clientId: string, budget = AI_CONTEXT_CHARS): Promise<KnowledgeContext> {
  const t = await getT();
  const docs = await db.knowledgeDoc.findMany({ where: { clientId, useForAi: true }, orderBy: { updatedAt: "desc" } });
  docs.sort((a, b) => PRIORITY.indexOf(a.category) - PRIORITY.indexOf(b.category));
  const parts: string[] = [];
  const truncated: string[] = [];
  let left = budget;
  let used = 0;
  for (const d of docs) {
    const head = `## [${categoryLabel(d.category, t)}] ${d.title} (${t("settings.knowledge.updatedOn", { date: d.updatedAt.toISOString().slice(0, 10) })})\n`;
    if (left < head.length + 200) {
      truncated.push(d.title);
      continue;
    }
    // Contracts often contain phone numbers, bank account numbers, national IDs: mask them before sending to Claude (prices kept).
    let body = maskPii(d.content);
    if (head.length + body.length > left) {
      body = `${body.slice(0, left - head.length - 60)}\n${t("settings.knowledge.truncatedNote")}`;
      truncated.push(d.title);
    }
    parts.push(head + body);
    left -= head.length + body.length;
    used++;
  }
  const text = parts.join("\n\n");
  return { text, used, total: docs.length, truncated, chars: text.length };
}

/** Text block to insert into the prompt; empty if the client has no documents. */
export async function knowledgePromptSection(clientId: string) {
  const k = await knowledgeContext(clientId);
  if (!k.text) return "";
  const t = await getT();
  return `${t("settings.knowledge.promptHead", { used: k.used })}
${t("settings.knowledge.promptIntro")}

${k.text}`;
}

