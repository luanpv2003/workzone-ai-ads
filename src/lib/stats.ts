// Statistical confidence for comparing cost / result between ad sets.
// Model: results ~ Poisson(λ × spend); λ = results per unit of currency. Jeffreys posterior: λ ~ Gamma(k + 0.5, spend).
// P(A costlier than B) = P(λ_A < λ_B), estimated by Monte Carlo sampling (fixed seed so results are stable across views).

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    // mulberry32
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(r: () => number) {
  const u = Math.max(r(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

/** Sample Gamma(shape, 1) via Marsaglia–Tsang (shape < 1 uses the boost trick). */
function gamma(shape: number, r: () => number): number {
  if (shape < 1) return gamma(shape + 1, r) * Math.pow(Math.max(r(), 1e-12), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number, v: number;
    do {
      x = normal(r);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = r();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

const N = 4000;

/** Probability ad set A is costlier than ad set B (A's results per unit of currency lower than B's). */
export function probMoreExpensive(a: { results: number; spend: number }, b: { results: number; spend: number }) {
  if (a.spend <= 0 || b.spend <= 0) return 0.5;
  const r = rng(Math.round(a.results * 7919 + a.spend + b.results * 104729 + b.spend));
  let n = 0;
  for (let i = 0; i < N; i++) if (gamma(a.results + 0.5, r) / a.spend < gamma(b.results + 0.5, r) / b.spend) n++;
  return n / N;
}

/** Probability the ad set's true CPR is above a fixed level (e.g. target CPR). */
export function probCprAbove(a: { results: number; spend: number }, cpr: number) {
  if (a.spend <= 0 || cpr <= 0) return 0.5;
  const r = rng(Math.round(a.results * 7919 + a.spend + cpr));
  let n = 0;
  for (let i = 0; i < N; i++) if (gamma(a.results + 0.5, r) / a.spend < 1 / cpr) n++;
  return n / N;
}

export const pctLabel = (p: number) => `${Math.round(p * 100)}%`;

/** Probability A's "good lead" rate is lower than B's (Jeffreys Beta, sampled via Gamma). */
export function probLowerProportion(a: { good: number; n: number }, b: { good: number; n: number }) {
  if (!a.n || !b.n) return 0.5;
  const r = rng(Math.round(a.good * 7919 + a.n * 31 + b.good * 104729 + b.n * 17));
  const beta = (k: number, n: number) => {
    const x = gamma(k + 0.5, r);
    return x / (x + gamma(n - k + 0.5, r));
  };
  let c = 0;
  for (let i = 0; i < N; i++) if (beta(a.good, a.n) < beta(b.good, b.n)) c++;
  return c / N;
}
