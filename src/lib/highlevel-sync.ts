import { db } from "./db";
import { getT } from "@/i18n/server";
import { BRAND } from "./brand";
import { saveFeedback, sheetRows } from "./lead-sheet";
import { reverseTarget, type ReverseMap, type StageFeedback, type StageMap } from "./highlevel-map";

export { suggestReverse, type ReverseMap, type StageMap } from "./highlevel-map";
import { addNote, addTags, createOpportunity, e164, ghlCreds, GHL_PAGE, moveOpportunity, searchOpportunities, setOpportunityStatus, upsertContact, type GhlCreds, type GhlPipeline } from "./highlevel";

// HighLevel sync (the worker checks every minute; each client every 30 minutes / when "Đồng bộ ngay" (Sync now) is clicked):
// 1. Push: customers with phone numbers in the customer list (lead forms + messages, since ghlSince) not yet on HighLevel →
//    upsert contact, tag source / campaign / ad set / industry, add a content note, create an opportunity at the chosen stage.
// 2. Push back: ratings edited in the system (GhlLink.dirtyAt, set in saveFeedback) → move stage / Won / Lost
//    per the reverse mapping (forward moves only, never backward), sales notes → note on the contact.
// 3. Pull: stage + opportunity status of pushed customers → sales rating (SalesFeedback source "crm")
//    per the stage mapping on the web. Only written when the stage changes. Contract pipeline (optional): Won = Đã chốt (Closed), Lost = Không mua (Didn't buy).
// Webhook /api/ghl/<code> (HighLevel workflow on stage change) and every rating edit set ghlRequestAt → the worker syncs within ~1 minute.

const EVERY_MS = 30 * 60_000;
const PUSH_MAX = 100; // customers pushed per run (the next run continues)
const PULL_PAGES = 30; // at most 3,000 most recent opportunities of the pipeline per run

export function parseGhlPipelines(s: string): GhlPipeline[] {
  try {
    return JSON.parse(s) as GhlPipeline[];
  } catch {
    return [];
  }
}
export function parseReverseMap(s: string): ReverseMap {
  try {
    return JSON.parse(s) as ReverseMap;
  } catch {
    return {};
  }
}

export function parseStageMap(s: string): StageMap {
  try {
    return JSON.parse(s) as StageMap;
  } catch {
    return {};
  }
}

/** Suggest stage → rating mapping by stage name (the user adjusts it on the web). */
export function suggestStage(name: string): StageFeedback {
  const n = name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d");
  // Before "enrol": handoff to enrollment is not yet signed.
  if (/handoff|hand off|ban giao|chuyen giao/.test(n)) return { contact: "Được", quality: "Tốt", outcome: "Đang chăm" };
  if (/won|chot|ky hop dong|da ky|dat coc|deposit|enrol|nhap hoc|thanh cong/.test(n)) return { contact: "Được", quality: "Tốt", outcome: "Đã chốt" };
  if (/lost|khong mua|tu choi|huy|that bai|khong phu hop|junk|spam/.test(n)) return { outcome: "Không mua" };
  if (/sai so|wrong number|invalid/.test(n)) return { contact: "Sai số" };
  if (/khong nghe|no answer|unreach|chua lien lac duoc/.test(n)) return { contact: "Không nghe máy" };
  if (/hen goi lai|goi lai sau|call ?back|busy/.test(n)) return { contact: "Hẹn gọi lại" };
  if (/hen|appointment|booked|meeting|review|tu van|consult|qualified|du dieu kien|tiem nang|hot/.test(n)) return { contact: "Được", quality: "Tốt", outcome: "Đang chăm" };
  if (/contacted|da goi|da lien he|lien he|follow|cham soc|nurtur/.test(n)) return { contact: "Được", outcome: "Đang chăm" };
  return {};
}

type DueClient = { ghlToken: string | null; ghlLocationId: string | null; ghlRequestAt: Date | null; ghlSyncAt: Date | null };
export function ghlDue(c: DueClient, now = Date.now()) {
  if (!c.ghlToken || !c.ghlLocationId) return false;
  return !!c.ghlRequestAt || !c.ghlSyncAt || now - c.ghlSyncAt.getTime() >= EVERY_MS;
}

