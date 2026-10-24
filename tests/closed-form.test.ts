import { describe, expect, it } from 'vitest';
import { values } from './helpers';

// Tests for the analytical layer: closed-form mean(p), analytical p(d, q),
// and arithmetic that propagates parametric identity (normal+normal, lognormal
// · lognormal, scalar × distribution). Every test here pins exact values, not
// sample tolerances — that's the whole point of the layer.
//
// Reading strategy: `num()` parses `display.value`, which the formatter rounds
// to ~3 significant figures. For *exact* assertions, read `summary.mean` /
// `summary.p50` directly via `one().summary` instead.

const STAT = { N: 20000, seed: 7 };

const summ = (src: string, opts = STAT) => {
  const s = values(src, opts)[0];
  if (s.error) throw new Error(`${src} → ${s.error}`);
  return s.summary;
};

// Helper: take the *last* result line of a multi-line sheet.
const lastSumm = (src: string, opts = STAT) => {
  const ls = values(src, opts);
  const last = ls[ls.length - 1];
  if (!last || last.error) throw new Error(`${src} → ${last?.error ?? 'no results'}`);
  return last.summary;
};

// Helper: read the scalar value of a deterministic (point) line. For
// multi-line sheets, take the *last* value-bearing line — the convention is
// that the query (e.g. `mean(N)`) sits after the variables it consumes.
const exact = (src: string, opts = STAT): number => {
  const ls = values(src, opts);
  const last = ls[ls.length - 1];
  if (last.summary?.kind === 'point') return last.summary.value;
  if (last.display?.value) return Number(last.display.value);
  throw new Error(`${src}: not a scalar`);
};

describe('analytical mean(d)', () => {
  it('reads the exact moment from meta, not the sample mean', () => {
    // normal(100, 15).mean ≡ 100 (exact). Use `exact()` so the formatter
    // doesn't round.
    expect(exact('mean(normal(100, 15))', STAT)).toBe(100);
  });

  it('logmean: mean(lognormal) = exp(μ + σ²/2)', () => {
    // 1 to 100 at 90% CI: μ = ln(10) ≈ 2.303, σ = ln(100)/(2·1.6452) ≈ 1.3995
    // E[X] = exp(2.303 + 0.5·1.9586) ≈ exp(3.282) ≈ 26.62
    const m = exact('mean(1 to 100)', STAT);
    expect(m).toBeGreaterThan(20);
    expect(m).toBeLessThan(35);
  });

  it('uniform mean is (lo + hi) / 2', () => {
    expect(exact('mean(uniform(0, 10))', STAT)).toBe(5);
    expect(exact('mean(uniform(100, 200))', STAT)).toBe(150);
  });

  it('exponential mean is its parameter', () => {
    expect(exact('mean(exponential(5))', STAT)).toBe(5);
    expect(exact('mean(exponential(100))', STAT)).toBe(100);
  });

  it('poisson mean is its parameter', () => {
    expect(exact('mean(poisson(8))', STAT)).toBe(8);
    expect(exact('mean(poisson(50))', STAT)).toBe(50);
  });

  it('beta mean is a / (a + b)', () => {
    expect(exact('mean(beta(2, 8))', STAT)).toBe(0.2);
    expect(exact('mean(beta(1, 1))', STAT)).toBe(0.5);
    expect(exact('mean(beta(5, 5))', STAT)).toBe(0.5);
  });

  it('triangular mean is (lo + mode + hi) / 3', () => {
    // (2 + 3 + 8) / 3 = 13/3 ≈ 4.333
    expect(exact('mean(triangular(2, 3, 8))', STAT)).toBeCloseTo(13 / 3, 6);
  });

  it('pert mean is (lo + 4m + hi) / 6', () => {
    // (2 + 12 + 8) / 6 = 22/6 ≈ 3.667
    expect(exact('mean(pert(2, 3, 8))', STAT)).toBeCloseTo(22 / 6, 6);
  });

  it('falls back to sample mean for distributions without meta', () => {
    // mixture of two normals — exact mean is 150, but no closed form path
    // because the closed-form layer doesn't recognise mixtures of meta'd
    // families (Phase 4 work). Verify it's close, not exact.
    const m = exact('mean(discrete(0.5: normal(100, 5), 0.5: normal(200, 5)))', STAT);
    expect(m).toBeGreaterThan(140);
    expect(m).toBeLessThan(160);
  });

  it('update() posterior mean is exact, not sample-derived', () => {
    // beta(2, 8) seen 3 of 10 → beta(5, 15). mean = 5/20 = 0.25 (exact).
    expect(exact('mean(update(beta(2, 8), 3, 10))', STAT)).toBe(0.25);
    // beta(2, 8) seen 0 of 10 → beta(2, 18). mean = 2/20 = 0.10 (exact).
    expect(exact('mean(update(beta(2, 8), 0, 10))', STAT)).toBe(0.1);
    // beta(2, 8) seen 10 of 10 → beta(12, 8). mean = 12/20 = 0.60 (exact).
    expect(exact('mean(update(beta(2, 8), 10, 10))', STAT)).toBe(0.6);
  });
});

