import { readFileSync } from "node:fs";
import { db } from "./db";
import { logActivity } from "./activity";
import { generateStructured, type ImageInput } from "./ai/claude";
import { POLICY_SYSTEM } from "./ai/prompts";
import { EditablePlanSchema, PolicyCheckSchema, type EditableAd, type EditablePlan } from "./ai/schemas";
import { clientProfile } from "./ai/context";
import { knowledgePromptSection } from "./knowledge";
import { RESULT_LABEL } from "./format";
import { uploadFilePath } from "./uploads";
import { safeFetch } from "./safe-fetch";
import { isCarousel } from "./carousel";
import { getT } from "@/i18n/server";
import { adContentKey, parseDraftPolicy, policyGate, type DraftPolicy, type PolicyEntry } from "./draft-policy-rules";

// Content policy check for drafts (required before publishing, see publishDraft).
// Automatic: queued as soon as Claude drafts / redrafts. Manual: the "Kiểm tra chính sách" (Check policy) button in the editor.

/** Queue a check (run in the background by the worker). No duplicate when this draft is already queued / being checked. */
export async function queueDraftPolicyCheck(clientId: string, draftId: string, triggeredBy: string | null, force = false) {
  const t = await getT();
  const pending = await db.clientJob.findFirst({ where: { clientId, kind: "draft_check", status: { in: ["queued", "running"] }, params: { contains: draftId } } });
  if (pending) return pending;
  return db.clientJob.create({
    data: {
      clientId,
      kind: "draft_check",
      triggeredBy,
      params: JSON.stringify({ draftId, force }),
      steps: JSON.stringify([{ key: "policy", label: t("campaigns.policyCheck.stepLabel"), status: "pending" }]),
    },
  });
}

async function loadImage(src: { path?: string | null; url?: string | null }, name: string): Promise<ImageInput | null> {
  try {
    let data: Buffer;
    let type: string;
    if (src.path) {
      data = readFileSync(uploadFilePath(src.path));
      type = src.path.endsWith(".png") ? "image/png" : src.path.endsWith(".webp") ? "image/webp" : "image/jpeg";
    } else {
      if (!src.url) return null;
      // The preview URL is saved from the editor (user-controlled): fetch it with SSRF protection.
      const res = await safeFetch(src.url, { timeoutMs: 15_000, maxBytes: 4_000_001 });
      if (!res.ok) return null;
      type = res.contentType.split(";")[0].trim();
      data = res.body;
    }
    if (data.length > 4_000_000 || !/^image\/(jpeg|png|webp|gif)$/.test(type)) return null;
    return { name: `${name}.${type.split("/")[1].replace("jpeg", "jpg")}`, data, mediaType: type as ImageInput["mediaType"] };
  } catch {
    return null;
  }
}

/** Images Claude needs to view for an ad: carousel = every card's image (null = card has no image / image too large to view). */
async function imagesOf(ad: EditableAd, name: string): Promise<(ImageInput | null)[]> {
  if (isCarousel(ad)) return Promise.all(ad.cards.map((c, k) => (c.image_path ? loadImage({ path: c.image_path }, `${name}_the${k + 1}`) : Promise.resolve(null))));
  const url = ad.source === "existing" ? ad.post_preview?.picture : ad.video_preview?.picture;
  return [await loadImage(ad.image_path ? { path: ad.image_path } : { url }, name)];
}

