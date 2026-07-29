// Render an evaluated workbook (SheetResult) to a chosen text format for the
// CLI. Pure — no I/O. The row model (RESULT_HEADER / resultRows) is shared with
// the in-app CSV export so every format stays column-consistent.

import { markdownTable } from 'markdown-table';
import { table } from 'table';
import type { SheetResult } from '../lib/engine';
import { RESULT_HEADER, resultRows, toCsv } from '../lib/sheet/export';

export const OUTPUT_FORMATS = ['table', 'md', 'csv', 'json'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export function render(result: SheetResult, format: OutputFormat): string {
  switch (format) {
    case 'md':
      return renderMarkdown(result);
    case 'csv':
      return toCsv(result.lines);
    case 'table':
      return renderTable(result);
    case 'json':
      return renderJson(result);
  }
}

// Header row + one data row per evaluated line, as a plain string grid.
function grid(result: SheetResult): string[][] {
  return [[...RESULT_HEADER], ...resultRows(result.lines)];
}

export function renderMarkdown(result: SheetResult): string {
  return markdownTable(grid(result));
}

export function renderTable(result: SheetResult): string {
  // `table` terminates its output with a newline; drop it so the caller owns
  // trailing whitespace (and stdout gets exactly one newline appended).
  return table(grid(result)).trimEnd();
}

export function renderJson(result: SheetResult): string {
  return JSON.stringify(result, typedArrayReplacer, 2);
}

// Distribution summaries can carry Float64Array sample buffers; JSON.stringify
// renders a typed array as an index-keyed object, so coerce any typed array
// (but not a DataView) to a plain number array first.
function typedArrayReplacer(_key: string, value: unknown): unknown {
  return ArrayBuffer.isView(value) && !(value instanceof DataView)
    ? Array.from(value as unknown as ArrayLike<number>)
    : value;
}
