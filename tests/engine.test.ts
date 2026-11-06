import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Engine, isValidSampleCount } from '../src/lib/engine';
import { makeEngine, num, values } from './helpers';

describe('engine configuration and sheet declarations', () => {
  it('restores removed and reordered unit directives between evaluations', () => {
    const engine = makeEngine();
    expect(engine.evalSheet('unit stride = 2 m\n1 stride in m').lines[1].display?.value).toBe('2');
    expect(engine.evalSheet('1 stride in m').lines[0].error).toMatch(/unknown|unit/i);

    engine.evalSheet('unit stride = 2 m\nunit pace = 3 stride\n1 pace in m');
    const reordered = engine.evalSheet('unit pace = 3 stride\nunit stride = 4 m\n1 pace in m');
    expect(reordered.lines[0].error).toBeDefined();
    expect(reordered.lines[2].error).toBeDefined();
    expect(
      engine.evalSheet('unit stride = 4 m\nunit pace = 3 stride\n1 pace in m').lines[2].display
        ?.value
    ).toBe('12');
  });

  it('restores overwritten built-ins and sheet-local bridge and currency directives', () => {
    const engine = makeEngine();
    engine.evalSheet('unit m = 2 s\n1 m in s');
    const restored = engine.evalSheet('1 m in s\n1 m in cm');
    expect(restored.lines[0].error).toBeDefined();
    expect(restored.lines[1].display?.value).toBe('100');

    engine.evalSheet('bridge water = 18.015 g/mol\n100 g in mol via water');
    expect(engine.evalSheet('100 g in mol via water').lines[0].error).toMatch(/bridge|water/i);

    engine.evalSheet('currency BTC, bitcoin\n1 BTC in bitcoin');
    expect(engine.evalSheet('1 BTC').lines[0].error).toMatch(/unknown|unit/i);
  });

  it('applies reordered bridge and currency directives only within the current sheet', () => {
    const engine = makeEngine();
    engine.evalSheet('bridge water = 18.015 g/mol\nbridge salt = 58.44 g/mol');
    const bridges = engine.evalSheet(
      'bridge salt = 58.44 g/mol\nbridge water = 18.015 g/mol\n100 g in mol via water'
    );
    expect(Number(bridges.lines[2].display?.value)).toBeCloseTo(100 / 18.015, 6);
    expect(engine.evalSheet('100 g in mol via water').lines[0].error).toMatch(/bridge|water/i);

    engine.evalSheet('currency BTC, bitcoin');
    const currency = engine.evalSheet('currency bitcoin, BTC\n1 BTC in bitcoin');
    expect(currency.lines[1].display?.value).toBe('1');
    expect(engine.evalSheet('1 BTC').lines[0].error).toMatch(/unknown|unit/i);
  });

  it('retains constructor and public declaration configuration across sheets', () => {
    const engine = new Engine({ N: 1 }, { stride: '2 m' });
    engine.evalSheet('unit stride = 4 m');
    expect(engine.evalSheet('1 stride in m').lines[0].display?.value).toBe('2');

    engine.defineUnit('pace', '3 m');
    engine.defineBridge('water', '18.015 g/mol');
    engine.defineCurrency(['COIN', 'coin']);
    const configured = engine.evalSheet('1 pace in m\n100 g in mol via water\n1 COIN in coin');
    expect(configured.lines.every((line) => line.error === undefined)).toBe(true);
    expect(Number(configured.lines[0].display?.value)).toBeCloseTo(3, 2);
    expect(Number(configured.lines[1].display?.value)).toBeCloseTo(5.55, 2);
    expect(configured.lines[2].display).toMatchObject({ value: '1', unit: 'coin' });
  });
});

describe('sample count validation', () => {
  it('accepts only positive safe integers', () => {
    expect([1, Number.MAX_SAFE_INTEGER].map(isValidSampleCount)).toEqual([true, true]);
    expect(
      [0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1].map(isValidSampleCount)
    ).toEqual([false, false, false, false, false, false, false]);
  });

  it('rejects invalid sample counts at construction and evaluates with one sample', () => {
    for (const N of [0, -1, 1.5, NaN, Infinity, -Infinity]) {
      expect(() => new Engine({ N })).toThrow('sample count must be a positive integer');
    }
    const result = new Engine({ N: 1 }).evalSheet('1 to 2').lines[0];
    expect(result.error).toBeUndefined();
    expect(result.summary?.kind).toBe('dist');
  });
});

// §1.8 golden examples. Statistical lines use a larger N for tighter bounds;
// the fixed seed keeps them deterministic (no flakiness).
const STAT = { N: 40000, seed: 7 };

