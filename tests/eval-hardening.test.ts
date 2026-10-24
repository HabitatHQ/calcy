import { describe, expect, it } from 'vitest';
import { lines, makeEngine, one } from './helpers';

// Hardening regressions for the evaluator: crashes and missing validation that
// let NaN / Infinity / garbage out, or that surfaced an internal error instead
// of a usable message. Errors are reported per-line (LineResult.error), so we
// assert on that rather than on a thrown exception.

const err = (src: string): string => {
  const results = lines(src);
  const last = results[results.length - 1];
  return last?.error ?? '';
};
const scalar = (src: string): number => Number(one(src).display?.value);

describe('min()/max() do not overflow the stack on large arrays', () => {
  it('min() over a huge list folds instead of spreading', () => {
    // `0..200000` is a list far larger than the call-argument limit, which
    // `Math.min(...list)` would blow. Default settings.
    expect(scalar('min(0..200000)')).toBe(0);
    expect(scalar('max(0..200000)')).toBe(200000);
  });

  it('min()/max() over a large sample array fold', () => {
    const r = one('min(normal(0, 1))', { N: 200000 });
    expect(r.error).toBeUndefined();
    expect(Number(r.display?.value)).toBeLessThan(0);
  });
});

describe('no-arg calls report an arity error, not an internal crash', () => {
  for (const fn of ['mean', 'min', 'max', 'median', 'sd', 'sqrt', 'abs', 'sin', 'ln', 'round']) {
    it(`${fn}() is a clean error`, () => {
      const e = err(`${fn}()`);
      expect(e).toContain(`${fn}()`);
      expect(e).not.toMatch(/Cannot read propert/);
    });
  }
});

describe('range and numeric literal hardening', () => {
  it('handles large singleton ranges and rejects non-advancing cardinalities', () => {
    expect(scalar('sum(10000000000000000..10000000000000000)')).toBe(1e16);
    expect(err('sum(0..2000000)')).toMatch(/cardinality/);
  });

  it('rejects non-finite inputs and steps that cannot advance', () => {
    for (const source of [
      'sum(0..Infinity)',
      'sum(0..1 step (0 / 0))',
      'sum(0..1 step 0)',
      'sum(10000000000000000..10000000000000002)'
    ]) {
      expect(err(source)).toMatch(/finite|positive|forward progress/);
    }
    expect(scalar('sum(0..0.3 step 0.1)')).toBeCloseTo(0.6);
  });

  it('rejects malformed decimals and exponents while preserving valid forms', () => {
    for (const src of ['1.2.3', '1e+', '2e3e4']) expect(err(src)).toMatch(/invalid number/);
    expect(scalar('1_000 + 2e3 + 1k')).toBe(4000);
  });

  it('rejects extra operands to unary reducers and math', () => {
    for (const src of ['max(1,100)', 'mean(1,3)', 'min(10,1)', 'sqrt(4,9)'])
      expect(err(src)).toMatch(/exactly one argument/);
    expect(scalar('sum(1,2)')).toBe(3);
  });
});

describe('custom units reject invalid scales at definition', () => {
  it('rejects zero, infinite, and NaN scales', () => {
    for (const definition of [
      'unit broken = 0 m',
      'unit broken = 1e999 m',
      'unit broken = 0 / 0 m'
    ])
      expect(err(definition)).not.toBe('');
    expect(() => makeEngine({}, { broken: '0 m' })).toThrow(/finite and non-zero/);
    const engine = makeEngine();
    expect(() => engine.defineUnit('broken', '0 m')).toThrow(/finite and non-zero/);
  });
});
describe('distribution constructors validate their parameters', () => {
  it('normal rejects a negative sd', () => {
    expect(err('normal(0, -1)')).toMatch(/sd must be non-negative/);
  });
  it('normal allows sd = 0 (degenerate point)', () => {
    expect(err('normal(5, 0)')).toBe('');
  });
  it('beta rejects non-positive shape params', () => {
    expect(err('beta(0, 0)')).toMatch(/must be positive/);
    expect(err('beta(-1, 2)')).toMatch(/must be positive/);
  });
});

describe('cagr rejects non-positive periods (no Infinity leak)', () => {
  it('periods = 0 is an error', () => {
    expect(err('cagr(100, 200, 0)')).toMatch(/periods must be positive/);
  });
  it('a valid cagr still computes', () => {
    // 100 → 200 over 1 period = 100% growth.
    expect(scalar('cagr(100, 200, 1)')).toBeCloseTo(1, 6);
  });
});
