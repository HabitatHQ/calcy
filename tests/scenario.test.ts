import { describe, expect, it } from 'vitest';
import type { ScenarioSummary } from '../src/lib/engine/mc';
import { num, one, values } from './helpers';

// scenario[axis](label: expr, …) — the inline constructor. A value gains one
// named axis whose coords are labelled expressions; each coord holds a full
// scalar/distribution cell.

const scenarioOf = (src: string): ScenarioSummary => {
  const results = values(src);
  const l = results[results.length - 1];
  if (l?.error) throw new Error(`${src} → ${l.error}`);
  if (l?.summary?.kind !== 'scenario') throw new Error(`expected scenario for: ${src}`);
  return l.summary;
};

// Point values per cell, row-major over the axes.
const cellValues = (src: string): number[] =>
  scenarioOf(src).cells.map((c) => (c.kind === 'point' ? c.value : Number.NaN));

describe('scenario(...) default axis', () => {
  it('defaults the axis name to `case` when [axis] is omitted', () => {
    const s = scenarioOf('scenario(low: 8, base: 10, high: 14)');
    expect(s.axes[0].name).toBe('case');
    expect(s.axes[0].coords).toEqual(['low', 'base', 'high']);
    expect(s.cells.map((c) => (c.kind === 'point' ? c.value : Number.NaN))).toEqual([8, 10, 14]);
  });

  it('the default axis behaves like an explicit one (pick / over)', () => {
    const last = (src: string): number => {
      const ls = values(src);
      return Number(ls[ls.length - 1].display?.value);
    };
    expect(last('p = scenario(low: 8, base: 10, high: 14)\npick(p, case = "high")')).toBe(14);
    expect(last('p = scenario(low: 8, base: 10, high: 14)\nmax(p over case)')).toBe(14);
  });
});

describe('scenario[axis](...) inline constructor', () => {
  it('builds a one-axis grid with the coords in author order', () => {
    const s = scenarioOf('scenario[case](low: 8, base: 10, high: 14)');
    expect(s.axes).toHaveLength(1);
    expect(s.axes[0].name).toBe('case');
    expect(s.axes[0].coords).toEqual(['low', 'base', 'high']);
    expect(s.cells).toHaveLength(3);
    expect(s.cells.map((c) => (c.kind === 'point' ? c.value : Number.NaN))).toEqual([8, 10, 14]);
  });

  it('carries a shared unit onto every cell', () => {
    const s = scenarioOf('scenario[case](low: 8 $, base: 10 $, high: 14 $)');
    expect(s.dim).toEqual({ usd: 1 });
    expect(s.cells.map((c) => (c.kind === 'point' ? c.value : Number.NaN))).toEqual([8, 10, 14]);
  });

  it('holds distribution cells, each summarized independently', () => {
    const s = scenarioOf('scenario[case](low: normal(10, 1), high: normal(100, 5))');
    expect(s.cells).toHaveLength(2);
    expect(s.cells[0].kind).toBe('dist');
    expect(s.cells[1].kind).toBe('dist');
  });

  it('renders a compact one-line label prefixed by the axis name', () => {
    const l = one('scenario[case](low: 8 $, base: 10 $, high: 14 $)');
    expect(l.display?.kind).toBe('scenario');
    expect(l.display?.axes?.[0]).toEqual({ name: 'case', coords: ['low', 'base', 'high'] });
    expect(l.display?.cells).toHaveLength(3);
    expect(l.display?.text).toBe('case: low=$8.00, base=$10.00, high=$14.00');
  });

  it('is assignable and re-usable by name', () => {
    const [decl] = values('tier = scenario[plan](basic: 5 $, pro: 20 $)');
    expect(decl.name).toBe('tier');
    expect(decl.summary?.kind).toBe('scenario');
  });

  it('rejects coords with mismatched units', () => {
    expect(values('scenario[case](low: 8 $, base: 10 kg)')[0].error).toMatch(/different units/);
  });

  it('rejects a duplicate coord label', () => {
    expect(values('scenario[case](low: 8, low: 9)')[0].error).toMatch(/duplicate coord/);
  });

  it('rejects a missing axis name', () => {
    expect(values('scenario[](low: 8)')[0].error).toMatch(/axis name/);
  });

  it('rejects an empty coord list', () => {
    expect(values('scenario[case]()')[0].error).toMatch(/at least one coord/);
  });
});

