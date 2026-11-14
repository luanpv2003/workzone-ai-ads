import { createHash, randomBytes } from "node:crypto";
import { db, findPaged } from "./db";
import { decrypt, encrypt } from "./crypto";
import { STAGE_LABEL } from "./format";
import { BRAND } from "./brand";

// A client's combined Lead list from 2 channels (lead forms + Messenger messages), with sales' real-world ratings.
// Ratings entered manually on the web or from Google Sheet (Apps Script calls /api/sheet/<code>, two-way sync).
// One row per person with a fixed key: F-<lead id> | M-<conversation id>. Duplicate phones across the 2 channels are not merged
// (the Sheet only appends rows, never changes keys); instead the other row's key goes in the "Trùng SĐT" (duplicate phone) column.

export const FEEDBACK_FIELDS = [
  { field: "contact", label: "Liên hệ", labelKey: "customers.feedback.fields.contact", options: ["Được", "Không nghe máy", "Hẹn gọi lại", "Sai số"] },
  { field: "quality", label: "Chất lượng", labelKey: "customers.feedback.fields.quality", options: ["Tốt", "Trung bình", "Kém", "Sai tệp"] },
  { field: "outcome", label: "Kết quả", labelKey: "customers.feedback.fields.outcome", options: ["Đang chăm", "Đã chốt", "Không mua", "Bỏ lead"] },
  { field: "note", label: "Ghi chú sale", labelKey: "customers.feedback.fields.note", options: [] as string[] },
] as const;

// `label` / the option values are DATA (stored in the DB and used as Google Sheet column headers / cell values). For the UI use `labelKey` and feedbackOptionLabel() (src/lib/highlevel-map.ts, client-safe).

export type FeedbackField = (typeof FEEDBACK_FIELDS)[number]["field"];
export const NO_ANSWER = "Không nghe máy";
/** Sales dropped the lead (unreachable): the bot stops claim / call-back reminders. */
const DROPPED = "Bỏ lead";
/** Final outcome reached: stop call-back reminders. */
export const DONE_OUTCOMES = ["Đã chốt", "Không mua", DROPPED];
export type Feedback = Record<FeedbackField, string>;
const EMPTY: Feedback = { contact: "", quality: "", outcome: "", note: "" };

/** Good lead per sales: quality Good / Average or closed. Poor lead: Poor / Wrong audience / wrong number. null = not yet rated by sales. */
export function feedbackGood(f: Pick<Feedback, "contact" | "quality" | "outcome">): boolean | null {
  if (f.outcome === "Đã chốt" || f.quality === "Tốt" || f.quality === "Trung bình") return true;
  if (f.quality === "Kém" || f.quality === "Sai tệp" || f.contact === "Sai số") return false;
  return null;
}

export const SHEET_COLUMNS = ["Mã", "Ngày", "Nguồn", "Tên", "SĐT", "Email", "Nhu cầu / câu trả lời", "Quảng cáo", "Chiến dịch", "Điểm AI", "Giai đoạn AI", "Link hội thoại", "Trùng SĐT", "Người chăm"];

export type SheetRow = {
  key: string;
  date: Date;
  source: "Form" | "Tin nhắn";
  name: string;
  phones: string[];
  email: string | null;
  need: string;
  adId: string | null;
  ad: string;
  campaign: string;
  score: number | null;
  stage: string;
  link: string | null;
  dup: string[];
  /** Person who claimed the lead via the group link; if nobody claimed, the person who rated on the web. */
  owner: string;
  fb: Feedback;
};

const isTestLead = (answers: string) => answers.includes("<test lead");

