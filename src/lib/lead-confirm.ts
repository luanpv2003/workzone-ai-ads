import { getT } from "@/i18n/server";
import type { T } from "@/i18n/translate";
import { db } from "./db";
import { clientIp, limiter } from "./throttle";
import { feedbackOptionLabel } from "./highlevel-map";
import { deliver, confirmUrl, groupText, withDuty } from "./lead-notify";
import { dutyAt, parseLeadNotify, qaLine, RECALL_GAP_HOURS } from "./lead-notify-config";
import { renderNotice } from "./notify-templates";
import { globalTemplates } from "./notify-templates-db";
import { DONE_OUTCOMES, FEEDBACK_FIELDS, NO_ANSWER, saveFeedback, type Feedback } from "./lead-sheet";

// Lead confirmation via the /l/<code> link in Zalo / Telegram bot messages (Zalo Bot has no buttons on messages).
// No login needed: anyone with the link (group members) can click; the clicker types their own name (browser remembers it for next time).
// - Claim lead: record the claimer on every notice for the same lead (Lead list row); the bot reports back to the group ("ack" template); first claimer keeps it.
// - Report result: written to the sales rating (SalesFeedback, source "link"), shared with the web and Google Sheet; the bot reports back to the group ("result" template).
// - Reminder: if nobody has claimed or rated after N minutes, remind once, only 7am–9pm customer time (runLeadReminders, background job every minute).
// - Call back: when sales picks "Không nghe máy" (no answer), remind the group to call back after 2 hours, then daily, up to recallMax times (runRecalls).

const CODE_RE = /^[\w-]{6,16}$/;
const LINK_TTL = 30 * 86400_000; // links expire 30 days after the notice was sent (they carry the lead's contact details)
// Unknown / expired codes per client IP (only when the IP is trustworthy, see TRUST_PROXY): slows down guessing.
const BAD_CODES = limiter(30, 15 * 60_000);
const REMIND_WINDOW = 24 * 3600_000; // only remind about leads from the last 24 hours
const REMIND_MAX = 14; // max lines in one reminder message (Zalo max 2000 characters)