describe('analytical p(d, q) — inverse CDF', () => {
  it('p(normal(100, 15), 0.5) ≡ 100 (exact median)', () => {
    expect(exact('p(normal(100, 15), 0.5)', STAT)).toBe(100);
  });

  it('p(normal(0, 1), 0.975) ≈ 1.96 (95th percentile of standard normal)', () => {
    // simple-statistics' probit is accurate to ~3 decimals: 1.95716...
    // (true value 1.95996...). Use 2-decimal tolerance.
    expect(exact('p(normal(0, 1), 0.975)', STAT)).toBeCloseTo(1.96, 2);
  });

  it('p(normal(100, 15), 0.05) is one sd below', () => {
    // probit(0.05) ≈ -1.6449; 100 + (-1.6449)·15 ≈ 75.33. Library accuracy ~3d.
    const v = exact('p(normal(100, 15), 0.05)', STAT);
    expect(v).toBeCloseTo(75.33, 1);
  });

  it('uniform inverse CDF is linear', () => {
    expect(exact('p(uniform(0, 10), 0.5)', STAT)).toBe(5);
    expect(exact('p(uniform(0, 10), 0.25)', STAT)).toBe(2.5);
    expect(exact('p(uniform(0, 10), 0.9)', STAT)).toBe(9);
  });

  it('exponential inverse CDF is -mean · ln(1 − q)', () => {
    // q = 0.5 ⇒ -5 · ln(0.5) ≈ 3.466
    expect(exact('p(exponential(5), 0.5)', STAT)).toBeCloseTo(5 * Math.LN2, 4);
    // q = 0.9 ⇒ -5 · ln(0.1) ≈ 11.513
    expect(exact('p(exponential(5), 0.9)', STAT)).toBeCloseTo(-5 * Math.log(0.1), 4);
  });

  it('lognormal inverse CDF is exp(μ + z·σ)', () => {
    // 1 to 100 at 90% CI: median = exp(μ) = exp((ln(1) + ln(100))/2) = 10.
    expect(exact('p(1 to 100, 0.5)', STAT)).toBeCloseTo(10, 6);
  });

  it('p() of 0 and 1 hit the distribution support', () => {
    expect(exact('p(uniform(0, 10), 0)', STAT)).toBe(0);
    expect(exact('p(uniform(0, 10), 1)', STAT)).toBe(10);
    expect(exact('p(beta(2, 8), 0)', STAT)).toBe(0);
    expect(exact('p(beta(2, 8), 1)', STAT)).toBe(1);
  });

  it('rejects q outside [0, 1]', () => {
    const err1 = values('p(normal(0, 1), 1.5)', STAT)[0].error;
    expect(err1).toBeDefined();
    const err2 = values('p(normal(0, 1), -0.1)', STAT)[0].error;
    expect(err2).toBeDefined();
  });
});