/** All leads of a client (newest first): form leads (excluding Meta test leads) + non-spam conversations. */
export async function sheetRows(clientId: string): Promise<SheetRow[]> {
  const [leads, convs, ads, fbs, acks] = await Promise.all([
    db.lead.findMany({ where: { clientId }, orderBy: { createdTime: "desc" } }),
    findPaged((skip, take) =>
      db.conversation.findMany({
        where: { clientId, OR: [{ stage: null }, { stage: { not: "spam" } }] },
        orderBy: [{ updatedTime: "desc" }, { id: "asc" }],
        skip,
        take,
        select: { id: true, customerName: true, updatedTime: true, phones: true, email: true, intent: true, sourceAdId: true, leadScore: true, stage: true, link: true, messages: { orderBy: { createdTime: "asc" }, take: 1, select: { createdTime: true } } },
      }),
    ),
    db.ad.findMany({ where: { clientId }, select: { id: true, name: true, campaign: { select: { name: true } } } }),
    db.salesFeedback.findMany({ where: { clientId } }),
    db.leadNotice.findMany({ where: { clientId, rowKey: { not: null }, ackAt: { not: null } }, orderBy: { ackAt: { sort: "asc", nulls: "first" } }, select: { rowKey: true, ackBy: true } }),
  ]);
  const adInfo = new Map(ads.map((a) => [a.id, a]));
  const fbOf = new Map(fbs.map((f) => [f.rowKey, { contact: f.contact, quality: f.quality, outcome: f.outcome, note: f.note }]));
  const ownerOf = new Map(fbs.filter((f) => f.source === "web" && f.updatedBy).map((f) => [f.rowKey, f.updatedBy!]));
  for (const a of acks.reverse()) if (a.ackBy) ownerOf.set(a.rowKey!, a.ackBy); // first claimer wins
  const rows: SheetRow[] = [];
  for (const l of leads) {
    if (isTestLead(l.answers)) continue;
    const key = `F-${l.id}`;
    rows.push({
      key,
      date: l.createdTime,
      source: "Form",
      name: l.name,
      phones: JSON.parse(l.phones) as string[],
      email: l.email,
      need: [l.formName, ...(JSON.parse(l.answers) as { q: string; a: string }[]).map((a) => `${a.q}: ${a.a}`)].filter(Boolean).join(" | "),
      adId: l.adId,
      ad: l.adName ?? (l.isOrganic ? "(tự nhiên)" : ""),
      campaign: l.campaignName ?? "",
      score: null,
      stage: "",
      link: null,
      dup: [],
      owner: ownerOf.get(key) ?? "",
      fb: fbOf.get(key) ?? EMPTY,
    });
  }
  for (const c of convs) {
    const key = `M-${c.id}`;
    const ad = c.sourceAdId ? adInfo.get(c.sourceAdId) : null;
    rows.push({
      key,
      date: c.messages[0]?.createdTime ?? c.updatedTime,
      source: "Tin nhắn",
      name: c.customerName,
      phones: JSON.parse(c.phones) as string[],
      email: c.email,
      need: c.intent ?? "",
      adId: c.sourceAdId,
      ad: ad?.name ?? (c.sourceAdId ? `QC ${c.sourceAdId}` : ""),
      campaign: ad?.campaign.name ?? "",
      score: c.leadScore,
      stage: c.stage ? (STAGE_LABEL[c.stage] ?? c.stage) : "",
      link: c.link,
      dup: [],
      owner: ownerOf.get(key) ?? "",
      fb: fbOf.get(key) ?? EMPTY,
    });
  }
  const byPhone = new Map<string, string[]>();
  for (const r of rows) for (const p of r.phones) byPhone.set(p, [...(byPhone.get(p) ?? []), r.key]);
  for (const r of rows) r.dup = [...new Set(r.phones.flatMap((p) => byPhone.get(p) ?? []))].filter((k) => k !== r.key);
  return rows.sort((a, b) => b.date.getTime() - a.date.getTime());
}

/** System column values (per SHEET_COLUMNS). Dates in Vietnam time so the Sheet can parse them. */
export function sheetValues(r: SheetRow): (string | number)[] {
  const d = new Date(r.date.getTime() + 7 * 3600_000).toISOString();
  // Block formulas (a customer named "=..." would be run as a formula by the Sheet).
  const safe = (v: string | number) => (typeof v === "string" && /^[=+\-@]/.test(v) ? `'${v}` : v);
  return [r.key, `${d.slice(0, 10)} ${d.slice(11, 16)}`, r.source, r.name, r.phones.join(" / "), r.email ?? "", r.need, r.ad, r.campaign, r.score ?? "", r.stage, r.link ?? "", r.dup.join(", "), r.owner].map(safe);
}

