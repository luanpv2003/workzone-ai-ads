"use client";

import { useState } from "react";
import { importPostImagesAction, uploadImageAction } from "@/app/actions";
import type { CarouselCard, EditableAd } from "@/lib/ai/schemas";
import { CAROUSEL_MAX, CAROUSEL_MIN } from "@/lib/carousel";
import { btnClass, inputClass } from "../ui";
import { Spinner } from "../action-button";
import { Label, Toggle } from "./fields";
import { PostPicker } from "./post-picker";
import { useT } from "@/i18n/client";

// Carousel ad: 2-10 cards, each card 1 image + headline / description (+ its own link if the objective drives to a website).
// Add images manually (select multiple files) or take all images from an existing post on the Page.

const blankCard = (image_path: string | null): CarouselCard => ({ image_path, headline: "", description: "", link_url: null });

export function CarouselEditor({
  clientId,
  draftId,
  pageId,
  ad,
  needsLink,
  onChange,
}: {
  clientId: string;
  draftId: string;
  pageId?: string | null;
  ad: EditableAd;
  needsLink: boolean;
  /** The updater receives the ad's latest version: finishing an (async) image upload doesn't overwrite text the user just typed. */
  onChange: (patch: Partial<EditableAd> | ((a: EditableAd) => Partial<EditableAd>)) => void;
}) {
  const t = useT();
  const cards = ad.cards;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fromPost, setFromPost] = useState(false);
  const room = CAROUSEL_MAX - cards.length;
  const setCards = (next: CarouselCard[]) => onChange({ cards: next });
  const setCard = (i: number, patch: Partial<CarouselCard>) => setCards(cards.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= cards.length) return;
    const next = [...cards];
    [next[i], next[j]] = [next[j], next[i]];
    setCards(next);
  };

  const upload = async (file: File) => {
    const fd = new FormData();
    fd.set("file", file);
    const r = await uploadImageAction(draftId, fd);
    if (!r.ok) throw new Error(`${file.name}: ${r.error}`);
    return r.path;
  };

  const addFiles = async (files: File[]) => {
    if (!files.length) return;
    setError(null);
    const take = files.slice(0, room);
    const paths: string[] = [];
    const errs: string[] = [];
    for (const [k, f] of take.entries()) {
      setBusy(t("campaigns.carousel.uploading", { n: k + 1, total: take.length }));
      try {
        paths.push(await upload(f));
      } catch (e) {
        errs.push(e instanceof Error ? e.message : String(e));
      }
    }
    setBusy(null);
    if (paths.length) onChange((a) => ({ cards: [...a.cards, ...paths.map(blankCard)].slice(0, CAROUSEL_MAX) }));
    if (files.length > take.length) errs.push(t("campaigns.carousel.maxCards", { max: CAROUSEL_MAX, dropped: files.length - take.length }));
    if (errs.length) setError(errs.join(" "));
  };

  const importPost = async (postId: string) => {
    setError(null);
    setBusy(t("campaigns.carousel.fetchingPostImages"));
    const r = await importPostImagesAction(clientId, draftId, postId, pageId);
    setBusy(null);
    if (!r.ok) return setError(r.error);
    const take = r.paths.slice(0, room);
    onChange((a) => ({ cards: [...a.cards, ...take.map(blankCard)].slice(0, CAROUSEL_MAX) }));
    setFromPost(false);
    const notes = [
      r.skipped ? t("campaigns.carousel.skipped", { count: r.skipped }) : "",
      r.paths.length > take.length ? t("campaigns.carousel.full", { max: CAROUSEL_MAX, dropped: r.paths.length - take.length }) : "",
      take.length < CAROUSEL_MIN && !cards.length ? t("campaigns.carousel.tooFewFromPost", { count: take.length, min: CAROUSEL_MIN }) : "",
    ].filter(Boolean);
    if (notes.length) setError(notes.join(" "));
  };

  return (
    <div className="space-y-3">
      <Label hint={t("campaigns.carousel.cardsHint", { count: cards.length, max: CAROUSEL_MAX, min: CAROUSEL_MIN })}>{t("campaigns.carousel.cardsLabel")}</Label>
      {cards.length > 0 && (
        <ol className="space-y-2">
          {cards.map((c, i) => (
            <li key={`${i}:${c.image_path ?? ""}`} className="flex gap-3 rounded-lg border border-slate-200 p-2">
              <CardImage draftId={draftId} path={c.image_path} onChange={(v) => onChange((a) => ({ cards: a.cards.map((x, j) => (j === i ? { ...x, image_path: v } : x)) }))} index={i} />
              <div className="min-w-0 flex-1 space-y-1.5">
                <input
                  className={inputClass}
                  value={c.headline}
                  placeholder={ad.headline ? t("campaigns.carousel.cardHeadlineWithDefault", { headline: ad.headline }) : t("campaigns.carousel.cardHeadline")}
                  onChange={(e) => setCard(i, { headline: e.target.value })}
                />
                {c.headline.length > 32 && <p className="text-[11px] text-amber-600">{t("campaigns.carousel.charsMayBeCut", { count: c.headline.length })}</p>}
                <input className={inputClass} value={c.description} placeholder={t("campaigns.carousel.shortDescription")} onChange={(e) => setCard(i, { description: e.target.value })} />
                {needsLink && (
                  <input
                    className={inputClass}
                    value={c.link_url ?? ""}
                    placeholder={t("campaigns.carousel.cardLink")}
                    onChange={(e) => setCard(i, { link_url: e.target.value.trim() ? e.target.value : null })}
                  />
                )}
              </div>
              <div className="flex shrink-0 flex-col items-center gap-1 text-xs">
                <span className="font-semibold text-slate-400">{i + 1}</span>
                <button type="button" title={t("campaigns.carousel.moveUp")} disabled={i === 0} onClick={() => move(i, -1)} className="rounded px-1.5 py-0.5 hover:bg-slate-100 disabled:opacity-30">↑</button>
                <button type="button" title={t("campaigns.carousel.moveDown")} disabled={i === cards.length - 1} onClick={() => move(i, 1)} className="rounded px-1.5 py-0.5 hover:bg-slate-100 disabled:opacity-30">↓</button>
                <button type="button" title={t("campaigns.carousel.deleteCard")} onClick={() => setCards(cards.filter((_, j) => j !== i))} className="rounded px-1.5 py-0.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600">✕</button>
              </div>
            </li>
          ))}
        </ol>
      )}
      {room > 0 && (
        <div className="flex flex-wrap gap-2">
          <label className={`${btnClass("secondary")} cursor-pointer`}>
            {t("campaigns.carousel.uploadImages")}
            <input
              type="file"
              multiple
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              disabled={!!busy}
              onChange={async (e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = "";
                await addFiles(files);
              }}
            />
          </label>
          <button type="button" className={btnClass("secondary")} disabled={!!busy} onClick={() => setFromPost((v) => !v)}>
            {fromPost ? t("campaigns.carousel.close") : t("campaigns.carousel.fromPagePost")}
          </button>
          <button type="button" className="text-xs font-medium text-indigo-600 hover:underline" disabled={!!busy} onClick={() => setCards([...cards, blankCard(null)])}>
            {t("campaigns.carousel.blankCard")}
          </button>
        </div>
      )}
      {fromPost && (
        <div className="rounded-lg border border-indigo-200 bg-indigo-50/30 p-2">
          <p className="mb-2 text-xs text-slate-600">{t("campaigns.carousel.pickPostHint", { max: Math.min(room, CAROUSEL_MAX) })}</p>
          <PostPicker key={pageId ?? ""} clientId={clientId} pageId={pageId} postId={null} preview={null} anyPost onChange={(id) => id && importPost(id)} />
        </div>
      )}
      {busy && (
        <p className="flex items-center gap-2 text-xs text-slate-500">
          <Spinner />
          {busy}
        </p>
      )}
      {error && <p className="text-xs text-rose-600">{error}</p>}
      <Toggle
        checked={ad.carousel_auto_order}
        onChange={(v) => onChange({ carousel_auto_order: v })}
        label={t("campaigns.carousel.autoOrder")}
        hint={
          ad.carousel_auto_order
            ? t("campaigns.carousel.autoOrderOn")
            : t("campaigns.carousel.autoOrderOff")
        }
      />
    </div>
  );
}

