import { currentUser } from "@/lib/auth";
import { visibleClientIds } from "@/lib/access";
import { contactRows, leadRows, type ContactFilter } from "@/lib/contacts";
import { clientPages, pageLabel } from "@/lib/client-pages";
import { industryLabels } from "@/lib/industries";
import { stageLabels } from "@/lib/format";
import { db } from "@/lib/db";
import { getT } from "@/i18n/server";
import { ownAds, sourceKind, sourceOptions } from "@/lib/own-ads";

const csv = (v: unknown) => {
  const s = v == null ? "" : String(v);
  // Neutralize Excel formulas (=, +, -, @) and wrap in double quotes.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};

/** Export customer contacts / form leads (full phone / email) using the current filters. Admins only; logged. */
export async function GET(req: Request) {
  const t = await getT();
  const INDUSTRY_LABEL = industryLabels(t);
  const STAGE_LABEL = stageLabels(t);
  const SOURCE_OPTIONS = sourceOptions(t);
  const industry = (k: string | null) => (k ? (INDUSTRY_LABEL[k] ?? k) : "");
  const user = await currentUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  if (user.role !== "admin") return new Response(t("system.exports.contactsAdminOnly"), { status: 403 });
  const p = new URL(req.url).searchParams;
  const get = (k: string) => p.get(k) ?? undefined;
  const own = await ownAds(get("client"));
  const scope = await visibleClientIds(user); // only clients the exporter can see
  const f: ContactFilter = { src: get("src"), client: get("client"), ind: get("ind"), seg: get("seg"), phone: get("phone"), q: get("q"), own: get("own"), ad: get("ad"), ownIds: [...own.keys()], scope };
  const source = (adId: string | null, adReply = false) => SOURCE_OPTIONS.find((o) => o.key === sourceKind(adId, own, adReply))!.label;
  const isLead = f.src === "lead";

  let head: string[];
  let lines: string[];
  if (isLead) {
    const leads = await leadRows(f, 20000);
    head = [t("system.exports.hName"), t("system.exports.hPhone"), "Email", t("system.exports.hClient"), "Page", t("system.exports.hIndustry"), "Form", t("system.exports.hSource"), "Ad ID", t("system.exports.hAd"), t("system.exports.hCampaign"), t("system.exports.hAnswers"), t("system.exports.hPlatform"), t("system.exports.hFilledOn")];
    lines = leads.map((l) =>
      [
        l.name,
        (JSON.parse(l.phones) as string[]).join(" / "),
        l.email,
        l.client.name,
        pageLabel(clientPages(l.client), l.pageId),
        industry(l.client.industryKey),
        l.formName,
        source(l.adId),
        l.adId,
        l.adName,
        l.campaignName,
        (JSON.parse(l.answers) as { q: string; a: string }[]).map((a) => `${a.q}: ${a.a}`).join(" | "),
        l.platform,
        l.createdTime.toISOString(),
      ]
        .map(csv)
        .join(","),
    );
  } else {
    const rows = await contactRows(f, 20000);
    head = [t("system.exports.hName"), t("system.exports.hPhone"), "Email", t("system.exports.hClient"), "Page", t("system.exports.hIndustry"), t("system.exports.hIntent"), t("system.exports.hTags"), t("system.exports.hStage"), t("system.exports.hLeadScore"), t("system.exports.hNeedsReply"), t("system.exports.hLast"), t("system.exports.hLink"), t("system.exports.hSource"), "Ad ID", t("system.exports.hAd")];
    lines = rows.map((c) =>
      [
        c.customerName,
        (JSON.parse(c.phones) as string[]).join(" / "),
        c.email,
        c.client.name,
        pageLabel(clientPages(c.client), c.pageId),
        industry(c.client.industryKey),
        c.intent,
        c.tags ? (JSON.parse(c.tags) as string[]).join(", ") : "",
        c.stage ? (STAGE_LABEL[c.stage] ?? c.stage) : "",
        c.leadScore,
        c.needsReply ? t("system.exports.yes") : "",
        c.updatedTime.toISOString(),
        c.link,
        source(c.sourceAdId, c.adReply),
        c.sourceAdId,
        c.sourceAdId ? own.get(c.sourceAdId)?.name : "",
      ]
        .map(csv)
        .join(","),
    );
  }

  await db.activity.create({
    data: { clientId: f.client ?? null, kind: "pii", message: t("system.exports.contactsLog", { what: isLead ? t("system.exports.whatLeads") : t("system.exports.whatContacts"), n: lines.length, filter: p.toString() || t("system.exports.all") }), actor: user.name },
  });
  const date = new Date().toISOString().slice(0, 10);
  return new Response(`﻿${[head.map(csv).join(","), ...lines].join("\r\n")}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${isLead ? t("system.exports.leadsFileForm") : t("system.exports.contactsFile")}-${date}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
