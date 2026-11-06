import { describe, expect, it } from 'vitest';
import type { LineResult } from '../src/lib/engine';
import { annotatedBody, slugify, toCsv, toMarkdown } from '../src/lib/sheet/export';

// Minimal LineResult builders for the serializer tests.
const value = (
  index: number,
  raw: string,
  text: string,
  extra: Partial<LineResult> = {}
): LineResult => ({
  index,
  kind: 'value',
  raw,
  display: { kind: 'point', unit: '', value: text, text },
  ...extra
});
const errline = (index: number, raw: string, error: string): LineResult => ({
  index,
  kind: 'value',
  raw,
  error
});

describe('annotatedBody', () => {
  it('annotates value lines with → result and error lines with ⚠', () => {
    const body = 'rate = 5\n# note\nrate * 2\nbroken';
    const results: LineResult[] = [
      value(0, 'rate = 5', '5', { name: 'rate' }),
      { index: 1, kind: 'comment', raw: '# note' },
      value(2, 'rate * 2', '10'),
      errline(3, 'broken', 'unknown identifier')
    ];
    expect(annotatedBody(body, results)).toBe(
      'rate = 5  → 5\n# note\nrate * 2  → 10\nbroken  ⚠ unknown identifier'
    );
  });
  it('passes through lines with no matching result', () => {
    expect(annotatedBody('a\nb', [])).toBe('a\nb');
  });
  it('matches results by index, not by position', () => {
    // A blank first line means the value result is at index 1.
    const body = '\nx = 1';
    const results: LineResult[] = [value(1, 'x = 1', '1', { name: 'x' })];
    expect(annotatedBody(body, results)).toBe('\nx = 1  → 1');
  });
});

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('My Cool Sheet')).toBe('my-cool-sheet');
  });
  it('strips leading/trailing separators and collapses runs', () => {
    expect(slugify('  Hello — World!! ')).toBe('hello-world');
  });
  it('falls back to "sheet" for empty or symbol-only titles', () => {
    expect(slugify('')).toBe('sheet');
    expect(slugify('!!!')).toBe('sheet');
  });
});

describe('toCsv', () => {
  it('emits a header plus one row per value/unitdef, CRLF-joined', () => {
    const results: LineResult[] = [
      value(0, '  rate = 5  ', '5 req/s', { name: 'rate', isRate: true }),
      { index: 1, kind: 'blank', raw: '' },
      value(2, 'rate * 2', '10 req/s', { isDist: true })
    ];
    const csv = toCsv(results);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('line,name,expression,result,kind,note');
    expect(lines[1]).toBe('1,rate,rate = 5,5 req/s,rate,');
    expect(lines[2]).toBe('3,,rate * 2,10 req/s,dist,');
    expect(lines).toHaveLength(3); // blank line excluded
  });
  it('quotes cells containing commas, quotes, or newlines', () => {
    const results: LineResult[] = [value(0, 'x', 'a,b', { name: 'q"d', comment: 'has "quote"' })];
    const row = toCsv(results).split('\r\n')[1];
    expect(row).toBe('1,"q""d",x,"a,b",point,"has ""quote"""');
  });
  it('quotes bare CR and CRLF inside fields, preserving record boundaries', () => {
    const csv = toCsv([value(0, 'x', '1', { comment: 'a\rb\r\nc', name: 'a\rb' })]);
    expect(csv).toBe('line,name,expression,result,kind,note\r\n1,"a\rb",x,1,point,"a\rb\r\nc"');
  });
  it('reports errors in the kind and note columns', () => {
    const csv = toCsv([errline(0, 'boom', 'kaboom')]);
    expect(csv.split('\r\n')[1]).toBe('1,,boom,,error,kaboom');
  });
});

describe('toMarkdown', () => {
  it('wraps the annotated body in a fenced block under an H1', () => {
    expect(toMarkdown('Title', 'a → 1')).toBe('# Title\n\n```\na → 1\n```\n');
  });
  it('defaults a blank title to Untitled', () => {
    expect(toMarkdown('', 'x')).toBe('# Untitled\n\n```\nx\n```\n');
  });
});
