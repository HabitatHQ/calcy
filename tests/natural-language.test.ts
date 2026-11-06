import { describe, expect, it } from 'vitest';
import { num, values } from './helpers';

// Non-technical-friendly input forms: spelled-out numbers, plural units, and
// natural range phrasing (`between … and …`, `± / +-`, `about`). Each desugars
// to an existing primitive, so we assert equality of the resulting summary
// against the canonical form (same AST shape → same seeded draws → same stats).
const STAT = { N: 20000, seed: 7 };

describe('word numbers', () => {
  it('single cardinals are numeric literals', () => {
    expect(num('two')).toBe(2);
    expect(num('twelve')).toBe(12);
    expect(num('zero')).toBe(0);
    expect(num('two * three')).toBe(6);
  });

  it('compound cardinals combine (space and hyphen)', () => {
    expect(num('twenty five')).toBe(25);
    expect(num('twenty-five')).toBe(25);
    expect(num('two hundred')).toBe(200);
    expect(num('two hundred fifty')).toBe(250);
    expect(num('one thousand two hundred')).toBe(1200);
  });

  it.each([
    'hundred',
    'thousand',
    'million',
    'billion'
  ])('retains explicit zero before %s', (scale) => {
    expect(num(`zero ${scale}`)).toBe(0);
    expect(num(`zero ${scale} five`)).toBe(5);
  });

  it('absorbs British "and" after a scale word (numutil-style)', () => {
    expect(num('two hundred and fifty')).toBe(250);
    expect(num('one thousand and one')).toBe(1001);
    // but `and` outside a number is still the `between` separator
    const a = values('between two and four', STAT)[0];
    const b = values('between 2 and 4', STAT)[0];
    expect(a.summary).toEqual(b.summary);
  });

  it('word numbers carry units like digits', () => {
    const a = values('two days to four days', STAT)[0];
    const b = values('2 day to 4 day', STAT)[0];
    expect(a.error).toBeUndefined();
    expect(a.summary).toEqual(b.summary);
  });
});

describe('k-suffix (scaled abbreviation)', () => {
  it('12k is 12000 when the k stands alone', () => {
    expect(num('12k')).toBe(12000);
    expect(num('1.5k')).toBe(1500);
    expect(num('12K + 1')).toBe(12001);
  });

  it('does not swallow a unit that begins with k', () => {
    expect(num('12kg in kg')).toBeCloseTo(12, 9); // kilograms, not 12000 g
    expect(num('12km in km')).toBeCloseTo(12, 9);
  });
});

describe('plural unit aliases already resolve', () => {
  it('plural spellings convert like their singular', () => {
    expect(num('5 kilometers in km')).toBeCloseTo(5, 9);
    expect(num('3 hours in h')).toBeCloseTo(3, 9);
    expect(num('2 days to 4 days', STAT)).toBeDefined();
  });
});

describe('between … and …', () => {
  it('is a confidence interval', () => {
    const a = values('between 2 and 4 days', STAT)[0];
    const b = values('2 to 4 day', STAT)[0];
    expect(a.error).toBeUndefined();
    expect(a.summary).toEqual(b.summary);
  });

  it('works without units', () => {
    const a = values('between 800 and 1200', STAT)[0];
    const b = values('800 to 1200', STAT)[0];
    expect(a.summary).toEqual(b.summary);
  });

  it('reports a clear error when "and" is missing', () => {
    expect(values('between 2 4')[0].error).toMatch(/between needs 'and'/);
  });
});

describe('plus-minus (± and +-)', () => {
  it('center ± half-width is the symmetric interval', () => {
    expect(values('3 ± 1', STAT)[0].summary).toEqual(values('2 to 4', STAT)[0].summary);
    expect(values('3 +- 1', STAT)[0].summary).toEqual(values('2 to 4', STAT)[0].summary);
  });

  it('distributes a trailing unit over a bare centre', () => {
    expect(values('3 ± 1 day', STAT)[0].summary).toEqual(values('2 to 4 day', STAT)[0].summary);
  });

  it('handles units on both sides', () => {
    expect(values('5 day ± 1 day', STAT)[0].summary).toEqual(values('4 to 6 day', STAT)[0].summary);
  });
});

describe('about (rough ±10% estimate)', () => {
  it('about X is a 90% range of ±10% around X', () => {
    expect(values('about 10', STAT)[0].summary).toEqual(values('9 to 11', STAT)[0].summary);
  });

  it('the tilde shorthand matches "about"', () => {
    expect(values('~10', STAT)[0].summary).toEqual(values('about 10', STAT)[0].summary);
  });

  it('carries units', () => {
    const a = values('about 10 day', STAT)[0];
    expect(a.error).toBeUndefined();
    expect(a.summary).toEqual(values('9 to 11 day', STAT)[0].summary);
  });
});
