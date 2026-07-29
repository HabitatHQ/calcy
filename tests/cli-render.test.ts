import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '@stricli/core';
import { afterAll, describe, expect, it } from 'vitest';
import { app } from '../src/cli/command';
import { OUTPUT_FORMATS, render } from '../src/cli/render';
import type { LineResult } from '../src/lib/engine';
import { RESULT_HEADER, toCsv } from '../src/lib/sheet/export';
import { lines, makeEngine } from './helpers';

const SHEET = ['# a comment', 'rate = 5 km', 'pace = (5 to 6) min/km', 'oops = 1 +'].join('\n');

describe('resultRows / RESULT_HEADER (via toCsv columns)', () => {
  const rows = lines(SHEET);

  it('has the expected header', () => {
    expect(RESULT_HEADER).toEqual(['line', 'name', 'expression', 'result', 'kind', 'note']);
  });

  it('omits comment/blank lines, keeping only value/unitdef rows', () => {
    const csv = toCsv(rows);
    const dataLines = csv.split('\r\n').slice(1);
    expect(dataLines).toHaveLength(3);
  });

  it('marks a point line, a dist line, and an error line with the right kind/note/result columns', () => {
    const csv = toCsv(rows);
    const [, pointRow, distRow, errorRow] = csv.split('\r\n');

    const [pLine, , , pResult, pKind] = pointRow.split(',');
    expect(pLine).toBe('2'); // 1-based: comment is line 1, `rate = 5 km` is line 2
    expect(pKind).toBe('point');
    expect(pResult).not.toBe('');

    const [dLine, , , , dKind] = distRow.split(',');
    expect(dLine).toBe('3');
    expect(dKind).toBe('dist');

    const errFields = errorRow.split(',');
    const [eLine, , , eResult, eKind, eNote] = errFields;
    expect(eLine).toBe('4');
    expect(eKind).toBe('error');
    expect(eResult).toBe('');
    expect(eNote.length).toBeGreaterThan(0);

    const errLine = rows.find((l) => l.raw.trim() === 'oops = 1 +');
    expect(errLine?.error).toBeTruthy();
    expect(eNote).toBe(errLine?.error);
  });
});

describe('toCsv quoting', () => {
  it('quotes a note field containing a comma', () => {
    const errline: LineResult = {
      index: 0,
      kind: 'value',
      raw: 'boom',
      error: 'has, a comma'
    };
    const row = toCsv([errline]).split('\r\n')[1];
    expect(row).toBe('1,,boom,,error,"has, a comma"');
  });
});

describe('render dispatch', () => {
  const result = makeEngine().evalSheet('x = 2 km\ny = x * 3');

  it('csv format matches toCsv(result.lines)', () => {
    expect(render(result, 'csv')).toBe(toCsv(result.lines));
  });

  it('md format is a GFM table', () => {
    const md = render(result, 'md');
    expect(md.startsWith('| line |')).toBe(true);
    expect(md).toMatch(/\|\s*---/);
  });

  it('table format uses box-drawing chars with no trailing newline', () => {
    const t = render(result, 'table');
    expect(/[│╔╗╚╝─]/.test(t)).toBe(true);
    expect(t.endsWith('\n')).toBe(false);
  });

  it('json format round-trips with a lines array matching the source line count', () => {
    const json = render(result, 'json');
    const parsed = JSON.parse(json);
    expect(Array.isArray(parsed.lines)).toBe(true);
    expect(parsed.lines).toHaveLength(result.lines.length);
  });

  it('exposes the supported formats in order', () => {
    expect(OUTPUT_FORMATS).toEqual(['table', 'md', 'csv', 'json']);
  });
});

describe('CLI integration (stricli run)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'calcy-cli-render-'));
  const file = join(dir, 'workbook.calcy');
  writeFileSync(file, 'x = 2 km\ny = x * 3\n');

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function fakeProcess() {
    let stdout = '';
    let stderr = '';
    return {
      stdout: {
        write(s: string) {
          stdout += s;
          return true;
        }
      },
      stderr: {
        write(s: string) {
          stderr += s;
          return true;
        }
      },
      env: {},
      exitCode: undefined as number | undefined,
      get out() {
        return stdout;
      },
      get err() {
        return stderr;
      }
    };
  }

  it('renders a workbook file to a markdown table', async () => {
    const proc = fakeProcess();
    await run(app, [file, '--format', 'md'], { process: proc as never });
    expect(proc.out).toContain('| line |');
    expect(proc.out).toContain('| x');
    expect(proc.out).toContain('2 km');
  });

  it('reports an error for a missing file', async () => {
    const proc = fakeProcess();
    await run(app, ['nonexistent-file-xyz.calcy', '-f', 'md'], { process: proc as never });
    const combined = proc.out + proc.err;
    expect(combined).toContain('nonexistent-file-xyz.calcy');
    expect(proc.out).not.toContain('| line |');
  });
});