function CardImage({ draftId, path, index, onChange }: { draftId: string; path: string | null; index: number; onChange: (v: string) => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <label className="relative block size-20 shrink-0 cursor-pointer" title={path ? t("campaigns.carousel.changeImage") : t("campaigns.carousel.uploadImage")}>
      {path ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`/api/uploads/${path}`} alt={t("campaigns.carousel.cardAlt", { n: index + 1 })} className="size-20 rounded-md border border-slate-200 object-cover" />
      ) : (
        <span className="grid size-20 place-items-center rounded-md border border-dashed border-rose-300 text-center text-[11px] text-rose-500">{t("campaigns.carousel.noImage")}</span>
      )}
      {busy && (
        <span className="absolute inset-0 grid place-items-center rounded-md bg-white/70">
          <Spinner />
        </span>
      )}
      {error && <span className="absolute inset-x-0 bottom-0 truncate rounded-b-md bg-rose-600 px-1 text-[10px] text-white" title={error}>{error}</span>}
      <input
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          setBusy(true);
          setError(null);
          const fd = new FormData();
          fd.set("file", file);
          const r = await uploadImageAction(draftId, fd);
          setBusy(false);
          if (r.ok) onChange(r.path);
          else setError(r.error);
        }}
      />
    </label>
  );
}
