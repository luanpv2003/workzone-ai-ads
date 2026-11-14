"use server";

import { getT } from "@/i18n/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireClient, requireClientOf } from "@/lib/access";
import { errorMessage } from "@/lib/activity";
import { enqueueClientJob } from "@/lib/client-jobs";
import { saveUpload } from "@/lib/uploads";
import { RESULT_TYPES } from "@/lib/ai/schemas";
import { addLinks, addManual, addPosts, createReview, finalizeReview, manualDraft, removeItem, reviewAdStatus } from "@/lib/content-review";

// Content review → run ads. Nothing here changes anything on Meta (only reads posts / review status).

type R<T = object> = ({ ok: true } & T) | { ok: false; error: string };

async function wrap<T extends object>(fn: () => Promise<T>): Promise<R<T>> {
  try {
    const out = await fn();
    revalidatePath("/", "layout");
    return { ok: true, ...out };
  } catch (err) {
    console.error(err);
    return { ok: false, error: errorMessage(err) };
  }
}

async function clientOf(reviewId: string) {
  const r = await db.contentReview.findUniqueOrThrow({ where: { id: reviewId }, select: { clientId: true, status: true } });
  return r;
}

export async function createReviewAction(clientId: string, title: string) {
  return wrap(async () => {
    await requireClient(clientId, "edit");
    return { id: await createReview(clientId, title) };
  });
}

export async function addLinksAction(reviewId: string, text: string) {
  return wrap(async () => {
    await requireClientOf("contentReview", reviewId, "edit");
    const links = text.split(/[\s,]+/).filter((l) => /^https?:\/\//.test(l));
    if (!links.length) throw new Error((await getT())("targeting.contentActions.pasteLinks"));
    return { failed: await addLinks(reviewId, links) };
  });
}

export async function addPostsAction(reviewId: string, postIds: string[]) {
  return wrap(async () => {
    await requireClientOf("contentReview", reviewId, "edit");
    await addPosts(reviewId, postIds);
    return {};
  });
}

/** Unpublished content: form has message, images, frames (video frames extracted in the browser), videoSeconds. */
export async function addManualAction(reviewId: string, form: FormData) {
  return wrap(async () => {
    await requireClientOf("contentReview", reviewId, "edit");
    await clientOf(reviewId);
    const folder = `rv_${reviewId}`;
    const save = async (key: string) => Promise.all(form.getAll(key).filter((f): f is File => f instanceof File && f.size > 0).slice(0, 10).map((f) => saveUpload(folder, f)));
    const seconds = Number(form.get("videoSeconds"));
    await addManual(reviewId, { message: String(form.get("message") ?? ""), images: await save("images"), frames: await save("frames"), videoSeconds: Number.isFinite(seconds) && seconds > 0 ? seconds : null });
    return {};
  });
}

export async function removeItemAction(reviewId: string, itemId: string) {
  return wrap(async () => {
    await requireClientOf("contentReview", reviewId, "edit");
    await removeItem(reviewId, itemId);
    return {};
  });
}

export async function startCheckAction(reviewId: string) {
  return wrap(async () => {
    const { user } = await requireClientOf("contentReview", reviewId, "edit");
    const r = await clientOf(reviewId);
    await db.contentReview.update({ where: { id: reviewId }, data: { status: "checking", error: null } });
    await enqueueClientJob(r.clientId, "content_check", user.name, { params: { reviewId }, steps: [{ key: "policy", label: (await getT())("targeting.contentActions.stepPolicy") }] });
    return {};
  });
}

const BriefSchema = z.object({
  goal: z.enum(RESULT_TYPES),
  dailyBudget: z.number().positive(),
  locations: z.string().max(500),
  ageMin: z.number().int().min(18).max(65),
  ageMax: z.number().int().min(18).max(65),
  landingUrl: z.string().max(500).optional(),
  notes: z.string().max(3000).optional(),
});

/** Draft a plan (first time or from feedback). Stored with the requirements (goal, budget…) the user entered. */
export async function startPlanAction(reviewId: string, brief: unknown, feedback: string | null) {
  return wrap(async () => {
    const { user } = await requireClientOf("contentReview", reviewId, "edit");
    const r = await clientOf(reviewId);
    const b = BriefSchema.parse(brief);
    await db.contentReview.update({ where: { id: reviewId }, data: { brief: JSON.stringify({ ...b, ageMax: Math.max(b.ageMin, b.ageMax) }), status: "planning", error: null } });
    await enqueueClientJob(r.clientId, "content_plan", user.name, { params: { reviewId, feedback: feedback?.trim() || null }, steps: [{ key: "plan", label: (await getT())("targeting.contentActions.stepPlan") }] });
    return {};
  });
}

export async function finalizeAction(reviewId: string, version: number) {
  return wrap(async () => {
    await requireClientOf("contentReview", reviewId, "edit");
    return { draftId: await finalizeReview(reviewId, version) };
  });
}

export async function manualDraftAction(reviewId: string) {
  return wrap(async () => {
    await requireClientOf("contentReview", reviewId, "edit");
    return { draftId: await manualDraft(reviewId) };
  });
}

export async function adStatusAction(reviewId: string) {
  return wrap(async () => {
    await requireClientOf("contentReview", reviewId, "view");
    return await reviewAdStatus(reviewId);
  });
}
