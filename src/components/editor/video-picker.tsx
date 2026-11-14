"use client";

import { useMemo, useState, useTransition } from "react";
import { listVideosAction } from "@/app/video-actions";
import type { PageVideo } from "@/lib/meta/types";
import { norm } from "@/lib/text";
import { dateOnly } from "@/lib/format";
import { btnClass, inputClass } from "../ui";
import { Spinner } from "../action-button";
import { useT } from "@/i18n/client";

type VideoPreview = { title: string; picture: string | null; length: number | null; permalink: string };

const duration = (s: number | null) => (s == null ? "" : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`);

function VideoThumb({ picture, length }: { picture: string | null; length: number | null }) {
  return (
    <div className="relative size-16 shrink-0 overflow-hidden rounded-md bg-slate-100">
      {picture ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={picture} alt="" className="size-full object-cover" />
      ) : (
        <div className="grid size-full place-items-center text-xl">🎬</div>
      )}
      {length != null && <span className="absolute right-0.5 bottom-0.5 rounded bg-black/70 px-1 text-[10px] text-white">{duration(length)}</span>}
    </div>
  );
}

/** Pick a video / Reel published on the Page as the video for a new ad (text, button, form, message template can be changed). */
export function VideoPicker({
  clientId,
  pageId,
  videoId,
  preview,
  onChange,
}: {
  clientId: string;
  pageId?: string | null;
  videoId: string | null;
  preview: VideoPreview | null;
  onChange: (id: string | null, preview: VideoPreview | null, description: string) => void;
}) {
  const t = useT();
  const [videos, setVideos] = useState<PageVideo[] | null>(null);
  const [open, setOpen] = useState(!videoId);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, start] = useTransition();

  const load = () =>
    start(async () => {
      setError(null);
      const r = await listVideosAction(clientId, pageId);
      if (r.ok) setVideos(r.videos);
      else setError(r.error);
    });

  const filtered = useMemo(() => {
    if (!videos) return [];
    const raw = q.trim();
    if (!raw) return videos;
    // Pasted video / Reel link: match by the digit ID sequence in the link.
    const nums = raw.match(/\d{8,}/g);
    if (nums) return videos.filter((v) => nums.some((n) => v.id === n || v.permalink.includes(n)));
    const k = norm(raw);
    return videos.filter((v) => norm(`${v.title} ${v.description}`).includes(k));
  }, [videos, q]);

  const pick = (v: PageVideo) => {
    onChange(v.id, { title: v.title, picture: v.picture, length: v.length, permalink: v.permalink }, v.description);
    setOpen(false);
  };

  return (
    <div className="space-y-3">
      {videoId && preview && !open && (
        <div className="flex gap-3 rounded-lg border border-indigo-200 bg-indigo-50/40 p-3">
          <VideoThumb picture={preview.picture} length={preview.length} />
          <div className="min-w-0 flex-1 text-sm">
            <p className="line-clamp-2 text-slate-800">{preview.title || t("campaigns.videoPicker.videoId", { id: videoId })}</p>
            <div className="mt-1 flex gap-3 text-xs">
              {preview.permalink && (
                <a href={preview.permalink} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">
                  {t("campaigns.videoPicker.viewOnFacebook")}
                </a>
              )}
              <button type="button" className="text-slate-500 hover:text-slate-800" onClick={() => (setOpen(true), !videos && load())}>
                {t("campaigns.videoPicker.changeVideo")}
              </button>
            </div>
          </div>
        </div>
      )}

      {open && (
        <div className="space-y-2 rounded-lg border border-slate-200 p-3">
          {!videos ? (
            <button type="button" className={btnClass("secondary")} onClick={load} disabled={loading}>
              {loading && <Spinner />}{t("campaigns.videoPicker.load")}
            </button>
          ) : (
            <>
              <input className={inputClass} placeholder={t("campaigns.videoPicker.search")} value={q} onChange={(e) => setQ(e.target.value)} />
              <ul className="max-h-96 space-y-1 overflow-y-auto">
                {filtered.map((v) => (
                  <li key={v.id}>
                    <button
                      type="button"
                      onClick={() => pick(v)}
                      className={`flex w-full gap-3 rounded-lg p-2 text-left hover:bg-slate-50 ${v.id === videoId ? "bg-indigo-50" : ""}`}
                    >
                      <VideoThumb picture={v.picture} length={v.length} />
                      <span className="min-w-0 flex-1 text-sm">
                        <span className="block text-xs text-slate-500">{dateOnly(v.created)}</span>
                        <span className="line-clamp-2 text-slate-800">{v.title || v.description || t("campaigns.videoPicker.noTitle")}</span>
                      </span>
                    </button>
                  </li>
                ))}
                {!filtered.length && <li className="p-2 text-sm text-slate-400">{t("campaigns.videoPicker.noMatch")}</li>}
              </ul>
              {videoId && (
                <button type="button" className="text-xs text-slate-500 hover:text-slate-800" onClick={() => setOpen(false)}>
                  {t("campaigns.videoPicker.cancel")}
                </button>
              )}
            </>
          )}
          {error && <p className="text-sm text-rose-600">{error}</p>}
        </div>
      )}
    </div>
  );
}