/** Save ratings (dropping values not in the picklist). Only writes changed rows; returns the number of rows changed. */
export async function saveFeedback(clientId: string, items: ({ key: string } & Partial<Feedback>)[], source: "web" | "sheet" | "link" | "crm", by: string) {
  const keys = items.map((i) => String(i.key ?? "")).filter((k) => /^[FM]-[\w.:-]+$/.test(k));
  if (!keys.length) return 0;
  // Only accept keys belonging to this client.
  const leadIds = keys.filter((k) => k.startsWith("F-")).map((k) => k.slice(2));
  const convIds = keys.filter((k) => k.startsWith("M-")).map((k) => k.slice(2));
  const [okLeads, okConvs, current] = await Promise.all([
    db.lead.findMany({ where: { clientId, id: { in: leadIds } }, select: { id: true } }),
    db.conversation.findMany({ where: { clientId, id: { in: convIds } }, select: { id: true } }),
    db.salesFeedback.findMany({ where: { clientId, rowKey: { in: keys } } }),
  ]);
  const valid = new Set([...okLeads.map((l) => `F-${l.id}`), ...okConvs.map((c) => `M-${c.id}`)]);
  const cur = new Map(current.map((f) => [f.rowKey, f]));
  let changed = 0;
  let toGhl = false;
  for (const item of items) {
    const key = String(item.key ?? "");
    if (!valid.has(key)) continue;
    const old = cur.get(key);
    const next: Feedback = old ? { contact: old.contact, quality: old.quality, outcome: old.outcome, note: old.note } : { ...EMPTY };
    for (const f of FEEDBACK_FIELDS) {
      const v = item[f.field];
      if (v === undefined) continue;
      const s = String(v ?? "").trim().slice(0, f.field === "note" ? 1000 : 50);
      if (s && f.options.length && !(f.options as readonly string[]).includes(s)) continue;
      next[f.field] = s;
    }
    if (old && FEEDBACK_FIELDS.every((f) => old[f.field] === next[f.field])) continue;
    if (!old && FEEDBACK_FIELDS.every((f) => !next[f.field])) continue;
    // Contact changed to "Không nghe máy" (no answer) → start counting call-back reminders; changed to anything else → stop (lib/lead-confirm.ts runRecalls).
    const recall = (old?.contact ?? "") === next.contact ? {} : next.contact === NO_ANSWER ? { recallAt: new Date(), recallCount: 0 } : { recallAt: null, recallCount: 0 };
    await db.salesFeedback.upsert({
      where: { clientId_rowKey: { clientId, rowKey: key } },
      create: { clientId, rowKey: key, ...next, ...recall, source, updatedBy: by },
      update: { ...next, ...recall, source, updatedBy: by },
    });
    changed++;
    // Lead already in HighLevel: flag it so the next sync pushes the new rating over (without pushing back what was just pulled from HighLevel).
    if (source !== "crm" && (await db.ghlLink.updateMany({ where: { clientId, rowKey: key }, data: { dirtyAt: new Date() } })).count) toGhl = true;
  }
  if (toGhl) await db.client.updateMany({ where: { id: clientId, ghlToken: { not: null } }, data: { ghlRequestAt: new Date() } });
  return changed;
}

/** Sync start date (Vietnam time) as YYYY-MM-DD ↔ Date. */
export const sinceToDate = (d: string) => new Date(`${d}T00:00:00+07:00`);
export const dateToSince = (d: Date | null) => (d ? new Date(d.getTime() + 7 * 3600_000).toISOString().slice(0, 10) : "");

// ------------------------------------------------------------ Secret link for Google Sheet

const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");

/** Create (or rotate) the secret code: the old link stops working immediately. */
export async function createSheetKey(clientId: string) {
  const key = randomBytes(24).toString("base64url");
  await db.client.update({ where: { id: clientId }, data: { sheetKeyHash: hashKey(key), sheetKey: encrypt(key), sheetSeenAt: null, sheetLinkedAt: new Date(), sheetRows: null, sheetFeedbackAt: null, sheetScriptV: null, sheetAuto: null } });
  return key;
}

export async function revokeSheetKey(clientId: string) {
  await db.client.update({ where: { id: clientId }, data: { sheetKeyHash: null, sheetKey: null, sheetSeenAt: null, sheetLinkedAt: null, sheetRows: null, sheetFeedbackAt: null, sheetScriptV: null, sheetAuto: null } });
}

