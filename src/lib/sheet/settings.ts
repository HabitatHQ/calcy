// Pure parsing of persisted settings strings and custom-unit input. The DB
// stores everything as strings; these turn them into validated, typed values.

import {
  isValidCalendarDays,
  isValidConfidence,
  isValidSampleCount,
  type NumberFormat
} from '$lib/engine';

export interface ParsedSettings {
  monthDays?: number;
  yearDays?: number;
  samples?: number;
  numberFormat?: NumberFormat;
  mode?: 'notepad' | 'tape';
  // UI colour theme. 'system' (the default) follows prefers-color-scheme.
  theme?: 'system' | 'light' | 'dark';
  // Confidence level used by `lo to hi` / `about` / `~` to map a symmetric
  // interval onto a normal/lognormal. In (0, 1). Default 0.90.
  confidence?: number;
  // Three-pane column widths in pixels plus per-column collapse flags;
  // persisted as a single `editor,gutter,inspector,ec,gc,ic` string so a
  // partial write can't leave the layout half-applied.
  layout?: {
    editor: number;
    gutter: number;
    inspector: number;
    editorCollapsed: boolean;
    gutterCollapsed: boolean;
    inspectorCollapsed: boolean;
  };
  debugAst: boolean;
}

const NUMBER_FORMATS: readonly string[] = ['auto', 'compact', 'newspaper', 'scientific'];

// Validate the raw string→string settings map into typed fields. Unknown or
// missing keys are simply omitted (the caller keeps its default), except
// `debugAst`, which is always resolved to a boolean.
export function parseSettings(raw: Record<string, string>): ParsedSettings {
  const out: ParsedSettings = { debugAst: raw.debugAst === 'true' };
  // Invalid persisted values must not reach evaluation; sample counts are
  // positive safe integers while calendar-day values may remain fractional.
  const positive = (s: string | undefined): number | undefined => {
    if (!s) return undefined;
    const n = Number(s);
    return isValidCalendarDays(n) ? n : undefined;
  };
  out.monthDays = positive(raw.monthDays);
  out.yearDays = positive(raw.yearDays);
  const samples = Number(raw.samples);
  if (isValidSampleCount(samples)) out.samples = samples;
  if (NUMBER_FORMATS.includes(raw.numberFormat))
    out.numberFormat = raw.numberFormat as NumberFormat;
  if (raw.mode === 'tape' || raw.mode === 'notepad') out.mode = raw.mode;
  if (raw.theme === 'system' || raw.theme === 'light' || raw.theme === 'dark')
    out.theme = raw.theme;
  if (raw.confidence) {
    const c = Number(raw.confidence);
    if (isValidConfidence(c)) out.confidence = c;
  }
  if (raw.layout) {
    const parts = raw.layout.split(',').map((s) => s.trim());
    if (parts.length === 3 && parts.every((s) => Number.isFinite(Number(s)) && Number(s) > 0)) {
      // Legacy 3-tuple: just widths, all expanded.
      out.layout = {
        editor: Number(parts[0]),
        gutter: Number(parts[1]),
        inspector: Number(parts[2]),
        editorCollapsed: false,
        gutterCollapsed: false,
        inspectorCollapsed: false
      };
    } else if (parts.length === 6) {
      // New 6-tuple: editor,gutter,inspector,ec,gc,ic.
      const [w, e, i, ec, gc, ic] = parts.map(Number);
      if (
        [w, e, i].every((n) => Number.isFinite(n) && n > 0) &&
        [ec, gc, ic].every((n) => n === 0 || n === 1)
      ) {
        out.layout = {
          editor: w,
          gutter: e,
          inspector: i,
          editorCollapsed: !!ec,
          gutterCollapsed: !!gc,
          inspectorCollapsed: !!ic
        };
      }
    }
  }
  return out;
}

export type CustomUnitInput = { name: string; definition: string } | { error: string };

// Parse a `name = definition` (optionally `unit name = …`) custom-unit entry.
// Returns a structured error message rather than throwing.
export function parseCustomUnitInput(input: string): CustomUnitInput {
  const m = /^(?:unit\s+)?([A-Za-z_]\w*)\s*=\s*(.+)$/.exec(input.trim());
  if (!m) return { error: 'format: name = definition (e.g. sprint = 2 week)' };
  return { name: m[1], definition: m[2] };
}