describe('scenario arithmetic (align / broadcast / cross)', () => {
  it('broadcasts a scalar across every coord', () => {
    expect(cellValues('scenario[case](low: 8, base: 10, high: 14) * 2')).toEqual([16, 20, 28]);
    expect(cellValues('2 * scenario[case](low: 8, base: 10, high: 14)')).toEqual([16, 20, 28]);
  });

  it('aligns (zips) two grids sharing an axis', () => {
    const s = scenarioOf(
      'scenario[case](low: 8, base: 10, high: 14) - scenario[case](low: 1, base: 2, high: 4)'
    );
    expect(s.axes).toHaveLength(1);
    expect(s.axes[0].coords).toEqual(['low', 'base', 'high']);
    expect(s.cells.map((c) => (c.kind === 'point' ? c.value : Number.NaN))).toEqual([7, 8, 10]);
  });

  it('crosses two grids with different axes (Cartesian, row-major)', () => {
    const s = scenarioOf('scenario[case](low: 1, high: 2) * scenario[geo](us: 10, eu: 20)');
    expect(s.axes.map((a) => a.name)).toEqual(['case', 'geo']);
    // row-major over [case, geo]: (low,us) (low,eu) (high,us) (high,eu)
    expect(s.cells.map((c) => (c.kind === 'point' ? c.value : Number.NaN))).toEqual([
      10, 20, 20, 40
    ]);
  });

  it('carries units through a broadcast', () => {
    const s = scenarioOf('scenario[case](low: 8, base: 10, high: 14) * (1 $)');
    expect(s.dim).toEqual({ usd: 1 });
    expect(s.cells.map((c) => (c.kind === 'point' ? c.value : Number.NaN))).toEqual([8, 10, 14]);
  });

  it('negates and powers cell-by-cell', () => {
    expect(cellValues('-scenario[case](low: 8, high: 14)')).toEqual([-8, -14]);
    expect(cellValues('scenario[case](low: 2, high: 3) ^ 2')).toEqual([4, 9]);
  });

  it('rejects an align whose coords differ under a shared axis name', () => {
    const err = values('scenario[case](low: 8, base: 10) + scenario[case](low: 1, high: 2)')[0]
      .error;
    expect(err).toMatch(/axis 'case': coords differ/);
  });

  it('caps the cell count on a large cross', () => {
    const coords = (prefix: string) =>
      Array.from({ length: 17 }, (_, i) => `${prefix}${i}: 1`).join(', ');
    const src = `scenario[a](${coords('a')}) * scenario[b](${coords('b')})`; // 17 × 17 = 289
    expect(values(src)[0].error).toMatch(/too large: 289 cells/);
  });
});

describe('pick(scenario, axis = "coord")', () => {
  it('selects one coord, collapsing a single-axis grid to a plain value', () => {
    expect(num('pick(scenario[case](low: 8, base: 10, high: 14), case = "base")')).toBe(10);
  });

  it('works against a named scenario over two lines', () => {
    const [, picked] = values('t = scenario[plan](basic: 5 $, pro: 20 $)\npick(t, plan = "pro")');
    expect(picked.summary?.kind).toBe('point');
    expect(Number(picked.display?.value)).toBe(20);
  });

  it('does a partial pick, keeping the unspecified axis', () => {
    const s = one(
      'pick(scenario[case](low: 1, high: 2) * scenario[geo](us: 10, eu: 20), case = "high")'
    );
    if (s.summary?.kind !== 'scenario') throw new Error('expected scenario');
    expect(s.summary.axes.map((a) => a.name)).toEqual(['geo']);
    // high row of the cross: (high,us)=20, (high,eu)=40
    expect(s.summary.cells.map((c) => (c.kind === 'point' ? c.value : Number.NaN))).toEqual([
      20, 40
    ]);
  });

  it('rejects a bare (unquoted) coord with a hint to quote it', () => {
    expect(values('pick(scenario[case](low: 8), case = base)')[0].error).toMatch(/must be quoted/);
  });

  it('rejects an unknown axis or coord', () => {
    expect(values('pick(scenario[case](low: 8), geo = "us")')[0].error).toMatch(/no axis 'geo'/);
    expect(values('pick(scenario[case](low: 8), case = "mid")')[0].error).toMatch(/no coord 'mid'/);
  });

  it('rejects a non-scenario input', () => {
    expect(values('pick(42, case = "low")')[0].error).toMatch(/expects a scenario/);
  });

  it('rejects a quoted string used as an ordinary value', () => {
    expect(values('"base" + 1')[0].error).toMatch(/quoted string/);
  });
});

