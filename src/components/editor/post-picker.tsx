"use client";

import { useMemo, useState, useTransition } from "react";
import { listPostsAction } from "@/app/actions";
import type { PagePost } from "@/lib/meta/types";
import { norm } from "@/lib/text";
import { dateOnly } from "@/lib/format";
import { btnClass, inputClass } from "../ui";
import { Spinner } from "../action-button";
import { useT } from "@/i18n/client";
import type { T } from "@/i18n/translate";

type PostPreview = { message: string; picture: string | null; permalink: string; type: string; created: string };

const TYPE_KEYS = {
  added_photos: "campaigns.postPicker.type.added_photos",
  added_video: "campaigns.postPicker.type.added_video",
  shared_story: "campaigns.postPicker.type.shared_story",
  mobile_status_update: "campaigns.postPicker.type.mobile_status_update",
} as const;
const typeLabel = (t: T, type: string) => (type in TYPE_KEYS ? t(TYPE_KEYS[type as keyof typeof TYPE_KEYS]) : type);

function PostThumb({ picture, type }: { picture: string | null; type: string }) {
  return picture ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={picture} alt="" className="size-16 shrink-0 rounded-md bg-slate-100 object-cover" />
  ) : (
    <div className="grid size-16 shrink-0 place-items-center rounded-md bg-slate-100 text-xl">{/video/.test(type) ? "🎬" : "🖼"}</div>
  );
}

/** Pick an existing post on the Page (like "Sử dụng bài viết có sẵn" (Use existing post) in Ads Manager). */
export function PostPicker({
  clientId,
  pageId,
  postId,
  preview,
  onChange,
  anyPost,
}: {
  clientId: string;
  pageId?: string | null;
  postId: string | null;
  preview: PostPreview | null;
  onChange: (id: string | null, preview: PostPreview | null) => void;
  /** Also allow picking posts Meta doesn't allow for ads (e.g. just to grab images). */
  anyPost?: boolean;
}) {
  const t = useT();
  const [posts, setPosts] = useState<PagePost[] | null>(null);
  const [open, setOpen] = useState(!postId);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, start] = useTransition();

  const load = () =>
    start(async () => {
      setError(null);
      const r = await listPostsAction(clientId, pageId);
      if (r.ok) setPosts(r.posts);
      else setError(r.error);
    });

  const filtered = useMemo(() => {
    if (!posts) return [];
    const raw = q.trim();
    if (!raw) return posts;
    // Pasted link: extract the digit sequences in the link to match against post ID / reel ID.
    const nums = raw.match(/\d{8,}/g);
    if (nums) return posts.filter((p) => nums.some((n) => p.id.endsWith(`_${n}`) || p.permalink.includes(n)));
    const k = norm(raw);
    return posts.filter((p) => norm(p.message).includes(k));
  }, [posts, q]);

  const pick = (p: PagePost) => {
    onChange(p.id, { message: p.message, picture: p.picture, permalink: p.permalink, type: p.type, created: p.created });
    setOpen(false);
  };

  return (
    <div className="space-y-3">
      {postId && preview && !open && (
        <div className="flex gap-3 rounded-lg border border-indigo-200 bg-indigo-50/40 p-3">
          <PostThumb picture={preview.picture} type={preview.type} />
          <div className="min-w-0 flex-1 text-sm">
            <div className="text-xs text-slate-500">
              {typeLabel(t, preview.type)} · {dateOnly(preview.created)}
            </div>
            <p className="line-clamp-3 whitespace-pre-line text-slate-800">{preview.message || t("campaigns.postPicker.noText")}</p>
            <div className="mt-1 flex gap-3 text-xs">
              <a href={preview.permalink} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">{t("campaigns.postPicker.viewOnFacebook")}</a>
              <button type="button" className="text-slate-500 hover:text-slate-800" onClick={() => (setOpen(true), !posts && load())}>{t("campaigns.postPicker.changePost")}</button>
            </div>
          </div>
        </div>
      )}

      {open && (
        <div className="space-y-2 rounded-lg border border-slate-200 p-3">
          {!posts ? (
            <button type="button" className={btnClass("secondary")} onClick={load} disabled={loading}>
              {loading && <Spinner />}{t("campaigns.postPicker.loadPosts")}
            </button>
          ) : (
            <>
              <input className={inputClass} placeholder={t("campaigns.postPicker.search")} value={q} onChange={(e) => setQ(e.target.value)} />
              {/pfbid/.test(q) && <p className="text-xs text-amber-600">{t("campaigns.postPicker.pfbid")}</p>}
              <ul className="max-h-96 space-y-1 overflow-y-auto">
                {filtered.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      disabled={!p.eligible && !anyPost}
                      onClick={() => pick(p)}
                      className={`flex w-full gap-3 rounded-lg p-2 text-left hover:bg-slate-50 disabled:opacity-40 ${p.id === postId ? "bg-indigo-50" : ""}`}
                    >
                      <PostThumb picture={p.picture} type={p.type} />
                      <span className="min-w-0 flex-1 text-sm">
                        <span className="block text-xs text-slate-500">
                          {typeLabel(t, p.type)} · {dateOnly(p.created)}
                          {!p.eligible && !anyPost && t("campaigns.postPicker.notEligible")}
                        </span>
                        <span className="line-clamp-2 text-slate-800">{p.message || t("campaigns.postPicker.noText")}</span>
                      </span>
                    </button>
                  </li>
                ))}
                {!filtered.length && <li className="p-2 text-sm text-slate-400">{t("campaigns.postPicker.noMatch")}</li>}
              </ul>
              {postId && (
                <button type="button" className="text-xs text-slate-500 hover:text-slate-800" onClick={() => setOpen(false)}>{t("campaigns.postPicker.cancel")}</button>
              )}
            </>
          )}
          {error && <p className="text-sm text-rose-600">{error}</p>}
        </div>
      )}
    </div>
  );
}