const fmtTime = (d: Date, tz: string) => d.toLocaleString("vi-VN", { timeZone: tz, hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
const parseJson = <T,>(s: string, fallback: T): T => {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

type Person = { name: string; phones: string[]; email: string | null; source: "Form" | "Tin nhắn"; ad: string | null; form: string | null; inbox: string | null; at: Date; lines: string[] };

/** Lead info for one Lead list row (F-<lead id> | M-<conversation id>). */
async function personOf(clientId: string, rowKey: string, t: T): Promise<Person | null> {
  const id = rowKey.slice(2);
  if (rowKey.startsWith("F-")) {
    const l = await db.lead.findFirst({ where: { id, clientId } });
    if (!l) return null;
    const answers = parseJson<{ q: string; a: string }[]>(l.answers, []);
    const phones = [...new Set([l.phone, ...parseJson<string[]>(l.phones, [])].filter((x): x is string => !!x))];
    return { name: l.name || t("notify.lead.noName"), phones, email: l.email, source: "Form", ad: l.adName, form: l.formName || l.formId, inbox: null, at: l.createdTime, lines: answers.map((x) => qaLine(x.q, x.a)) };
  }
  const cv = await db.conversation.findFirst({ where: { id, clientId }, include: { messages: { where: { fromCustomer: true }, orderBy: { createdTime: "desc" }, take: 6 } } });
  if (!cv) return null;
  const ad = cv.sourceAdId ? ((await db.ownAd.findFirst({ where: { clientId, id: cv.sourceAdId }, select: { name: true } }))?.name ?? null) : null;
  const phones = [...new Set([cv.phone, ...parseJson<string[]>(cv.phones, [])].filter((x): x is string => !!x))];
  return {
    name: cv.customerName,
    phones,
    email: cv.email,
    source: "Tin nhắn",
    ad: ad ?? (cv.adReply ? t("notify.lead.fromAd") : null),
    form: null,
    inbox: cv.link,
    at: cv.messages.at(-1)?.createdTime ?? cv.updatedTime,
    lines: cv.messages.reverse().map((m) => m.text.slice(0, 300)),
  };
}

const whoOf = (p: Person) => [p.name, p.phones[0]].filter(Boolean).join(" · ");

async function noticeByCode(code: string) {
  // Only throttle per known client IP: a shared bucket would let anyone lock out every valid link.
  const ip = await clientIp();
  const key = ip ? `l|${ip}` : null;
  if (key && BAD_CODES.blocked(key)) return null;
  const n = CODE_RE.test(code)
    ? await db.leadNotice.findFirst({ where: { code, createdAt: { gt: new Date(Date.now() - LINK_TTL) } }, include: { client: { select: { id: true, name: true, timezone: true, leadNotify: true } } } })
    : null;
  if (!n?.rowKey) {
    if (key) BAD_CODES.hit(key);
    return null;
  }
  return { ...n, rowKey: n.rowKey };
}

/** First claimer of this lead (across all notices for the same Lead list row). */
const firstAck = (clientId: string, rowKey: string) =>
  db.leadNotice.findFirst({ where: { clientId, rowKey, ackAt: { not: null } }, orderBy: { ackAt: { sort: "asc", nulls: "first" } }, select: { ackBy: true, ackAt: true } });

/** Data for the /l/<code> page. null = bad link / lead was deleted. */
export async function confirmView(code: string) {
  const n = await noticeByCode(code);
  if (!n) return null;
  const t = await getT();
  const [person, ack, fb] = await Promise.all([
    personOf(n.clientId, n.rowKey, t),
    firstAck(n.clientId, n.rowKey),
    db.salesFeedback.findUnique({ where: { clientId_rowKey: { clientId: n.clientId, rowKey: n.rowKey } } }),
  ]);
  if (!person) return null;
  const feedback: Feedback = { contact: fb?.contact ?? "", quality: fb?.quality ?? "", outcome: fb?.outcome ?? "", note: fb?.note ?? "" };
  return {
    client: n.client.name,
    tz: n.client.timezone,
    person,
    ack: ack?.ackAt ? { by: ack.ackBy ?? "", at: ack.ackAt } : null,
    feedback,
    feedbackBy: fb ? { by: fb.updatedBy ?? "", at: fb.updatedAt } : null,
  };
}

/** Bot reports back to the client's notification groups (send errors are only logged, never block saving). Returns true if sent to at least 1 destination. */
async function postBack(n: NonNullable<Awaited<ReturnType<typeof noticeByCode>>>, key: "ack" | "result", vars: Record<string, string>, t: T) {
  const cfg = parseLeadNotify(n.client.leadNotify);
  if (!cfg.targets.length) return false;
  const text = renderNotice(key, { khach_hang: n.client.name, ...vars }, cfg.templates, await globalTemplates(), t);
  const res = await deliver(cfg.targets, groupText(cfg, text));
  for (const r of res.filter((x) => !x.ok)) console.error(`Reporting back to the group (${key}) failed for ${n.client.name}:`, r.error);
  return res.some((x) => x.ok);
}

const cleanName = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 40);

/** Click "Nhận khách" (claim lead). If someone already claimed it, keep that person (returns already). */
export async function ackLead(code: string, name: string) {
  const t = await getT();
  const n = await noticeByCode(code);
  if (!n) throw new Error(t("notify.confirm.badLink"));
  const by = cleanName(name);
  if (!by) throw new Error(t("notify.confirm.nameToClaim"));
  const at = new Date();
  const prev = await firstAck(n.clientId, n.rowKey);
  if (prev?.ackAt) return { by: prev.ackBy ?? "", at: prev.ackAt, already: true, posted: false };
  // The conditional update is atomic: if 2 people click at once, the second finds no row with ackAt = null.
  const { count } = await db.leadNotice.updateMany({ where: { clientId: n.clientId, rowKey: n.rowKey, ackAt: null }, data: { ackBy: by, ackAt: at } });
  if (!count) {
    const won = await firstAck(n.clientId, n.rowKey);
    return { by: won?.ackBy ?? "", at: won?.ackAt ?? at, already: true, posted: false };
  }
  const person = await personOf(n.clientId, n.rowKey, t);
  await db.activity.create({ data: { clientId: n.clientId, kind: "notify", message: t("notify.confirm.activityClaim", { by, who: person ? whoOf(person) : n.rowKey }), actor: by } });
  const posted = await postBack(n, "ack", { nguoi: by, ten_sdt: person ? whoOf(person) : "", thoi_gian: fmtTime(at, n.client.timezone) }, t);
  return { by, at, already: false, posted };
}


/** Save the call result (written to the sales rating). If nobody claimed yet, the reporter becomes the claimer. */
export async function reportLeadResult(code: string, name: string, patch: Partial<Feedback>) {
  const t = await getT();
  const n = await noticeByCode(code);
  if (!n) throw new Error(t("notify.confirm.badLink"));
  const by = cleanName(name);
  if (!by) throw new Error(t("notify.confirm.nameToSave"));
  const clean: Partial<Feedback> = {};
  for (const f of FEEDBACK_FIELDS) if (typeof patch[f.field] === "string") clean[f.field] = patch[f.field];
  const changed = await saveFeedback(n.clientId, [{ key: n.rowKey, ...clean }], "link", by);
  if (!changed) return { changed: false, posted: false };
  await db.leadNotice.updateMany({ where: { clientId: n.clientId, rowKey: n.rowKey, ackAt: null }, data: { ackBy: by, ackAt: new Date() } });
  const [person, fb] = await Promise.all([personOf(n.clientId, n.rowKey, t), db.salesFeedback.findUnique({ where: { clientId_rowKey: { clientId: n.clientId, rowKey: n.rowKey } } })]);
  const ketQua = fb ? [fb.contact === "Được" ? t("notify.confirm.contactReached") : feedbackOptionLabel(t, fb.contact), feedbackOptionLabel(t, fb.quality), feedbackOptionLabel(t, fb.outcome)].filter(Boolean).join(" · ") : "";
  const posted = await postBack(n, "result", { nguoi: by, ten_sdt: person ? whoOf(person) : "", ket_qua: ketQua || t("notify.confirm.notPicked"), ghi_chu: fb?.note ?? "" }, t);
  return { changed: true, posted };
}

// ------------------------------------------------------------------ Remind when nobody has claimed

const hourIn = (tz: string) => Number(new Date().toLocaleString("en-GB", { timeZone: tz, hour: "2-digit", hour12: false }));

/** Background job, every minute: for each client with leads unclaimed after N minutes, send 1 combined reminder. */
export async function runLeadReminders() {
  const t = await getT();
  const lines: string[] = [];
  const now = Date.now();
  for (const c of await db.client.findMany({ where: { leadNotify: { contains: '"on":true' } }, select: { id: true, name: true, timezone: true, leadNotify: true } })) {
    const cfg = parseLeadNotify(c.leadNotify);
    if (!cfg.on || !cfg.confirm || !cfg.remindMin || !cfg.targets.length) continue;
    const h = hourIn(c.timezone);
    if (h < 7 || h >= 21) continue; // no reminders at night; in the morning, remind about last night's leads
    try {
      const due = await db.leadNotice.findMany({
        where: { clientId: c.id, code: { not: null }, rowKey: { not: null }, ackAt: null, remindedAt: null, createdAt: { lte: new Date(now - cfg.remindMin * 60_000), gte: new Date(now - REMIND_WINDOW) } },
        orderBy: { createdAt: "asc" },
      });
      if (!due.length) continue;
      // Mark as reminded before sending: 2 overlapping runs won't remind twice.
      await db.leadNotice.updateMany({ where: { id: { in: due.map((d) => d.id) }, remindedAt: null }, data: { remindedAt: new Date() } });
      const keys = [...new Set(due.map((d) => d.rowKey!))];
      const [acked, rated] = await Promise.all([
        db.leadNotice.findMany({ where: { clientId: c.id, rowKey: { in: keys }, ackAt: { not: null } }, select: { rowKey: true } }),
        db.salesFeedback.findMany({ where: { clientId: c.id, rowKey: { in: keys } }, select: { rowKey: true, contact: true, quality: true, outcome: true } }),
      ]);
      const done = new Set([...acked.map((x) => x.rowKey), ...rated.filter((f) => f.contact || f.quality || f.outcome).map((f) => f.rowKey)]);
      // One line per lead, linking the most recent notice; skip if every send failed.
      const latest = new Map<string, (typeof due)[number]>();
      for (const d of due) if (!done.has(d.rowKey!) && d.sends.includes('"ok":true')) latest.set(d.rowKey!, d);
      if (!latest.size) continue;
      const rows: string[] = [];
      for (const d of [...latest.values()].slice(0, REMIND_MAX)) {
        const p = await personOf(c.id, d.rowKey!, t);
        if (p) rows.push(`${rows.length + 1}. ${whoOf(p)} (${p.source === "Form" ? t("notify.confirm.sourceForm") : t("notify.confirm.sourceMessage")} ${fmtTime(d.createdAt, c.timezone)}) 👉 ${confirmUrl(d.code!)}`);
      }
      if (!rows.length) continue;
      if (latest.size > REMIND_MAX) rows.push(t("notify.confirm.remindMore", { n: latest.size - REMIND_MAX }));
      const duty = dutyAt(cfg, new Date(), c.timezone);
      const text = withDuty(renderNotice("remind", { khach_hang: c.name, so_lead: latest.size, phut: cfg.remindMin, danh_sach: rows.join("\n"), nguoi_truc: duty }, cfg.templates, await globalTemplates(), t), duty, t("notify.templates.lines.dutyToday"));
      const res = await deliver(cfg.targets, groupText(cfg, text));
      const bad = res.filter((x) => !x.ok);
      lines.push(`${c.name}: reminded about ${latest.size} unclaimed leads${bad.length ? ` (send errors ${bad.length}/${res.length}: ${bad.map((x) => x.error).join("; ")})` : ""}`);
    } catch (err) {
      console.error(`Lead reminder failed for ${c.name}:`, err instanceof Error ? err.message : err);
    }
  }
  return lines;
}

// ------------------------------------------------------------------ Call-back reminders for leads who didn't answer

const RECALL_WINDOW = 10 * 86400_000; // stop once "Không nghe máy" (no answer) was picked more than 10 days ago

/** Background job, every minute: "Không nghe máy" (no answer) leads due for a call-back reminder → 1 combined message per client. Reminder count is kept in SalesFeedback. */
export async function runRecalls() {
  const t = await getT();
  const lines: string[] = [];
  const now = Date.now();
  for (const c of await db.client.findMany({ where: { leadNotify: { contains: '"on":true' } }, select: { id: true, name: true, timezone: true, leadNotify: true } })) {
    const cfg = parseLeadNotify(c.leadNotify);
    if (!cfg.on || !cfg.confirm || !cfg.recallMax || !cfg.targets.length) continue;
    const h = hourIn(c.timezone);
    if (h < 7 || h >= 21) continue;
    try {
      const rows = await db.salesFeedback.findMany({
        where: { clientId: c.id, contact: NO_ANSWER, outcome: { notIn: DONE_OUTCOMES }, recallAt: { gte: new Date(now - RECALL_WINDOW) }, recallCount: { lt: cfg.recallMax } },
        orderBy: { recallAt: { sort: "asc", nulls: "first" } },
      });
      const due = rows.filter((f) => f.recallAt!.getTime() + (RECALL_GAP_HOURS[f.recallCount] ?? 24) * 3600_000 <= now);
      if (!due.length) continue;
      // Link of the most recent notice; leads with no notice in the group (no link) are skipped.
      const notices = await db.leadNotice.findMany({ where: { clientId: c.id, rowKey: { in: due.map((f) => f.rowKey) }, code: { not: null } }, orderBy: { createdAt: "desc" }, select: { rowKey: true, code: true } });
      const codeOf = new Map<string, string>();
      for (const n of notices) if (!codeOf.has(n.rowKey!)) codeOf.set(n.rowKey!, n.code!);
      const out: string[] = [];
      for (const f of due.filter((x) => codeOf.has(x.rowKey)).slice(0, REMIND_MAX)) {
        // Increment the count before sending: 2 overlapping runs won't remind twice (only the run that updated the row sends).
        const { count } = await db.salesFeedback.updateMany({ where: { id: f.id, recallCount: f.recallCount }, data: { recallCount: f.recallCount + 1, recallAt: new Date() } });
        if (!count) continue;
        const p = await personOf(c.id, f.rowKey, t);
        if (!p) continue;
        const n = f.recallCount + 1;
        out.push(`${out.length + 1}. ${t("notify.confirm.recallRow", { who: whoOf(p), n, max: cfg.recallMax, last: n === cfg.recallMax ? t("notify.confirm.lastTime") : "" })} 👉 ${confirmUrl(codeOf.get(f.rowKey)!)}`);
      }
      if (!out.length) continue;
      const duty = dutyAt(cfg, new Date(), c.timezone);
      const text = withDuty(renderNotice("recall", { khach_hang: c.name, so_lead: out.length, danh_sach: out.join("\n"), nguoi_truc: duty }, cfg.templates, await globalTemplates(), t), duty, t("notify.templates.lines.dutyToday"));
      const res = await deliver(cfg.targets, groupText(cfg, text));
      const bad = res.filter((x) => !x.ok);
      lines.push(`${c.name}: call-back reminder for ${out.length} leads${bad.length ? ` (send errors ${bad.length}/${res.length}: ${bad.map((x) => x.error).join("; ")})` : ""}`);
    } catch (err) {
      console.error(`Call-back reminder failed for ${c.name}:`, err instanceof Error ? err.message : err);
    }
  }
  return lines;
}

/** Lead list: who claimed each lead (rowKey → person, time). */
export async function ackedRows(clientId: string, rowKeys: string[]) {
  const rows = await db.leadNotice.findMany({ where: { clientId, rowKey: { in: rowKeys }, ackAt: { not: null } }, orderBy: { ackAt: { sort: "asc", nulls: "first" } }, select: { rowKey: true, ackBy: true, ackAt: true } });
  const out = new Map<string, { by: string; at: Date }>();
  for (const r of rows) if (!out.has(r.rowKey!)) out.set(r.rowKey!, { by: r.ackBy ?? "", at: r.ackAt! });
  return out;
}