const trim = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export async function syncGhl(clientId: string): Promise<{ pushed: number; pending: number; reversed: number; pulled: number; updated: number; deals: number }> {
  const c = await db.client.findUniqueOrThrow({ where: { id: clientId } });
  const creds = ghlCreds(c);
  if (!creds) throw new Error((await getT())("customers.highlevelSync.notConnected"));
  const requestedAt = c.ghlRequestAt;
  // Only clear requests already picked up: webhooks / rating edits arriving during the run are handled by the next run.
  const clearRequest = () => (requestedAt ? db.client.updateMany({ where: { id: clientId, ghlRequestAt: requestedAt }, data: { ghlRequestAt: null } }) : null);
  try {
    const push = c.ghlPush || requestedAt ? await pushRows(clientId, creds, c) : { pushed: 0, pending: 0 };
    const pipeline = parseGhlPipelines(c.ghlPipelines).find((p) => p.id === c.ghlPipelineId);
    const reversed = pipeline ? await pushEdits(clientId, creds, pipeline, parseReverseMap(c.ghlReverseMap)) : 0;
    const pull = c.ghlPipelineId ? await pullStages(clientId, creds, c.ghlPipelineId, parseStageMap(c.ghlStageMap)) : { pulled: 0, updated: 0 };
    const deals = c.ghlDealPipelineId && c.ghlDealPipelineId !== c.ghlPipelineId ? await pullDeals(clientId, creds, c.ghlDealPipelineId) : 0;
    await db.client.update({ where: { id: clientId }, data: { ghlSyncAt: new Date(), ghlSyncError: null } });
    await clearRequest();
    return { ...push, reversed, ...pull, deals };
  } catch (err) {
    await db.client.update({ where: { id: clientId }, data: { ghlSyncAt: new Date(), ghlSyncError: err instanceof Error ? err.message : String(err) } });
    await clearRequest();
    throw err;
  }
}

/** Ratings edited in the system → opportunity stage / status + note. Only moves forward in pipeline order. */
async function pushEdits(clientId: string, creds: GhlCreds, pipeline: GhlPipeline, rev: ReverseMap): Promise<number> {
  const links = await db.ghlLink.findMany({ where: { clientId, dirtyAt: { not: null }, opportunityId: { not: null } }, take: 200 });
  if (!links.length) return 0;
  const fbs = await db.salesFeedback.findMany({ where: { clientId, rowKey: { in: links.map((l) => l.rowKey) } } });
  const fbOf = new Map(fbs.map((f) => [f.rowKey, f]));
  const pos = new Map(pipeline.stages.map((s, i) => [s.id, i]));
  let changed = 0;
  for (const l of links) {
    const fb = fbOf.get(l.rowKey);
    const data: { dirtyAt: null; stageId?: string; status?: string; noteSent?: string } = { dirtyAt: null };
    if (fb) {
      const target = reverseTarget(fb, rev);
      if ((target === "won" || target === "lost") && l.status !== target) {
        await setOpportunityStatus(creds, l.opportunityId!, target);
        data.status = target;
      } else if (pos.has(target) && target !== l.stageId && (pos.get(target)! > (pos.get(l.stageId ?? "") ?? -1) || l.status !== "open")) {
        await moveOpportunity(creds, l.opportunityId!, target);
        if (l.status && l.status !== "open") await setOpportunityStatus(creds, l.opportunityId!, "open"); // reopen customers already Won / Lost when sales edits on the web
        data.stageId = target;
        data.status = "open";
      }
      const note = fb.note.trim();
      if (note && note !== (l.noteSent ?? "")) {
        await addNote(creds, l.contactId, `Ghi chú sale (${BRAND.app}): ${note}`);
        data.noteSent = note;
      }
      if (data.stageId || data.status || data.noteSent) changed++;
    }
    await db.ghlLink.update({ where: { id: l.id }, data });
  }
  return changed;
}

/** Contract pipeline: opportunities of pushed customers (matched by contact) Won → Đã chốt (Closed), Lost → Không mua (Didn't buy). */
async function pullDeals(clientId: string, creds: GhlCreds, pipelineId: string): Promise<number> {
  const links = await db.ghlLink.findMany({ where: { clientId } });
  if (!links.length) return 0;
  const byContact = new Map(links.map((l) => [l.contactId, l]));
  let updated = 0;
  for (let page = 1; page <= PULL_PAGES; page++) {
    const opps = await searchOpportunities(creds, { pipelineId, page });
    for (const o of opps) {
      const l = byContact.get(o.contactId);
      if (!l || (l.dealOppId === o.id && l.dealStatus === o.status)) continue;
      const outcome = o.status === "won" ? "Đã chốt" : o.status === "lost" || o.status === "abandoned" ? "Không mua" : null;
      if (outcome) updated += await saveFeedback(clientId, [{ key: l.rowKey, outcome, ...(outcome === "Đã chốt" && { contact: "Được", quality: "Tốt" }) }], "crm", "HighLevel");
      await db.ghlLink.update({ where: { id: l.id }, data: { dealOppId: o.id, dealStatus: o.status } });
    }
    if (opps.length < GHL_PAGE) break;
  }
  return updated;
}

