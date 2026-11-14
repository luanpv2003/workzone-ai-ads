import Link from "next/link";
import { InboxLink } from "@/components/inbox-link";
import { connection } from "next/server";
import { db } from "@/lib/db";
import { notFound } from "next/navigation";
import { requirePageUser } from "@/lib/auth";
import { visibleClientIds } from "@/lib/access";
import { contactRows, contactWhere, leadRows, leadWhere, SEGMENTS, type ContactFilter } from "@/lib/contacts";
import { clientPages, pageLabel } from "@/lib/client-pages";
import { industryLabels } from "@/lib/industries";
import { maskEmail, maskPhone } from "@/lib/pii";
import { dateTime, num, stageLabels } from "@/lib/format";
import { getT } from "@/i18n/server";
import { BRAND } from "@/lib/brand";
import type { T } from "@/i18n/translate";
import { Badge, Card, Empty, inputClass, btnClass, PageHeader, Stat } from "@/components/ui";
import { RevealContact } from "@/components/reveal-contact";
import { ownAds, sourceKind, sourceOptions, type AdSource, type OwnAdInfo } from "@/lib/own-ads";

export async function generateMetadata() {
  const t = await getT();
  return { title: `${t("customers.contactsPage.title")} · ${BRAND.app}` };
}

const PAGE = 100;
/** Current timestamp (the page renders dynamically on each visit). */
const daysAgo = (d: number) => new Date(Date.now() - d * 86400000);
type SP = ContactFilter & { page?: string };

