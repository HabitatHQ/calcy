// The universal value type: a distribution of a dimensioned quantity.
//
// Every magnitude is stored in *canonical base units* (SI: m, kg, s, A, K,
// mol, cd, bit; plus per-name base dims for counts/currency). A value is
// either a deterministic `scalar` or an N-sample `samples` array — never both.
// Scalars stay scalar (allocation-free) until they meet a distribution.

// A dimension signature: base-dim name -> exponent. Zero exponents omitted.
export type Dimension = Record<string, number>;

// A scenario axis: a named, ordered set of labelled coordinates. A value gains
// one or more axes (see `Value.axes`); each axis multiplies the value's shape
// into a grid of `cells`. Distinct from `dim` (units) and from `list` (a
// reducer input) — an axis is labelled *output*.
export interface Axis {
  name: string; // 'case', 'geo', …
  coords: string[]; // ordered labels: ['low', 'base', 'high']
}

// Optional parametric identity carried by certain distribution constructors
// (e.g. `beta(a, b)`) so downstream functions like `update()` can apply an
// exact conjugate update without reverse-engineering the prior shape. Kept
// narrow on purpose — sample-only posteriors are still expressible; you just
// can't update them analytically.
//
// Each entry stores enough state for the analytical-arithmetic layer
// (Phase 3) to recognise and combine distributions in closed form:
//   - `normal.mean + normal.mean → normal`, `lognormal · lognormal → lognormal`
//   - `p(d, q)` skips the sample-sort path for known families
//   - `mean(d)` reads off the analytic moment instead of sample-mean
export type ValueMeta =
  | { kind: 'normal'; mean: number; sd: number }
  | { kind: 'lognormal'; mu: number; sigma: number }
  | { kind: 'uniform'; lo: number; hi: number }
  | { kind: 'exponential'; mean: number }
  | { kind: 'poisson'; lambda: number }
  | { kind: 'beta'; a: number; b: number }
  | { kind: 'triangular'; lo: number; mode: number; hi: number }
  | { kind: 'pert'; alpha: number; beta: number; lo: number; hi: number }
  | { kind: 'weibull'; shape: number; scale: number }
  | { kind: 'binomial'; n: number; p: number };

export interface Value {
  dim: Dimension;
  scalar?: number; // present iff deterministic
  samples?: Float64Array; // present iff uncertain (length N)
  list?: number[]; // present iff a list literal `[1, 2, 3]` or range `1..5`
  meta?: ValueMeta;
  // Set only on a bare *affine* (offset) unit reference, e.g. `°C`/`barg`. The
  // magnitude-multiply (`20 °C`) consumes it to produce an absolute base-unit
  // value (`base = magnitude·scale + offset`); the tag does not survive onto
  // the result. Delta units (`Cdeg`) are plain multiplicative units and carry
  // no affine tag.
  affine?: { scale: number; offset: number };
  // Set only on a bare *logarithmic* unit reference (`dB`/`dBm`/`dBW`). The
  // magnitude-multiply (`20 dBm`) consumes it to produce a linear base-unit
  // value (`base = ref · 10^(magnitude / factor)`); the tag does not survive
  // onto the result, so ordinary linear arithmetic flows. Conversion `P in dBm`
  // reapplies the inverse (`factor · log10(base / ref)`) for display only.
  log?: { ref: number; factor: number };
  // Temperature absolute-vs-difference tag (phase 2). `abs` comes from an
  // absolute unit (°C/°F); `diff` from a delta unit (Cdeg/Δ°C) or from
  // subtracting two absolutes. Drives the +/− algebra and lets a difference
  // convert without the offset. Only set on pure-temperature values; plain `K`
  // is untagged and behaves exactly as before.
  temp?: 'abs' | 'diff';
  // Preferred *display* unit, carried from the unit the user typed (`day`,
  // `km/h`, `GB/s`). The magnitude itself stays in canonical base units — this
  // only chooses how the result is rendered, exactly as an explicit `in <unit>`
  // would. Propagated through arithmetic by the evaluator and surfaced as the
  // pinned unit at the line root when no `in` is present. Dropped whenever a
  // dimension cancels (rate × time → count), since then there is no clean typed
  // unit to show. See [unitsCancel] / [composeHint] in eval.ts.
  unitHint?: UnitHint;
  // Scenario axes carried by this value. When present, the value is a grid: it
  // holds `cells` (one full Value per coord-combination, row-major over `axes`)
  // instead of its own scalar/samples. A value with no `axes` is exactly
  // today's scalar/samples value (zero-cost). Every cell shares this value's
  // `dim`.
  axes?: Axis[];
  cells?: Value[]; // row-major over `axes`; length = ∏ axes[i].coords.length
}