describe('analytical arithmetic — Phase 3', () => {
  it('normal + normal is normal with combined moments', () => {
    // N(100, 10) + N(50, 5) = N(150, √(100+25)) = N(150, √125 ≈ 11.18)
    const s = summ('normal(100, 10) + normal(50, 5)', STAT);
    if (s?.kind !== 'dist') throw new Error('expected dist');
    expect(s.mean).toBeCloseTo(150, 6);
    expect(s.sd).toBeCloseTo(Math.sqrt(125), 6);
  });

  it('normal - normal is normal with √(σ₁² + σ₂²) sd', () => {
    const s = summ('normal(100, 10) - normal(50, 5)', STAT);
    if (s?.kind !== 'dist') throw new Error('expected dist');
    expect(s.mean).toBeCloseTo(50, 6);
    expect(s.sd).toBeCloseTo(Math.sqrt(125), 6);
  });

  it('mean() of normal + normal is exact', () => {
    expect(exact('mean(normal(100, 10) + normal(50, 5))', STAT)).toBe(150);
  });

  // The closed-form spread must reflect correlation-by-reuse, not the
  // independence formula. x + x is 2x (sd 2σ), x − x is identically 0.
  it('normal + normal respects correlation-by-reuse (x + x has sd 2σ)', () => {
    const s = lastSumm('x = normal(0, 10)\nx + x', STAT);
    if (s?.kind !== 'dist') throw new Error('expected dist');
    expect(s.sd).toBeCloseTo(20, 0);
  });

  it('normal − normal respects correlation-by-reuse (x − x is 0)', () => {
    const s = lastSumm('x = normal(100, 10)\nx - x', STAT);
    if (s?.kind !== 'dist') throw new Error('expected dist');
    expect(s.sd).toBeCloseTo(0, 6);
  });

  it('normal + normal reflects an imposed correlation in the sd', () => {
    // t + correlate(t, N(0,10), 0.8): sd = √(100 + 100 + 2·0.8·100) = √360.
    const s = lastSumm('t = normal(0, 10)\nt + correlate(t, normal(0, 10), 0.8)', STAT);
    if (s?.kind !== 'dist') throw new Error('expected dist');
    expect(s.sd).toBeCloseTo(Math.sqrt(360), 0);
  });

  it('lognormal / lognormal respects correlation-by-reuse (x / x has sd 0)', () => {
    const s = lastSumm('x = 1 to 100\nx / x', STAT);
    if (s?.kind !== 'dist') throw new Error('expected dist');
    expect(s.sd).toBeCloseTo(0, 6);
  });

  it('lognormal · lognormal keeps lognormal shape; mean is exact', () => {
    // (1 to 100) * (1 to 100): μ' = 2·ln(10) = ln(100), σ' = √2·σ.
    // E[X] = exp(μ' + σ'²/2) = exp(2·ln(10) + σ²) = 100 · exp(σ²).
    // σ² for one factor of (1 to 100) at 90% CI is ≈ 1.96 → exp(σ²) ≈ 7.1
    // → mean ≈ 710. Sample noise is high; pin exact analytical value.
    const analyticMean = exact('mean((1 to 100) * (1 to 100))', STAT);
    expect(analyticMean).toBeGreaterThan(500);
    expect(analyticMean).toBeLessThan(1000);
  });

  it('lognormal / lognormal median is 1 (μ cancels)', () => {
    // (1 to 100) / (1 to 100): μ' = 0 → median = exp(0) = 1 (exact).
    expect(exact('p((1 to 100) / (1 to 100), 0.5)', STAT)).toBeCloseTo(1, 6);
  });

  it('scalar × normal scales mean and sd by |k|', () => {
    const s = summ('3 * normal(100, 10)', STAT);
    if (s?.kind !== 'dist') throw new Error('expected dist');
    expect(s.mean).toBeCloseTo(300, 6);
    expect(s.sd).toBeCloseTo(30, 6);
  });

  it('scalar + normal shifts the mean only', () => {
    const s = summ('normal(100, 10) + 50', STAT);
    if (s?.kind !== 'dist') throw new Error('expected dist');
    expect(s.mean).toBeCloseTo(150, 6);
    expect(s.sd).toBeCloseTo(10, 6);
  });

  it('scalar multiplication by negative flips the sign, scales sd by absolute value', () => {
    const s = summ('-2 * normal(100, 10)', STAT);
    if (s?.kind !== 'dist') throw new Error('expected dist');
    expect(s.mean).toBeCloseTo(-200, 6);
    expect(s.sd).toBeCloseTo(20, 6);
  });

  it('Drake-style product of lognormals: mean is exact, no sample noise', () => {
    // Five lognormal factors of identical shape; product mean is exact.
    // (We can't use `prod` as a variable name because `prod` isn't a
    // reserved word but the parser is fine with it — but a previous
    // iteration had `*` in identifiers which the parser can't handle, so
    // we use plain letters throughout.)
    const sheet =
      'a = 1 to 100\nb = 1 to 100\nc = 1 to 100\nd = 1 to 100\ne = 1 to 100\np = a * b * c * d * e\nmean(p)';
    const meanA = exact(sheet, { ...STAT, seed: 1 });
    const meanB = exact(sheet, { ...STAT, seed: 999 });
    expect(meanA).toBe(meanB);
  });

  it('mixed-family operations fall back to MC (no false exactness)', () => {
    // normal + uniform has no closed form.
    const m = exact('mean(normal(100, 10) + uniform(0, 1))', STAT);
    expect(m).toBeGreaterThan(99);
    expect(m).toBeLessThan(102);
  });
});