describe('scenario wrappers in ordinary functions and sums', () => {
  it('maps reducers and unary math per cell without collapsing axes', () => {
    expect(cellValues('mean(scenario[case](low: 1, high: 2))')).toEqual([1, 2]);
    expect(cellValues('sqrt(scenario[case](low: 4, high: 9))')).toEqual([2, 3]);
  });

  it('reduces samples inside each cell while retaining its coordinates', () => {
    const normalCells = 'scenario(low: normal(10, 1), high: normal(20, 2))';
    expect(cellValues(`mean(${normalCells})`)).toEqual([10, 20]);
    expect(cellValues(`p(${normalCells}, 0.5)`)).toEqual([10, 20]);
    expect(cellValues('chance(scenario(low: -1, high: 1) > 0)')).toEqual([0, 1]);
    const bands = scenarioOf('interval(scenario(low: 1, high: 2), 0.9)');
    expect(bands.cells).toEqual([
      { kind: 'list', dim: {}, list: [1, 1] },
      { kind: 'list', dim: {}, list: [2, 2] }
    ]);
  });

  it('broadcasts multi-argument functions across distinct axes', () => {
    expect(cellValues('clamp(scenario(low: 1, high: 5), scenario[geo](us: 2, eu: 3))')).toEqual([
      2, 3, 5, 5
    ]);
    expect(cellValues('round(scenario(low: 1.24, high: 2.56), digits = 1)')).toEqual([1.2, 2.6]);
  });

  it('sums aligned and crossed scenarios with labels preserved', () => {
    expect(cellValues('x=scenario[case](low:1,high:2)\nsum(x,x)')).toEqual([2, 4]);
    expect(cellValues('sum(scenario[case](low:1,high:2), 3)')).toEqual([4, 5]);
    expect(cellValues('sum(scenario[case](low:1,high:2), scenario[geo](us:10,eu:20))')).toEqual([
      11, 21, 12, 22
    ]);
  });

  it('sums scenario values from preceding lines with sum(above)', () => {
    expect(
      cellValues(`x = scenario[case](low:1,high:2)
y = scenario[case](low:3,high:4)
sum(above)`)
    ).toEqual([4, 6]);
  });
});

it('renders multi-axis coordinates as named tuples', () => {
  const text =
    one(
      'scenario[case](low:1,high:2)*scenario[geo](us:10,eu:20)*scenario[season](winter:1,summer:2)'
    ).display?.text ?? '';
  expect(text).toContain('case=low, geo=us, season=winter');
  expect(text).not.toContain('0=');
});
describe('reducers with over <axis>', () => {
  it('collapses a single axis by min / max / mean / sum', () => {
    expect(num('min(scenario[case](low: 8, base: 10, high: 14) over case)')).toBe(8);
    expect(num('max(scenario[case](low: 8, base: 10, high: 14) over case)')).toBe(14);
    expect(num('mean(scenario[case](low: 8, base: 10, high: 12) over case)')).toBe(10);
    expect(num('sum(scenario[case](low: 8, base: 10, high: 12) over case)')).toBe(30);
  });

  it('accepts the kwarg spelling over = axis', () => {
    expect(num('max(scenario[case](low: 8, high: 14), over = case)')).toBe(14);
  });

  it('preserves the shared unit through the collapse', () => {
    const l = one('sum(scenario[case](low: 8 $, high: 14 $) over case)');
    expect(l.summary?.kind).toBe('point');
    expect(l.display?.unit).toBe('$');
    expect(Number(l.display?.value)).toBe(22);
  });

  it('does a partial collapse, keeping the other axis', () => {
    const s = one('max(scenario[case](low: 1, high: 2) * scenario[geo](us: 10, eu: 20) over case)');
    if (s.summary?.kind !== 'scenario') throw new Error('expected scenario');
    expect(s.summary.axes.map((a) => a.name)).toEqual(['geo']);
    expect(s.summary.cells.map((c) => (c.kind === 'point' ? c.value : Number.NaN))).toEqual([
      20, 40
    ]);
  });

  it('rejects over on a reducer that has no axis form', () => {
    expect(values('median(scenario[case](low: 8, high: 14) over case)')[0].error).toMatch(
      /no 'over <axis>' form/
    );
  });

  it('rejects over on an unknown axis or a non-scenario', () => {
    expect(values('min(scenario[case](low: 8) over geo)')[0].error).toMatch(/no axis 'geo'/);
    expect(values('min(42 over case)')[0].error).toMatch(/no axes to collapse/);
  });
});
