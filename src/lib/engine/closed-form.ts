// Closed-form operations on distributions that carry a parametric identity
// (ValueMeta). The engine still falls back to Monte Carlo when a distribution
// has no `meta` or when an operation can't preserve a closed form — this
// module just short-circuits the cases that have one.
//
// Phases:
//   Phase 2 — analytical `mean(d)` and `p(d, q)` for known families
//   Phase 3 — analytical arithmetic on normal / lognormal / scalar × distribution
//
// Every function here is total: if it can't reduce to a closed form, it
// returns `null` and the caller falls back to the sample path.

import { type DistFns, gamma } from './mc';
import { correlation } from './stats';
import { normalInverseCdf } from './stats-adapter';
import type { Dimension, Value, ValueMeta } from './value';

// Empirical correlation of two sample arrays, snapped to exactly 0 below a
// noise floor. The floor 4/√n sits ≈4σ above the sampling scatter of genuinely
// independent arrays (whose empirical correlation is ~1/√n), so an independent
// construction snaps to 0 — keeping the exact analytic spread the closed-form
// layer promises — while structural coupling (variable reuse, `correlate`)
// clears the floor and is carried into the combined moment.
function structuralCorr(a: Float64Array, b: Float64Array): number {
  if (a === b) return 1;
  const r = correlation(a, b);
  if (Number.isFinite(r) && Math.abs(r) >= 1 - 1e-12) return r;
  return Math.abs(r) < 4 / Math.sqrt(a.length) ? 0 : r;
}

// Structural correlation of the operands' logs — the coupling that drives a
// lognormal product/ratio's spread (X = exp(A), so it is corr(A, B)). Samples
// are positive by construction, so the log is finite.
function structuralLogCorr(a: Float64Array, b: Float64Array): number {
  if (a === b) return 1;
  const n = Math.min(a.length, b.length);
  const la = new Float64Array(n);
  const lb = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    la[i] = Math.log(a[i]);
    lb[i] = Math.log(b[i]);
  }
  return structuralCorr(la, lb);
}

// Draw N samples from a closed-form distribution. Used to materialise a
// `Value` that came out of `closedFormBinop` so that the display pipeline
// (sparkline, p5/p95, sd) has data to render. The meta rides alongside the
// samples, so analytical consumers (mean, p) read the exact value.
//
// When the closed-form op has access to the input sample arrays, we
// *derive* the output samples from the inputs elementwise — not from a
// fresh draw. This preserves correlation-by-reuse: `x * x` shares its
// sample array with `x`, so `x - x ≡ 0` and `x + x ≡ 2x` keep working,
// and sensitivity still detects the rank-correlation between `a` and
// `a * b`.
export function sampleFromMeta(
  v: Value & { meta: ValueMeta },
  ctx: { fns: DistFns },
  op: '+' | '-' | '*' | '/',
  fromA?: Value,
  fromB?: Value
): Value {
  const N = ctx.fns.N;
  const out = new Float64Array(N);
  // Apply the *actual* operator elementwise. Deriving samples from the inputs
  // (rather than re-keying off the meta family) is what preserves correlation-
  // by-reuse — `x - x ≡ 0`, `x / x ≡ 1` — and it keeps the sample array in
  // agreement with the analytical `meta` for every op, not just the additive /
  // multiplicative one the family happens to be closed under.
  const apply = (x: number, y: number): number =>
    op === '+' ? x + y : op === '-' ? x - y : op === '*' ? x * y : x / y;

  // Distribution ⊕ distribution: combine the paired input samples directly.
  if (fromA?.samples && fromB?.samples) {
    for (let i = 0; i < N; i++) out[i] = apply(fromA.samples[i], fromB.samples[i]);
    return { dim: v.dim, samples: out, meta: v.meta };
  }

  // Distribution ⊕ scalar: apply the scalar elementwise on the right.
  if (fromA?.samples && fromB?.scalar != null) {
    const k = fromB.scalar;
    for (let i = 0; i < N; i++) out[i] = apply(fromA.samples[i], k);
    return { dim: v.dim, samples: out, meta: v.meta };
  }
  // Scalar ⊕ distribution: scalar on the left (only `k * dist` reaches here —
  // `k / dist` and `k - dist` aren't family-closed, so closedFormBinop returns
  // null and the engine takes the sample path).
  if (fromB?.samples && fromA?.scalar != null) {
    const k = fromA.scalar;
    for (let i = 0; i < N; i++) out[i] = apply(k, fromB.samples[i]);
    return { dim: v.dim, samples: out, meta: v.meta };
  }

  // Fallback: fresh draws from the closed-form distribution.
  for (let i = 0; i < N; i++) {
    switch (v.meta.kind) {
      case 'normal':
        out[i] = v.meta.mean + v.meta.sd * ctx.fns.gaussian();
        break;
      case 'lognormal':
        out[i] = Math.exp(v.meta.mu + v.meta.sigma * ctx.fns.gaussian());
        break;
      default:
        throw new Error(`sampleFromMeta: unhandled meta kind ${(v.meta as ValueMeta).kind}`);
    }
  }
  return { dim: v.dim, samples: out, meta: v.meta };
}

