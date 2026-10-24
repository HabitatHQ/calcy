import { describe, expect, it } from 'vitest';
import type { ScenarioSummary } from '../src/lib/engine/mc';
import { lines } from './helpers';

// The `scenario <axis>:` table block: a column-aligned way to write many
// one-row scenario constructors that share an axis. Rows are variables, the
// `# …` header row names the coords, and each row desugars to the inline
// scenario[axis](…) constructor. Columns are separated by runs of two or more
// spaces, so a cell may hold a spaced expression like `1 to 10`. Rows share the
// axis, so they zip (align).

const OPTS = { numberFormat: 'scientific' as const };

// The point value of each cell of a named scenario line, row-major.
function cellsOf(sheet: string, name: string): number[] {
  const l = lines(sheet, OPTS).find((r) => r.name === name);
  if (!l) throw new Error(`no line '${name}'`);
  if (l.error) throw new Error(`${name} → ${l.error}`);
  if (l.summary?.kind !== 'scenario') throw new Error(`'${name}' is not a scenario`);
  return (l.summary as ScenarioSummary).cells.map((c) =>
    c.kind === 'point' ? c.value : Number.NaN
  );
}
function axisOf(sheet: string, name: string): { name: string; coords: string[] } {
  const l = lines(sheet, OPTS).find((r) => r.name === name);
  if (l?.summary?.kind !== 'scenario') throw new Error(`'${name}' is not a scenario`);
  return (l.summary as ScenarioSummary).axes[0];
}

describe('scenario <axis>: table block', () => {
  it('builds one aligned scenario per row over the named axis', () => {
    const sheet = [
      'scenario case:',
      '  #       low   base   high',
      '  price = 8     10     14',
      '  cost  = 9     6      4'
    ].join('\n');
    expect(axisOf(sheet, 'price')).toEqual({ name: 'case', coords: ['low', 'base', 'high'] });
    expect(cellsOf(sheet, 'price')).toEqual([8, 10, 14]);
    expect(cellsOf(sheet, 'cost')).toEqual([9, 6, 4]);
  });

  it('rows zip over the shared axis in a downstream expression', () => {
    const sheet = [
      'scenario case:',
      '  #       low   base   high',
      '  price = 8     10     14',
      '  cost  = 9     6      4',
      'margin = price - cost'
    ].join('\n');
    expect(cellsOf(sheet, 'margin')).toEqual([-1, 4, 10]);
  });

  it('applies a trailing shared unit to every cell', () => {
    const sheet = [
      'scenario case:',
      '  #       low   base   high',
      '  price = 8     10     14    $'
    ].join('\n');
    expect(cellsOf(sheet, 'price')).toEqual([8, 10, 14]);
    const total = lines([sheet, 'total = price + 1 $'].join('\n'), OPTS).find(
      (r) => r.name === 'total'
    );
    expect(total?.error).toBeUndefined();
  });

  it('defaults the axis to `case` when the header omits it', () => {
    const sheet = ['scenario:', '  #       low   base   high', '  price = 8     10     14'].join(
      '\n'
    );
    expect(axisOf(sheet, 'price').name).toBe('case');
  });

  it('names any other axis explicitly', () => {
    const sheet = ['scenario geo:', '  #     us   eu', '  tax = 7    20'].join('\n');
    expect(axisOf(sheet, 'tax')).toEqual({ name: 'geo', coords: ['us', 'eu'] });
  });

  it('allows distribution cells (single spaces inside a cell, 2+ between)', () => {
    const sheet = ['scenario case:', '  #   low       high', '  x = 1 to 10    5 to 50'].join('\n');
    const l = lines(sheet, OPTS).find((r) => r.name === 'x');
    expect(l?.error).toBeUndefined();
    expect(l?.summary?.kind).toBe('scenario');
  });

  it('ends the block at the first dedented line', () => {
    const sheet = [
      'scenario case:',
      '  #       low   base   high',
      '  price = 8     10     14',
      'after = 42'
    ].join('\n');
    const after = lines(sheet, OPTS).find((r) => r.name === 'after');
    expect(after?.error).toBeUndefined();
    expect(after?.display?.value).toBe('42');
  });
});

describe('scenario shared-unit expression precedence', () => {
  it('applies one trailing unit after parenthesizing every cell expression', () => {
    const sheet = [
      'scenario case:',
      '  #      low       high',
      '  ratio = 1 / 2     3 / 4    m'
    ].join('\n');
    expect(cellsOf(sheet, 'ratio')).toEqual([0.5, 0.75]);
  });
});

it('keeps addition, negatives, and where expressions inside each shared-unit cell', () => {
  const sheet = [
    'scenario case:',
    '  #       low                  high',
    '  result = 1 + 2              - (2 + 2)    m',
    '  local  = a + 1 where a = 2  b + 1 where b = 3  m'
  ].join('\n');
  expect(cellsOf(sheet, 'result')).toEqual([3, -4]);
  expect(cellsOf(sheet, 'local')).toEqual([3, 4]);
});

describe('scenario <axis>: table block — errors', () => {
  it('requires a coord header row before the data rows', () => {
    const sheet = ['scenario case:', '  price = 8     10     14'].join('\n');
    const row = lines(sheet, OPTS).find((r) => r.raw.includes('price'));
    expect(row?.error).toMatch(/coord header/i);
  });

  it('rejects a row whose cell count differs from the coords', () => {
    const sheet = ['scenario case:', '  #       low   base   high', '  price = 8     10'].join(
      '\n'
    );
    const row = lines(sheet, OPTS).find((r) => r.raw.includes('price'));
    expect(row?.error).toMatch(/cell|coord|3/i);
  });
});
