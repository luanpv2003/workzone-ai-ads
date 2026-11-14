"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";
import { AlertTriangle, Check, ClipboardCopy, ExternalLink, ImageIcon, Link2, Loader2, Newspaper, PenLine, ShieldCheck, Sparkles, Trash2, Video } from "lucide-react";
import { Badge, btnClass, Card, inputClass, type Tone } from "../ui";
import { AutoRefresh } from "../targeting/controls";
import { money, resultLabels } from "@/lib/format";
import type { ContentItem, PlanVersion, ReviewBrief } from "@/lib/content-review";
import type { PolicyCheck } from "@/lib/ai/schemas";
import type { AdReview, PagePost } from "@/lib/meta/types";
import { listPostsAction } from "@/app/actions";
import { useT } from "@/i18n/client";
import type { MessageKey, T } from "@/i18n/translate";
import {
  addLinksAction,
  addManualAction,
  addPostsAction,
  adStatusAction,
  finalizeAction,
  manualDraftAction,
  removeItemAction,
  startCheckAction,
  startPlanAction,
} from "@/app/content-review-actions";

type Props = {
  clientId: string;
  review: { id: string; title: string; status: string; error: string | null; chosen: number | null; draftId: string | null };
  items: ContentItem[];
  policy: PolicyCheck | null;
  plans: PlanVersion[];
  brief: ReviewBrief;
  currency: string;
  isMeta: boolean;
  pages: { id: string; name: string }[];
  draft: { status: string; name: string } | null;
};

const VERDICT: Record<string, { label: MessageKey; tone: Tone }> = {
  safe: { label: "targeting.crv.verdict.safe", tone: "good" },
  fix: { label: "targeting.crv.verdict.fix", tone: "warn" },
  reject: { label: "targeting.crv.verdict.reject", tone: "bad" },
};
const SEVERITY: Record<string, { label: MessageKey; cls: string }> = {
  high: { label: "targeting.crv.severity.high", cls: "border-rose-200 bg-rose-50" },
  medium: { label: "targeting.crv.severity.medium", cls: "border-amber-200 bg-amber-50" },
  low: { label: "targeting.crv.severity.low", cls: "border-line bg-soft" },
};
const SPECIAL: Record<string, MessageKey> = {
  credit: "targeting.crv.special.credit",
  employment: "targeting.crv.special.employment",
  housing: "targeting.crv.special.housing",
  social_issues: "targeting.crv.special.social_issues",
  financial_products: "targeting.crv.special.financial_products",
};
const KIND: Record<string, MessageKey> = {
  photo: "targeting.crv.kind.photo",
  album: "targeting.crv.kind.album",
  video: "targeting.crv.kind.video",
  text: "targeting.crv.kind.text",
  link: "targeting.crv.kind.link",
};
const USE: Record<string, { label: MessageKey; tone: Tone }> = {
  existing: { label: "targeting.crv.use.existing", tone: "good" },
  new_fixed: { label: "targeting.crv.use.new_fixed", tone: "info" },
  skip: { label: "targeting.crv.use.skip", tone: "mut" },
};
const GOALS = ["messages", "leads", "engagement", "link_clicks", "purchases", "reach", "video_views", "profile_visits", "page_likes"] as const;
const goalLabel = (t: T, g: string) => (g === "page_likes" ? t("targeting.crv.goal.page_likes") : (resultLabels(t)[g] ?? g));

/** Call the action, show errors; ok → refresh the page. */
function useAct() {
  const t = useT();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const act = <T extends { ok: boolean; error?: string }>(fn: () => Promise<T>, then?: (r: T) => void) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) return setError(r.error ?? t("targeting.crv.error"));
      then?.(r);
      router.refresh();
    });
  return { pending, error, act, setError };
}

function Err({ text }: { text: string | null }) {
  return text ? <p className="mt-2 text-sm text-rose-700">{text}</p> : null;
}

