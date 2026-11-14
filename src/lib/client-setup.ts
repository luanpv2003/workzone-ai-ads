import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { db } from "./db";
import { extractText, looksGarbled } from "./knowledge";
import { guessCategory, toCategory } from "./knowledge-rules";
import { generateStructured } from "./ai/claude";
import { CLIENT_SETUP_SYSTEM } from "./ai/prompts";
import { ClientSetupSchema, type ClientSetup } from "./ai/schemas";
import { getT } from "@/i18n/server";

// Create a client from documents: upload files → extract text → Claude pre-fills the profile → user reviews/edits → save (files go to the Knowledge base).
// Files sit temporarily in data/knowledge/_staging/<id>/ between the analysis step and the save step.

const ROOT = path.join(process.cwd(), "data", "knowledge");
const STAGING = path.join(ROOT, "_staging");
const PROMPT_CHARS = 90_000; // total document text sent to Claude

type StagedFile = { fileName: string; stored: string; size: number; content: string; warning: string | null };
type Manifest = { files: StagedFile[]; note: string; createdAt: string; userId?: string };

const stagingDir = (id: string) => {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid temporary document ID.");
  return path.join(STAGING, id);
};

/** Clean up temp folders older than 1 day (user analyzed but did not save). */
function cleanupStaging() {
  if (!existsSync(STAGING)) return;
  for (const d of readdirSync(STAGING)) {
    const p = path.join(STAGING, d);
    try {
      if (Date.now() - statSync(p).mtimeMs > 86400_000) rmSync(p, { recursive: true, force: true });
    } catch {}
  }
}

export type SetupResult = { stagingId: string; profile: ClientSetup; files: { fileName: string; chars: number; warning: string | null }[]; model: string };

const MAX_SETUP_FILE_BYTES = 60 * 1024 * 1024;

const readManifest = (id: string): Manifest => JSON.parse(readFileSync(path.join(stagingDir(id), "manifest.json"), "utf8"));
const writeManifest = (id: string, m: Manifest) => writeFileSync(path.join(stagingDir(id), "manifest.json"), JSON.stringify(m));

export function beginStaging(userId: string) {
  cleanupStaging();
  const id = randomUUID();
  mkdirSync(stagingDir(id), { recursive: true });
  writeManifest(id, { files: [], note: "", createdAt: new Date().toISOString(), userId });
  return id;
}

/** A staging folder can only be used by the user who started it. */
async function ownedManifest(id: string, userId: string): Promise<Manifest> {
  const dir = stagingDir(id);
  const m = existsSync(path.join(dir, "manifest.json")) ? readManifest(id) : null;
  if (!m || m.userId !== userId) throw new Error((await getT())("core.clientSetup.sessionExpired"));
  return m;
}

/** Receive one chunk of a file (sent sequentially from the browser). Last chunk: once assembled, extract text immediately. */
export async function appendChunk(id: string, userId: string, fileKey: string, fileName: string, index: number, total: number, buf: Buffer) {
  const t = await getT();
  if (!/^[a-z0-9-]{1,64}$/.test(fileKey)) throw new Error(t("core.clientSetup.badFileId"));
  const dir = stagingDir(id);
  await ownedManifest(id, userId);
  const part = path.join(dir, `${fileKey}.part`);
  if (index === 0) writeFileSync(part, buf);
  else appendFileSync(part, buf);
  if (statSync(part).size > MAX_SETUP_FILE_BYTES) {
    rmSync(part, { force: true });
    throw new Error(t("core.clientSetup.tooBig", { name: fileName }));
  }
  if (index < total - 1) return null;

  const ext = fileName.split(".").pop()!.toLowerCase().replace(/[^a-z0-9]/g, "");
  const stored = `${fileKey}.${ext}`;
  renameSync(part, path.join(dir, stored));
  const data = readFileSync(path.join(dir, stored));
  let content = "";
  let warning: string | null = null;
  try {
    content = await extractText(fileName, data);
    if (content.length < 50) warning = t("core.clientSetup.noText");
    else if (looksGarbled(content)) warning = t("core.clientSetup.garbled");
  } catch (err) {
    warning = err instanceof Error ? err.message : String(err);
  }
  const m = readManifest(id);
  if (m.files.length >= 20) throw new Error(t("core.clientSetup.maxFiles"));
  m.files.push({ fileName, stored, size: data.length, content, warning });
  writeManifest(id, m);
  return { fileName, chars: content.length, warning };
}

export async function analyzeStaged(id: string, userId: string, note: string, workspaceId: string | null = null): Promise<SetupResult> {
  const t = await getT();
  const m = await ownedManifest(id, userId);
  if (!m.files.length && !note.trim()) throw new Error(t("core.clientSetup.noDocs"));
  m.note = note;
  writeManifest(id, m);
  const staged = m.files;
  // Split the text limit evenly across files (short files use their full share, leftovers go to long files).
  const usable = staged.filter((s) => s.content.length >= 50);
  let budget = PROMPT_CHARS;
  const sorted = [...usable].sort((a, b) => a.content.length - b.content.length);
  const take = new Map<string, number>();
  sorted.forEach((s, i) => {
    const n = Math.min(s.content.length, Math.floor(budget / (sorted.length - i)));
    take.set(s.stored, n);
    budget -= n;
  });
  const docs = staged
    .map((s) => `## File: ${s.fileName}${s.warning ? ` (note: ${s.warning})` : ""}\n${s.content.slice(0, take.get(s.stored) ?? 0)}${(take.get(s.stored) ?? 0) < s.content.length ? "\n[... truncated]" : ""}`)
    .join("\n\n");
  const prompt = `# User notes\n${note.trim() || "(none)"}\n\n# Documents (${staged.length} files)\n${docs}\n\nFill in the client profile.`;
  const res = await generateStructured({ workspaceId, system: CLIENT_SETUP_SYSTEM, prompt, schema: ClientSetupSchema, effort: "medium" });
  return { stagingId: id, profile: res.data, files: staged.map((s) => ({ fileName: s.fileName, chars: s.content.length, warning: s.warning })), model: res.model };
}

/** After creating the client: move temp files into the Knowledge base (title / group as suggested by AI, editable later). */
export async function importStagedFiles(clientId: string, stagingId: string, userId: string, docs: { file_name: string; title: string; category: string }[] = []) {
  const dir = stagingDir(stagingId);
  const manifestPath = path.join(dir, "manifest.json");
  if (!existsSync(manifestPath)) return 0;
  const manifest = await ownedManifest(stagingId, userId);
  const safeClient = clientId.replace(/[^a-zA-Z0-9_-]/g, "");
  mkdirSync(path.join(ROOT, safeClient), { recursive: true });
  let n = 0;
  for (const f of manifest.files) {
    const meta = docs.find((d) => d.file_name === f.fileName);
    const rel = `${safeClient}/${f.stored}`;
    renameSync(path.join(dir, f.stored), path.join(ROOT, rel));
    const garbled = f.content.length < 50 || looksGarbled(f.content);
    await db.knowledgeDoc.create({
      data: {
        clientId,
        title: meta?.title?.trim() || f.fileName.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim(),
        category: meta ? toCategory(meta.category) : guessCategory(f.fileName),
        content: f.content,
        fileName: f.fileName,
        filePath: rel,
        fileSize: f.size,
        useForAi: !garbled,
      },
    });
    n++;
  }
  if (manifest.note.trim()) {
    await db.knowledgeDoc.create({ data: { clientId, title: (await getT())("core.clientSetup.noteTitle"), category: "project", content: manifest.note.trim() } });
  }
  rmSync(dir, { recursive: true, force: true });
  return n;
}