function describe(plan: EditablePlan, ad: EditableAd, i: number, imgs: (ImageInput | null)[], count: number) {
  const set = plan.ad_sets[ad.ad_set_index];
  const existing = ad.source === "existing";
  const carousel = isCarousel(ad);
  const img = imgs[0] ?? null;
  const text = existing ? (ad.post_preview?.message ?? "") : ad.primary_text;
  const media = existing
    ? `existing Page post (${ad.post_preview?.type ?? "?"})`
    : carousel
      ? `carousel of ${ad.cards.length} image cards (viewers swipe sideways; each card has its own image + headline)`
      : ad.video_id
        ? `existing Page video "${ad.video_preview?.title ?? ad.video_id}"${ad.video_preview?.length ? ` ${Math.round(ad.video_preview.length)} seconds` : ""}`
        : ad.image_path
          ? "uploaded image"
          : "NO image / video yet";
  const cards =
    carousel &&
    ad.cards
      .map((c, k) => {
        const im = imgs[k];
        const pic = im ? `image ${im.name}` : c.image_path ? "image TOO LARGE / unreadable, so it could NOT be viewed: mention it in issues (where=image, severity=medium) so the user checks it themselves" : "NO image yet";
        return `- Card ${k + 1}: ${pic} · Headline: ${c.headline.trim() || `(empty, uses "${ad.headline}")`}${c.description.trim() ? ` · Description: ${c.description.trim()}` : ""}${c.link_url ? ` · Link: ${c.link_url}` : ""}`;
      })
      .join("\n");
  return [
    `## Content ${i} — "${ad.name}"${count > 1 ? ` (used for ${count} identical ads)` : ""}`,
    `Format: ${media}.${!carousel && img ? ` Image: ${img.name}${ad.video_id ? " (video thumbnail: only this frame is visible, the speech / music CANNOT be heard)" : ""}` : ""}`,
    set && `Ad set: ${set.name} · age ${set.age_min}–${set.age_max} · ${set.locations.map((l) => l.name).join(", ") || "?"}`,
    `Button: ${ad.call_to_action}${ad.lead_form ? ` · Lead form "${ad.lead_form.name}"` : ""}${ad.link_url ? ` · Link: ${ad.link_url}` : ""}`,
    !existing && `Headline: ${ad.headline || "(empty)"}${ad.description ? ` · Description: ${ad.description}` : ""}`,
    cards && `Carousel cards (check EVERY card, both image and text; for an issue on a card, write "Card N" in quote):\n${cards}`,
    `Primary text:\n"""\n${text || "(no text)"}\n"""`,
    ad.welcome && `Message template (what viewers see after tapping to message):\n"""\n${ad.welcome.greeting}\n${ad.welcome.questions.map((q) => `- Question: ${q.q}${q.a ? ` → Automatic reply: ${q.a}` : ""}`).join("\n")}\n"""`,
  ]
    .filter(Boolean)
    .join("\n");
}

// Each Claude call takes at most 10 images / ~16MB: with lots of content (10-card carousels) split into multiple calls, never skipping an image.
// (27/10/2026: a 20-image call through Claude Code returned empty — each image is one Read.)
const MAX_IMAGES_PER_CALL = 10;
const MAX_IMAGE_BYTES_PER_CALL = 16_000_000;

