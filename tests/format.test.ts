import { describe, expect, it } from 'vitest';
import { formatNumber, formatSummary } from '../src/lib/engine/format';
import type { DistSummary, PointSummary } from '../src/lib/engine/mc';

describe('formatNumber — auto (default)', () => {
  // Below 1000 stays literal; from thousands upward the short-scale suffix
  // kicks in so 225689 reads as 226K instead of bloating the result line.
  // The extremes (beyond trillions, or tiny) fall back to e-notation.
  it.each([
    [0, '0'],
    [5, '5'],
    [-5, '-5'],
    [60, '60'],
    [Math.PI, '3.14'],
    [0.1728, '0.173'],
    [999, '999'],
    [12000, '12K'],
    [999999, '1M'],
    [1e6, '1M'],
    [1.0368e9, '1.04B'],
    [3.1104e10, '31.1B'],
    [-2.5e8, '-250M'],
    [1.5e12, '1.5T'],
    [1e15, '1e15'],
    [5e-7, '5e-7'],
    [1.5e-5, '1.5e-5'],
    [0.0001, '0.0001']
  ])('formatNumber(%d) = %s', (n, expected) => {
    expect(formatNumber(n)).toBe(expected);
  });
});

describe('formatNumber — compact (1M / 1B)', () => {
  // Suffixes kick in from thousands upward.
  it.each([
    [12000, '12K'],
    [999999, '1M'],
    [1e6, '1M'],
    [1.0368e9, '1.04B'],
    [3.1104e10, '31.1B'],
    [-2.5e8, '-250M'],
    [1.5e12, '1.5T'],
    [1e15, '1e15'],
    [500, '500'],
    [5e-7, '5e-7']
  ])('formatNumber(%d, compact) = %s', (n, expected) => {
    expect(formatNumber(n, 'compact')).toBe(expected);
  });
});

describe('formatNumber — scientific (1e9)', () => {
  it.each([
    [12000, '12000'],
    [999999, '999999'],
    [1e6, '1e6'],
    [1.0368e9, '1.04e9'],
    [3.1104e10, '3.11e10'],
    [-2.5e8, '-2.5e8'],
    [5e-7, '5e-7'],
    [1.5e-5, '1.5e-5'],
    [0.0001, '0.0001']
  ])('formatNumber(%d, scientific) = %s', (n, expected) => {
    expect(formatNumber(n, 'scientific')).toBe(expected);
  });
});

describe('formatNumber — newspaper (1 million)', () => {
  // Spelled-out scale words from thousands upward; below that it reads plain.
  it.each([
    [60, '60'],
    [999, '999'],
    [12000, '12 thousand'],
    [999999, '1 million'],
    [1e6, '1 million'],
    [1.0368e9, '1.04 billion'],
    [3.1104e10, '31.1 billion'],
    [-2.5e8, '-250 million'],
    [1.5e12, '1.5 trillion'],
    [1e15, '1e15'],
    [5e-7, '5e-7']
  ])('formatNumber(%d, newspaper) = %s', (n, expected) => {
    expect(formatNumber(n, 'newspaper')).toBe(expected);
  });
});

describe('formatNumber', () => {
  it('handles non-finite values in every mode', () => {
    for (const fmt of ['auto', 'compact', 'newspaper', 'scientific'] as const) {
      expect(formatNumber(Number.NaN, fmt)).toBe('NaN');
      expect(formatNumber(Number.POSITIVE_INFINITY, fmt)).toBe('∞');
      expect(formatNumber(Number.NEGATIVE_INFINITY, fmt)).toBe('-∞');
    }
  });
});

const point = (value: number, dim = {}): PointSummary => ({ kind: 'point', value, dim });
const dist = (over: Partial<DistSummary> = {}): DistSummary => {
  const base = {
    kind: 'dist' as const,
    dim: {},
    mean: 0,
    sd: 0,
    min: 0,
    max: 0,
    p5: 0,
    p25: 0,
    p50: 0,
    p75: 0,
    p95: 0,
    skew: 0,
    hist: [],
    histMin: 0,
    histMax: 0,
    ...over
  };
  // At the 0.9 default the displayed band equals p5/p95; mirror that here so
  // existing text assertions hold unless a test pins its own ci bounds.
  return {
    ...base,
    ciLow: over.ciLow ?? base.p5,
    ciHigh: over.ciHigh ?? base.p95,
    ciLevel: over.ciLevel ?? 0.9
  };
};

describe('formatSummary — points', () => {
  it('dimensionless and dimensioned points', () => {
    expect(formatSummary(point(5))).toMatchObject({
      kind: 'point',
      value: '5',
      unit: '',
      text: '5'
    });
    expect(formatSummary(point(3, { length: 1 }))).toMatchObject({ unit: 'm', text: '3 m' });
  });
  it('a pinned unit rescales the magnitude', () => {
    const out = formatSummary(point(5000, { length: 1 }), { label: 'km', factor: 1000 });
    expect(out).toMatchObject({ value: '5', unit: 'km', text: '5 km' });
  });
  it('honours the number format', () => {
    expect(formatSummary(point(1.0368e9, { req: 1 }), undefined, 'auto').text).toBe('1.04B req');
    expect(formatSummary(point(1.0368e9, { req: 1 }), undefined, 'scientific').text).toBe(
      '1.04e9 req'
    );
  });
});

