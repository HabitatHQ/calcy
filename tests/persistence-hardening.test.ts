import { describe, expect, it } from 'vitest';
import type { LineResult } from '../src/lib/engine';
import { decodeShare, encodeShare } from '../src/lib/share';
import { annotatedBody } from '../src/lib/sheet/export';
import { parseSettings } from '../src/lib/sheet/settings';

describe('parseSettings rejects values that would poison evaluation', () => {
  it('drops non-numeric day/sample counts (keeps the default)', () => {
    const s = parseSettings({ monthDays: 'abc', yearDays: 'NaN', samples: 'oops' });
    expect(s.monthDays).toBeUndefined();
    expect(s.yearDays).toBeUndefined();
    expect(s.samples).toBeUndefined();
  });
  it('drops non-positive values', () => {
    const s = parseSettings({ monthDays: '0', yearDays: '-365', samples: '-5' });
    expect(s.monthDays).toBeUndefined();
    expect(s.yearDays).toBeUndefined();
    expect(s.samples).toBeUndefined();
  });
  it('rejects fractional sample counts without rounding but keeps fractional day counts', () => {
    const s = parseSettings({ monthDays: '30.4', yearDays: '365.25', samples: '10000.9' });
    expect(s.monthDays).toBe(30.4);
    expect(s.yearDays).toBe(365.25);
    expect(s.samples).toBeUndefined();
  });
  it('accepts the smallest valid positive integer sample count', () => {
    expect(parseSettings({ samples: '1' }).samples).toBe(1);
  });
});

describe('decodeShare validates the seed and normalises line endings', () => {
  it('rejects a non-finite seed', () => {
    const payload = btoa(encodeURIComponent(JSON.stringify({ title: 't', body: 'b', seed: null })));
    expect(decodeShare(payload)).toBeNull();
  });
  it('coerces a fractional seed to an integer', () => {
    const enc = encodeShare({ title: 't', body: 'b', seed: 3.7 });
    expect(decodeShare(enc)?.seed).toBe(3);
  });
  it('normalises CRLF in the shared body to LF', () => {
    const enc = encodeShare({ title: 't', body: 'a = 1\r\nb = 2', seed: 1 });
    expect(decodeShare(enc)?.body).toBe('a = 1\nb = 2');
  });
  it('a normal round-trip is unchanged', () => {
    const p = { title: 'My Sheet', body: 'x = 1\ny = 2', seed: 42 };
    expect(decodeShare(encodeShare(p))).toEqual(p);
  });
});

describe('annotatedBody handles CRLF bodies without corrupting annotations', () => {
  it('does not leave a stray carriage return before the marker', () => {
    const stub = (index: number, text: string): LineResult =>
      ({ index, kind: 'value', display: { text } }) as unknown as LineResult;
    const out = annotatedBody('a = 1\r\nb = 2', [stub(0, '1'), stub(1, '2')]);
    expect(out).toBe('a = 1  → 1\nb = 2  → 2');
    expect(out).not.toContain('\r');
  });
});