/** force = re-check every ad; by default only check ads without a result for their current content. */
export async function runDraftPolicyCheck(draftId: string, force = false) {
  const t = await getT();
  const draft = await db.campaignDraft.findUniqueOrThrow({ where: { id: draftId }, include: { client: true } });
  if (draft.status === "published") return t("campaigns.policyCheck.alreadyPublished");
  const plan = EditablePlanSchema.parse(JSON.parse(draft.plan));
  const prev = parseDraftPolicy(draft.policy);

  // Merge ads with identical content (same text + same image/video across ad sets) into one item to check.
  const groups = new Map<string, number[]>();
  plan.ads.forEach((ad, i) => {
    const k = adContentKey(ad);
    if (!force && prev?.results[k]) return;
    groups.set(k, [...(groups.get(k) ?? []), i]);
  });
  if (!groups.size) return t("campaigns.policyCheck.allChecked");

  const keys = [...groups.keys()];
  type Item = { k: string; n: number; part: string; images: ImageInput[] };
  const items: Item[] = [];
  for (const [n, k] of keys.entries()) {
    const ad = plan.ads[groups.get(k)![0]];
    const imgs = await imagesOf(ad, `nd${n}`);
    items.push({ k, n, part: describe(plan, ad, n, imgs, groups.get(k)!.length), images: imgs.filter((x): x is ImageInput => !!x) });
  }
  const batches: Item[][] = [];
  for (const it of items) {
    const last = batches.at(-1);
    const size = (b: Item[]) => b.reduce((a, x) => a + x.images.length, 0);
    const bytes = (b: Item[]) => b.reduce((a, x) => a + x.images.reduce((s2, im) => s2 + im.data.length, 0), 0);
    if (last && size(last) + it.images.length <= MAX_IMAGES_PER_CALL && bytes(last) + it.images.reduce((a, im) => a + im.data.length, 0) <= MAX_IMAGE_BYTES_PER_CALL) last.push(it);
    else batches.push([it]);
  }

  const at = new Date().toISOString();
  const fresh: Record<string, PolicyEntry> = {};
  const overall: string[] = [];
  let failed: string | null = null;
  for (const batch of batches) {
    // Renumber within each call (0..n-1) so Claude returns indexes matching the list it sees.
    const parts = batch.map((it, j) => it.part.replace(`## Content ${it.n} —`, `## Content ${j} —`));
    const prompt = `# Client\n${clientProfile(draft.client)}\n\n${await knowledgePromptSection(draft.clientId)}\n\n# Campaign\n${plan.campaign_name} · objective ${plan.result_type} (${RESULT_LABEL[plan.result_type] ?? plan.result_type})\n\n# Content to check (${batch.length})\n${parts.join("\n\n")}\n\nCheck each content item (primary text, headline, the text of every carousel card, the message template and every image if any). Ads without an image / video yet: check the text only.`;
    // If a later call fails, results from earlier calls are still saved; the error is reported at the end.
    const res = await generateStructured({ clientId: draft.clientId, system: POLICY_SYSTEM, prompt, schema: PolicyCheckSchema, effort: "high", images: batch.flatMap((it) => it.images) }).catch((e: unknown) => {
      failed ??= e instanceof Error ? e.message : String(e);
      return null;
    });
    if (!res) continue;
    overall.push(res.data.overall);
    for (const { index, ...rest } of res.data.items) {
      const it = batch[index];
      if (!it) continue;
      fresh[it.k] = { ...rest, at, model: res.model };
    }
  }
  const missing = keys.filter((k) => !fresh[k]).length;

  // Write over the latest version (the user may have edited during the check): only keep results for content still in the draft.
  const cur = await db.campaignDraft.findUniqueOrThrow({ where: { id: draftId } });
  const curPlan = EditablePlanSchema.parse(JSON.parse(cur.plan));
  const live = new Set(curPlan.ads.map(adContentKey));
  const merged = { ...(parseDraftPolicy(cur.policy)?.results ?? {}), ...fresh };
  const policy: DraftPolicy = { at, overall: overall.join(" "), results: Object.fromEntries(Object.entries(merged).filter(([k]) => live.has(k))) };
  await db.campaignDraft.update({ where: { id: draftId }, data: { policy: JSON.stringify(policy) } });

  const g = policyGate(curPlan, policy);
  const summary = `${g.blocked.length ? `${t("campaigns.policyCheck.sumRejected", { count: g.blocked.length })} · ` : ""}${g.fix.length ? `${t("campaigns.policyCheck.sumFix", { count: g.fix.length })} · ` : ""}${t("campaigns.policyCheck.sumSafe", { count: curPlan.ads.length - g.blocked.length - g.fix.length - g.unchecked.length })}${g.unchecked.length ? ` · ${t("campaigns.policyCheck.sumUnchecked", { count: g.unchecked.length })}` : ""}`;
  await logActivity(draft.clientId, "analyze", t("campaigns.policyCheck.activity", { name: curPlan.campaign_name, summary }));
  if (failed) throw new Error(t("campaigns.policyCheck.failedItems", { count: missing, error: failed }));
  if (missing) throw new Error(t("campaigns.policyCheck.missedItems", { count: missing }));
  return summary;
}
