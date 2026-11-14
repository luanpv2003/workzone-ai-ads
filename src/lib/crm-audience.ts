import { db } from "./db";
import { getT } from "@/i18n/server";
import { forEachContact, ghlCreds, GHL_PAGE, searchOpportunities } from "./highlevel";
import { normalizePhone } from "./meta/audiences";

// Meta audiences from HighLevel CRM: filter contacts by tag / pipeline, merge in Meta lead forms already in the system,
// return normalized phone numbers + emails to create a Custom Audience (lib/meta/audiences.ts hashes with SHA-256 before sending).
// By default drop unverified imported lists / contacts collected elsewhere: Meta only accepts people who consented to the business using their info.

export const DEFAULT_EXCLUDE_TAGS = ["unverified-import", "confessions", "tung-amser", "tung-cva", "forbes-subscribers"];

export type CrmAudienceFilter = {
  excludeTags: string[]; // drop contacts whose tag CONTAINS any of these strings (case-insensitive)
  includeTags: string[]; // empty = all contacts; set = only contacts with a tag containing one of these strings
  pipelineIds: string[]; // empty = no filter; set = only contacts with an opportunity in these pipelines
  addLeadForms: boolean; // merge the client's Meta lead forms already synced into the system
};

export type CrmAudienceCounts = { scanned: number; kept: number; excluded: number; leadForms: number; phones: number; emails: number; topTags: [string, number][] };

const EMAIL_OK = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const norm = (s: string) => s.trim().toLowerCase();

export async function collectCrmContacts(clientId: string, f: CrmAudienceFilter): Promise<CrmAudienceCounts & { phoneSet: Set<string>; emailSet: Set<string> }> {
  const c = await db.client.findUniqueOrThrow({ where: { id: clientId } });
  const creds = ghlCreds(c);
  if (!creds) throw new Error((await getT())("customers.crmAudience.notConnected"));
  const ex = f.excludeTags.map(norm).filter(Boolean);
  const inc = f.includeTags.map(norm).filter(Boolean);
  let inPipe: Set<string> | null = null;
  if (f.pipelineIds.length) {
    inPipe = new Set();
    for (const pipelineId of f.pipelineIds) {
      for (let page = 1; page <= 200; page++) {
        const opps = await searchOpportunities(creds, { pipelineId, page });
        for (const o of opps) if (o.contactId) inPipe.add(o.contactId);
        if (opps.length < GHL_PAGE) break;
      }
    }
  }
  const phoneSet = new Set<string>();
  const emailSet = new Set<string>();
  const tagCount = new Map<string, number>();
  let kept = 0;
  let excluded = 0;
  const scanned = await forEachContact(creds, (batch) => {
    for (const x of batch) {
      const tags = x.tags.map(norm);
      if (tags.some((t) => ex.some((e) => t.includes(e)))) {
        excluded++;
        continue;
      }
      if (inc.length && !tags.some((t) => inc.some((i) => t.includes(i)))) continue;
      if (inPipe && !inPipe.has(x.id)) continue;
      let any = false;
      for (const p of x.phones) {
        const n = normalizePhone(p);
        if (n) {
          phoneSet.add(n);
          any = true;
        }
      }
      for (const e of x.emails) {
        const n = norm(e);
        if (EMAIL_OK.test(n)) {
          emailSet.add(n);
          any = true;
        }
      }
      if (!any) continue;
      kept++;
      for (const t of tags) tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
    }
  });
  let leadForms = 0;
  if (f.addLeadForms) {
    const leads = await db.lead.findMany({ where: { clientId }, select: { phones: true, email: true, answers: true } });
    for (const l of leads) {
      if (l.answers.includes("<test lead")) continue;
      const before = phoneSet.size + emailSet.size;
      for (const p of JSON.parse(l.phones) as string[]) {
        const n = normalizePhone(p);
        if (n) phoneSet.add(n);
      }
      if (l.email && EMAIL_OK.test(norm(l.email))) emailSet.add(norm(l.email));
      if (phoneSet.size + emailSet.size > before) leadForms++;
    }
  }
  return {
    scanned,
    kept,
    excluded,
    leadForms,
    phones: phoneSet.size,
    emails: emailSet.size,
    topTags: [...tagCount].sort((a, b) => b[1] - a[1]).slice(0, 15),
    phoneSet,
    emailSet,
  };
}
