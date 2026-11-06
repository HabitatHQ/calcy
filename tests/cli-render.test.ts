import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '@stricli/core';
import { compile } from 'mdsvex';
import { afterAll, describe, expect, it } from 'vitest';
import { app } from '../src/cli/command';
import { render } from '../src/cli/render';
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

  it.each([
    'left | right',
    String.raw`left \| right`,
    String.raw`left \\| right`
  ])('preserves Markdown table columns and literal comment text: %s', async (note) => {
    const expression = `x = 1 # ${note}`;
    const rendered = await compile(render(makeEngine().evalSheet(expression), 'md'));
    const cells = [...(rendered?.code ?? '').matchAll(/<td>(.*?)<\/td>/gs)].map(
      (match) => match[1]
    );
    expect(cells).toEqual(['1', 'x', expression, '1', 'point', note]);
  });

  it('table format uses box-drawing chars with no trailing newline', () => {
    const t = render(result, 'table');
    expect(/[│╔╗╚╝─]/.test(t)).toBe(true);
    expect(t.endsWith('\n')).toBe(false);
  });

  it('JSON export preserves evaluated values and expressions', () => {
    const parsed = JSON.parse(render(result, 'json'));
    expect(parsed.lines).toMatchObject([
      { raw: 'x = 2 km', name: 'x', display: { value: '2', unit: 'km' } },
      { raw: 'y = x * 3', name: 'y', display: { value: '6', unit: 'km' } }
    ]);
  });
});

it('escapes literal Markdown table cell syntax', async () => {
  const note = '`C:\\temp` | **literal**';
  const source = `x = 1 # ${note}`;
  const compiled = await compile(render(makeEngine().evalSheet(source), 'md'));
  const cells = [...(compiled?.code ?? '').matchAll(/<td>(.*?)<\/td>/gs)].map((match) => match[1]);
  expect(cells).toEqual(['1', 'x', source, '1', 'point', note]);
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

  it.each([
    '0',
    '-1',
    '0.5',
    '10000.9',
    'NaN',
    'Infinity'
  ])('rejects invalid sample counts before producing results: %s', async (samples) => {
    const proc = fakeProcess();
    await run(app, [file, '--samples', samples], { process: proc as never });
    expect(proc.exitCode).toEqual(expect.any(Number));
    expect(proc.exitCode).not.toBe(0);
    expect(proc.err).toMatch(/positive integer|convert .* to a number/i);
    expect(proc.out).not.toContain('| line |');
  });

  it.each([
    '0',
    '1',
    '-1',
    '1.5',
    'Infinity',
    'NaN'
  ])('rejects invalid confidence before evaluating: %s', async (confidence) => {
    const proc = fakeProcess();
    await run(app, [file, '--confidence', confidence], { process: proc as never });
    expect(proc.exitCode).not.toBe(0);
    expect(proc.err).toMatch(/confidence|convert .* to a number/i);
    expect(proc.out).toBe('');
  });

  it('reports an error for a missing file', async () => {
    const proc = fakeProcess();
    await run(app, ['nonexistent-file-xyz.calcy', '-f', 'md'], { process: proc as never });
    const combined = proc.out + proc.err;
    expect(combined).toContain('nonexistent-file-xyz.calcy');
    expect(proc.out).not.toContain('| line |');
  });
});