// A display-unit choice: how to render a base-unit magnitude. Structurally the
// same as eval's PinnedUnit (an inferred hint becomes an implicit pin).
export interface UnitHint {
  label: string;
  factor: number; // base-per-1-of-unit
  offset?: number; // affine units: displayed = (base − offset) / factor
  log?: { ref: number; factor: number }; // log units: displayed = factor · log10(base / ref)
}

export const dimZero = (): Dimension => ({});

export function dimMul(a: Dimension, b: Dimension): Dimension {
  const out: Dimension = { ...a };
  for (const k in b) {
    const e = (out[k] ?? 0) + b[k];
    if (e === 0) delete out[k];
    else out[k] = e;
  }
  return out;
}

export function dimDiv(a: Dimension, b: Dimension): Dimension {
  const out: Dimension = { ...a };
  for (const k in b) {
    const e = (out[k] ?? 0) - b[k];
    if (e === 0) delete out[k];
    else out[k] = e;
  }
  return out;
}

export function dimPow(a: Dimension, p: number): Dimension {
  const out: Dimension = {};
  for (const k in a) {
    const e = a[k] * p;
    if (e !== 0) out[k] = e;
  }
  return out;
}

export function dimEq(a: Dimension, b: Dimension): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if ((a[k] ?? 0) !== (b[k] ?? 0)) return false;
  return true;
}

export const dimIsZero = (a: Dimension): boolean => Object.keys(a).length === 0;

// Human-readable dimension label, e.g. {length:1, time:-1} -> "m s^-1".
const BASE_SYMBOL: Record<string, string> = {
  length: 'm',
  mass: 'kg',
  time: 's',
  current: 'A',
  temperature: 'K',
  amount: 'mol',
  luminosity: 'cd',
  data: 'bit',
  usd: '$',
  eur: '€',
  gbp: '£',
  jpy: '¥',
  inr: '₹',
  co2: 'gCO2'
};

// Unicode superscript digits/minus, used to render integer exponents as
// `m²` instead of `m^2`. Only exact integers get this treatment (see `sup`
// below) — fractional exponents (e.g. `^0.5`) keep the ASCII `^n` form.
const SUPERSCRIPT_DIGIT = ['⁰', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹'];
const SUPERSCRIPT_MINUS = '⁻';

// Superscript form of an exponent for display, or the ASCII `^e` fallback
// when `e` isn't an integer (e.g. 0.5 stays as `^0.5`).
function sup(e: number): string {
  if (!Number.isInteger(e)) return `^${e}`;
  const digits = Math.abs(e)
    .toString()
    .split('')
    .map((c) => SUPERSCRIPT_DIGIT[Number(c)])
    .join('');
  return e < 0 ? `${SUPERSCRIPT_MINUS}${digits}` : digits;
}

// Render with a `/` denominator instead of negative exponents, so a rate reads
// as "req/s" rather than "req s^-1". Numerator and denominator each list their
// base symbols (positive exponents kept as superscripts, e.g. `sym²`); a
// multi-term denominator is parenthesised, e.g. {mass:1, length:-1, time:-1}
// -> "kg/(m s)".
export function dimToString(d: Dimension): string {
  const sym = (k: string) => BASE_SYMBOL[k] ?? k;
  const term = (k: string) => {
    const e = Math.abs(d[k]);
    return e === 1 ? sym(k) : `${sym(k)}${sup(e)}`;
  };
  const keys = Object.keys(d).sort();
  const num = keys.filter((k) => d[k] > 0);
  const den = keys.filter((k) => d[k] < 0);
  if (den.length === 0) return num.map(term).join(' ');
  const numStr = num.length ? num.map(term).join(' ') : '1';
  const denStr = den.map(term).join(' ');
  return `${numStr}/${den.length > 1 ? `(${denStr})` : denStr}`;
}

export const isScalar = (v: Value): boolean => v.scalar != null;

// Index of the time exponent — used for rate detection.
export const timeExp = (d: Dimension): number => d.time ?? 0;