async function pushRows(clientId: string, creds: GhlCreds, c: { ghlSince: Date | null; ghlPipelineId: string | null; ghlStageId: string | null }) {
  const [rows, links, ads] = await Promise.all([
    sheetRows(clientId),
    db.ghlLink.findMany({ where: { clientId }, select: { rowKey: true } }),
    db.ad.findMany({ where: { clientId }, select: { id: true, adSet: { select: { name: true } } } }),
  ]);
  const done = new Set(links.map((l) => l.rowKey));
  const adSetOf = new Map(ads.map((a) => [a.id, a.adSet.name]));
  const since = c.ghlSince?.getTime() ?? 0;
  const todo = rows.filter((r) => r.phones.length && !done.has(r.key) && r.date.getTime() >= since).reverse(); // oldest first
  let pushed = 0;
  for (const r of todo.slice(0, PUSH_MAX)) {
    const contact = await upsertContact(creds, { name: r.name, phone: e164(r.phones[0]), email: r.email, source: BRAND.app });
    const adSet = r.adId ? adSetOf.get(r.adId) : undefined;
    const major = /Ngành con quan tâm: ([^|]+)/.exec(r.need)?.[1]?.trim();
    const tags = ["WZ Ads", r.source === "Form" ? "WZ Form" : "WZ Tin nhắn", r.campaign && `WZ camp: ${trim(r.campaign)}`, adSet && `WZ nhóm: ${trim(adSet)}`, major && `Ngành: ${trim(major, 40)}`].filter(
      (t): t is string => !!t,
    );
    await addTags(creds, contact.id, tags);
    const when = r.date.toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", dateStyle: "short", timeStyle: "short" });
    await addNote(
      creds,
      contact.id,
      [
        `${BRAND.app} · ${r.source} · ${when}`,
        r.campaign && `Chiến dịch: ${r.campaign}`,
        adSet && `Nhóm quảng cáo: ${adSet}`,
        r.ad && `Quảng cáo: ${r.ad}`,
        r.need && `\n${r.need.split(" | ").join("\n")}`,
        r.phones.length > 1 && `SĐT khác: ${r.phones.slice(1).join(", ")}`,
        r.link && `Hội thoại: ${r.link}`,
        `Mã WZ: ${r.key}`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    let opp: { id: string; pipelineStageId: string; status: string } | null = null;
    if (c.ghlPipelineId) {
      // Customer already has an opportunity in the pipeline (old or from another channel): reuse it, no duplicate.
      opp = (await searchOpportunities(creds, { pipelineId: c.ghlPipelineId, contactId: contact.id }))[0] ?? null;
      opp ??= await createOpportunity(creds, { pipelineId: c.ghlPipelineId, stageId: c.ghlStageId, contactId: contact.id, name: trim(`${r.name || "Khách"} · ${r.source}${major ? ` · ${major}` : ""}`, 80) });
    }
    await db.ghlLink.upsert({
      where: { clientId_rowKey: { clientId, rowKey: r.key } },
      create: { clientId, rowKey: r.key, contactId: contact.id, opportunityId: opp?.id ?? null },
      update: { contactId: contact.id, opportunityId: opp?.id ?? null },
    });
    pushed++;
  }
  return { pushed, pending: Math.max(0, todo.length - pushed) };
}

/** Sales rating by stage + status: won = closed, lost / abandoned = didn't buy (status overrides the mapping). */
function feedbackOf(map: StageMap, stageId: string, status: string): StageFeedback {
  const f: StageFeedback = { ...(map[stageId] ?? {}) };
  if (status === "won") f.outcome = "Đã chốt";
  else if (status === "lost" || status === "abandoned") f.outcome = "Không mua";
  return f;
}

async function pullStages(clientId: string, creds: GhlCreds, pipelineId: string, map: StageMap) {
  const links = await db.ghlLink.findMany({ where: { clientId, opportunityId: { not: null } } });
  if (!links.length) return { pulled: 0, updated: 0 };
  const want = new Map(links.map((l) => [l.opportunityId!, l]));
  const seen = new Map<string, { stage: string; status: string }>();
  for (let page = 1; page <= PULL_PAGES && seen.size < want.size; page++) {
    const opps = await searchOpportunities(creds, { pipelineId, page });
    for (const o of opps) if (want.has(o.id)) seen.set(o.id, { stage: o.pipelineStageId, status: o.status });
    if (opps.length < GHL_PAGE) break;
  }
  let updated = 0;
  for (const [oppId, s] of seen) {
    const link = want.get(oppId)!;
    if (link.stageId === s.stage && link.status === s.status) continue;
    const data = Object.fromEntries(Object.entries(feedbackOf(map, s.stage, s.status)).filter(([, v]) => v));
    if (Object.keys(data).length) updated += await saveFeedback(clientId, [{ key: link.rowKey, ...data }], "crm", "HighLevel");
    await db.ghlLink.update({ where: { id: link.id }, data: { stageId: s.stage, status: s.status, pulledAt: new Date() } });
  }
  return { pulled: seen.size, updated };
}