// --- analytical mean ---------------------------------------------------------
//
// Each entry returns the *population* mean of the distribution, exact (no
// sampling noise). Used by `mean(d)` when a distribution has a meta identity.

export function analyticalMean(v: Value): number | null {
  switch (v.meta?.kind) {
    case 'normal':
      return v.meta.mean;
    case 'lognormal':
      // E[X] = exp(μ + σ²/2). May overflow for large σ; let the caller
      // fall back to sample-mean if so (handled by `Number.isFinite`).
      return Math.exp(v.meta.mu + (v.meta.sigma * v.meta.sigma) / 2);
    case 'uniform':
      return (v.meta.lo + v.meta.hi) / 2;
    case 'exponential':
      return v.meta.mean;
    case 'poisson':
      return v.meta.lambda;
    case 'beta':
      return v.meta.a / (v.meta.a + v.meta.b);
    case 'triangular':
      return (v.meta.lo + v.meta.mode + v.meta.hi) / 3;
    case 'pert': {
      // Beta-PERT mean over [lo, hi] = (lo + 4m + hi) / 6.
      // Recover m from α: α = 1 + 4(m − lo)/(hi − lo).
      const span = v.meta.hi - v.meta.lo;
      const m = v.meta.lo + ((v.meta.alpha - 1) * span) / 4;
      return (v.meta.lo + 4 * m + v.meta.hi) / 6;
    }
    case 'weibull':
      // E[X] = λ·Γ(1 + 1/k).
      return v.meta.scale * gamma(1 + 1 / v.meta.shape);
    case 'binomial':
      return v.meta.n * v.meta.p;
    default:
      return null;
  }
}

// --- analytical mode (the density peak) -------------------------------------
//
// The value at which the pdf is maximised, exact for families that have a
// closed-form mode. Returns null when there's no analytic mode (uniform is
// flat; poisson/beta/exponential are left to the sample estimate), and the
// caller falls back to a smoothed histogram peak.

export function analyticalMode(v: Value): number | null {
  switch (v.meta?.kind) {
    case 'normal':
      return v.meta.mean;
    case 'lognormal':
      // exp(μ − σ²): strictly below the median exp(μ), the honest "most likely".
      return Math.exp(v.meta.mu - v.meta.sigma * v.meta.sigma);
    case 'triangular':
      return v.meta.mode;
    case 'pert': {
      // Recover the most-likely m from α: α = 1 + 4(m − lo)/(hi − lo).
      const span = v.meta.hi - v.meta.lo;
      return v.meta.lo + ((v.meta.alpha - 1) * span) / 4;
    }
    case 'binomial':
      // The largest integer ≤ (n+1)p (two adjacent modes when (n+1)p is an
      // integer; we report the lower, matching ⌊(n+1)p⌋).
      return Math.floor((v.meta.n + 1) * v.meta.p);
    case 'weibull':
      // λ·((k−1)/k)^(1/k) for k > 1; the density peaks at 0 for k ≤ 1.
      return v.meta.shape > 1
        ? v.meta.scale * ((v.meta.shape - 1) / v.meta.shape) ** (1 / v.meta.shape)
        : 0;
    default:
      // uniform (flat), exponential (peaks at 0 but left to the sample path),
      // poisson, beta — no analytic mode reported here.
      return null;
  }
}

// --- analytical skewness (third standardized moment) ------------------------
//
// The Fisher–Pearson skewness γ₁ — positive = long upper tail (upside risk),
// negative = long lower tail. Exact for families with a closed form; null for
// the rest (weibull, triangular, pert), where the caller reads the sample
// skewness instead.