describe('formatSummary — distributions', () => {
  it('renders median (p5 … p95) with the unit', () => {
    const out = formatSummary(dist({ dim: { req: 1 }, min: 1, max: 9, p5: 2, p50: 5, p95: 8 }));
    expect(out.kind).toBe('dist');
    expect(out).toMatchObject({ p5: '2', p50: '5', p95: '8', unit: 'req' });
    expect(out.text).toBe('5 (2 … 8) req');
  });
  it('a pinned unit rescales every percentile', () => {
    const out = formatSummary(
      dist({ dim: { data: 1 }, min: 1e6, max: 9e6, p5: 2e6, p50: 5e6, p95: 8e6 }),
      { label: 'MB', factor: 8e6 }
    );
    expect(out).toMatchObject({ p5: '0.25', p50: '0.625', p95: '1', unit: 'MB' });
  });
  it('a zero-spread distribution collapses to a point', () => {
    const out = formatSummary(dist({ min: 7, max: 7, p5: 7, p50: 7, p95: 7 }));
    expect(out).toMatchObject({ kind: 'point', value: '7', text: '7' });
  });
});

describe('formatSummary — baseUnit (hover decomposition)', () => {
  // baseUnit carries the canonical base-dimension signature for the hover
  // tooltip. It is dimToString(dim), independent of any pinned display label,
  // and absent for dimensionless values (an empty tooltip is noise).
  it('is absent for a dimensionless value', () => {
    expect(formatSummary(point(5)).baseUnit).toBeUndefined();
  });
  it('equals the display unit when nothing is pinned', () => {
    expect(formatSummary(point(3, { length: 1 })).baseUnit).toBe('m');
  });
  it('shows the base decomposition under a pinned label', () => {
    const out = formatSummary(point(5000, { length: 1 }), { label: 'km', factor: 1000 });
    expect(out).toMatchObject({ unit: 'km', baseUnit: 'm' });
  });
  it('decomposes a pinned composite rate to base units', () => {
    const out = formatSummary(point(10, { length: 1, time: -1 }), {
      label: 'km/h',
      factor: 1000 / 3600
    });
    expect(out).toMatchObject({ unit: 'km/h', baseUnit: 'm/s' });
  });
  it('is present on distributions too', () => {
    const out = formatSummary(dist({ dim: { length: 1 }, min: 1, max: 9, p5: 2, p50: 5, p95: 8 }));
    expect(out.baseUnit).toBe('m');
  });
});

describe('formatSummary — money (auto-detected currency units)', () => {
  // Currency units get $-prefixed, 2-decimal, thousands-separated display in
  // the user-facing `text`. The numeric fields (value, p5, p50, p95) stay
  // machine-parseable so Number(value) keeps working for tests / clipboard.
  const usd = { usd: 1 };
  const eur = { eur: 1 };
  const gbp = { gbp: 1 };
  const jpy = { jpy: 1 };

  it('renders a USD scalar with prefix and 2 decimals', () => {
    expect(formatSummary({ kind: 'point', value: 1234.5, dim: usd }).text).toBe('$1,234.50');
  });
  it('renders zero, negative, and small money values', () => {
    expect(formatSummary({ kind: 'point', value: 0, dim: usd }).text).toBe('$0.00');
    expect(formatSummary({ kind: 'point', value: -42, dim: usd }).text).toBe('-$42.00');
    expect(formatSummary({ kind: 'point', value: 0.5, dim: usd }).text).toBe('$0.50');
  });
  it('uses the right symbol for each currency', () => {
    expect(formatSummary({ kind: 'point', value: 100, dim: eur }).text).toBe('€100.00');
    expect(formatSummary({ kind: 'point', value: 100, dim: gbp }).text).toBe('£100.00');
    expect(formatSummary({ kind: 'point', value: 100, dim: jpy }).text).toBe('¥100.00');
  });
  it('renders a distribution with money format on every bound (in text)', () => {
    const out = formatSummary(
      dist({ dim: usd, min: 800, max: 1500, p5: 850, p50: 1100, p95: 1400 })
    );
    expect(out.kind).toBe('dist');
    expect(out.text).toBe('$1,100.00 ($850.00 … $1,400.00)');
    // numeric fields stay raw so they round-trip via Number(...) regardless
    // of the user's number-format choice
    expect(out.p5).toBe('850');
    expect(out.p50).toBe('1100');
    expect(out.p95).toBe('1400');
    expect(Number(out.p5)).toBeCloseTo(850);
    expect(Number(out.p50)).toBeCloseTo(1100);
    expect(Number(out.p95)).toBeCloseTo(1400);
  });
  it('a zero-spread money distribution collapses to a money point', () => {
    const out = formatSummary(dist({ dim: usd, min: 100, max: 100, p5: 100, p50: 100, p95: 100 }));
    expect(out).toMatchObject({ kind: 'point', value: '100', text: '$100.00' });
  });
  it('a pinned $ unit still gets money format', () => {
    const out = formatSummary(
      { kind: 'point', value: 100000, dim: usd },
      { label: '$', factor: 1 }
    );
    expect(out.text).toBe('$100,000.00');
  });
  it('non-currency dimensioned values are unaffected', () => {
    expect(formatSummary({ kind: 'point', value: 3, dim: { length: 1 } }).text).toBe('3 m');
  });
  it('machine-parseable value is unaffected by money display', () => {
    const out = formatSummary({ kind: 'point', value: 100, dim: usd });
    expect(Number(out.value)).toBeCloseTo(100);
  });
});