export function sheetKeyOf(c: { sheetKey: string | null }) {
  try {
    return c.sheetKey ? decrypt(c.sheetKey) : null;
  } catch {
    return null;
  }
}

export async function clientBySheetKey(key: string) {
  if (!/^[\w-]{20,64}$/.test(key)) return null;
  return db.client.findFirst({ where: { sheetKeyHash: hashKey(key) }, select: { id: true, name: true, sheetSince: true } });
}

/** Apps Script snippet to paste into Google Sheet (Extensions → Apps Script). */
/** Apps Script sync interval (trigger everyMinutes(15)), used for the countdown on the web. */
export const SHEET_EVERY_MIN = 15;
/** Apps Script snippet version (the Sheet sends ?v=): if lower, prompt to paste the new code. */
export const SHEET_SCRIPT_V = 3; // 3: skip rows before the sync start date

export function appsScript(url: string) {
  return `// ${BRAND.app} → Google Sheet: danh sách khách (Form + Tin nhắn) + đánh giá của sale, đồng bộ 2 chiều.
// Cách dùng: dán toàn bộ đoạn này, Lưu, bấm Chạy (hàm nào cũng được, nên chọn caiDat) và cấp quyền 1 lần.
// Lần chạy đầu tự bật lịch đồng bộ mỗi 15 phút (xem ở biểu tượng đồng hồ "Trình kích hoạt").
// Menu "${BRAND.app}" → "Đồng bộ ngay" để chạy tay.
// Chỉ khách từ "ngày bắt đầu đồng bộ" (đặt trên web); dòng cũ hơn chưa ai ghi gì sẽ được bỏ khỏi Sheet.
// Sale chỉ sửa 4 cột cuối (Liên hệ, Chất lượng, Kết quả, Ghi chú sale). Các cột khác hệ thống ghi lại mỗi lần đồng bộ.
// Link dưới đây là mã bí mật: không chia sẻ ra ngoài.
const WZ_URL = ${JSON.stringify(url)};
const WZ_SHEET = "Khách hàng";
// Mỗi lượt đồng bộ cách nhau khoảng 15 phút (Google chạy trễ / sớm vài phút).
const WZ_SNAP = "_wzone";

const WZ_V = ${SHEET_SCRIPT_V};

function onOpen() {
  SpreadsheetApp.getUi().createMenu(${JSON.stringify(BRAND.app)}).addItem("Đồng bộ ngay", "dongBo").addItem("Bật lại đồng bộ tự động", "caiDat").addToUi();
}

function caiDat() {
  ScriptApp.getProjectTriggers().filter((t) => t.getHandlerFunction() === "dongBo").forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("dongBo").timeBased().everyMinutes(15).create();
  dongBo();
}

// Chạy tay hàm nào cũng tự bật lịch 15 phút nếu chưa có (trước đây phải nhớ chạy đúng caiDat).
function wzAuto_() {
  try {
    if (ScriptApp.getProjectTriggers().some((t) => t.getHandlerFunction() === "dongBo")) return 1;
    ScriptApp.newTrigger("dongBo").timeBased().everyMinutes(15).create();
    return 1;
  } catch (e) {
    return 0;
  }
}

function wzGet_(auto) {
  const res = UrlFetchApp.fetch(WZ_URL + "?v=" + WZ_V + "&auto=" + auto, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error(${JSON.stringify(BRAND.app + ": ")} + res.getContentText());
  return JSON.parse(res.getContentText());
}

function dongBo() {
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) return;
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const auto = wzAuto_();
    let data = wzGet_(auto);
    const fbCols = data.feedback.map((f) => f.label);
    const head = data.columns.concat(fbCols);
    const sh = ss.getSheetByName(WZ_SHEET) || ss.insertSheet(WZ_SHEET);
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight("bold");
      sh.setFrozenRows(1);
    }
    // Thêm cột còn thiếu (giữ nguyên cột người dùng tự thêm).
    let header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
    head.forEach((h) => { if (header.indexOf(h) < 0) { sh.getRange(1, header.length + 1).setValue(h).setFontWeight("bold"); header.push(h); } });
    const col = (h) => header.indexOf(h);
    const snap = ss.getSheetByName(WZ_SNAP) || ss.insertSheet(WZ_SNAP).hideSheet();
    const snapRows = snap.getLastRow() ? snap.getRange(1, 1, snap.getLastRow(), 1 + fbCols.length).getValues() : [];
    const before = {};
    snapRows.forEach((r) => { before[r[0]] = r.slice(1).map(String); });

    // 1) Đánh giá sale đã sửa trên Sheet (khác lần đồng bộ trước) → gửi về hệ thống.
    const last = sh.getLastRow();
    const rows = last > 1 ? sh.getRange(2, 1, last - 1, header.length).getValues() : [];
    const changed = [];
    rows.forEach((r) => {
      const key = String(r[col("Mã")] || "");
      if (!key) return;
      const now = fbCols.map((h) => String(r[col(h)] ?? "").trim());
      const old = before[key] || fbCols.map(() => "");
      if (now.join("\\u0001") !== old.join("\\u0001")) {
        const item = { key: key };
        data.feedback.forEach((f, j) => { item[f.field] = now[j]; });
        changed.push(item);
      }
    });
    if (changed.length) {
      const res = UrlFetchApp.fetch(WZ_URL, { method: "post", contentType: "application/json", payload: JSON.stringify({ feedback: changed }), muteHttpExceptions: true });
      if (res.getResponseCode() !== 200) throw new Error(${JSON.stringify(BRAND.app + ": ")} + res.getContentText());
      data = wzGet_(auto);
    }

    // 2) Bỏ dòng không còn trong danh sách (trước ngày bắt đầu đồng bộ, hoặc đã thành spam) nếu chưa ai ghi gì vào;
    //    dòng sale đã ghi (hoặc có cột tự thêm) thì giữ.
    const inFeed = {};
    data.rows.forEach((x) => { inFeed[x.key] = true; });
    const sysCol = {};
    data.columns.forEach((h) => { sysCol[col(h)] = true; });
    const out = [];
    rows.forEach((r) => {
      const key = String(r[col("Mã")] || "");
      const own = r.some((v, j) => !sysCol[j] && String(v ?? "").trim() !== "");
      if (/^[FM]-/.test(key) && !inFeed[key] && !own) { delete before[key]; return; }
      out.push(r.slice());
    });
    const at = {};
    out.forEach((r, i) => { const k = String(r[col("Mã")] || ""); if (k) at[k] = i; });

    // 3) Ghi lại cột hệ thống + đánh giá sửa trên web; khách mới thêm xuống cuối.
    const add = [];
    data.rows.forEach((x) => {
      const fb = data.feedback.map((f) => x.fb[f.field] || "");
      let r = at[x.key] === undefined ? null : out[at[x.key]];
      if (!r) { r = header.map(() => ""); add.push(r); }
      data.columns.forEach((h, j) => { r[col(h)] = x.values[j]; });
      fbCols.forEach((h, j) => { r[col(h)] = fb[j]; });
      before[x.key] = fb;
    });
    add.reverse(); // khách mới nhất ở cuối
    sh.getRange(1, col("SĐT") + 1, sh.getMaxRows(), 1).setNumberFormat("@"); // giữ số 0 đầu
    if (rows.length) sh.getRange(2, 1, rows.length, header.length).clearContent();
    const all = out.concat(add);
    if (all.length) sh.getRange(2, 1, all.length, header.length).setValues(all);

    // Ô chọn cho cột đánh giá.
    const n = Math.max(sh.getLastRow() - 1, 1);
    data.feedback.forEach((f) => {
      if (!f.options.length) return;
      const rule = SpreadsheetApp.newDataValidation().requireValueInList(f.options, true).setAllowInvalid(false).build();
      sh.getRange(2, col(f.label) + 1, n, 1).setDataValidation(rule);
    });

    const snapOut = Object.keys(before).map((k) => [k].concat(before[k]));
    snap.clearContents();
    if (snapOut.length) snap.getRange(1, 1, snapOut.length, snapOut[0].length).setNumberFormat("@").setValues(snapOut);
  } finally {
    lock.releaseLock();
  }
}
`;
}
