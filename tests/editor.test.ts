import { describe, expect, it } from 'vitest';
import { collectVariables, functionInsertion, setLineConversion } from '../src/lib/editor';
import { Engine } from '../src/lib/engine';

describe('collectVariables', () => {
  it('collects assigned names in order', () => {
    expect(collectVariables('rate = 12_000 req/s\nload = 5')).toEqual(['rate', 'load']);
  });

  it('collects custom unit names', () => {
    expect(collectVariables('unit sprint = 2 week')).toEqual(['sprint']);
  });

  it('ignores names that appear only in comments', () => {
    expect(collectVariables('x = 1 # later use y = 2')).toEqual(['x']);
  });

  it('does not treat conversions or bare expressions as assignments', () => {
    expect(collectVariables('5 km in mi\nrate * 30 day')).toEqual([]);
  });

  it('dedupes redefinitions, keeping first position', () => {
    expect(collectVariables('a = 1\nb = 2\na = 3')).toEqual(['a', 'b']);
  });
});

describe('setLineConversion', () => {
  it('appends a conversion to a bare expression', () => {
    expect(setLineConversion('5 km', 'mi')).toBe('5 km in mi');
  });

  it('replaces an existing in conversion', () => {
    expect(setLineConversion('5 km in mi', 'm')).toBe('5 km in m');
  });

  it('clears the conversion when given an empty unit', () => {
    expect(setLineConversion('5 km in mi', '')).toBe('5 km');
  });

  it('preserves a trailing comment', () => {
    expect(setLineConversion('5 km # road', 'mi')).toBe('5 km in mi # road');
    expect(setLineConversion('5 km in mi # road', 'm')).toBe('5 km in m # road');
  });

  it('keeps an assignment intact', () => {
    expect(setLineConversion('rate = 12_000 req/s', 'req/day')).toBe(
      'rate = 12_000 req/s in req/day'
    );
  });

  it('does not mistake the unit "min" for the in keyword', () => {
    expect(setLineConversion('5 min', 'h')).toBe('5 min in h');
  });

  it('preserves interval bounds when pinning or clearing units', () => {
    const engine = new Engine({ N: 500 });
    const source = 'latency = 20 ms to 80 ms';
    const pinned = setLineConversion(source, 's');
    const line = engine.evalSheet(pinned).lines[0];
    expect(line.error).toBeUndefined();
    expect(line.isDist).toBe(true);
    expect(line.display?.unit).toBe('s');
    expect(Number(line.display?.ciLow)).toBeCloseTo(0.02, 2);
    const cleared = engine.evalSheet(setLineConversion(pinned, '')).lines[0];
    expect(cleared.summary).toEqual(engine.evalSheet(source).lines[0].summary);
  });

  it('converts the result rather than a where binding or nested expression', () => {
    const engine = new Engine();
    for (const source of [
      'd / t where d = 100 km, t = 2 h',
      '(100 km in m) / t where t = 2 h',
      'd / t in km/h where d = 100 km, t = 2 h'
    ]) {
      const line = engine.evalSheet(setLineConversion(source, 'mph')).lines[0];
      expect(line.error).toBeUndefined();
      expect(Number(line.display?.value)).toBeCloseTo(31.06856, 4);
    }
  });
});

describe('functionInsertion', () => {
  it('inserts the name with an opening paren and lands the cursor inside it', () => {
    expect(functionInsertion('normal')).toEqual({ insert: 'normal(', cursorOffset: 7 });
  });
});
