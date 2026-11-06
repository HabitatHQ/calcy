import { describe, expect, it } from 'vitest';
import { parseCustomUnitInput, parseSettings } from '../src/lib/sheet/settings';

describe('parseSettings', () => {
  it('parses numeric settings when present', () => {
    expect(parseSettings({ monthDays: '30', yearDays: '365', samples: '5000' })).toMatchObject({
      monthDays: 30,
      yearDays: 365,
      samples: 5000
    });
  });
  it('accepts positive safe-integer samples and rejects fractional or unsafe counts', () => {
    expect(parseSettings({ samples: '1' }).samples).toBe(1);
    expect(parseSettings({ samples: String(Number.MAX_SAFE_INTEGER) }).samples).toBe(
      Number.MAX_SAFE_INTEGER
    );
    for (const samples of ['0', '0.5', '1.2', '-1', '9007199254740992', 'NaN', '']) {
      expect(parseSettings({ samples }).samples).toBeUndefined();
    }
  });
  it('omits numeric settings when absent or empty', () => {
    const s = parseSettings({ monthDays: '' });
    expect(s.monthDays).toBeUndefined();
    expect(s.yearDays).toBeUndefined();
    expect(s.samples).toBeUndefined();
  });
  it('accepts only valid number formats', () => {
    expect(parseSettings({ numberFormat: 'compact' }).numberFormat).toBe('compact');
    expect(parseSettings({ numberFormat: 'bogus' }).numberFormat).toBeUndefined();
  });
  it('accepts only valid editor modes', () => {
    expect(parseSettings({ mode: 'tape' }).mode).toBe('tape');
    expect(parseSettings({ mode: 'notepad' }).mode).toBe('notepad');
    expect(parseSettings({ mode: 'spreadsheet' }).mode).toBeUndefined();
  });
  it('accepts only valid themes', () => {
    expect(parseSettings({ theme: 'light' }).theme).toBe('light');
    expect(parseSettings({ theme: 'dark' }).theme).toBe('dark');
    expect(parseSettings({ theme: 'system' }).theme).toBe('system');
    expect(parseSettings({ theme: 'solarized' }).theme).toBeUndefined();
    expect(parseSettings({}).theme).toBeUndefined();
  });
  it('always resolves debugAst to a boolean', () => {
    expect(parseSettings({ debugAst: 'true' }).debugAst).toBe(true);
    expect(parseSettings({ debugAst: 'false' }).debugAst).toBe(false);
    expect(parseSettings({}).debugAst).toBe(false);
  });
});

describe('parseCustomUnitInput', () => {
  it('parses name = definition', () => {
    expect(parseCustomUnitInput('sprint = 2 week')).toEqual({
      name: 'sprint',
      definition: '2 week'
    });
  });
  it('accepts an optional leading "unit" keyword and surrounding space', () => {
    expect(parseCustomUnitInput('  unit foo = 7 m / 2 s ')).toEqual({
      name: 'foo',
      definition: '7 m / 2 s'
    });
  });
  it('rejects malformed input with a hint', () => {
    expect(parseCustomUnitInput('no equals here')).toMatchObject({
      error: expect.stringContaining('format')
    });
    expect(parseCustomUnitInput('1bad = 2')).toMatchObject({ error: expect.any(String) });
    expect(parseCustomUnitInput('name =')).toMatchObject({ error: expect.any(String) });
  });
});