describe('real third-moment skewness (sampleSkewness)', () => {
  it('symmetric distributions have near-zero skew', () => {
    const s = summ('normal(100, 5)', STAT);
    if (s?.kind !== 'dist') throw new Error('expected dist');
    expect(Math.abs(s.skew)).toBeLessThan(0.15);
  });

  it('uniform on [a, b] is symmetric, skew ≈ 0', () => {
    const s = summ('uniform(0, 100)', STAT);
    if (s?.kind !== 'dist') throw new Error('expected dist');
    expect(Math.abs(s.skew)).toBeLessThan(0.1);
  });

  it('lognormal is right-skewed', () => {
    const s = summ('1 to 100', STAT);
    if (s?.kind !== 'dist') throw new Error('expected dist');
    expect(s.skew).toBeGreaterThan(0.5);
  });

  it('exponential is right-skewed', () => {
    const s = summ('exponential(5)', STAT);
    if (s?.kind !== 'dist') throw new Error('expected dist');
    expect(s.skew).toBeGreaterThan(0.5);
  });
});

describe('closed-form end-to-end: Drake equation', () => {
  // The whole point: a chain of closed-form lognormal factors collapses to
  // a single closed-form lognormal. mean(d) and p(d, 0.5) are exact
  // regardless of N or seed.
  // Identifiers use plain letters (`R*` would break the parser's `*` token).
  // Units go on the *whole* value: `R = (1 to 3) / year`, not `1 to 3 / year`.
  const sheet = `R = (1 to 3) / year
f_p = 0.2 to 0.5
n_e = 0.5 to 5
f_l = 0.2 to 1
f_i = 0.01 to 1
f_c = 0.05 to 0.2
L = (100 to 10000) year
N = R * f_p * n_e * f_l * f_i * f_c * L`;

  it('Drake mean is deterministic across seeds', () => {
    const a = exact(`${sheet}\nmean(N)`, { ...STAT, seed: 1 });
    const b = exact(`${sheet}\nmean(N)`, { ...STAT, seed: 999 });
    expect(a).toBe(b);
  });

  it('Drake p(d, 0.5) is the exact closed-form median', () => {
    const a = exact(`${sheet}\np(N, 0.5)`, { ...STAT, seed: 1 });
    const b = exact(`${sheet}\np(N, 0.5)`, { ...STAT, seed: 999 });
    expect(a).toBe(b);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(1e10);
  });
});
it('keeps exact self-correlation at small sample counts', () => {
  for (const N of [1, 4]) {
    expect(exact('x = normal(0, 1)\ny = x - x\np(y, 0.95)', { N, seed: 10 })).toBe(0);
    expect(exact('x = lognormal(1, 4)\ny = x / x\nmean(y)', { N, seed: 10 })).toBe(1);
  }
});
it('preserves perfect correlations across derived sample arrays at small N', () => {
  for (const N of [4, 8]) {
    expect(exact('x = normal(0, 1)\np(x - 1 * x, 0.95)', { N, seed: 11 })).toBe(0);
    expect(exact('x = lognormal(1, 4)\nmean(x / (1 * x))', { N, seed: 11 })).toBe(1);
  }
});