describe('§1.8 acceptance — capacity & accumulation', () => {
  it('rate conversion and accumulation are exact', () => {
    const ls = values('rate = 12_000 req/s\nrate in req/day\nrate * 30 day');
    expect(ls[1].display?.text).toBe('1.04e9 req/day');
    expect(ls[2].display?.text).toBe('3.11e10 req');
  });

  it('uncertain rate over a month: ~2.1e9 to 3.2e9 req', () => {
    const d = values('load = (800 to 1200) req/s\nload * 1 month', STAT)[1].display;
    expect(d?.kind).toBe('dist');
    expect(d?.unit).toBe('req');
    expect(Number(d?.p5)).toBeGreaterThan(2.0e9);
    expect(Number(d?.p5)).toBeLessThan(2.2e9);
    expect(Number(d?.p95)).toBeGreaterThan(3.05e9);
    expect(Number(d?.p95)).toBeLessThan(3.3e9);
  });

  it('storage accrual: ~0.17 to 0.43 TB', () => {
    const d = values('write = (2 to 5) MB/s\nwrite * 1 day in TB', STAT)[1].display;
    expect(d?.unit).toBe('TB');
    expect(Number(d?.p5)).toBeGreaterThan(0.16);
    expect(Number(d?.p5)).toBeLessThan(0.19);
    expect(Number(d?.p95)).toBeGreaterThan(0.41);
    expect(Number(d?.p95)).toBeLessThan(0.45);
  });
});

describe('§1.8 acceptance — safety & correlation', () => {
  it('incompatible dimensions error', () => {
    expect(values('5 km + 3 s')[0].error).toMatch(/incompatible/i);
  });
  it('correlation via reuse: x - x is exactly 0', () => {
    expect(values('x = 1 to 10\nx - x')[1].display?.text).toBe('0');
  });
  it('correlation via reuse: x * x uses x’s sample draws', () => {
    // `x * x` is a product of two lognormals. The closed-form layer
    // gives it the exact `meta` (lognormal), and the *samples* are
    // derived elementwise from x's samples — so the realised
    // percentiles of `x * x` track those of `x ^ 2` (which goes
    // through the sample-only ^ path) modulo the analytical mean
    // override. We assert the empirical percentiles match within
    // sampling tolerance, which only holds when the closed-form
    // path preserves the input's RNG draws.
    const ls = values('x = 1 to 10\nx * x\nx ^ 2');
    const sq = ls[1].summary;
    const pow = ls[2].summary;
    if (sq?.kind !== 'dist' || pow?.kind !== 'dist') throw new Error('expected dist');
    expect(sq.p5).toBeCloseTo(pow.p5, 6);
    expect(sq.p50).toBeCloseTo(pow.p50, 6);
    expect(sq.p95).toBeCloseTo(pow.p95, 6);
  });
  it('but two independent draws of the same CI are NOT equal', () => {
    const ls = values('a = 1 to 10\nb = 1 to 10\na - b');
    // independent: the difference has real spread
    const d = ls[2].summary;
    if (d?.kind !== 'dist') throw new Error('expected dist');
    expect(d.sd).toBeGreaterThan(0);
  });
});

describe('determinism (FR6.2)', () => {
  it('same seed -> identical samples', () => {
    expect(num('1 to 100')).toBe(num('1 to 100'));
    const a = makeEngine().evalSheet('1 to 100').lines[0].summary;
    const b = makeEngine().evalSheet('1 to 100').lines[0].summary;
    expect(a).toEqual(b);
  });
  it('different seed -> different samples', () => {
    const a = makeEngine({ seed: 1 }).evalSheet('1 to 100').lines[0].summary;
    const b = makeEngine({ seed: 2 }).evalSheet('1 to 100').lines[0].summary;
    expect(a).not.toEqual(b);
  });
});

describe('properties (fast-check)', () => {
  const small = { N: 400, seed: 4 };

  it('scalar addition is commutative', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1e6, max: 1e6 }),
        fc.integer({ min: -1e6, max: 1e6 }),
        (a, b) => {
          expect(num(`${a} + ${b}`, small)).toBe(num(`${b} + ${a}`, small));
        }
      )
    );
  });

  it('x - x is exactly 0 for any CI bounds', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.01, max: 1e4, noNaN: true }),
        fc.double({ min: 0.01, max: 1e4, noNaN: true }),
        (lo, hi) => {
          const [a, b] = lo <= hi ? [lo, hi] : [hi, lo];
          expect(values(`x = ${a} to ${b}\nx - x`, small)[1].display?.text).toBe('0');
        }
      )
    );
  });

  it('km->mi->km round-trips within display precision', () => {
    fc.assert(
      fc.property(fc.double({ min: 0.001, max: 1e5, noNaN: true }), (x) => {
        const mi = num(`${x} km in mi`, small);
        const back = num(`${mi} mi in km`, small);
        expect(Math.abs(back - x) / x).toBeLessThan(0.01);
      })
    );
  });

  it('accumulating a rate over [count] periods scales linearly', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1000 }), fc.integer({ min: 2, max: 50 }), (rate, k) => {
        const e = makeEngine(small);
        e.evalSheet(`${rate} req/s`);
        const one = Number(e.accumulate(0, 'hour', 1)?.value);
        const many = Number(e.accumulate(0, 'hour', k)?.value);
        // independently rounded to ~3 sig figs; linearity holds within that
        expect(Math.abs(many - k * one) / (k * one)).toBeLessThan(0.015);
      })
    );
  });

  it('rate card "per second" equals the base rate value', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1e6 }), (rate) => {
        const card = makeEngine(small).evalSheet(`${rate} req/s`).lines[0].rateCard;
        const perSec = card?.find((c) => c.period === 'second');
        expect(perSec?.display.value).toBe(String(rate));
      })
    );
  });
});
