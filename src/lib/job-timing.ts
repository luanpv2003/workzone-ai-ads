import { db } from "./db";
import { viT } from "./format";
import type { T } from "@/i18n/translate";

// Estimated duration for background jobs: learned from real runs (moving average); the first time uses figures measured at rollout
// (25-conversation batch ~4.3 minutes, merging results ~2 minutes, persona build ~3.3 minutes, sync ~1.5 minutes).

type TimingKey = "conv_batch" | "conv_merge" | "audience" | "sync";
const DEFAULT_SEC: Record<TimingKey, number> = { conv_batch: 260, conv_merge: 120, audience: 200, sync: 90 };
const KEY = (k: TimingKey) => `timing.${k}`;

export async function typicalSeconds(k: TimingKey) {
  const s = await db.setting.findUnique({ where: { key: KEY(k) } });
  const v = s ? Number(s.value) : NaN;
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_SEC[k];
}

/** Record a real run: moving average (the new run weighs 30%). */
export async function recordSeconds(k: TimingKey, seconds: number) {
  if (!(seconds > 1 && seconds < 3 * 3600)) return;
  const prev = await typicalSeconds(k);
  const next = Math.round(prev * 0.7 + seconds * 0.3);
  await db.setting.upsert({ where: { key: KEY(k) }, create: { key: KEY(k), value: String(next) }, update: { value: String(next) } });
}

/** "còn ~45 phút" / "còn ~1 giờ 20 phút" / "còn ~2 phút" (~45 min left / ~1 h 20 min left / ~2 min left) */
export function formatEta(seconds: number, t: T = viT) {
  const m = Math.max(1, Math.round(seconds / 60));
  if (m < 60) return t("core.eta.min", { m });
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? t("core.eta.hourMin", { h, m: r }) : t("core.eta.hour", { h });
}