export function analyticalSkew(v: Value): number | null {
  switch (v.meta?.kind) {
    case 'normal':
    case 'uniform':
      return 0;
    case 'exponential':
      return 2;
    case 'poisson':
      return 1 / Math.sqrt(v.meta.lambda);
    case 'lognormal': {
      const e = Math.exp(v.meta.sigma * v.meta.sigma);
      return (e + 2) * Math.sqrt(e - 1);
    }
    case 'binomial': {
      const { n, p } = v.meta;
      return (1 - 2 * p) / Math.sqrt(n * p * (1 - p));
    }
    case 'beta': {
      const { a, b } = v.meta;
      return (2 * (b - a) * Math.sqrt(a + b + 1)) / ((a + b + 2) * Math.sqrt(a * b));
    }
    default:
      // weibull, triangular, pert — no simple closed form; sample it.
      return null;
  }
}

// --- analytical percentile (inverse CDF) ------------------------------------
//
// `p(d, q)` for known families. Returns null for distributions where the
// inverse CDF isn't a simple closed form (pert, triangular — could be added
// later but the inverse CDF is messy).

export function analyticalPercentile(v: Value, q: number): number | null {
  if (!(q >= 0 && q <= 1)) {
    throw new Error(`p: percentile q must be between 0 and 1, got ${q}`);
  }
  if (q === 0) {
    switch (v.meta?.kind) {
      case 'normal':
        return -Infinity;
      case 'lognormal':
        return 0;
      case 'uniform':
        return v.meta.lo;
      case 'exponential':
        return 0;
      case 'poisson':
        return 0;
      case 'beta':
        return 0;
      case 'weibull':
        return 0;
      default:
        return null;
    }
  }
  if (q === 1) {
    switch (v.meta?.kind) {
      case 'normal':
        return Infinity;
      case 'lognormal':
        return Infinity;
      case 'uniform':
        return v.meta.hi;
      case 'exponential':
        return Infinity;
      case 'poisson':
        return Infinity;
      case 'beta':
        return 1;
      case 'weibull':
        return Infinity;
      default:
        return null;
    }
  }
  const z = normalInverseCdf(q);
  switch (v.meta?.kind) {
    case 'normal':
      return v.meta.mean + z * v.meta.sd;
    case 'lognormal':
      return Math.exp(v.meta.mu + z * v.meta.sigma);
    case 'uniform':
      return v.meta.lo + (v.meta.hi - v.meta.lo) * q;
    case 'exponential':
      // Q(q) = -mean · ln(1 − q)
      return -v.meta.mean * Math.log(1 - q);
    case 'weibull':
      // Q(q) = λ·(−ln(1 − q))^(1/k) — the sampler's inverse CDF, exact.
      return v.meta.scale * (-Math.log(1 - q)) ** (1 / v.meta.shape);
    case 'beta':
      // No closed form without the regularised incomplete beta function.
      // simple-statistics doesn't ship one; we fall back to samples.
      return null;
    default:
      // poisson, triangular, pert — no closed-form inverse CDF; the caller
      // reads the empirical quantile from the sample array.
      return null;
  }
}

// --- analytical arithmetic (Phase 3) ----------------------------------------
//
// Each entry takes two `Value`s plus optional scalar arithmetic context
// (a scalar multiplier or addend) and tries to produce a new `Value` whose
// `meta` captures the closed-form result. Returns null when no closed form
// applies — the engine then samples elementwise as today.