function Steps({ status, hasItems, hasPolicy, hasPlan, final }: { status: string; hasItems: boolean; hasPolicy: boolean; hasPlan: boolean; final: boolean }) {
  const t = useT();
  const steps = [
    { label: t("targeting.crv.step.content"), done: hasItems },
    { label: t("targeting.crv.step.policy"), done: hasPolicy, busy: status === "checking" },
    { label: t("targeting.crv.step.plan"), done: hasPlan, busy: status === "planning" },
    { label: t("targeting.crv.step.setup"), done: final },
  ];
  return (
    <ol className="flex flex-wrap gap-2 text-xs">
      {steps.map((s, i) => (
        <li key={s.label} className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-3 font-medium ${s.done ? "border-emerald-200 bg-emerald-50 text-emerald-700" : s.busy ? "border-violet-200 bg-violet-50 text-violet-700" : "border-line text-mut"}`}>
          {s.busy ? <Loader2 className="size-3.5 animate-spin" /> : s.done ? <Check className="size-3.5" /> : <span className="tabular-nums">{i + 1}</span>}
          {s.label}
        </li>
      ))}
    </ol>
  );
}

// ------------------------------------------------------------ 1. Content

function Thumb({ it }: { it: ContentItem }) {
  const t = useT();
  const src = it.images[0]?.url ?? it.frames[0]?.url;
  return (
    <div className="relative grid size-20 shrink-0 place-items-center overflow-hidden rounded-lg bg-soft text-mut">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {src ? <img src={src} alt="" className="size-full object-cover" /> : <Newspaper className="size-6" />}
      {it.kind === "video" && <Video className="absolute right-1 bottom-1 size-4 rounded bg-black/60 p-0.5 text-white" />}
      {it.images.length > 1 && <span className="absolute right-1 bottom-1 rounded bg-black/60 px-1 text-[10px] text-white">{t("targeting.crv.photosCount", { n: it.images.length })}</span>}
    </div>
  );
}

function ItemCard({ it, index, reviewId, locked }: { it: ContentItem; index: number; reviewId: string; locked: boolean }) {
  const t = useT();
  const { pending, error, act } = useAct();
  const [open, setOpen] = useState(false);
  return (
    <li className="flex gap-3 py-3">
      <Thumb it={it} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-semibold text-ink">{t("targeting.crv.contentN", { n: index + 1 })}</span>
          <Badge tone="mut">{KIND[it.kind] ? t(KIND[it.kind]) : it.kind}</Badge>
          <Badge tone={it.source === "post" ? "pri" : "mut"}>{it.source === "post" ? t("targeting.crv.onPage") : t("targeting.crv.unpublished")}</Badge>
          {it.eligible === false && <Badge tone="bad">{t("targeting.crv.notEligible")}</Badge>}
          {it.videoSeconds != null && <span className="text-xs text-mut">{t("targeting.crv.seconds", { n: Math.round(it.videoSeconds) })}</span>}
        </div>
        <p className={`mt-1 text-sm whitespace-pre-line text-ink2 ${open ? "" : "line-clamp-2"}`}>{it.message || <span className="text-mut">{t("targeting.crv.noText")}</span>}</p>
        <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-mut">
          {it.message.length > 120 && (
            <button type="button" className="text-indigo-700" onClick={() => setOpen(!open)}>
              {open ? t("targeting.crv.collapse") : t("targeting.crv.expand")}
            </button>
          )}
          {it.stats && (
            <span>
              {t("targeting.crv.stats", { reactions: it.stats.reactions ?? "?", comments: it.stats.comments ?? "?", shares: it.stats.shares ?? 0 })}
            </span>
          )}
          {it.permalink && (
            <a href={it.permalink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-indigo-700">
              {t("targeting.crv.openPost")} <ExternalLink className="size-3" />
            </a>
          )}
          {it.frames.length > 0 && <span>{t("targeting.crv.frames", { n: it.frames.length })}</span>}
        </div>
        <Err text={error} />
      </div>
      {!locked && (
        <button type="button" disabled={pending} title={t("targeting.crv.removeItem")} className="self-start rounded-md p-1.5 text-mut hover:bg-hover hover:text-rose-700" onClick={() => act(() => removeItemAction(reviewId, it.id))}>
          <Trash2 className="size-4" />
        </button>
      )}
    </li>
  );
}

/** Extract a few frames from the video right in the browser (the server doesn't need to process video). */
async function videoFrames(file: File, unreadable: string, n = 4): Promise<{ frames: Blob[]; seconds: number }> {
  const url = URL.createObjectURL(file);
  const v = document.createElement("video");
  v.muted = true;
  v.preload = "auto";
  v.src = url;
  await new Promise<void>((ok, fail) => {
    v.onloadedmetadata = () => ok();
    v.onerror = () => fail(new Error(unreadable));
  });
  const seconds = v.duration;
  const canvas = document.createElement("canvas");
  const scale = Math.min(1, 960 / (v.videoWidth || 960));
  canvas.width = Math.round((v.videoWidth || 960) * scale);
  canvas.height = Math.round((v.videoHeight || 540) * scale);
  const frames: Blob[] = [];
  for (let i = 0; i < n; i++) {
    v.currentTime = Math.min(seconds - 0.05, (seconds * (i + 0.5)) / n);
    await new Promise<void>((ok) => (v.onseeked = () => ok()));
    canvas.getContext("2d")!.drawImage(v, 0, 0, canvas.width, canvas.height);
    const b = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/jpeg", 0.85));
    if (b) frames.push(b);
  }
  URL.revokeObjectURL(url);
  return { frames, seconds };
}

function AddContent({ reviewId, clientId, isMeta, pages }: { reviewId: string; clientId: string; isMeta: boolean; pages: { id: string; name: string }[] }) {
  const t = useT();
  const [tab, setTab] = useState<"link" | "page" | "manual">(isMeta ? "link" : "manual");
  const { pending, error, act, setError } = useAct();
  const [links, setLinks] = useState("");
  const [failed, setFailed] = useState<{ link: string; error: string }[]>([]);
  const [posts, setPosts] = useState<PagePost[] | null>(null);
  const [pageId, setPageId] = useState(pages[0]?.id ?? "");
  const [picked, setPicked] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [video, setVideo] = useState<File | null>(null);
  const [loadingPosts, startPosts] = useTransition();

  const loadPosts = (pid: string) =>
    startPosts(async () => {
      const r = await listPostsAction(clientId, pid || null);
      if (r.ok) setPosts(r.posts);
      else setError(r.error);
    });

  const tabs: { key: typeof tab; label: string; icon: ReactNode; off?: boolean }[] = [
    { key: "link", label: t("targeting.crv.tabLink"), icon: <Link2 className="size-4" />, off: !isMeta },
    { key: "page", label: t("targeting.crv.tabPage"), icon: <Newspaper className="size-4" />, off: !isMeta },
    { key: "manual", label: t("targeting.crv.tabManual"), icon: <PenLine className="size-4" /> },
  ];
  return (
    <div className="rounded-xl border border-dashed border-line p-4">
      <div className="mb-3 flex flex-wrap gap-1.5">
        {tabs.map((tb) => (
          <button
            key={tb.key}
            type="button"
            disabled={tb.off}
            title={tb.off ? t("targeting.crv.notConnected") : undefined}
            onClick={() => {
              setTab(tb.key);
              if (tb.key === "page" && !posts) loadPosts(pageId);
            }}
            className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm disabled:opacity-40 ${tab === tb.key ? "bg-ink text-panel" : "text-ink2 hover:bg-hover"}`}
          >
            {tb.icon} {tb.label}
          </button>
        ))}
      </div>

      {tab === "link" && (
        <div className="space-y-2">
          <textarea className={`${inputClass} h-24 py-2`} placeholder={t("targeting.crv.linksPlaceholder")} value={links} onChange={(e) => setLinks(e.target.value)} />
          <button
            type="button"
            className={btnClass("primary")}
            disabled={pending || !links.trim()}
            onClick={() =>
              act(
                () => addLinksAction(reviewId, links),
                (r) => {
                  const f = "failed" in r ? (r.failed as { link: string; error: string }[]) : [];
                  setFailed(f);
                  setLinks(f.map((x) => x.link).join("\n"));
                },
              )
            }
          >
            {pending ? t("targeting.crv.readingPost") : t("targeting.crv.add")}
          </button>
          {failed.length > 0 && (
            <ul className="space-y-1 text-xs text-rose-700">
              {failed.map((f) => (
                <li key={f.link}>
                  <span className="break-all">{f.link}</span>: {f.error}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {tab === "page" && (
        <div className="space-y-2">
          {pages.length > 1 && (
            <select
              className={inputClass}
              value={pageId}
              onChange={(e) => {
                setPageId(e.target.value);
                setPicked([]);
                loadPosts(e.target.value);
              }}
            >
              {pages.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          {loadingPosts && <p className="text-sm text-mut">{t("targeting.crv.loadingPosts")}</p>}
          {posts && (
            <ul className="max-h-80 divide-y divide-line overflow-y-auto rounded-lg border border-line">
              {posts.map((p) => (
                <li key={p.id}>
                  <label className={`flex cursor-pointer gap-3 p-2 hover:bg-hover ${!p.eligible ? "opacity-50" : ""}`}>
                    <input type="checkbox" className="mt-1" checked={picked.includes(p.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, p.id] : picked.filter((x) => x !== p.id))} />
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {p.picture ? <img src={p.picture} alt="" className="size-12 shrink-0 rounded object-cover" /> : <span className="grid size-12 shrink-0 place-items-center rounded bg-soft text-mut"><ImageIcon className="size-4" /></span>}
                    <span className="min-w-0 text-sm">
                      <span className="line-clamp-2 text-ink2">{p.message || t("targeting.crv.noText")}</span>
                      <span className="text-xs text-mut">
                        {new Date(p.created).toLocaleDateString("vi-VN")}
                        {!p.eligible && ` · ${t("targeting.crv.notEligible")}`}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <button type="button" className={btnClass("primary")} disabled={pending || !picked.length} onClick={() => act(() => addPostsAction(reviewId, picked), () => setPicked([]))}>
            {pending ? t("targeting.crv.readingShort") : t("targeting.crv.addPosts", { n: picked.length || "" })}
          </button>
        </div>
      )}

      {tab === "manual" && (
        <div className="space-y-2">
          <textarea className={`${inputClass} h-32 py-2`} placeholder={t("targeting.crv.pastePlaceholder")} value={message} onChange={(e) => setMessage(e.target.value)} />
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2">
              <ImageIcon className="size-4 text-mut" /> {t("targeting.crv.images")}
              <input type="file" accept="image/jpeg,image/png,image/webp" multiple className="text-xs" onChange={(e) => setFiles([...(e.target.files ?? [])].slice(0, 10))} />
            </label>
            <label className="flex items-center gap-2">
              <Video className="size-4 text-mut" /> {t("targeting.crv.videoLabel")}
              <input type="file" accept="video/*" className="text-xs" onChange={(e) => setVideo(e.target.files?.[0] ?? null)} />
            </label>
          </div>
          {video && <p className="text-xs text-mut">{t("targeting.crv.videoNote")}</p>}
          <button
            type="button"
            className={btnClass("primary")}
            disabled={pending || (!message.trim() && !files.length && !video)}
            onClick={() =>
              act(
                async () => {
                  const fd = new FormData();
                  fd.set("message", message);
                  for (const f of files) fd.append("images", f);
                  if (video) {
                    const v = await videoFrames(video, t("targeting.crv.videoUnreadable")).catch((e: Error) => e);
                    if (v instanceof Error) return { ok: false as const, error: v.message };
                    v.frames.forEach((b, i) => fd.append("frames", new File([b], `frame${i}.jpg`, { type: "image/jpeg" })));
                    fd.set("videoSeconds", String(v.seconds));
                  }
                  return addManualAction(reviewId, fd);
                },
                () => {
                  setMessage("");
                  setFiles([]);
                  setVideo(null);
                },
              )
            }
          >
            {pending ? t("targeting.crv.uploading") : t("targeting.crv.addContent")}
          </button>
        </div>
      )}
      <Err text={error} />
    </div>
  );
}

// ------------------------------------------------------------ 2. Policy

function CopyButton({ text }: { text: string }) {
  const t = useT();
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 text-xs text-indigo-700"
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? <Check className="size-3.5" /> : <ClipboardCopy className="size-3.5" />} {done ? t("targeting.crv.copied") : t("targeting.crv.copy")}
    </button>
  );
}

function PolicyResult({ policy, items }: { policy: PolicyCheck; items: ContentItem[] }) {
  const t = useT();
  return (
    <div className="space-y-4">
      <p className="text-sm text-ink2">{policy.overall}</p>
      {policy.items.map((x) => {
        const v = VERDICT[x.verdict];
        const it = items[x.index];
        return (
          <div key={x.index} className="rounded-xl border border-line p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-ink">{t("targeting.crv.contentN", { n: x.index + 1 })}</span>
              <Badge tone={v.tone}>{t(v.label)}</Badge>
              {x.special_category !== "none" && <Badge tone="meta">{t("targeting.crv.specialLine", { name: SPECIAL[x.special_category] ? t(SPECIAL[x.special_category]) : x.special_category })}</Badge>}
              {it?.eligible === false && <Badge tone="bad">{t("targeting.crv.notEligible")}</Badge>}
            </div>
            <p className="mt-1.5 text-sm text-ink2">{x.summary}</p>
            {x.issues.length > 0 && (
              <ul className="mt-3 space-y-2">
                {x.issues.map((i, k) => (
                  <li key={k} className={`rounded-lg border p-3 text-sm ${SEVERITY[i.severity].cls}`}>
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-semibold text-ink">{t(SEVERITY[i.severity].label)}</span>
                      <span className="text-mut">{i.policy}</span>
                    </div>
                    <p className="mt-1 text-ink">&ldquo;{i.quote}&rdquo;</p>
                    <p className="mt-1 text-ink2">{i.explain}</p>
                    <p className="mt-1 text-emerald-800">→ {i.fix}</p>
                  </li>
                ))}
              </ul>
            )}
            {x.rewrite && (
              <div className="mt-3 rounded-lg bg-soft p-3">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs font-semibold text-ink">{t("targeting.crv.revised")}</span>
                  <CopyButton text={`${x.rewrite.primary_text}${x.rewrite.headline ? `\n\n${x.rewrite.headline}` : ""}`} />
                </div>
                <p className="text-sm whitespace-pre-line text-ink2">{x.rewrite.primary_text}</p>
                {x.rewrite.headline && <p className="mt-1 text-sm font-medium text-ink">{t("targeting.crv.headline", { text: x.rewrite.headline })}</p>}
              </div>
            )}
            {x.creative_notes && <p className="mt-2 text-xs text-mut">{t("targeting.crv.creativeNotes", { text: x.creative_notes })}</p>}
          </div>
        );
      })}
      <p className="text-xs text-mut">{t("targeting.crv.disclaimer")}</p>
    </div>
  );
}

// ------------------------------------------------------------ 3. Options

function BriefFields({ brief, setBrief, currency }: { brief: ReviewBrief; setBrief: (b: ReviewBrief) => void; currency: string }) {
  const t = useT();
  const f = (k: keyof ReviewBrief, v: unknown) => setBrief({ ...brief, [k]: v });
  return (
    <div className="grid gap-3 @xl:grid-cols-2">
      <label className="text-sm">
        <span className="mb-1 block text-xs font-medium text-mut">{t("targeting.crv.brief.goal")}</span>
        <select className={inputClass} value={brief.goal} onChange={(e) => f("goal", e.target.value)}>
          {GOALS.map((g) => (
            <option key={g} value={g}>
              {goalLabel(t, g)}
            </option>
          ))}
        </select>
      </label>
      <label className="text-sm">
        <span className="mb-1 block text-xs font-medium text-mut">{t("targeting.crv.brief.budget", { currency })}</span>
        <input type="number" min={10000} step={10000} className={inputClass} value={brief.dailyBudget} onChange={(e) => f("dailyBudget", Number(e.target.value))} />
      </label>
      <label className="text-sm">
        <span className="mb-1 block text-xs font-medium text-mut">{t("targeting.crv.brief.area")}</span>
        <input className={inputClass} placeholder={t("targeting.crv.brief.areaPh")} value={brief.locations} onChange={(e) => f("locations", e.target.value)} />
      </label>
      <div className="grid grid-cols-2 gap-2 text-sm">
        <label>
          <span className="mb-1 block text-xs font-medium text-mut">{t("targeting.crv.brief.ageFrom")}</span>
          <input type="number" min={18} max={65} className={inputClass} value={brief.ageMin} onChange={(e) => f("ageMin", Number(e.target.value))} />
        </label>
        <label>
          <span className="mb-1 block text-xs font-medium text-mut">{t("targeting.crv.brief.ageTo")}</span>
          <input type="number" min={18} max={65} className={inputClass} value={brief.ageMax} onChange={(e) => f("ageMax", Number(e.target.value))} />
        </label>
      </div>
      <label className="text-sm">
        <span className="mb-1 block text-xs font-medium text-mut">{t("targeting.crv.brief.landing")}</span>
        <input className={inputClass} value={brief.landingUrl ?? ""} onChange={(e) => f("landingUrl", e.target.value || undefined)} />
      </label>
      <label className="text-sm">
        <span className="mb-1 block text-xs font-medium text-mut">{t("targeting.crv.brief.extra")}</span>
        <input className={inputClass} placeholder={t("targeting.crv.brief.extraPh")} value={brief.notes ?? ""} onChange={(e) => f("notes", e.target.value || undefined)} />
      </label>
    </div>
  );
}

function PlanView({ v, currency }: { v: PlanVersion; currency: string }) {
  const t = useT();
  const p = v.data.plan;
  const total = p.budget_mode === "CBO" ? (p.campaign_daily_budget ?? 0) : p.ad_sets.reduce((a, s) => a + (s.daily_budget ?? 0), 0);
  return (
    <div className="space-y-4 text-sm">
      {v.feedback && (
        <p className="rounded-lg bg-soft p-3 text-ink2">
          <span className="font-medium text-ink">{t("targeting.crv.plan.yourFeedback")}</span> {v.feedback}
        </p>
      )}
      {v.data.changes && (
        <p className="text-ink2">
          <span className="font-medium text-ink">{t("targeting.crv.plan.changed")}</span> {v.data.changes}
        </p>
      )}
      <p className="text-ink">{v.data.summary}</p>
      <div className="flex flex-wrap gap-2 text-xs">
        <Badge tone="pri">{p.campaign_name}</Badge>
        <Badge tone="mut">{goalLabel(t, p.result_type)}</Badge>
        <Badge tone="mut">
          {p.budget_mode === "CBO" ? t("targeting.crv.plan.campaignBudget") : t("targeting.crv.plan.adSetBudget")} · {t("targeting.crv.plan.perDay", { budget: money(total, currency) })}
        </Badge>
        {p.kpi_target_cpr != null && <Badge tone="mut">{t("targeting.crv.plan.targetCpr", { v: money(p.kpi_target_cpr, currency) })}</Badge>}
      </div>

      <div>
        <p className="mb-1.5 text-xs font-semibold tracking-wide text-mut uppercase">{t("targeting.crv.plan.howUse")}</p>
        <ul className="space-y-1">
          {v.data.content_use.map((u) => (
            <li key={u.index} className="flex flex-wrap items-baseline gap-2">
              <span className="font-medium text-ink">{t("targeting.crv.contentN", { n: u.index + 1 })}</span>
              <Badge tone={USE[u.use].tone}>{t(USE[u.use].label)}</Badge>
              <span className="text-ink2">{u.reason}</span>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <p className="mb-1.5 text-xs font-semibold tracking-wide text-mut uppercase">{t("targeting.crv.plan.adSets", { n: p.ad_sets.length })}</p>
        <div className="grid gap-2 @3xl:grid-cols-2">
          {p.ad_sets.map((s, i) => (
            <div key={i} className="rounded-lg border border-line p-3">
              <p className="font-medium text-ink">{s.name}</p>
              <p className="mt-1 text-xs text-mut">
                {s.daily_budget ? `${t("targeting.crv.plan.perDay", { budget: money(s.daily_budget, currency) })} · ` : ""}
                {t("targeting.crv.plan.ageYears", { min: s.age_min, max: s.age_max, gender: t(s.genders === "all" ? "targeting.crv.plan.all" : s.genders === "male" ? "targeting.crv.plan.male" : "targeting.crv.plan.female") })}
              </p>
              <p className="mt-1 text-xs text-ink2">📍 {[...s.locations.map((l) => l.name), ...s.custom_locations.map((c) => `${c.label} +${c.radius_km}km`)].join(", ") || t("targeting.crv.plan.vn")}</p>
              <p className="mt-1 text-xs text-ink2">🎯 {s.detailed_targeting.length ? s.detailed_targeting.map((d) => d.name).join(" · ") : s.advantage_audience ? t("targeting.crv.plan.advantage") : t("targeting.crv.plan.broad")}</p>
              <p className="mt-1 text-xs text-mut">{s.hypothesis}</p>
            </div>
          ))}
        </div>
      </div>

      <div>
        <p className="mb-1.5 text-xs font-semibold tracking-wide text-mut uppercase">{t("targeting.crv.plan.ads", { n: p.ads.length })}</p>
        <ul className="space-y-2">
          {p.ads.map((a, i) => (
            <li key={i} className="rounded-lg border border-line p-3">
              <p className="text-xs text-mut">
                {t("targeting.crv.plan.adLine", { adSet: p.ad_sets[a.ad_set_index]?.name ?? "?", n: a.content_index + 1, cta: a.call_to_action })}
              </p>
              <p className="mt-1 font-medium text-ink">{a.name}</p>
              <p className="mt-1 line-clamp-3 text-xs whitespace-pre-line text-ink2">{a.primary_text}</p>
            </li>
          ))}
        </ul>
      </div>

      <p className="text-ink2">
        <span className="font-medium text-ink">{t("targeting.crv.plan.strategy")}</span> {p.strategy}
      </p>
      <p className="text-ink2">
        <span className="font-medium text-ink">{t("targeting.crv.plan.testing")}</span> {p.testing_plan}
      </p>
      {p.risks.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-ink2">
          {p.risks.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}
      {(v.data.plan_notes?.length ?? 0) > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-mut">
          {v.data.plan_notes!.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
      {v.data.questions.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p className="mb-1 text-xs font-semibold text-amber-800">{t("targeting.crv.plan.confirm")}</p>
          <ul className="list-disc space-y-0.5 pl-5 text-ink2">
            {v.data.questions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------ 4. Setup

const AD_STATUS: Record<string, { label: MessageKey; tone: Tone }> = {
  ACTIVE: { label: "targeting.crv.adStatus.ACTIVE", tone: "good" },
  PAUSED: { label: "targeting.crv.adStatus.PAUSED", tone: "good" },
  PENDING_REVIEW: { label: "targeting.crv.adStatus.PENDING_REVIEW", tone: "warn" },
  IN_PROCESS: { label: "targeting.crv.adStatus.IN_PROCESS", tone: "warn" },
  DISAPPROVED: { label: "targeting.crv.adStatus.DISAPPROVED", tone: "bad" },
  WITH_ISSUES: { label: "targeting.crv.adStatus.WITH_ISSUES", tone: "bad" },
  PREAPPROVED: { label: "targeting.crv.adStatus.PREAPPROVED", tone: "good" },
  CAMPAIGN_PAUSED: { label: "targeting.crv.adStatus.CAMPAIGN_PAUSED", tone: "mut" },
  ADSET_PAUSED: { label: "targeting.crv.adStatus.ADSET_PAUSED", tone: "mut" },
};

function AdStatus({ reviewId }: { reviewId: string }) {
  const t = useT();
  const [ads, setAds] = useState<AdReview[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="mt-3">
      <button
        type="button"
        className={btnClass("secondary")}
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await adStatusAction(reviewId);
            if (!r.ok) return setError(r.error);
            setError(r.error ?? null);
            setAds(r.ads);
          })
        }
      >
        <ShieldCheck className="size-4" /> {pending ? t("targeting.crv.adStatusUi.asking") : t("targeting.crv.adStatusUi.view")}
      </button>
      {ads && (
        <ul className="mt-3 space-y-2 text-sm">
          {ads.map((a) => {
            const st = AD_STATUS[a.status];
            const s = { label: st ? t(st.label) : a.status, tone: st ? st.tone : ("mut" as Tone) };
            return (
              <li key={a.id} className="rounded-lg border border-line p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-ink">{a.name}</span>
                  <Badge tone={s.tone}>{s.label}</Badge>
                </div>
                {a.feedback.length > 0 && (
                  <ul className="mt-1 list-disc pl-5 text-xs text-rose-700">
                    {a.feedback.map((f, i) => (
                      <li key={i}>{f}</li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
          {!ads.length && <li className="text-mut">{t("targeting.crv.adStatusUi.noAds")}</li>}
        </ul>
      )}
      <Err text={error} />
    </div>
  );
}

// ------------------------------------------------------------

export function ContentReviewView(p: Props) {
  const t = useT();
  const { review, items, policy, plans } = p;
  const router = useRouter();
  const busy = review.status === "checking" || review.status === "planning";
  const final = !!p.draft;
  const [brief, setBrief] = useState<ReviewBrief>(p.brief);
  const [feedback, setFeedback] = useState("");
  const [shown, setShown] = useState<number | null>(null);
  const cur = shown ?? plans.length - 1;
  const check = useAct();
  const plan = useAct();
  const fin = useAct();
  const base = `/clients/${p.clientId}`;

  return (
    <div className="space-y-6">
      <AutoRefresh active={busy} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <Link href={`${base}/content`} className="text-xs text-mut hover:text-ink">
            {t("targeting.crv.view.back")}
          </Link>
          <h2 className="text-lg font-semibold text-ink">{review.title}</h2>
        </div>
        <Steps status={review.status} hasItems={items.length > 0} hasPolicy={!!policy} hasPlan={plans.length > 0} final={final} />
      </div>
      {review.error && (
        <p className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {review.error}
        </p>
      )}

      <Card title={t("targeting.crv.view.c1", { n: items.length })}>
        {items.length > 0 && (
          <ul className="mb-4 divide-y divide-line">
            {items.map((it, i) => (
              <ItemCard key={it.id} it={it} index={i} reviewId={review.id} locked={busy || final} />
            ))}
          </ul>
        )}
        {!final && !busy && <AddContent reviewId={review.id} clientId={p.clientId} isMeta={p.isMeta} pages={p.pages} />}
      </Card>

      <Card
        title={t("targeting.crv.view.c2")}
        action={
          items.length > 0 &&
          !final && (
            <button type="button" className={btnClass(policy ? "secondary" : "ai")} disabled={busy || check.pending} onClick={() => check.act(() => startCheckAction(review.id))}>
              <Sparkles className="size-4" /> {review.status === "checking" ? t("targeting.crv.view.checking") : policy ? t("targeting.crv.view.recheck") : t("targeting.crv.view.check")}
            </button>
          )
        }
      >
        {review.status === "checking" ? (
          <p className="flex items-center gap-2 text-sm text-violet-700">
            <Loader2 className="size-4 animate-spin" /> {t("targeting.crv.view.checkingNote")}
          </p>
        ) : policy ? (
          <PolicyResult policy={policy} items={items} />
        ) : (
          <p className="text-sm text-mut">{items.length ? t("targeting.crv.view.checkHint") : t("targeting.crv.view.addFirst")}</p>
        )}
        <Err text={check.error} />
      </Card>

      <Card title={t("targeting.crv.view.c3")}>
        {!policy ? (
          <p className="text-sm text-mut">{t("targeting.crv.view.needPolicy")}</p>
        ) : (
          <div className="space-y-5">
            {!final && (
              <details open={!plans.length} className="rounded-xl border border-line p-4">
                <summary className="cursor-pointer text-sm font-medium text-ink">{t("targeting.crv.view.briefTitle")}</summary>
                <div className="mt-3">
                  <BriefFields brief={brief} setBrief={setBrief} currency={p.currency} />
                  {!plans.length && (
                    <button type="button" className={`${btnClass("ai")} mt-3`} disabled={busy || plan.pending} onClick={() => plan.act(() => startPlanAction(review.id, brief, null))}>
                      <Sparkles className="size-4" /> {review.status === "planning" ? t("targeting.crv.view.drafting") : t("targeting.crv.view.draftBtn")}
                    </button>
                  )}
                </div>
              </details>
            )}
            {review.status === "planning" && (
              <p className="flex items-center gap-2 text-sm text-violet-700">
                <Loader2 className="size-4 animate-spin" /> {t("targeting.crv.view.planningNote")}
              </p>
            )}
            {plans.length > 0 && (
              <>
                <div className="flex flex-wrap gap-1.5">
                  {plans.map((_, i) => (
                    <button key={i} type="button" onClick={() => setShown(i)} className={`h-7 rounded-full px-3 text-xs font-medium ${i === cur ? "bg-ink text-panel" : "border border-line text-ink2 hover:bg-hover"}`}>
                      {t("targeting.crv.view.version", { n: i + 1 })}
                      {review.chosen === i ? t("targeting.crv.view.chosen") : ""}
                    </button>
                  ))}
                </div>
                <PlanView v={plans[cur]} currency={p.currency} />
                {!final && (
                  <div className="space-y-2 rounded-xl border border-line p-4">
                    <label className="block text-sm font-medium text-ink">{t("targeting.crv.view.feedbackLabel")}</label>
                    <textarea
                      className={`${inputClass} h-24 py-2`}
                      placeholder={t("targeting.crv.view.feedbackPh")}
                      value={feedback}
                      onChange={(e) => setFeedback(e.target.value)}
                    />
                    <div className="flex flex-wrap gap-2">
                      <button type="button" className={btnClass("ai")} disabled={busy || plan.pending || !feedback.trim()} onClick={() => plan.act(() => startPlanAction(review.id, brief, feedback), () => (setFeedback(""), setShown(null)))}>
                        <Sparkles className="size-4" /> {t("targeting.crv.view.revise")}
                      </button>
                      <button
                        type="button"
                        className={btnClass("primary")}
                        disabled={busy || fin.pending}
                        onClick={() => fin.act(() => finalizeAction(review.id, cur), (r) => "draftId" in r && router.push(`${base}/drafts/${r.draftId}`))}
                      >
                        <Check className="size-4" /> {fin.pending ? t("targeting.crv.view.creatingDraft") : t("targeting.crv.view.finalize", { n: cur + 1 })}
                      </button>
                    </div>
                    <p className="text-xs text-mut">{t("targeting.crv.view.finalizeNote")}</p>
                  </div>
                )}
              </>
            )}
            <Err text={plan.error ?? fin.error} />
          </div>
        )}
      </Card>

      <Card title={t("targeting.crv.view.c4")}>
        {p.draft && review.draftId ? (
          <div className="text-sm">
            <p className="text-ink2">
              {t("targeting.crv.view.draftLine", { name: "\u0001" }).split("\u0001").flatMap((part, i) => (i ? [<span key="n" className="font-medium text-ink">{p.draft!.name}</span>, part] : [part]))}{" "}
              {p.draft.status === "published" ? <Badge tone="good">{t("targeting.crv.view.published")}</Badge> : <Badge tone="warn">{t("targeting.crv.view.notPublished")}</Badge>}
            </p>
            <Link href={`${base}/drafts/${review.draftId}`} className={`${btnClass("primary")} mt-3`}>
              {p.draft.status === "published" ? t("targeting.crv.view.viewDraft") : t("targeting.crv.view.openDraft")}
            </Link>
            {p.draft.status === "published" && p.isMeta && <AdStatus reviewId={review.id} />}
          </div>
        ) : (
          <div className="text-sm text-mut">
            <p>{t("targeting.crv.view.finalizeFirst")}</p>
            {items.length > 0 && (
              <button type="button" className={`${btnClass("secondary")} mt-3`} disabled={busy || fin.pending} onClick={() => fin.act(() => manualDraftAction(review.id), (r) => "draftId" in r && router.push(`${base}/drafts/${r.draftId}`))}>
                <PenLine className="size-4" /> {t("targeting.crv.view.manual")}
              </button>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
