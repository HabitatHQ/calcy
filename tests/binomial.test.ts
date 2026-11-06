import { describe, expect, it } from 'vitest';
import { values } from './helpers';

// binomial(trials = n, p): fixed-n successes — "concurrent failures out of 100
// servers". Unlike poisson (unbounded window), it can never exceed n. Whole
// counts; assumes independent trials.
const STAT = { N: 40000, seed: 7 };

const summaryOf = (src: string, opts = STAT) => {
  const l = values(src, opts)[0];
  if (l.error) throw new Error(`${src} → ${l.error}`);
  if (l.summary?.kind !== 'dist') throw new Error(`expected dist for: ${src}`);
  return l.summary;
};

const exact = (src: string, opts = STAT): number => {
  const l = values(src, opts)[0];
  if (l.error) throw new Error(`${src} → ${l.error}`);
  if (l.summary?.kind !== 'point') throw new Error(`expected point for: ${src}`);
  return l.summary.value;
};

describe('binomial(trials, p)', () => {
  it('exact analytic mean = n·p', () => {
    expect(exact('mean(binomial(100, 0.02))')).toBeCloseTo(2, 9);
    expect(exact('mean(binomial(500, 0.3))')).toBeCloseTo(150, 9);
  });

  it('displayed sd = √(n·p·(1−p))', () => {
    // n = 100, p = 0.02 → sd = √1.96 = 1.4 (summary reads the exact moment).
    expect(summaryOf('binomial(100, 0.02)').sd).toBeCloseTo(1.4, 6);
  });

  it('produces whole counts bounded by n', () => {
    const s = summaryOf('binomial(100, 0.02)');
    expect([s.min, s.p5, s.p50, s.p95, s.max].every((x) => Number.isInteger(x))).toBe(true);
    expect(s.min).toBeGreaterThanOrEqual(0);
    expect(s.max).toBeLessThanOrEqual(100);
  });

  it('carries the count unit of its trials argument', () => {
    expect(values('binomial(100 req, 0.1)', STAT)[0].display?.unit).toBe('req');
    expect(values('binomial(100, 0.1) req', STAT)[0].display?.unit).toBe('req');
  });

  it('accepts keyword params in either order', () => {
    expect(exact('mean(binomial(trials = 100, p = 0.02))')).toBeCloseTo(2, 9);
    expect(exact('mean(binomial(p = 0.02, trials = 100))')).toBeCloseTo(2, 9);
  });

  it('rejects a non-integer trials count (no silent rounding)', () => {
    expect(values('binomial(10.5, 0.2)')[0].error).toMatch(/integer/);
  });

  it('rejects p outside [0, 1] and a dimensioned p', () => {
    expect(values('binomial(10, 1.5)')[0].error).toMatch(/between 0 and 1|p must/);
    expect(values('binomial(10, -0.1)')[0].error).toMatch(/between 0 and 1|p must/);
    expect(values('binomial(10, 0.2 day)')[0].error).toMatch(/dimensionless|p /);
  });

  it('keeps the analytical mode within the binomial support', () => {
    expect(exact('mode(binomial(10, 1))')).toBe(10);
    expect(exact('mode(binomial(0, 1))')).toBe(0);
  });

  it('preserves unique and tied interior modes', () => {
    expect(exact('mode(binomial(10, 0.3))')).toBe(3);
    // (n + 1)p = 5, so either adjacent value is a valid mode.
    expect([4, 5]).toContain(exact('mode(binomial(9, 0.5))'));
  });
});