// Normal ⊕ Normal combinations that preserve the family. For jointly-normal
// X ~ N(μ₁,σ₁) and Y ~ N(μ₂,σ₂) with correlation ρ:
//   X ± Y  ~ N(μ₁±μ₂, √(σ₁²+σ₂² ± 2ρσ₁σ₂))   (ρ from the paired samples)
//   X · k  ~ N(k·μ₁, |k|·σ₁)        (k scalar)
//   X + k  ~ N(μ₁+k, σ₁)             (k scalar)
//   X - k  ~ N(μ₁-k, σ₁)
//   X · Y  — not normal (closed form is messier); fall back to MC
// The cross term makes x + x (ρ=1) yield sd 2σ and x − x yield 0, and carries
// an imposed `correlate` coupling into the sum; independent operands snap ρ to
// 0 (see structuralCorr) so the spread stays the exact independence value.
export function normalOp(op: '+' | '-' | '*' | '/', a: Value, b: Value): Value | null {
  const ma = a.meta?.kind === 'normal' ? a.meta : null;
  const mb = b.meta?.kind === 'normal' ? b.meta : null;

  // X + Y / X - Y where both are normal: closed form (X - Y).
  if (ma && mb && (op === '+' || op === '-')) {
    const sign = op === '+' ? 1 : -1;
    const rho = a.samples && b.samples ? structuralCorr(a.samples, b.samples) : 0;
    const newMean = ma.mean + sign * mb.mean;
    const newSd = Math.sqrt(
      Math.max(0, ma.sd * ma.sd + mb.sd * mb.sd + 2 * sign * rho * ma.sd * mb.sd)
    );
    const dim: Dimension = op === '+' ? a.dim : { ...a.dim };
    // X - Y has the *same* dim as X (Y is subtracted, dim cancels).
    return { dim, meta: { kind: 'normal', mean: newMean, sd: newSd } };
  }

  // X * k or X / k where one side is a scalar.
  if (ma && b.scalar != null && (op === '*' || op === '/')) {
    const k = op === '*' ? b.scalar : 1 / b.scalar;
    const dim: Dimension = { ...a.dim };
    // Multiplication/division by a scalar preserves units-of-1; dim stays.
    return { dim, meta: { kind: 'normal', mean: ma.mean * k, sd: ma.sd * Math.abs(k) } };
  }
  if (mb && a.scalar != null && (op === '*' || op === '/')) {
    const k = op === '*' ? a.scalar : a.scalar; // scalar / normal isn't a normal
    if (op === '/') return null;
    return { dim: b.dim, meta: { kind: 'normal', mean: mb.mean * k, sd: mb.sd * Math.abs(k) } };
  }

  // X + k / X - k where k is a scalar in the same units as X.
  if (ma && b.scalar != null && (op === '+' || op === '-')) {
    const sign = op === '+' ? 1 : -1;
    return {
      dim: a.dim,
      meta: { kind: 'normal', mean: ma.mean + sign * b.scalar, sd: ma.sd }
    };
  }

  return null;
}

// Lognormal combinations that preserve the family. For X = exp(A), Y = exp(B)
// with A, B normal and correlation ρ (of the logs):
//   X · Y  ~ Lognormal(μ₁+μ₂, √(σ₁²+σ₂² + 2ρσ₁σ₂))   (the operation that matters)
//   X / Y  ~ Lognormal(μ₁-μ₂, √(σ₁²+σ₂² − 2ρσ₁σ₂))
//   X · k  ~ Lognormal(μ + ln(k), σ)          (k > 0)
//   X + k  — not lognormal; fall back to MC
// The log-space cross term makes x / x (ρ=1) collapse to a point; independent
// operands snap ρ to 0, keeping the exact independence spread.
export function lognormalOp(op: '+' | '-' | '*' | '/', a: Value, b: Value): Value | null {
  const ma = a.meta?.kind === 'lognormal' ? a.meta : null;
  const mb = b.meta?.kind === 'lognormal' ? b.meta : null;

  if (ma && mb && (op === '*' || op === '/')) {
    const sign = op === '*' ? 1 : -1;
    const rho = a.samples && b.samples ? structuralLogCorr(a.samples, b.samples) : 0;
    const newMu = ma.mu + sign * mb.mu;
    const newSigma = Math.sqrt(
      Math.max(0, ma.sigma * ma.sigma + mb.sigma * mb.sigma + 2 * sign * rho * ma.sigma * mb.sigma)
    );
    return {
      dim: a.dim,
      meta: { kind: 'lognormal', mu: newMu, sigma: newSigma }
    };
  }

  if (ma && b.scalar != null && (op === '*' || op === '/') && b.scalar > 0) {
    const k = op === '*' ? Math.log(b.scalar) : -Math.log(b.scalar);
    return {
      dim: a.dim,
      meta: { kind: 'lognormal', mu: ma.mu + k, sigma: ma.sigma }
    };
  }
  if (mb && a.scalar != null && op === '*' && a.scalar > 0) {
    return {
      dim: b.dim,
      meta: { kind: 'lognormal', mu: mb.mu + Math.log(a.scalar), sigma: mb.sigma }
    };
  }

  return null;
}

// Top-level dispatcher for a binary op. Returns a closed-form `Value` if one
// exists, otherwise null. The dim is the same as the engine's `binop` would
// compute; callers can re-derive if needed.
export function closedFormBinop(
  op: '+' | '-' | '*' | '/' | '^' | '<' | '>' | '<=' | '>=',
  a: Value,
  b: Value,
  outDim: Dimension
): Value | null {
  if (op !== '+' && op !== '-' && op !== '*' && op !== '/') return null;
  const n = normalOp(op, a, b);
  if (n) return { ...n, dim: outDim };
  const l = lognormalOp(op, a, b);
  if (l) return { ...l, dim: outDim };
  return null;
}
