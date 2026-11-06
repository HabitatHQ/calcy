import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Engine } from '../src/lib/engine';
import { summarize } from '../src/lib/engine/mc';

const evaluate = (source: string, N = 500) => {
  const line = new Engine({ N }).evalSheet(source).lines.at(-1);
  if (!line) throw new Error('expected an evaluated line');
  return line;
};

describe('currency denominations retain their value and unit', () => {
  it.each([
    ['100 cents', '100 cents'],
    ['$5 in cents', '500 cents'],
    ['50 k$', '50 k$'],
    ['$50000 in k$', '50 k$'],
    ['unit lakh = 100000 INR\n5 lakh', '5 lakh'],
    ['100 INR', '₹100.00']
  ])('%s displays an unambiguous amount', (source, text) => {
    const line = evaluate(source);
    expect(line.error).toBeUndefined();
    expect(line.display?.text).toBe(text);
  });

  it('round-trips displayed scaled currency expressions without changing the amount', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 999 }),
        fc.constantFrom('cents', 'k$', 'INR'),
        (amount, unit) => {
          const source = `${amount} ${unit}`;
          const displayed = evaluate(source).display?.text;
          expect(displayed).toBeDefined();
          const original = evaluate(`${source} in ${unit}`);
          const restored = evaluate(`${displayed} in ${unit}`);
          expect(restored.error).toBeUndefined();
          expect(Number(restored.display?.value)).toBeCloseTo(Number(original.display?.value), 8);
        }
      ),
      { seed: 7, numRuns: 40 }
    );
  });
});

describe('distribution parameter ordering', () => {
  it.each([
    'uniform(10, 2)',
    'lognormal(100, 10)',
    'ci(10, 2)',
    'p10: -2, p90: -10'
  ])('rejects reversed bounds: %s', (source) => {
    expect(evaluate(source).error).toMatch(/bound|order/i);
    expect(evaluate(`mean(${source})`).error).toBeDefined();
  });

  it('ordered uniform distributions have nonnegative spread and monotonic quantiles', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -100, max: 100 }),
        fc.integer({ min: 0, max: 100 }),
        (lo, width) => {
          const engine = new Engine({ N: 30 });
          const rows = engine.evalSheet(
            `d = uniform(${lo}, ${lo + width})\nsd(d)\np(d, 0.05)\np(d, 0.95)`
          ).lines;
          expect(rows.map((row) => row.error)).toEqual([
            undefined,
            undefined,
            undefined,
            undefined
          ]);
          expect(Number(rows[1].display?.value)).toBeGreaterThanOrEqual(0);
          expect(Number(rows[2].display?.value)).toBeLessThanOrEqual(
            Number(rows[3].display?.value)
          );
        }
      ),
      { seed: 42, numRuns: 30 }
    );
  });
});

describe('configuration and custom unit boundaries', () => {
  it.each([
    0,
    -1,
    NaN,
    Infinity,
    -Infinity
  ])('rejects invalid calendar days %s at both options', (days) => {
    expect(() => new Engine({ monthDays: days })).toThrow(/month/);
    expect(() => new Engine({ yearDays: days })).toThrow(/year/);
  });
  it.each([0, 1, -1, 1.5, NaN, Infinity])('rejects invalid confidence %s', (confidence) => {
    expect(() => new Engine({ confidence })).toThrow(/confidence/);
  });
  it.each([
    '0 m',
    '-1 m',
    '(0/0) m',
    '(1/0) m'
  ])('rejects invalid unit and bridge scale: %s', (definition) => {
    const engine = new Engine();
    expect(() => engine.defineUnit('invalid', definition)).toThrow(/finite|positive/);
    expect(() => engine.defineBridge('invalid', definition)).toThrow(/finite|positive/);
    expect(evaluate(`unit invalid = ${definition}`).error).toBeDefined();
  });
  it('loads dependency-ordered definitions independent of backup key order', () => {
    const engine = new Engine({}, { second_unit: '3 first_unit', first_unit: '2 m' });
    expect(engine.evalSheet('1 second_unit in m').lines[0].display?.value).toBe('6');
    expect(
      () => new Engine({}, { custom_alpha: '3 custom_beta', custom_beta: '2 custom_alpha' })
    ).toThrow(/custom unit/);
    expect(() => new Engine({}, { in: '2 m' })).toThrow();
  });
  it('keeps current-sheet declarations discoverable but removes them when the sheet changes', () => {
    const engine = new Engine();
    engine.evalSheet('unit stride = 2 m');
    expect(engine.units.has('stride')).toBe(true);
    engine.evalSheet('1 m');
    expect(engine.units.has('stride')).toBe(false);
  });
});

describe('correlation block validation', () => {
  const members = 'correlate:\n  a = normal(0, 1)\n  b = normal(0, 1)\n';
  it('exports a singleton block for downstream arithmetic', () => {
    const rows = new Engine({ N: 20 }).evalSheet('correlate:\n  a = normal(10, 1)\na + 1').lines;
    expect(rows[2].error).toBeUndefined();
    expect(rows[2].summary).toMatchObject({ kind: 'dist', mean: 11 });
  });
  it.each([1, 2])('reports insufficient samples honestly for N=%s', (N) => {
    const result = new Engine({ N }).evalSheet(`${members}  cor(a, b) = 0.5`);
    expect(result.lines[0].error).toMatch(/more samples than variables/i);
  });
  it('rejects a repeated unordered pair and an assignment as correlation', () => {
    expect(evaluate(`${members}  cor(a, b) = 0.5\n  cor(b, a) = -0.5`).error).toMatch(/duplicate/);
    expect(evaluate(`${members}  cor(a, b) = x = 0.5`).error).toMatch(/number expression/);
  });
  it('rejects a non-positive-definite target even with one sample', () => {
    const source = `${members}  c = normal(0, 1)\n  cor(a, b) = 0.9\n  cor(a, c) = 0.9\n  cor(b, c) = -0.9`;
    expect(new Engine({ N: 1 }).evalSheet(source).lines[0].error).toMatch(
      /correlation matrix is not positive definite/
    );
  });
  it('keeps invalid correlation members local to their line', () => {
    const rows = new Engine({ N: 20 }).evalSheet('correlate:\n  a = normal(0, 1 / 0)\n2 + 2').lines;
    expect(rows[1].error).toMatch(/non-finite/);
    expect(rows[2].display?.value).toBe('4');
  });
});

describe('scenario boundary errors', () => {
  it.each([
    'sqrt(scenario(low: -1, high: 4))',
    'scenario(low: 0/0, high: 1)',
    'min(sqrt(scenario(low: -1, high: 4)) over case)'
  ])('rejects a non-finite cell before it can poison another operation: %s', (source) => {
    expect(evaluate(source).error).toMatch(/non-finite/);
  });

  it('returns no scalar rate accumulation for a scenario rate', () => {
    const engine = new Engine();
    engine.evalSheet('scenario(low: 1 req/s, high: 2 req/s)');
    expect(engine.accumulate(0, 'day', 1)).toBeNull();
  });
});

it('preserves parenthesized signed range bounds', () => {
  expect(evaluate('sum((-2)..2)').display?.value).toBe('0');
  expect(evaluate('min((-2)..2)').display?.value).toBe('-2');
});

describe('distribution summary domain errors', () => {
  it.each([NaN, Infinity, -Infinity])('rejects a partial non-finite sample set: %s', (invalid) => {
    expect(() => summarize({ dim: {}, samples: Float64Array.of(1, invalid, 3) })).toThrow(
      /non-finite/
    );
  });
});