export default async function ContactsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requirePageUser(); // check the session right on the page: the layout may not re-run on client-side navigation
  await connection();
  const t = await getT();
  const stageLabel = stageLabels(t);
  const sources = sourceOptions(t);
  const sp = await searchParams;
  const scope = await visibleClientIds(user);
  if (sp.client && scope && !scope.includes(sp.client)) notFound();
  const page = Math.max(1, Number(sp.page) || 1);
  const isLead = sp.src === "lead";
  // Our own ads (connected ad accounts), to separate messages / forms brought in by our ads from other agencies' ads.
  const own = await ownAds(sp.client);
  const f: ContactFilter = { ...sp, ownIds: [...own.keys()], scope };
  const where = contactWhere(f);
  const lWhere = leadWhere(f);
  const week = daysAgo(7);
  const [leadTotal, leadContact, leadFromAds, leadWeek, leads, allLeads] = await Promise.all([
    db.lead.count({ where: lWhere }),
    db.lead.count({ where: { AND: [lWhere, { OR: [{ phone: { not: null } }, { email: { not: null } }] }] } }),
    db.lead.count({ where: { AND: [lWhere, { adId: { not: null } }] } }),
    db.lead.count({ where: { AND: [lWhere, { createdTime: { gt: week } }] } }),
    isLead ? leadRows(f, PAGE, (page - 1) * PAGE) : Promise.resolve([]),
    db.lead.findMany({ where: leadWhere({ ...f, ind: undefined }), select: { phone: true, email: true, client: { select: { industryKey: true } } } }),
  ]);
  const [clients, total, withContact, hot, reply, rows, all] = await Promise.all([
    db.client.findMany({ where: { ...(scope && { id: { in: scope } }), OR: [{ conversations: { some: {} } }, { leads: { some: {} } }] }, select: { id: true, name: true, industryKey: true }, orderBy: { name: "asc" } }),
    db.conversation.count({ where }),
    db.conversation.count({ where: { AND: [where, { OR: [{ phone: { not: null } }, { email: { not: null } }] }] } }),
    db.conversation.count({ where: { AND: [where, { leadScore: { gte: 75 } }] } }),
    db.conversation.count({ where: { AND: [where, { needsReply: true }] } }),
    isLead ? Promise.resolve([]) : contactRows(f, PAGE, (page - 1) * PAGE),
    // Industry-aggregated table: counts only, no personal information.
    db.conversation.findMany({ where: contactWhere({ ...f, ind: undefined }), select: { leadScore: true, phone: true, email: true, tags: true, client: { select: { industryKey: true } } } }),
  ]);
  const qs = (patch: Partial<SP>) => {
    const p = new URLSearchParams(Object.entries({ ...sp, page: undefined, ...patch }).filter(([, v]) => v) as [string, string][]);
    return `?${p}`;
  };
  const exportQs = new URLSearchParams(Object.entries({ ...sp, page: undefined }).filter(([, v]) => v) as [string, string][]);

  const byIndustry = new Map<string, { n: number; contact: number; hot: number; tags: Map<string, number>; leads: number; leadContact: number }>();
  const group = (k: string) => byIndustry.get(k) ?? byIndustry.set(k, { n: 0, contact: 0, hot: 0, tags: new Map(), leads: 0, leadContact: 0 }).get(k)!;
  for (const l of allLeads) {
    const g = group(l.client.industryKey ?? "");
    g.leads++;
    if (l.phone || l.email) g.leadContact++;
  }
  for (const c of all) {
    const k = c.client.industryKey ?? "";
    const g = group(k);
    g.n++;
    if (c.phone || c.email) g.contact++;
    if ((c.leadScore ?? 0) >= 75) g.hot++;
    for (const tag of c.tags ? (JSON.parse(c.tags) as string[]) : []) g.tags.set(tag, (g.tags.get(tag) ?? 0) + 1);
  }
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");
  const bySource = sp.client ? await sourceBreakdown(sp.client, own, t) : null;
  const byClient = sp.client ? null : await clientSourceSummary(own, scope, t);
  const srcLabel = (adId: string | null) => (!adId ? null : own.has(adId) ? { own: true, text: own.get(adId)!.name || adId } : { own: false, text: adId });
  const convSrc = (c: { sourceAdId: string | null; adReply: boolean }) => srcLabel(c.sourceAdId) ?? (c.adReply ? { own: null, text: "" } : null);

  return (
    <>
      <PageHeader title={t("customers.contactsPage.title")} subtitle={t("customers.contactsPage.subtitle")} />
      <div className="mb-4 flex gap-1 border-b border-slate-200">
        {[
          { key: undefined, label: t("customers.contactsPage.tab.messages", { n: num(total) }) },
          { key: "lead", label: t("customers.contactsPage.tab.leads", { n: num(leadTotal) }) },
        ].map((tab) => (
          <Link key={tab.label} href={qs({ src: tab.key, seg: undefined })} className={`-mb-px border-b-2 px-3 py-2 text-sm ${isLead === (tab.key === "lead") ? "border-indigo-600 font-medium text-indigo-700" : "border-transparent text-slate-500 hover:text-slate-800"}`}>
            {tab.label}
          </Link>
        ))}
      </div>
      {isLead ? (
        <div className="mb-6 grid gap-3 @xl:grid-cols-2 @4xl:grid-cols-4">
          <Stat label={t("customers.contactsPage.stat.leadForm")} value={num(leadTotal)} hint={t("customers.contactsPage.stat.leadFormHint")} />
          <Stat label={t("customers.contactsPage.stat.contact")} value={num(leadContact)} hint={pct(leadContact, leadTotal)} />
          <Stat label={t("customers.contactsPage.stat.knownAd")} value={num(leadFromAds)} hint={pct(leadFromAds, leadTotal)} />
          <Stat label={t("customers.contactsPage.stat.last7")} value={num(leadWeek)} />
        </div>
      ) : (
        <div className="mb-6 grid gap-3 @xl:grid-cols-2 @4xl:grid-cols-4">
          <Stat label={t("customers.contactsPage.stat.people")} value={num(total)} hint={t("customers.contactsPage.stat.clients", { n: clients.length })} />
          <Stat label={t("customers.contactsPage.stat.contact")} value={num(withContact)} hint={pct(withContact, total)} />
          <Stat label={t("customers.contactsPage.stat.hot")} value={num(hot)} tone={hot ? "good" : undefined} />
          <Stat label={t("customers.contactsPage.stat.reply")} value={num(reply)} tone={reply ? "bad" : undefined} />
        </div>
      )}

      <Card title={t("customers.contactsPage.industry.title")} className="mb-6">
        {!byIndustry.size ? (
          <Empty>{t("customers.contactsPage.industry.empty")}</Empty>
        ) : (
          <div className="-mx-5 -my-5 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-4 py-2 font-medium">{t("customers.contactsPage.industry.col")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("customers.contactsPage.industry.people")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("customers.contactsPage.industry.contact")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("customers.contactsPage.industry.hot")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("customers.contactsPage.industry.leadForm")}</th>
                  <th className="px-3 py-2 font-medium">{t("customers.contactsPage.industry.asks")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {[...byIndustry.entries()].sort((a, b) => b[1].n - a[1].n).map(([k, g]) => (
                  <tr key={k || "none"}>
                    <td className="px-4 py-2">
                      <Link href={qs({ ind: k || undefined })} className="font-medium text-slate-900 hover:underline">{k ? (industryLabels(t)[k] ?? k) : t("customers.contactsPage.industry.none")}</Link>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{num(g.n)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{pct(g.contact, g.n)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{pct(g.hot, g.n)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{num(g.leads)}{g.leads > 0 && <span className="text-slate-400"> · {t("customers.contactsPage.industry.withPhone", { p: pct(g.leadContact, g.leads) })}</span>}</td>
                    <td className="px-3 py-2 text-xs text-slate-600">
                      {[...g.tags.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([tag, n]) => `${tag} (${n})`).join(" · ") || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {byClient && (
        <Card title={t("customers.contactsPage.byClient.title")} action={<span className="text-xs text-slate-500">{t("customers.contactsPage.byClient.action")}</span>} className="mb-6">
          <div className="-mx-5 -my-5 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  <th rowSpan={2} className="min-w-44 px-4 py-2 font-medium">{t("customers.contactsPage.byClient.client")}</th>
                  <th colSpan={5} className="border-l border-slate-200 px-3 pt-2 text-center font-medium">{t("customers.contactsPage.byClient.messages")}</th>
                  <th colSpan={3} className="border-l border-slate-200 px-3 pt-2 text-center font-medium">{t("customers.contactsPage.byClient.leadForm")}</th>
                </tr>
                <tr>
                  <th className="border-l border-slate-200 px-3 py-1 text-right font-medium text-emerald-700">{t("customers.ownAds.wz.label")}</th>
                  <th className="px-3 py-1 text-right font-medium text-amber-700">{t("customers.contactsPage.byClient.otherShort")}</th>
                  <th className="px-3 py-1 text-right font-medium" title={t("customers.contactsPage.byClient.adTitle")}>{t("customers.ownAds.ad.label")}</th>
                  <th className="px-3 py-1 text-right font-medium">{t("customers.contactsPage.byClient.unknownShort")}</th>
                  <th className="px-3 py-1 text-right font-medium">{t("customers.contactsPage.byClient.wzPhone")}</th>
                  <th className="border-l border-slate-200 px-3 py-1 text-right font-medium text-emerald-700">{t("customers.ownAds.wz.label")}</th>
                  <th className="px-3 py-1 text-right font-medium text-amber-700">{t("customers.contactsPage.byClient.otherShort")}</th>
                  <th className="px-3 py-1 text-right font-medium">{t("customers.contactsPage.byClient.organic")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {byClient.map((r) => {
                  const cell = (n: number, own?: string) => (n ? <Link href={qs({ client: r.id || undefined, own, page: undefined, src: undefined })} className="hover:underline">{num(n)}</Link> : <span className="text-slate-300">0</span>);
                  const lcell = (n: number, own?: string) => (n ? <Link href={qs({ client: r.id || undefined, own, page: undefined, src: "lead" })} className="hover:underline">{num(n)}</Link> : <span className="text-slate-300">0</span>);
                  return (
                    <tr key={r.id || "all"} className={r.id ? "hover:bg-slate-50" : "bg-slate-50 font-medium"}>
                      <td className="px-4 py-2">{r.id ? <Link href={qs({ client: r.id, page: undefined })} className="font-medium text-slate-900 hover:underline">{r.name}</Link> : r.name}</td>
                      <td className="border-l border-slate-100 px-3 py-2 text-right tabular-nums">{cell(r.wz.conv, "wz")}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{cell(r.other.conv, "other")}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{cell(r.ad.conv, "ad")}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{cell(r.none.conv, "none")}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-600">{r.wz.conv ? pct(r.wz.convContact, r.wz.conv) : "—"}</td>
                      <td className="border-l border-slate-100 px-3 py-2 text-right tabular-nums">{lcell(r.wz.leads, "wz")}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{lcell(r.other.leads, "other")}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{lcell(r.none.leads, "none")}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-6 text-xs text-slate-500">{t("customers.contactsPage.byClient.note")}</p>
        </Card>
      )}

      {bySource && (
        <Card title={t("customers.contactsPage.bySource.title")} action={<span className="text-xs text-slate-500">{t("customers.contactsPage.bySource.action")}</span>} className="mb-6">
          <div className="-mx-5 -my-5 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  <th className="min-w-56 px-4 py-2 font-medium">{t("customers.contactsPage.bySource.source")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("customers.contactsPage.bySource.messages")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("customers.contactsPage.bySource.contact")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("customers.contactsPage.bySource.hot")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("customers.contactsPage.bySource.leadForm")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("customers.contactsPage.bySource.formPhone")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {bySource.groups.map((g) => (
                  <SourceRow key={g.key} href={qs({ own: g.key, ad: undefined, page: undefined })} label={<span className="font-medium text-slate-900">{g.label}</span>} hint={g.hint} r={g} pct={pct} active={sp.own === g.key && !sp.ad} />
                ))}
                {bySource.ads.map((a) => (
                  <SourceRow key={a.id} href={qs({ ad: a.id, own: undefined, page: undefined })} label={<span className="pl-4 text-slate-700">{a.name || a.id}</span>} hint={a.campaignName ? `${a.campaignName} · ${a.id}` : a.id} r={a} pct={pct} active={sp.ad === a.id} />
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-6 text-xs text-slate-500">{t("customers.contactsPage.bySource.note")}</p>
        </Card>
      )}

      <form className="mb-4 flex flex-wrap items-end gap-2">
        {isLead && <input type="hidden" name="src" value="lead" />}
        <input name="q" defaultValue={sp.q} placeholder={t("customers.contactsPage.filter.q")} className={`${inputClass} w-64`} />
        <select name="client" defaultValue={sp.client ?? ""} className={`${inputClass} w-auto`}>
          <option value="">{t("customers.contactsPage.filter.allClients")}</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select name="ind" defaultValue={sp.ind ?? ""} className={`${inputClass} w-auto`}>
          <option value="">{t("customers.contactsPage.filter.allIndustries")}</option>
          {[...new Set(clients.map((c) => c.industryKey).filter(Boolean))].map((k) => <option key={k} value={k!}>{industryLabels(t)[k!] ?? k}</option>)}
        </select>
        {!isLead && (
          <select name="seg" defaultValue={sp.seg ?? ""} className={`${inputClass} w-auto`}>
            <option value="">{t("customers.contactsPage.filter.allSegments")}</option>
            {SEGMENTS.map((s) => <option key={s.key} value={s.key}>{t(s.labelKey)}</option>)}
          </select>
        )}
        <select name="own" defaultValue={sp.own ?? ""} className={`${inputClass} w-auto`} title={t("customers.contactsPage.filter.ownTitle")}>
          <option value="">{t("customers.ownAds.all")}</option>
          {sources.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
        <input name="ad" defaultValue={sp.ad} placeholder={t("customers.contactsPage.filter.adIds")} className={`${inputClass} w-64`} />
        <label className="flex items-center gap-1.5 text-sm text-slate-700">
          <input type="checkbox" name="phone" value="1" defaultChecked={sp.phone === "1"} className="accent-indigo-600" />{t("customers.contactsPage.filter.phoneOnly")}
        </label>
        <button className={btnClass("secondary")}>{t("customers.contactsPage.filter.apply")}</button>
        {user?.role === "admin" && (
          <a href={`/api/contacts/export?${exportQs}`} className={`${btnClass("ghost")} ml-auto`}>{t("customers.contactsPage.export", { n: num(isLead ? leadTotal : total) })}</a>
        )}
      </form>

      {isLead ? (
        !leads.length ? (
          <Empty>{t("customers.contactsPage.leads.empty")}</Empty>
        ) : (
          <Card>
            <div className="-mx-5 -my-5 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs text-slate-500">
                  <tr>
                    <th className="min-w-44 px-4 py-2 font-medium">{t("customers.contactsPage.leads.name")}</th>
                    <th className="px-3 py-2 font-medium">{t("customers.contactsPage.leads.contact")}</th>
                    <th className="min-w-44 px-3 py-2 font-medium">{t("customers.contactsPage.leads.clientPage")}</th>
                    <th className="min-w-56 px-3 py-2 font-medium">{t("customers.contactsPage.leads.formAd")}</th>
                    <th className="min-w-64 px-3 py-2 font-medium">{t("customers.contactsPage.leads.answers")}</th>
                    <th className="px-3 py-2 font-medium whitespace-nowrap">{t("customers.contactsPage.leads.filledAt")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {leads.map((l) => {
                    const answers = JSON.parse(l.answers) as { q: string; a: string }[];
                    return (
                      <tr key={l.id} className="align-top hover:bg-slate-50">
                        <td className="px-4 py-2.5 font-medium text-slate-900">
                          {l.name}
                          {l.platform && <div className="text-[11px] font-normal text-slate-400">{l.platform === "ig" ? "Instagram" : "Facebook"}</div>}
                        </td>
                        <td className="px-3 py-2.5">
                          <RevealContact kind="lead" id={l.id} phone={l.phone ? maskPhone(l.phone) : null} email={l.email ? maskEmail(l.email) : null} more={(JSON.parse(l.phones) as string[]).length - 1} />
                        </td>
                        <td className="px-3 py-2.5 text-xs">
                          <Link href={`/clients/${l.clientId}`} className="font-medium text-slate-800 hover:underline">{l.client.name}</Link>
                          <div className="text-slate-500">
                            {pageLabel(clientPages(l.client), l.pageId)}
                            {l.client.industryKey && ` · ${industryLabels(t)[l.client.industryKey] ?? l.client.industryKey}`}
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-xs text-slate-700">
                          <div>{l.formName}</div>
                          {l.adName && <div className="text-slate-500">{t("customers.contactsPage.leads.adPrefix", { name: l.adName })}{l.campaignName && ` · ${l.campaignName}`}</div>}
                          <SourceBadge t={t} src={l.adId ? { own: own.has(l.adId), text: "" } : null} />
                        </td>
                        <td className="px-3 py-2.5 text-xs text-slate-600">
                          {answers.slice(0, 5).map((a) => (
                            <div key={a.q} className="truncate" title={`${a.q}: ${a.a}`}>
                              <span className="text-slate-400">{a.q}:</span> {/^https?:\/\//.test(a.a) ? <a href={a.a} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">{t("customers.contactsPage.leads.open")}</a> : a.a}
                            </div>
                          ))}
                        </td>
                        <td className="px-3 py-2.5 text-xs whitespace-nowrap text-slate-500">{dateTime(l.createdTime)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )
      ) : !rows.length ? (
        <Empty>{t("customers.contactsPage.conv.empty")}</Empty>
      ) : (
        <Card>
          <div className="-mx-5 -my-5 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  <th className="min-w-44 px-4 py-2 font-medium">{t("customers.contactsPage.leads.name")}</th>
                  <th className="px-3 py-2 font-medium">{t("customers.contactsPage.leads.contact")}</th>
                  <th className="min-w-44 px-3 py-2 font-medium">{t("customers.contactsPage.leads.clientPage")}</th>
                  <th className="min-w-56 px-3 py-2 font-medium">{t("customers.contactsPage.conv.need")}</th>
                  <th className="px-3 py-2 font-medium">{t("customers.contactsPage.conv.stage")}</th>
                  <th className="px-3 py-2 font-medium whitespace-nowrap">{t("customers.contactsPage.conv.last")}</th>
                  <th className="px-3 py-2 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((c) => {
                  const pages = clientPages(c.client);
                  const phones = (JSON.parse(c.phones) as string[]).length; // count only, don't send full numbers to the browser
                  return (
                    <tr key={c.id} className="align-top hover:bg-slate-50">
                      <td className="px-4 py-2.5 font-medium text-slate-900">
                        {c.customerName}
                        <SourceBadge t={t} src={convSrc(c)} />
                      </td>
                      <td className="px-3 py-2.5">
                        <RevealContact id={c.id} phone={c.phone ? maskPhone(c.phone) : null} email={c.email ? maskEmail(c.email) : null} more={phones - 1} />
                      </td>
                      <td className="px-3 py-2.5 text-xs">
                        <Link href={`/clients/${c.clientId}`} className="font-medium text-slate-800 hover:underline">{c.client.name}</Link>
                        <div className="text-slate-500">
                          {pageLabel(pages, c.pageId)}
                          {c.client.industryKey && ` · ${industryLabels(t)[c.client.industryKey] ?? c.client.industryKey}`}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-xs text-slate-700">
                        {c.intent ?? <span className="text-slate-400">{t("customers.contactsPage.conv.notAnalyzed")}</span>}
                        {c.tags && (JSON.parse(c.tags) as string[]).length > 0 && (
                          <div className="mt-0.5 text-slate-400">{(JSON.parse(c.tags) as string[]).slice(0, 4).join(" · ")}</div>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex flex-wrap gap-1">
                          {c.stage && <Badge tone={c.stage === "ready_to_buy" || c.stage === "purchased" ? "green" : c.stage === "spam" || c.stage === "lost" ? "red" : "gray"}>{stageLabel[c.stage] ?? c.stage}</Badge>}
                          {c.leadScore != null && <Badge tone={c.leadScore >= 75 ? "green" : c.leadScore >= 50 ? "amber" : "gray"}>{t("customers.contactsPage.conv.lead", { n: c.leadScore })}</Badge>}
                          {c.needsReply && <Badge tone="red">{t("customers.contactsPage.conv.needsReply")}</Badge>}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-xs whitespace-nowrap text-slate-500">{dateTime(c.updatedTime)}</td>
                      <td className="px-3 py-2.5 text-xs whitespace-nowrap">
                        <Link href={`/clients/${c.clientId}/messages?c=${c.id}`} className="text-indigo-600 hover:underline">{t("customers.contactsPage.conv.view")}</Link>
                        {c.link && (
                          <div>
                            <InboxLink href={c.link} name={c.customerName} className="text-slate-500 hover:underline">{t("customers.contactsPage.conv.openInbox")}</InboxLink>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {(isLead ? leadTotal : total) > PAGE && (
        <div className="mt-4 flex items-center justify-center gap-3 text-sm">
          {page > 1 && <Link href={qs({ page: String(page - 1) })} className="text-indigo-600 hover:underline">{t("customers.contactsPage.pager.prev")}</Link>}
          <span className="text-slate-500">{t("customers.contactsPage.pager.page", { page, pages: Math.ceil((isLead ? leadTotal : total) / PAGE) })}</span>
          {page * PAGE < (isLead ? leadTotal : total) && <Link href={qs({ page: String(page + 1) })} className="text-indigo-600 hover:underline">{t("customers.contactsPage.pager.next")}</Link>}
        </div>
      )}
    </>
  );
}

type SourceCounts = { conv: number; convContact: number; hot: number; leads: number; leadContact: number };

/** Count messages / forms by source ad for one client: total per source group (own-ads.ts) + each of our own ads. */
async function sourceBreakdown(clientId: string, own: Map<string, OwnAdInfo>, t: T) {
  const sourceOpts = sourceOptions(t);
  const contact = { OR: [{ phone: { not: null } }, { email: { not: null } }] };
  const [conv, convContact, hot, leads, leadContact] = await Promise.all([
    db.conversation.groupBy({ by: ["sourceAdId", "adReply"], where: { clientId }, _count: true }),
    db.conversation.groupBy({ by: ["sourceAdId", "adReply"], where: { clientId, ...contact }, _count: true }),
    db.conversation.groupBy({ by: ["sourceAdId", "adReply"], where: { clientId, leadScore: { gte: 75 } }, _count: true }),
    db.lead.groupBy({ by: ["adId"], where: { clientId }, _count: true }),
    db.lead.groupBy({ by: ["adId"], where: { clientId, ...contact }, _count: true }),
  ]);
  const empty = (): SourceCounts => ({ conv: 0, convContact: 0, hot: 0, leads: 0, leadContact: 0 });
  // Key: ad ID, or "#ad" / "#none" for conversations without an ad ID (with / without the "replied to an ad" message).
  const perAd = new Map<string, SourceCounts>();
  const at = (id: string | null, adReply = false) => {
    const key = id ?? (adReply ? "#ad" : "#none");
    return perAd.get(key) ?? perAd.set(key, empty()).get(key)!;
  };
  for (const r of conv) at(r.sourceAdId, r.adReply).conv += r._count;
  for (const r of convContact) at(r.sourceAdId, r.adReply).convContact += r._count;
  for (const r of hot) at(r.sourceAdId, r.adReply).hot += r._count;
  for (const r of leads) at(r.adId).leads += r._count;
  for (const r of leadContact) at(r.adId).leadContact += r._count;

  const groups = Object.fromEntries(sourceOpts.map((o) => [o.key, { ...o, ...empty(), ads: 0 }]));
  const ads: (OwnAdInfo & SourceCounts)[] = [];
  for (const [key, n] of perAd) {
    const id = key.startsWith("#") ? null : key;
    const g = groups[sourceKind(id, own, key === "#ad")];
    for (const k of Object.keys(n) as (keyof SourceCounts)[]) g[k] += n[k];
    if (id) g.ads++;
    if (id && own.has(id)) ads.push({ ...own.get(id)!, ...n });
  }
  ads.sort((a, b) => b.conv + b.leads - (a.conv + a.leads));
  return {
    groups: sourceOpts.map((o) => {
      const g = groups[o.key];
      return { ...g, hint: o.key === "wz" || o.key === "other" ? t("customers.contactsPage.bySource.hint", { n: g.ads, hint: o.hint }) : o.hint };
    }),
    ads,
  };
}

/** System-wide: one row per client, messages / forms split by our ads · others' ads · unknown (first row is the total). */
async function clientSourceSummary(own: Map<string, OwnAdInfo>, scope: string[] | null, t: T) {
  const contact = { OR: [{ phone: { not: null } }, { email: { not: null } }] };
  const mine = scope ? { clientId: { in: scope } } : {};
  const [clients, conv, convContact, leads] = await Promise.all([
    db.client.findMany({ where: { ...(scope && { id: { in: scope } }), OR: [{ conversations: { some: {} } }, { leads: { some: {} } }] }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    db.conversation.groupBy({ by: ["clientId", "sourceAdId", "adReply"], where: mine, _count: true }),
    db.conversation.groupBy({ by: ["clientId", "sourceAdId", "adReply"], where: { ...mine, ...contact }, _count: true }),
    db.lead.groupBy({ by: ["clientId", "adId"], where: mine, _count: true }),
  ]);
  const empty = () => ({ conv: 0, convContact: 0, leads: 0 });
  const row = (id: string, name: string): { id: string; name: string } & Record<AdSource, ReturnType<typeof empty>> => ({ id, name, wz: empty(), other: empty(), ad: empty(), none: empty() });
  const total = row("", t("customers.contactsPage.byClient.total"));
  const rows = new Map(clients.map((c) => [c.id, row(c.id, c.name)]));
  const add = (clientId: string, adId: string | null, adReply: boolean, k: "conv" | "convContact" | "leads", n: number) => {
    for (const r of [rows.get(clientId), total]) if (r) r[sourceKind(adId, own, adReply)][k] += n;
  };
  for (const r of conv) add(r.clientId, r.sourceAdId, r.adReply, "conv", r._count);
  for (const r of convContact) add(r.clientId, r.sourceAdId, r.adReply, "convContact", r._count);
  for (const r of leads) add(r.clientId, r.adId, false, "leads", r._count);
  return [total, ...rows.values()];
}

function SourceRow({ href, label, hint, r, pct, active }: { href: string; label: React.ReactNode; hint: string; r: SourceCounts; pct: (a: number, b: number) => string; active: boolean }) {
  return (
    <tr className={active ? "bg-indigo-50" : "hover:bg-slate-50"}>
      <td className="px-4 py-2">
        <Link href={href} className="hover:underline">{label}</Link>
        <div className="text-[11px] text-slate-400">{hint}</div>
      </td>
      <td className="px-3 py-2 text-right tabular-nums">{num(r.conv)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{r.conv ? `${num(r.convContact)} · ${pct(r.convContact, r.conv)}` : "—"}</td>
      <td className="px-3 py-2 text-right tabular-nums">{r.conv ? num(r.hot) : "—"}</td>
      <td className="px-3 py-2 text-right tabular-nums">{num(r.leads)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{r.leads ? `${num(r.leadContact)} · ${pct(r.leadContact, r.leads)}` : "—"}</td>
    </tr>
  );
}

/** own: true = our ads, false = other parties' ads, null = from an ad but the ad is unknown. */
function SourceBadge({ src, t }: { src: { own: boolean | null; text: string } | null; t: T }) {
  if (!src) return null;
  return (
    <div className="mt-0.5 text-[11px] font-normal">
      <span className={src.own ? "text-emerald-700" : src.own === false ? "text-amber-700" : "text-slate-500"}>{t(src.own ? "customers.ownAds.wz.label" : src.own === false ? "customers.ownAds.other.label" : "customers.ownAds.ad.label")}</span>
      {src.text && <span className="text-slate-400"> · {src.text}</span>}
    </div>
  );
}
