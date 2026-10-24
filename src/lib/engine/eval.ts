// AST evaluator: walks nodes to Values, with the scalar fast path and lazy
// broadcast to samples only when a value meets a distribution.

import { collapseAxis, resolveAxes, selectAxes } from './axis';
import {
  analyticalMean,
  analyticalMode,
  analyticalPercentile,
  analyticalSkew,
  closedFormBinop,
  sampleFromMeta
} from './closed-form';
import {
  betaSamples,
  binomialSamples,
  ciSamples,
  correlateTo,
  type DistFns,
  exponentialSamples,
  lognormalSamples,
  mixtureSamples,
  normalSamples,
  pertSamples,
  poissonSamples,
  reduceMean,
  reduceMode,
  reducePercentile,
  reduceSd,
  reduceSkew,
  triangularSamples,
  uniformSamples,
  weibullSamples,
  zForLevel
} from './mc';
import type { CallArg, Node } from './parse';
import { normalInverseCdf } from './stats-adapter';
import type { UnitDef } from './units';
import {
  type Axis,
  type Dimension,
  dimDiv,
  dimEq,
  dimIsZero,
  dimMul,
  dimPow,
  dimToString,
  type UnitHint,
  type Value,
  type ValueMeta
} from './value';

// ---- Display-unit hints --------------------------------------------------
// The magnitude is always canonical base units; a hint records the unit the
// user typed so the result renders in it (issue #1). Hints ride along on
// Values and compose through arithmetic, then surface as an implicit pin at the
// line root (see evalRoot). offset/log units (°C, dB) never compose, so a hint
// carrying one is dropped the moment it meets another unit.

// Attach a hint to a freshly-built value (no-op when there's nothing to carry).
const withHint = (v: Value, hint?: UnitHint): Value => (hint ? { ...v, unitHint: hint } : v);

// Does combining dims `da` and `db` under `op` reduce a shared base dimension?
// e.g. req/s (× day) cancels `time`. When it does, the two typed units didn't
// concatenate into a clean compound unit, so the caller drops the hint.
function unitsCancel(op: '*' | '/', da: Dimension, db: Dimension): boolean {
  for (const k in da) {
    if (!da[k]) continue;
    const e = op === '/' ? -(db[k] ?? 0) : (db[k] ?? 0);
    if (e !== 0 && Math.sign(da[k]) !== Math.sign(e)) return true;
  }
  return false;
}

// Wrap a compound denominator label so `GB / (req/s)` doesn't read as `GB/req/s`.
const denomLabel = (l: string): string => (/[\s/]/.test(l) ? `(${l})` : l);

// Combine the operands' display hints for a `*` or `/`. Returns undefined when
// there's nothing clean to show: no hints, an affine/log unit in play, or a
// cancelling dimension. A dimensionless operand (a plain number) contributes no
// unit, so the other side's hint carries through unchanged (`2 * day` → day).
function composeHint(op: '*' | '/', a: Value, b: Value): UnitHint | undefined {
  const ha = a.unitHint;
  const hb = b.unitHint;
  if (ha?.offset != null || ha?.log || hb?.offset != null || hb?.log) return undefined;
  if (!ha && !hb) return undefined;
  // Only one side has a unit. Carrying it is valid when it stays in the
  // numerator (`2 * day`, `day / 2`); but `1 / day` is "per day", whose clean
  // label is the inverse — so drop it and let the base unit (`1/day`) show.
  if (!ha) return dimIsZero(a.dim) && op === '*' ? hb : undefined;
  if (!hb) return dimIsZero(b.dim) ? ha : undefined;
  if (unitsCancel(op, a.dim, b.dim)) return undefined;
  const factor = op === '*' ? ha.factor * hb.factor : ha.factor / hb.factor;
  const label = op === '*' ? `${ha.label} ${hb.label}` : `${ha.label}/${denomLabel(hb.label)}`;
  return { label, factor };
}

// Common hint across a set of summed/listed values: keep it only when every
// contributor agrees on the same unit label (mixed units → fall back to base).
function sharedHint(vals: Value[]): UnitHint | undefined {
  const first = vals[0]?.unitHint;
  if (!first) return undefined;
  return vals.every((v) => v.unitHint?.label === first.label) ? first : undefined;
}

export interface EvalCtx {
  env: Map<string, Value>;
  units: Map<string, UnitDef>;
  fns: DistFns;
  // Result values of preceding result-bearing lines, in sheet order. Populated
  // by the sheet evaluator; consumed by `sum(above)`.
  above: Value[];
  // Declared cross-dimension equivalences, by name (`bridge water = 18 g/mol`),
  // used by `X in Y via name`.
  bridges: Map<string, Value>;
}

export interface PinnedUnit {
  label: string;
  factor: number; // base-per-1-of-unit
  offset?: number; // affine units: displayed = (base − offset) / factor
  log?: { ref: number; factor: number }; // log units: displayed = factor · log10(base / ref)
}

const samplesOf = (v: Value, n: number): Float64Array =>
  v.samples ?? Float64Array.from({ length: n }, () => v.scalar as number);

// Elementwise binary op with scalar fast path and dim check.
function binop(
  a: Value,
  b: Value,
  fn: (x: number, y: number) => number,
  dimOut: Dimension,
  n: number
): Value {
  if (a.scalar != null && b.scalar != null) return { dim: dimOut, scalar: fn(a.scalar, b.scalar) };
  const xa = samplesOf(a, n);
  const xb = samplesOf(b, n);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = fn(xa[i], xb[i]);
  return { dim: dimOut, samples: out };
}

function unaryMap(a: Value, fn: (x: number) => number, dimOut: Dimension): Value {
  if (a.scalar != null) return { dim: dimOut, scalar: fn(a.scalar) };
  const out = new Float64Array((a.samples as Float64Array).length);
  const xs = a.samples as Float64Array;
  for (let i = 0; i < xs.length; i++) out[i] = fn(xs[i]);
  return { dim: dimOut, samples: out };
}

const scalarParam = (v: Value, what: string): number => {
  if (v.scalar == null) throw new Error(`${what} must be a deterministic scalar`);
  return v.scalar;
};

// ---- scenario grids ----

// Cap on the number of cells a single scenario value may hold. Aligned axes
// don't multiply, but crosses do; past this the grid stops being a readable
// table, so it's a hard error naming the axes rather than a silent subset.
const MAX_CELLS = 256;

// A value's cells as a flat array: the grid's own cells, or itself as one cell
// when it has no axes (so a plain value broadcasts against a grid).
const cellsOf = (v: Value): Value[] => (v.axes ? (v.cells ?? []) : [v]);

// Re-wrap freshly-computed cells into a grid over `axes`, carrying a shared
// display hint when every cell agrees on one (so the grid renders in the unit
// the cells carry).
function makeGrid(axes: Axis[], cells: Value[]): Value {
  const grid: Value = { dim: cells[0].dim, axes, cells };
  const h0 = cells[0].unitHint;
  const shared =
    h0 && cells.every((c) => c.unitHint?.label === h0.label && c.unitHint?.factor === h0.factor)
      ? h0
      : undefined;
  return shared ? withHint(grid, shared) : grid;
}

// Apply a unary op to every cell of a grid (`-scenario`, `scenario ^ 2`).
function mapCells(v: Value, fn: (cell: Value) => Value): Value {
  return makeGrid(v.axes as Axis[], cellsOf(v).map(fn));
}

// Resolve two operands' axes (align/broadcast/cross), then apply the scalar op
// to each pair of cells. At least one operand carries axes.
function resolveAxisBinop(a: Value, b: Value, perCell: (x: Value, y: Value) => Value): Value {
  const { axes, leftIndex, rightIndex } = resolveAxes(a.axes ?? [], b.axes ?? []);
  if (leftIndex.length > MAX_CELLS)
    throw new Error(
      `scenario grid too large: ${leftIndex.length} cells over ${axes.map((x) => x.name).join(' × ')} (cap ${MAX_CELLS})`
    );
  const aCells = cellsOf(a);
  const bCells = cellsOf(b);
  const cells = leftIndex.map((li, k) => perCell(aCells[li], bCells[rightIndex[k]]));
  return makeGrid(axes, cells);
}

// Fold-based min/max. `Math.min(...arr)` spreads every element as a call
// argument and overflows the call stack for large arrays (the default sample
// array is ~10k, and a list like `0..200000` is far larger), so we reduce
// instead. NaN elements are skipped rather than poisoning the whole result.
const foldMin = (a: ArrayLike<number>): number => {
  let m = Infinity;
  for (let i = 0; i < a.length; i++) if (a[i] < m) m = a[i];
  return m;
};
const foldMax = (a: ArrayLike<number>): number => {
  let m = -Infinity;
  for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i];
  return m;
};

// Scale a value's magnitude (scalar or whole sample array) by `k`, relabelling
// its dimension. Used by bridge conversions.
function scaleVal(v: Value, k: number, dim: Dimension): Value {
  if (v.scalar != null) return { dim, scalar: v.scalar * k };
  const xs = v.samples as Float64Array;
  const out = new Float64Array(xs.length);
  for (let i = 0; i < xs.length; i++) out[i] = xs[i] * k;
  return { dim, samples: out };
}

// Cross a dimension gap through a declared bridge: multiply or divide the value
// by the (deterministic) bridge factor, whichever lands on the target dim.
function applyBridge(value: Value, name: string, ctx: EvalCtx, targetDim: Dimension): Value {
  const bridge = ctx.bridges.get(name);
  if (!bridge) throw new Error(`unknown bridge '${name}' — declare it with 'bridge ${name} = …'`);
  const k = scalarParam(bridge, `bridge '${name}'`);
  if (dimEq(dimDiv(value.dim, bridge.dim), targetDim)) return scaleVal(value, 1 / k, targetDim);
  if (dimEq(dimMul(value.dim, bridge.dim), targetDim)) return scaleVal(value, k, targetDim);
  throw new Error(
    `bridge '${name}' can't convert ${dimToString(value.dim) || 'number'} to ${dimToString(targetDim) || 'number'}`
  );
}

// Apply an affine unit to a magnitude value: `base = x·scale + offset`. Maps a
// scalar or a whole sample array; the result is an absolute temperature/pressure.
function applyAffine(mag: Value, aff: { scale: number; offset: number }, dim: Dimension): Value {
  if (mag.scalar != null) return { dim, scalar: mag.scalar * aff.scale + aff.offset, temp: 'abs' };
  const xs = mag.samples as Float64Array;
  const out = new Float64Array(xs.length);
  for (let i = 0; i < xs.length; i++) out[i] = xs[i] * aff.scale + aff.offset;
  return { dim, samples: out, temp: 'abs' };
}

// Apply a logarithmic unit to a magnitude value: `base = ref·10^(x/factor)`.
// Maps a scalar or a whole sample array; the result is an ordinary linear
// base-unit value (the log tag is consumed, so arithmetic flows linearly).
function applyLog(mag: Value, log: { ref: number; factor: number }, dim: Dimension): Value {
  const f = (x: number) => log.ref * 10 ** (x / log.factor);
  if (mag.scalar != null) return { dim, scalar: f(mag.scalar) };
  const xs = mag.samples as Float64Array;
  const out = new Float64Array(xs.length);
  for (let i = 0; i < xs.length; i++) out[i] = f(xs[i]);
  return { dim, samples: out };
}

// The temperature absolute-vs-difference algebra. Returns null when it doesn't
// apply (no temp tag on either side, or a non-temp op), so the caller falls
// through to ordinary arithmetic. An untagged temperature operand is read as a
// *difference* here (the common `°C + 5 K` increment case); plain `K`-only
// arithmetic never reaches this because neither side is tagged.
function tempAlgebra(op: string, a: Value, b: Value): Value | null {
  if (!a.temp && !b.temp) return null;
  const ka = a.temp ?? 'diff';
  const kb = b.temp ?? 'diff';
  const apply = (
    fn: (x: number, y: number) => number,
    dimOut: Dimension,
    kind: 'abs' | 'diff'
  ): Value => {
    const n = (a.samples ?? b.samples)?.length ?? 0;
    const r = n
      ? binop(a, b, fn, dimOut, n)
      : { dim: dimOut, scalar: fn(a.scalar as number, b.scalar as number) };
    r.temp = kind;
    return r;
  };
  // Mismatched dims (`20 °C + 5 m`) fall through to the ordinary
  // incompatible-dimensions error rather than being silently combined.
  if ((op === '+' || op === '-') && !dimEq(a.dim, b.dim)) return null;
  if (op === '+') {
    if (ka === 'abs' && kb === 'abs')
      throw new Error('cannot add two absolute temperatures — use a difference (e.g. Cdeg) or K');
    return apply((x, y) => x + y, a.dim, ka === 'abs' || kb === 'abs' ? 'abs' : 'diff');
  }
  if (op === '-') {
    if (ka === 'abs' && kb === 'abs') return apply((x, y) => x - y, a.dim, 'diff');
    if (ka === 'abs' && kb === 'diff') return apply((x, y) => x - y, a.dim, 'abs');
    if (ka === 'diff' && kb === 'diff') return apply((x, y) => x - y, a.dim, 'diff');
    throw new Error('cannot subtract an absolute temperature from a difference');
  }
  // Scaling a difference by a dimensionless factor stays a difference; any other
  // product/quotient lets the temperature combine into a composite dim, so the
  // tag is dropped (return null → ordinary arithmetic).
  if (op === '*') {
    if (dimIsZero(a.dim) && b.temp) return apply((x, y) => x * y, b.dim, kb);
    if (dimIsZero(b.dim) && a.temp) return apply((x, y) => x * y, a.dim, ka);
  }
  if (op === '/' && a.temp && dimIsZero(b.dim)) return apply((x, y) => x / y, a.dim, ka);
  return null;
}

const requireDimless = (v: Value, what: string): void => {
  if (!dimIsZero(v.dim)) throw new Error(`${what} must be dimensionless`);
};

// The q-quantile of a value, analytic-first (exact inverse CDF for known
// families) then empirical from the sample array — the same resolution `p(d, q)`
// uses. A scalar is its own quantile. Shared by `interval(...)`.
function percentileOf(d: Value, q: number): number {
  if (d.scalar != null) return d.scalar;
  const ap = analyticalPercentile(d, q);
  if (ap != null && Number.isFinite(ap)) return ap;
  return reducePercentile(d.samples as Float64Array, q);
}

// Parameter names (with aliases) for functions that accept named arguments.
// First alias is canonical (used in error messages).
const PARAMS: Record<string, string[][]> = {
  normal: [['mean'], ['sd', 'stdev']],
  lognormal: [['p5'], ['p95']],
  uniform: [
    ['lo', 'min'],
    ['hi', 'max']
  ],
  beta: [['a'], ['b']],
  pert: [
    ['low', 'lo', 'min'],
    ['likely', 'ml', 'mode'],
    ['high', 'hi', 'max']
  ],
  triangular: [
    ['low', 'lo', 'min'],
    ['likely', 'ml', 'mode'],
    ['high', 'hi', 'max']
  ],
  exponential: [['mean']],
  poisson: [['mean']],
  weibull: [
    ['shape', 'k'],
    ['scale', 'lambda']
  ],
  binomial: [['trials', 'n'], ['p']],
  p: [
    ['dist', 'd'],
    ['q', 'p']
  ],
  percentile: [
    ['dist', 'd'],
    ['q', 'p']
  ],
  interval: [
    ['dist', 'd'],
    ['level', 'confidence']
  ],
  clamp: [['x'], ['lo', 'min'], ['hi', 'max']],
  round: [['x'], ['digits', 'n']],
  cagr: [['start', 'from'], ['end'], ['periods', 'n']],
  ci: [
    ['lo', 'low'],
    ['hi', 'high'],
    ['level', 'confidence']
  ],
  update: [
    ['prior', 'p'],
    ['successes', 'k', 'hits'],
    ['trials', 'n', 'tries']
  ]
};

// Catalogue of every user-callable function, for the generated reference. The
// `name`/`aliases` here are the single source the doc lists; a test
// (function-catalogue.test.ts) cross-checks them against the `evalCall` switch so
// adding a function without documenting it fails the build. Internal AST nodes
// (num/ident/call/neg/list/range/where/given/convert/bin) and operators are not
// functions and are excluded there.
export interface FnDoc {
  name: string;
  aliases?: string[];
  category:
    | 'Distributions'
    | 'Reducers'
    | 'Scenarios'
    | 'Math'
    | 'Trigonometry'
    | 'Inference'
    | 'Tiered';
  sig: string;
  summary: string;
}
export const FUNCTIONS: FnDoc[] = [
  // Distributions
  {
    name: 'normal',
    category: 'Distributions',
    sig: 'normal(mean, sd)',
    summary: 'Gaussian with the given mean and standard deviation.'
  },
  {
    name: 'lognormal',
    category: 'Distributions',
    sig: 'lognormal(p5, p95)',
    summary: 'Lognormal fitted to a 5th/95th-percentile range.'
  },
  {
    name: 'uniform',
    category: 'Distributions',
    sig: 'uniform(lo, hi)',
    summary: 'Flat distribution between two bounds.'
  },
  {
    name: 'beta',
    category: 'Distributions',
    sig: 'beta(a, b)',
    summary: 'Beta distribution (dimensionless); a/b are pseudo-counts.'
  },
  {
    name: 'pert',
    category: 'Distributions',
    sig: 'pert(lo, ml, hi)',
    summary: 'Three-point beta-PERT estimate (low, most-likely, high).'
  },
  {
    name: 'triangular',
    category: 'Distributions',
    sig: 'triangular(lo, ml, hi)',
    summary: 'Three-point triangular estimate; flatter than pert.'
  },
  {
    name: 'exponential',
    category: 'Distributions',
    sig: 'exponential(mean)',
    summary: 'Wait time between events; carries the mean’s units.'
  },
  {
    name: 'poisson',
    category: 'Distributions',
    sig: 'poisson(mean)',
    summary: 'Whole count of events at the given mean rate.'
  },
  {
    name: 'weibull',
    category: 'Distributions',
    sig: 'weibull(shape, scale)',
    summary: 'Time-to-failure / reliability; scale carries the units, shape is dimensionless.'
  },
  {
    name: 'binomial',
    category: 'Distributions',
    sig: 'binomial(trials, p)',
    summary: 'Whole count of successes in n independent trials (bounded by n).'
  },
  {
    name: 'discrete',
    category: 'Distributions',
    sig: 'discrete(w1: v1, w2: v2, …)',
    summary: 'Weighted scenarios (or equal-weight from a list).'
  },
  {
    name: 'mixture',
    category: 'Distributions',
    sig: 'mixture(d1, d2, …)',
    summary: 'Equal-weight (or weighted) mix of like-dimensioned distributions.'
  },
  {
    name: 'ci',
    category: 'Distributions',
    sig: 'ci(lo, hi[, level])',
    summary: 'Confidence interval as a function — the `lo to hi` form, with an optional level.'
  },
  {
    name: 'correlate',
    category: 'Distributions',
    sig: 'correlate(reference, marginal, r)',
    summary:
      'Couple a marginal to an existing distribution at rank correlation r, preserving its marginal exactly.'
  },
  // Reducers
  {
    name: 'mean',
    category: 'Reducers',
    sig: 'mean(d)',
    summary: 'Average of a distribution (exact for known families).'
  },
  {
    name: 'median',
    category: 'Reducers',
    sig: 'median(d)',
    summary: 'Middle value (50th percentile).'
  },
  {
    name: 'mode',
    category: 'Reducers',
    sig: 'mode(d)',
    summary:
      'Most likely value (density peak); analytic for known families, else a smoothed estimate.'
  },
  {
    name: 'skew',
    category: 'Reducers',
    sig: 'skew(d)',
    summary: 'Asymmetry (Fisher–Pearson): positive = upside tail. Sample skew is high-variance.'
  },
  {
    name: 'sd',
    aliases: ['stdev'],
    category: 'Reducers',
    sig: 'sd(d)',
    summary: 'Standard deviation.'
  },
  {
    name: 'p',
    aliases: ['percentile'],
    category: 'Reducers',
    sig: 'p(d, q)',
    summary: 'The q-quantile, q in 0…1.'
  },
  {
    name: 'interval',
    category: 'Reducers',
    sig: 'interval(d, level)',
    summary: 'The central [lo, hi] band at a confidence level, as a 2-element list.'
  },
  { name: 'min', category: 'Reducers', sig: 'min(d) / min(list)', summary: 'Smallest value.' },
  { name: 'max', category: 'Reducers', sig: 'max(d) / max(list)', summary: 'Largest value.' },
  {
    name: 'sum',
    category: 'Reducers',
    sig: 'sum(list) / sum(above)',
    summary: 'Total of a list, or of preceding result lines.'
  },
  {
    name: 'chance',
    category: 'Reducers',
    sig: 'chance(pred)',
    summary: 'Probability a predicate holds (mean of a 0/1 mask).'
  },
  // Scenarios
  {
    name: 'pick',
    category: 'Scenarios',
    sig: 'pick(scenario, axis = "coord")',
    summary: 'Select one coord of a scenario axis; a partial pick keeps the remaining axes.'
  },
  // Math
  { name: 'sqrt', category: 'Math', sig: 'sqrt(x)', summary: 'Square root.' },
  { name: 'abs', category: 'Math', sig: 'abs(x)', summary: 'Absolute value.' },
  { name: 'ceil', category: 'Math', sig: 'ceil(x)', summary: 'Round up to an integer.' },
  { name: 'floor', category: 'Math', sig: 'floor(x)', summary: 'Round down to an integer.' },
  {
    name: 'round',
    category: 'Math',
    sig: 'round(x, digits?)',
    summary: 'Round to the nearest integer, or to an optional number of decimal places.'
  },
  { name: 'exp', category: 'Math', sig: 'exp(x)', summary: 'e to the power x (dimensionless).' },
  {
    name: 'ln',
    aliases: ['log'],
    category: 'Math',
    sig: 'ln(x)',
    summary: 'Natural logarithm (dimensionless).'
  },
  {
    name: 'log10',
    category: 'Math',
    sig: 'log10(x)',
    summary: 'Base-10 logarithm (dimensionless).'
  },
  {
    name: 'clamp',
    category: 'Math',
    sig: 'clamp(x, lo[, hi])',
    summary: 'Keep x within bounds (2-arg = lower bound only).'
  },
  {
    name: 'cagr',
    category: 'Math',
    sig: 'cagr(start, end, periods)',
    summary: 'Compound growth rate per period, (end/start)^(1/n)−1.'
  },
  // Trigonometry
  {
    name: 'sin',
    category: 'Trigonometry',
    sig: 'sin(x)',
    summary: 'Sine; argument in radians (`deg` works).'
  },
  { name: 'cos', category: 'Trigonometry', sig: 'cos(x)', summary: 'Cosine; argument in radians.' },
  {
    name: 'tan',
    category: 'Trigonometry',
    sig: 'tan(x)',
    summary: 'Tangent; argument in radians.'
  },
  {
    name: 'asin',
    category: 'Trigonometry',
    sig: 'asin(x)',
    summary: 'Inverse sine; returns radians.'
  },
  {
    name: 'acos',
    category: 'Trigonometry',
    sig: 'acos(x)',
    summary: 'Inverse cosine; returns radians.'
  },
  {
    name: 'atan',
    category: 'Trigonometry',
    sig: 'atan(x)',
    summary: 'Inverse tangent; returns radians.'
  },
  // Inference
  {
    name: 'update',
    category: 'Inference',
    sig: 'update(prior, k, n)',
    summary:
      'Bayesian update of a beta prior with k successes in n trials (also `prior seen k of n`).'
  },
  // Tiered
  {
    name: 'bracket',
    category: 'Tiered',
    sig: 'bracket(x, u1: r1, …[, total=yes])',
    summary: 'Piecewise-constant tiers: marginal rate at x, or cumulative total with total=yes.'
  }
];

// Reorder named arguments into canonical positional order. Positional args
// (no name) fill slots in call order; named args fill their canonical slot.
// Trailing params left unset are dropped (e.g. clamp's optional hi), so the
// call's own arity check still governs; gaps in the middle are an error.
// Mixing positional + named is allowed — `update(prior, k=3, n=10)` and
// `clamp(x, 0, hi=10)` both work.
function bindNamed(name: string, callArgs: CallArg[]): Node[] {
  const params = PARAMS[name];
  if (!params) throw new Error(`${name} doesn't take named arguments`);
  const out: (Node | null)[] = new Array(params.length).fill(null);
  let positionalIdx = 0;
  for (const a of callArgs) {
    const value = a.value;
    if (value === undefined) throw new Error(`${name}: missing value for '${a.name ?? ''}'`);
    if (a.name == null) {
      // Positional: fill the next unfilled slot in order.
      while (positionalIdx < params.length && out[positionalIdx] != null) positionalIdx++;
      if (positionalIdx >= params.length) throw new Error(`${name}: too many positional arguments`);
      out[positionalIdx++] = value;
    } else {
      const idx = params.findIndex((aliases) => aliases.includes(a.name as string));
      if (idx < 0)
        throw new Error(
          `${name}: unknown argument '${a.name}' (expected ${params.map((p) => p[0]).join(', ')})`
        );
      if (out[idx]) throw new Error(`${name}: argument '${params[idx][0]}' given twice`);
      out[idx] = value;
    }
  }
  let end = params.length;
  while (end > 0 && out[end - 1] == null) end--;
  for (let i = 0; i < end; i++)
    if (out[i] == null) throw new Error(`${name}: missing argument '${params[i][0]}'`);
  return out.slice(0, end) as Node[];
}

// Weighted blend from `weight: value` pairs — backs discrete() and mixture().
function weightedMixture(callArgs: CallArg[], ctx: EvalCtx, label: string): Value {
  if (callArgs.length < 2) throw new Error(`${label} needs at least two entries`);
  const weights: number[] = [];
  const comps: Value[] = [];
  for (const a of callArgs) {
    if (a.weight == null) throw new Error(`${label}: give every entry a weight (e.g. 0.3: value)`);
    if (a.value === undefined)
      throw new Error(`${label}: bare 'weight:' is only valid for bracket() — give a value here`);
    const w = evalNode(a.weight, ctx);
    requireDimless(w, `${label} weight`);
    const wv = scalarParam(w, 'weight');
    if (wv < 0) throw new Error(`${label}: weights must be non-negative`);
    weights.push(wv);
    comps.push(evalNode(a.value, ctx));
  }
  const dim = comps[0].dim;
  for (const c of comps)
    if (!dimEq(c.dim, dim)) throw new Error(`${label}: values must share units`);
  return {
    dim,
    samples: mixtureSamples(
      comps.map((c) => samplesOf(c, ctx.fns.N)),
      ctx.fns,
      weights
    )
  };
}

// bracket(x, u1: r1, u2: r2, …, [total = yes]): piecewise-constant marginal
// function defined by `(upper, rate)` tiers. With `total` set, returns the
// cumulative integral ∫₀ˣ rate(t) dt instead. Tiers are left-closed /
// right-open: at an exact boundary the *upper* tier wins. Bounds must share
// units with `x`; rates may carry any units (typically dimensionless for tax,
// `currency/x` for tiered pricing). All rates must share the same dimension.
// Elementwise on a distribution.
// pick(scenario, axis = "coord", …) — select one coord on each named axis. A
// full selection collapses to the chosen cell (a plain value); a partial
// selection returns a smaller grid over the axes left unspecified.
function evalPick(callArgs: CallArg[], ctx: EvalCtx): Value {
  const positional = callArgs.filter((a) => a.name == null && a.weight == null);
  const selectors = callArgs.filter((a) => a.name != null);
  if (callArgs.some((a) => a.weight != null))
    throw new Error('pick(scenario, axis = "coord") — no weight: pairs');
  if (positional.length !== 1)
    throw new Error('pick(scenario, axis = "coord") — one scenario, then axis selectors');
  if (selectors.length === 0)
    throw new Error('pick needs at least one selector, e.g. pick(x, case = "base")');
  const v = evalNode(positional[0].value as Node, ctx);
  if (!v.axes) throw new Error('pick expects a scenario value (one with named axes)');
  const sel = new Map<string, string>();
  for (const s of selectors) {
    const label = s.value;
    if (label?.type !== 'str')
      throw new Error(`pick: coord for axis '${s.name}' must be quoted, e.g. ${s.name} = "base"`);
    if (sel.has(s.name as string)) throw new Error(`pick: axis '${s.name}' selected twice`);
    sel.set(s.name as string, label.value);
  }
  const { axes, index } = selectAxes(v.axes, sel);
  const cells = index.map((i) => (v.cells as Value[])[i]);
  // Fully specified → the single cell itself (a plain value, hint intact).
  return axes.length === 0 ? cells[0] : makeGrid(axes, cells);
}

// Reducers that can collapse a scenario axis with `over <axis>`. These fold
// element-wise across the axis's cells (per-draw for distributions), so they
// have a natural definition; other reducers (median, sd, p, …) do not.
const OVER_REDUCERS = new Set(['min', 'max', 'mean', 'sum']);
// Fold a scenario axis's cells with the named reducer. Cells share one dim/hint
// (they are coords of one value), so we reduce pairwise via binop; distributions
// fold per-draw, preserving correlation-by-reuse.
function foldOver(name: string, members: Value[], ctx: EvalCtx): Value {
  const n = ctx.fns.N;
  const dim = members[0].dim;
  const hint = members[0].unitHint;
  const fold = (fn: (x: number, y: number) => number) =>
    withHint(
      members.reduce((acc, m) => binop(acc, m, fn, dim, n)),
      hint
    );
  switch (name) {
    case 'min':
      return fold((x, y) => Math.min(x, y));
    case 'max':
      return fold((x, y) => Math.max(x, y));
    case 'sum':
      return fold((x, y) => x + y);
    default: {
      // mean = sum / count
      const total = fold((x, y) => x + y);
      return withHint(
        unaryMap(total, (x) => x / members.length, dim),
        hint
      );
    }
  }
}

// `min(x over case)` etc. — collapse one scenario axis. Omitting `over` reduces
// the sample axis (the ordinary reducer path); this is the axis path.
function evalReduceOver(name: string, callArgs: CallArg[], overArg: CallArg, ctx: EvalCtx): Value {
  if (!OVER_REDUCERS.has(name))
    throw new Error(
      `${name}() has no 'over <axis>' form — only min, max, mean, sum collapse an axis`
    );
  if (overArg.value?.type !== 'ident')
    throw new Error('over: expected an axis name, e.g. `min(x over case)`');
  const axisName = overArg.value.name;
  const positional = callArgs.filter((a) => a.name == null && a.weight == null);
  if (positional.length !== 1)
    throw new Error(`${name}(x over ${axisName}) takes exactly one scenario value`);
  const v = evalNode(positional[0].value as Node, ctx);
  if (!v.axes) throw new Error(`${name} over ${axisName}: the value has no axes to collapse`);
  const { axes, groups } = collapseAxis(v.axes, axisName);
  const cells = v.cells as Value[];
  const reduced = groups.map((g) =>
    foldOver(
      name,
      g.map((i) => cells[i]),
      ctx
    )
  );
  // A last surviving axis collapses to a plain value; otherwise a smaller grid.
  return axes.length === 0 ? reduced[0] : makeGrid(axes, reduced);
}

function evalBracket(callArgs: CallArg[], ctx: EvalCtx): Value {
  if (callArgs.some((a) => a.name != null && a.name !== 'total'))
    throw new Error("bracket: only 'total' is a named argument");
  const totalArg = callArgs.find((a) => a.name === 'total');
  let total = false;
  if (totalArg) {
    if (totalArg.value?.type !== 'ident') throw new Error('bracket total: must be yes or no');
    const n = (totalArg.value as { type: 'ident'; name: string }).name.toLowerCase();
    if (n === 'yes' || n === 'true' || n === '1') total = true;
    else if (n === 'no' || n === 'false' || n === '0') total = false;
    else throw new Error(`bracket total: expected yes/no, got '${n}'`);
  }
  const pairArgs = callArgs.filter((a) => a.name == null);
  if (pairArgs.length === 0 || pairArgs[0].weight !== undefined)
    throw new Error('bracket(x, u1: r1, u2: r2, …) — x first, then tier pairs');
  if (pairArgs.length < 2)
    throw new Error('bracket: needs at least one tier — bracket(x, upper: rate)');
  const x = evalNode(pairArgs[0].value as Node, ctx);
  for (let i = 1; i < pairArgs.length; i++) {
    if (pairArgs[i].weight === undefined)
      throw new Error(`bracket: tier ${i} is missing its 'upper:' weight`);
  }
  const lastPair = pairArgs[pairArgs.length - 1];
  if (lastPair.value === undefined)
    throw new Error('bracket: top tier must have a rate (e.g. Infinity: 37%)');
  const boundsScalar: number[] = [];
  const ratesScalar: number[] = [];
  let rateDim: Dimension | null = null;
  let prevBound = -Infinity;
  for (let i = 1; i < pairArgs.length; i++) {
    const u = evalNode(pairArgs[i].weight as Node, ctx);
    if (!dimEq(u.dim, x.dim))
      throw new Error(`bracket: tier ${i} bound has different units from x`);
    const us = scalarParam(u, 'bound');
    if (us < prevBound)
      throw new Error(`bracket: tier ${i} bound (${us}) is below previous (${prevBound})`);
    boundsScalar.push(us);
    prevBound = us;
    const r = evalNode(pairArgs[i].value as Node, ctx);
    if (rateDim == null) rateDim = r.dim;
    else if (!dimEq(r.dim, rateDim))
      throw new Error(
        `bracket: tier ${i} rate has different units from tier 1 (${dimToString(r.dim)} vs ${dimToString(rateDim)})`
      );
    ratesScalar.push(scalarParam(r, 'rate'));
  }
  const rd = rateDim ?? {};
  if (x.scalar != null) {
    const xi = x.scalar;
    if (!total) {
      let k = 0;
      while (k < boundsScalar.length && xi >= boundsScalar[k]) k++;
      if (k === boundsScalar.length) k = boundsScalar.length - 1;
      return { dim: rd, scalar: ratesScalar[k] };
    }
    let acc = 0;
    let prevU = 0;
    for (let k = 0; k < boundsScalar.length; k++) {
      const width = Math.min(xi, boundsScalar[k]) - prevU;
      if (width > 0) acc += ratesScalar[k] * width;
      prevU = boundsScalar[k];
    }
    return { dim: dimMul(x.dim, rd), scalar: acc };
  }
  const xs = x.samples as Float64Array;
  const out = new Float64Array(xs.length);
  if (!total) {
    // Marginal: index of the first tier whose upper exceeds x.
    for (let i = 0; i < xs.length; i++) {
      const xi = xs[i];
      let k = 0;
      while (k < boundsScalar.length && xi >= boundsScalar[k]) k++;
      if (k === boundsScalar.length) k = boundsScalar.length - 1;
      out[i] = ratesScalar[k];
    }
    return { dim: rd, samples: out };
  }
  // Cumulative: Σ (min(bᵢ, x) − bᵢ₋₁) · rᵢ over all i.
  let prevU = 0;
  for (let k = 0; k < boundsScalar.length; k++) {
    const u = boundsScalar[k];
    const r = ratesScalar[k];
    for (let i = 0; i < xs.length; i++) {
      const width = Math.min(xs[i], u) - prevU;
      if (width > 0) out[i] += r * width;
    }
    prevU = u;
  }
  return { dim: dimMul(x.dim, rd), samples: out };
}

// Ordinary functions preserve scenario axes; their reducers consume samples
// within each cell. Axis reducers and selector syntax are handled separately.
const UNARY_CALLS = new Set([
  'chance',
  'mean',
  'median',
  'mode',
  'skew',
  'sd',
  'stdev',
  'min',
  'max',
  'sqrt',
  'abs',
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'ceil',
  'floor',
  'exp',
  'ln',
  'log',
  'log10'
]);
const CELL_CALLS = new Set([
  ...UNARY_CALLS,
  'p',
  'percentile',
  'interval',
  'round',
  'clamp',
  'cagr'
]);

function mapCall(values: Value[], apply: (cells: Value[]) => Value): Value {
  let axes: Axis[] = [];
  let rows: Value[][] = [[]];
  for (const value of values) {
    const resolved = resolveAxes(axes, value.axes ?? []);
    if (resolved.leftIndex.length > MAX_CELLS)
      throw new Error(
        `scenario grid too large: ${resolved.leftIndex.length} cells (cap ${MAX_CELLS})`
      );
    const cells = cellsOf(value);
    rows = resolved.leftIndex.map((i, k) => [...rows[i], cells[resolved.rightIndex[k]]]);
    axes = resolved.axes;
  }
  return makeGrid(axes, rows.map(apply));
}

function evalCall(
  node: { name: string; args: CallArg[] },
  ctx: EvalCtx,
  evaluated?: Value[]
): Value {
  const name = node.name;
  const callArgs = node.args;
  const hasNamed = callArgs.some((a) => a.name != null);
  const hasWeights = callArgs.some((a) => a.weight != null);
  if (hasWeights && name !== 'discrete' && name !== 'mixture' && name !== 'bracket')
    throw new Error(
      `${name}: weight:value pairs are only for discrete(), mixture(), and bracket()`
    );
  // bracket reads callArgs directly (it uses `weight: value` pairs, not a
  // flat positional list), so it bypasses the named-arg binder entirely.
  if (name === 'bracket') return evalBracket(callArgs, ctx);
  // pick reads its axis selectors by name (`case = "base"`) with quoted-string
  // coords, so it bypasses the fixed-parameter binder like bracket does.
  if (name === 'pick') return evalPick(callArgs, ctx);
  // `min(total over case)` / `min(total, over = case)` — collapse a scenario
  // axis instead of the sample axis. Intercepted before bindNamed, which has no
  // parameter named `over`.
  const overArg = callArgs.find((a) => a.name === 'over');
  if (overArg) return evalReduceOver(name, callArgs, overArg, ctx);
  const args: Node[] = hasNamed ? bindNamed(name, callArgs) : callArgs.map((a) => a.value as Node);
  if (UNARY_CALLS.has(name) && args.length !== 1)
    throw new Error(`${name}() takes exactly one argument`);
  // Validate arity before evaluating operands: malformed extra args must not
  // trigger unrelated parse/evaluation failures first.
  const values = !evaluated && CELL_CALLS.has(name) ? args.map((arg) => evalNode(arg, ctx)) : null;
  if (values?.some((value) => value.axes))
    return mapCall(values, (cells) => evalCall(node, ctx, cells));
  if (values) evaluated = values;
  const ev = (i: number) => {
    // Guard the unary/reducer cases that read ev(0) without an explicit arity
    // check (mean, min, sqrt, sin, …). Without this, a no-arg call like `mean()`
    // dereferences `undefined.type` deep in evalNode and leaks an internal
    // "Cannot read properties of undefined" error instead of a usable message.
    if (args[i] === undefined) throw new Error(`${name}() needs an argument`);
    return evaluated ? evaluated[i] : evalNode(args[i], ctx);
  };
  switch (name) {
    case 'normal': {
      if (args.length !== 2) throw new Error('normal(mean, sd)');
      const mean = ev(0);
      const sd = ev(1);
      if (!dimEq(mean.dim, sd.dim)) throw new Error('normal: mean and sd must share units');
      const meanV = scalarParam(mean, 'mean');
      const sdV = scalarParam(sd, 'sd');
      if (!(sdV >= 0)) throw new Error('normal: sd must be non-negative');
      return {
        dim: mean.dim,
        samples: normalSamples(meanV, sdV, ctx.fns),
        meta: { kind: 'normal', mean: meanV, sd: sdV }
      };
    }
    case 'lognormal': {
      if (args.length !== 2) throw new Error('lognormal(p5, p95)');
      const lo = ev(0);
      const hi = ev(1);
      if (!dimEq(lo.dim, hi.dim)) throw new Error('lognormal: bounds must share units');
      const pL = scalarParam(lo, 'p5');
      const pU = scalarParam(hi, 'p95');
      // Cache the mu/sigma so `update()` (when added) and any future
      // lognormal-aware primitive can read the exact parametrisation
      // instead of refitting from samples.
      const z = zForLevel(ctx.fns.level);
      const mu = (Math.log(pL) + Math.log(pU)) / 2;
      const sigma = (Math.log(pU) - Math.log(pL)) / (2 * z);
      return {
        dim: lo.dim,
        samples: lognormalSamples(pL, pU, ctx.fns),
        meta: { kind: 'lognormal', mu, sigma }
      };
    }
    case 'uniform': {
      if (args.length !== 2) throw new Error('uniform(lo, hi)');
      const lo = ev(0);
      const hi = ev(1);
      if (!dimEq(lo.dim, hi.dim)) throw new Error('uniform: bounds must share units');
      const loV = scalarParam(lo, 'lo');
      const hiV = scalarParam(hi, 'hi');
      return {
        dim: lo.dim,
        samples: uniformSamples(loV, hiV, ctx.fns),
        meta: { kind: 'uniform', lo: loV, hi: hiV }
      };
    }
    case 'beta': {
      if (args.length !== 2) throw new Error('beta(a, b)');
      const a = ev(0);
      const b = ev(1);
      requireDimless(a, 'beta a');
      requireDimless(b, 'beta b');
      const aV = scalarParam(a, 'a');
      const bV = scalarParam(b, 'b');
      if (!(aV > 0 && bV > 0)) throw new Error('beta(a, b): a and b must be positive');
      return {
        dim: {},
        samples: betaSamples(aV, bV, ctx.fns),
        meta: { kind: 'beta', a: aV, b: bV }
      };
    }
    case 'mixture': {
      if (hasWeights) return weightedMixture(callArgs, ctx, 'mixture');
      // List form: mixture([v1, v2, …]) — equal-weight scenarios. Each draw
      // picks one list element uniformly; we reuse list elements as needed.
      if (args.length === 1) {
        const v = ev(0);
        if (v.list) {
          const arr = v.list;
          const out = new Float64Array(ctx.fns.N);
          for (let i = 0; i < ctx.fns.N; i++)
            out[i] = arr[Math.floor(ctx.fns.uniform() * arr.length)];
          return { dim: v.dim, samples: out };
        }
      }
      if (args.length < 2) throw new Error('mixture(d1, d2, …)');
      const comps = args.map((_, i) => ev(i));
      const dim = comps[0].dim;
      for (const c of comps)
        if (!dimEq(c.dim, dim)) throw new Error('mixture: components must share units');
      return {
        dim,
        samples: mixtureSamples(
          comps.map((c) => samplesOf(c, ctx.fns.N)),
          ctx.fns
        )
      };
    }
    case 'pert': {
      if (args.length !== 3) throw new Error('pert(lo, most-likely, hi)');
      const lo = ev(0);
      const ml = ev(1);
      const hi = ev(2);
      if (!dimEq(lo.dim, ml.dim) || !dimEq(lo.dim, hi.dim))
        throw new Error('pert: lo, most-likely and hi must share units');
      const loV = scalarParam(lo, 'lo');
      const mlV = scalarParam(ml, 'most-likely');
      const hiV = scalarParam(hi, 'hi');
      const range = hiV - loV;
      const alpha = 1 + (4 * (mlV - loV)) / range;
      const beta = 1 + (4 * (hiV - mlV)) / range;
      return {
        dim: lo.dim,
        samples: pertSamples(loV, mlV, hiV, ctx.fns),
        meta: { kind: 'pert', alpha, beta: beta, lo: loV, hi: hiV }
      };
    }
    // triangular three-point estimate: a flatter alternative to pert.
    case 'triangular': {
      if (args.length !== 3) throw new Error('triangular(lo, most-likely, hi)');
      const lo = ev(0);
      const ml = ev(1);
      const hi = ev(2);
      if (!dimEq(lo.dim, ml.dim) || !dimEq(lo.dim, hi.dim))
        throw new Error('triangular: lo, most-likely and hi must share units');
      const loV = scalarParam(lo, 'lo');
      const mlV = scalarParam(ml, 'most-likely');
      const hiV = scalarParam(hi, 'hi');
      return {
        dim: lo.dim,
        samples: triangularSamples(loV, mlV, hiV, ctx.fns),
        meta: { kind: 'triangular', lo: loV, mode: mlV, hi: hiV }
      };
    }
    // exponential(mean): wait time between events; carries the mean's units.
    case 'exponential': {
      if (args.length !== 1) throw new Error('exponential(mean) — e.g. exponential(5 day)');
      const mean = ev(0);
      const meanV = scalarParam(mean, 'mean');
      return {
        dim: mean.dim,
        samples: exponentialSamples(meanV, ctx.fns),
        meta: { kind: 'exponential', mean: meanV }
      };
    }
    // poisson(mean): whole count of events in a window. The argument is the
    // expected count; the result carries its unit (poisson(50 req) → req).
    case 'poisson': {
      if (args.length !== 1) throw new Error('poisson(mean) — e.g. poisson(1000)');
      const mean = ev(0);
      const meanV = scalarParam(mean, 'mean');
      return {
        dim: mean.dim,
        samples: poissonSamples(meanV, ctx.fns),
        meta: { kind: 'poisson', lambda: meanV }
      };
    }
    // weibull(shape, scale): time-to-failure / reliability. The scale carries
    // the units (a duration for time-to-failure); the shape is a dimensionless
    // knob — shape > 1 is aging failure, shape < 1 infant mortality, shape = 1
    // is exponential. Keyword args (shape=, scale=) guard against the classic
    // swapped-argument bug, since Weibull parameterizations differ across tools.
    case 'weibull': {
      if (args.length !== 2) throw new Error('weibull(shape, scale) — e.g. weibull(1.5, 200 day)');
      const shape = ev(0);
      const scale = ev(1);
      requireDimless(shape, 'weibull shape');
      const shapeV = scalarParam(shape, 'shape');
      const scaleV = scalarParam(scale, 'scale');
      if (!(shapeV > 0)) throw new Error('weibull: shape must be positive');
      if (!(scaleV > 0)) throw new Error('weibull: scale must be positive');
      return {
        dim: scale.dim,
        samples: weibullSamples(shapeV, scaleV, ctx.fns),
        meta: { kind: 'weibull', shape: shapeV, scale: scaleV }
      };
    }
    // binomial(trials, p): whole count of successes in n independent trials —
    // the bounded counterpart to poisson (which is unbounded). trials carries
    // the count unit (binomial(100 server, …) → server); p is dimensionless in
    // [0, 1]. Non-integer trials is a hard error, never silently rounded.
    case 'binomial': {
      if (args.length !== 2) throw new Error('binomial(trials, p) — e.g. binomial(100, 0.02)');
      const trials = ev(0);
      const p = ev(1);
      requireDimless(p, 'binomial p');
      const nV = scalarParam(trials, 'trials');
      const pV = scalarParam(p, 'p');
      if (!Number.isInteger(nV) || nV < 0)
        throw new Error('binomial: trials must be a non-negative integer');
      if (!(pV >= 0 && pV <= 1)) throw new Error('binomial: p must be between 0 and 1');
      return {
        dim: trials.dim,
        samples: binomialSamples(nV, pV, ctx.fns),
        meta: { kind: 'binomial', n: nV, p: pV }
      };
    }
    // correlate(reference, marginal, r): couple `marginal` to an already-drawn
    // sample-based `reference` at rank correlation r, preserving the marginal
    // exactly (Iman–Conover, reference fixed). The returned samples flow through
    // correlation-by-reuse, so any later `reference * result` is correlated.
    case 'correlate': {
      if (args.length !== 3) throw new Error('correlate(reference, marginal, r)');
      const ref = ev(0);
      const marginal = ev(1);
      const rArg = ev(2);
      requireDimless(rArg, 'correlation r');
      const r = scalarParam(rArg, 'r');
      if (!(Math.abs(r) < 1))
        throw new Error(
          'correlate: r must satisfy |r| < 1 — express perfect coupling as a formula (e.g. b = -a)'
        );
      if (!ref.samples)
        throw new Error(
          'correlate: the reference must be a distribution (it has no samples to pair)'
        );
      if (!marginal.samples)
        throw new Error(
          'correlate: the marginal must be a distribution (it has no samples to reorder)'
        );
      // Reordering is a permutation, so the marginal's family identity (meta)
      // and display unit still hold exactly — carry them through.
      return withHint(
        {
          dim: marginal.dim,
          samples: correlateTo(ref.samples, marginal.samples, r, ctx.fns),
          ...(marginal.meta ? { meta: marginal.meta } : {})
        },
        marginal.unitHint
      );
    }
    // discrete: pick value vᵢ with probability ∝ wᵢ — weighted scenario /
    // decision modelling. Prefer the pair form `discrete(w1: v1, w2: v2, …)`;
    // the flat `discrete(w1, v1, w2, v2, …)` form is also accepted.
    case 'discrete': {
      if (hasWeights) return weightedMixture(callArgs, ctx, 'discrete');
      // List form: discrete([v1, v2, …]) — equal-weight scenarios.
      if (args.length === 1) {
        const v = ev(0);
        if (v.list) {
          const arr = v.list;
          const out = new Float64Array(ctx.fns.N);
          for (let i = 0; i < ctx.fns.N; i++)
            out[i] = arr[Math.floor(ctx.fns.uniform() * arr.length)];
          return { dim: v.dim, samples: out };
        }
      }
      if (args.length < 2 || args.length % 2 !== 0)
        throw new Error('discrete(w1: v1, w2: v2, …) — weight/value pairs');
      const weights: number[] = [];
      const vals: Value[] = [];
      for (let i = 0; i < args.length; i += 2) {
        const w = evalNode(args[i], ctx);
        requireDimless(w, 'discrete weight');
        const wv = scalarParam(w, 'weight');
        if (wv < 0) throw new Error('discrete: weights must be non-negative');
        weights.push(wv);
        vals.push(evalNode(args[i + 1], ctx));
      }
      const dim = vals[0].dim;
      for (const v of vals)
        if (!dimEq(v.dim, dim)) throw new Error('discrete: values must share units');
      return {
        dim,
        samples: mixtureSamples(
          vals.map((v) => samplesOf(v, ctx.fns.N)),
          ctx.fns,
          weights
        )
      };
    }
    // clamp(x, lo[, hi]): keep x within bounds, elementwise. Two-arg form is a
    // lower bound only (e.g. clamp(x, 0 day) keeps an estimate non-negative).
    case 'clamp': {
      if (args.length !== 2 && args.length !== 3) throw new Error('clamp(x, lo[, hi])');
      const x = ev(0);
      const lo = ev(1);
      if (!dimEq(lo.dim, x.dim)) throw new Error('clamp: lo must share units with x');
      const loS = scalarParam(lo, 'lo');
      let hiS = Number.POSITIVE_INFINITY;
      if (args.length === 3) {
        const hi = ev(2);
        if (!dimEq(hi.dim, x.dim)) throw new Error('clamp: hi must share units with x');
        hiS = scalarParam(hi, 'hi');
      }
      return withHint(
        unaryMap(x, (v) => Math.min(hiS, Math.max(loS, v)), x.dim),
        x.unitHint
      );
    }
    // sum(above) folds every preceding result line; sum(a, b, …) folds an
    // explicit list. `above` reuses the stored sample arrays, so correlated
    // terms stay correlated and sum(a, b) == sum(above) for those lines.
    case 'sum': {
      const vals: Value[] = [];
      for (const arg of args) {
        if (arg.type === 'ident' && arg.name === 'above') vals.push(...ctx.above);
        else vals.push(evalNode(arg, ctx));
      }
      // Single-list form: sum([1, 2, 3]) → 6.
      if (vals.length === 1 && vals[0].list) {
        const l = vals[0].list;
        return withHint(
          { dim: vals[0].dim, scalar: l.reduce((a, b) => a + b, 0) },
          vals[0].unitHint
        );
      }
      if (vals.length === 0) return { dim: {}, scalar: 0 };
      const dim = vals[0].dim;
      for (const v of vals)
        if (!dimEq(v.dim, dim))
          throw new Error(
            `sum: incompatible dimensions (${dimToString(dim) || 'number'} vs ${dimToString(v.dim) || 'number'})`
          );
      if (vals.some((value) => value.axes)) {
        return vals.reduce((acc, value) =>
          acc.axes || value.axes
            ? resolveAxisBinop(acc, value, (a, b) => binScalar('+', a, b, ctx))
            : binScalar('+', acc, value, ctx)
        );
      }
      return withHint(
        vals.reduce((acc, value) => binop(acc, value, (a, b) => a + b, dim, ctx.fns.N)),
        sharedHint(vals)
      );
    }
    // chance(predicate): fraction of samples for which a comparison holds, e.g.
    // chance(total < 30 day). The predicate evaluates to a dimensionless 0/1
    // mask, so this is just its mean.
    case 'chance': {
      if (args.length !== 1) throw new Error('chance(predicate) — e.g. chance(total < 30 day)');
      const d = ev(0);
      requireDimless(d, 'chance predicate');
      return { dim: {}, scalar: d.scalar ?? reduceMean(d.samples as Float64Array) };
    }
    // reducers -> scalar
    case 'mean': {
      const d = ev(0);
      if (d.list) {
        if (d.list.length === 0) throw new Error('mean of an empty list');
        return withHint({ dim: d.dim, scalar: reduceMean(Float64Array.from(d.list)) }, d.unitHint);
      }
      // Scalar: trivially itself.
      if (d.scalar != null) return withHint({ dim: d.dim, scalar: d.scalar }, d.unitHint);
      // Closed-form mean when the distribution has a parametric identity.
      const am = analyticalMean(d);
      if (am != null && Number.isFinite(am))
        return withHint({ dim: d.dim, scalar: am }, d.unitHint);
      return withHint({ dim: d.dim, scalar: reduceMean(d.samples as Float64Array) }, d.unitHint);
    }
    case 'median': {
      const d = ev(0);
      if (d.list) throw new Error('median() is for distributions — use mean() for a list');
      return withHint(
        { dim: d.dim, scalar: d.scalar ?? reducePercentile(d.samples as Float64Array, 0.5) },
        d.unitHint
      );
    }
    // mode(d): the density peak — the honest "most likely" the mean/median
    // hide for skewed families. Analytic when the distribution carries a
    // parametric identity (lognormal, normal, binomial, weibull, tri/pert);
    // otherwise a smoothed histogram-peak estimate.
    case 'mode': {
      const d = ev(0);
      if (d.list) throw new Error('mode() is for distributions — use mean() for a list');
      if (d.scalar != null) return withHint({ dim: d.dim, scalar: d.scalar }, d.unitHint);
      const am = analyticalMode(d);
      if (am != null && Number.isFinite(am))
        return withHint({ dim: d.dim, scalar: am }, d.unitHint);
      return withHint({ dim: d.dim, scalar: reduceMode(d.samples as Float64Array) }, d.unitHint);
    }
    // skew(d): the Fisher–Pearson skewness — upside (+) vs downside (−) tail.
    // A pure number, so the result is dimensionless regardless of d's units.
    // Analytic for known families; sample skewness otherwise (high-variance —
    // flagged in the help text).
    case 'skew': {
      const d = ev(0);
      if (d.list) throw new Error('skew() is for distributions — use mean() for a list');
      if (d.scalar != null) return { dim: {}, scalar: 0 };
      const as = analyticalSkew(d);
      if (as != null && Number.isFinite(as)) return { dim: {}, scalar: as };
      return { dim: {}, scalar: reduceSkew(d.samples as Float64Array) };
    }
    case 'sd':
    case 'stdev': {
      const d = ev(0);
      if (d.list) throw new Error('sd() is for distributions — use mean() for a list');
      return withHint(
        { dim: d.dim, scalar: d.scalar != null ? 0 : reduceSd(d.samples as Float64Array) },
        d.unitHint
      );
    }
    case 'p':
    case 'percentile': {
      if (args.length !== 2) throw new Error('p(dist, q)');
      const d = ev(0);
      if (d.list) throw new Error('p() is for distributions — use mean() for a list');
      const q = ev(1);
      requireDimless(q, 'percentile q');
      const qq = scalarParam(q, 'q');
      if (d.scalar != null) return { dim: d.dim, scalar: d.scalar };
      // Closed-form percentile (inverse CDF) when the distribution has
      // a parametric identity. Sample-percentile stays as the fallback
      // for families we haven't added (beta, pert, triangular).
      const ap = analyticalPercentile(d, qq);
      if (ap != null && Number.isFinite(ap))
        return withHint({ dim: d.dim, scalar: ap }, d.unitHint);
      return withHint(
        {
          dim: d.dim,
          scalar: reducePercentile(d.samples as Float64Array, qq)
        },
        d.unitHint
      );
    }
    // interval(d, level): the central [lo, hi] band at a confidence level, as a
    // 2-element list — sugar for [p(d, (1−level)/2), p(d, (1+level)/2)]. This
    // *extracts* a band from a simulated result; the ci(...) constructor, which
    // *builds* a distribution from a band, is left untouched. Level defaults to
    // the sheet confidence. Returns a list, so it composes with min/max/etc.
    case 'interval': {
      if (args.length !== 1 && args.length !== 2)
        throw new Error('interval(d, level) — e.g. interval(x, 0.9)');
      const d = ev(0);
      if (d.list) throw new Error('interval() is for distributions, not lists');
      let level = ctx.fns.level;
      if (args.length === 2) {
        const lvl = ev(1);
        requireDimless(lvl, 'interval level');
        level = scalarParam(lvl, 'level');
      }
      if (!(level > 0 && level < 1)) throw new Error('interval: level must be between 0 and 1');
      const tail = (1 - level) / 2;
      return withHint(
        { dim: d.dim, list: [percentileOf(d, tail), percentileOf(d, 1 - tail)] },
        d.unitHint
      );
    }
    case 'min': {
      const d = ev(0);
      if (d.list) return withHint({ dim: d.dim, scalar: foldMin(d.list) }, d.unitHint);
      return withHint(
        { dim: d.dim, scalar: d.scalar ?? foldMin(d.samples as Float64Array) },
        d.unitHint
      );
    }
    case 'max': {
      const d = ev(0);
      if (d.list) return withHint({ dim: d.dim, scalar: foldMax(d.list) }, d.unitHint);
      return withHint(
        { dim: d.dim, scalar: d.scalar ?? foldMax(d.samples as Float64Array) },
        d.unitHint
      );
    }
    // elementwise math
    case 'sqrt': {
      const x = ev(0);
      return unaryMap(x, Math.sqrt, dimPow(x.dim, 0.5));
    }
    case 'abs': {
      const x = ev(0);
      return withHint(unaryMap(x, Math.abs, x.dim), x.unitHint);
    }
    // trigonometry: the argument is a dimensionless angle in radians (an angle
    // unit like `deg` is dimensionless, so `sin(90 deg)` works). Inverse
    // functions return radians (dimensionless).
    case 'sin':
    case 'cos':
    case 'tan':
    case 'asin':
    case 'acos':
    case 'atan': {
      const x = ev(0);
      requireDimless(x, name);
      return unaryMap(x, Math[name], {});
    }
    // cagr(start, end, periods): the compound growth rate per period that takes
    // start to end, i.e. (end/start)^(1/periods) − 1. Dimensionless.
    case 'cagr': {
      if (args.length !== 3) throw new Error('cagr(start, end, periods)');
      const start = ev(0);
      const end = ev(1);
      const periods = ev(2);
      if (!dimEq(start.dim, end.dim)) throw new Error('cagr: start and end must share units');
      requireDimless(periods, 'cagr periods');
      const n = scalarParam(periods, 'periods');
      if (!(n > 0)) throw new Error('cagr(start, end, periods): periods must be positive');
      const ratio = binop(end, start, (x, y) => x / y, {}, ctx.fns.N);
      return unaryMap(ratio, (r) => r ** (1 / n) - 1, {});
    }
    // rounding (dimension preserved) — e.g. ceil() whole instances for sizing
    case 'ceil': {
      const x = ev(0);
      return unaryMap(x, Math.ceil, x.dim);
    }
    case 'floor': {
      const x = ev(0);
      return unaryMap(x, Math.floor, x.dim);
    }
    case 'round': {
      if (args.length > 2) throw new Error('round(x, digits?)');
      const x = ev(0);
      if (args.length === 1) return unaryMap(x, Math.round, x.dim);
      const digits = ev(1);
      requireDimless(digits, 'round digits');
      const n = scalarParam(digits, 'digits');
      if (!Number.isInteger(n)) throw new Error('round: digits must be an integer');
      const f = 10 ** n;
      return unaryMap(x, (v) => Math.round(v * f) / f, x.dim);
    }
    case 'exp': {
      const x = ev(0);
      requireDimless(x, 'exp');
      return unaryMap(x, Math.exp, {});
    }
    case 'ln':
    case 'log': {
      const x = ev(0);
      requireDimless(x, name);
      return unaryMap(x, Math.log, {});
    }
    case 'log10': {
      const x = ev(0);
      requireDimless(x, 'log10');
      return unaryMap(x, Math.log10, {});
    }
    // ci(lo, hi[, level]): explicit confidence interval at a chosen level
    // (default = sheet setting). One-off override of the per-sheet
    // `confidence` setting; same semantics as `lo to hi` but with an
    // explicit confidence instead of the implicit sheet default.
    case 'ci': {
      if (args.length !== 2 && args.length !== 3)
        throw new Error('ci(lo, hi[, level]) — e.g. ci(2, 10) or ci(2, 10, level=0.95)');
      const lo = ev(0);
      const hi = ev(1);
      if (!dimEq(lo.dim, hi.dim)) throw new Error('ci: bounds must share units');
      let level = ctx.fns.level;
      if (args.length === 3) {
        const lvl = ev(2);
        requireDimless(lvl, 'ci level');
        level = scalarParam(lvl, 'ci level');
      }
      const fns: DistFns = { ...ctx.fns, level };
      return withHint(
        {
          dim: lo.dim,
          samples: ciSamples(scalarParam(lo, 'lo'), scalarParam(hi, 'hi'), fns)
        },
        lo.unitHint ?? hi.unitHint
      );
    }
    // update(prior, k, n): Bayesian conjugate update — currently Beta–Binomial.
    // If `prior` was constructed by `beta(a, b)` (carrying `meta`), the result
    // is the exact posterior `beta(a + k, b + n − k)`. Other priors raise a
    // clear error pointing at the Beta requirement, since sample-only
    // posteriors can't be updated analytically without a likelihood model.
    case 'update': {
      if (args.length !== 3) throw new Error('update(prior, successes, trials)');
      const prior = ev(0);
      const k = ev(1);
      const n = ev(2);
      requireDimless(prior, 'update prior');
      requireDimless(k, 'update successes');
      requireDimless(n, 'update trials');
      const kV = scalarParam(k, 'successes');
      const nV = scalarParam(n, 'trials');
      if (nV <= 0) throw new Error('update: trials must be positive');
      if (kV < 0 || kV > nV) throw new Error('update: successes must be between 0 and trials');
      if (prior.meta?.kind !== 'beta')
        throw new Error(
          'update: prior must be a beta(a, b) for Beta–Binomial conjugacy — pass beta(a, b) directly'
        );
      const { a, b } = prior.meta;
      const aPost = a + kV;
      const bPost = b + (nV - kV);
      return {
        dim: {},
        samples: betaSamples(aPost, bPost, ctx.fns),
        meta: { kind: 'beta', a: aPost, b: bPost }
      };
    }
    default:
      throw new Error(`unknown function '${name}'`);
  }
}

export function evalNode(node: Node, ctx: EvalCtx): Value {
  switch (node.type) {
    case 'num':
      return { dim: {}, scalar: node.value };
    case 'ident': {
      const v = ctx.env.get(node.name);
      if (v) return v;
      const u = ctx.units.get(node.name);
      if (u) {
        if (u.log) return { dim: u.dim, scalar: u.scale, log: u.log };
        if (u.offset != null)
          return { dim: u.dim, scalar: u.scale, affine: { scale: u.scale, offset: u.offset } };
        if (u.diff) return { dim: u.dim, scalar: u.scale, temp: 'diff' };
        // Carry the typed unit as a display hint, but only for dimensioned
        // units — dimensionless multipliers (`thousand`, `deg`, `%`) have no
        // unit to show and would otherwise mis-scale a compound label.
        const base: Value = { dim: u.dim, scalar: u.scale };
        return dimIsZero(u.dim) ? base : withHint(base, { label: node.name, factor: u.scale });
      }
      if (node.name === 'Infinity') return { dim: {}, scalar: Number.POSITIVE_INFINITY }; // open-ended bracket bound
      if (node.name === 'above')
        throw new Error("'above' is only valid as an argument to sum(...)");
      throw new Error(`unknown identifier '${node.name}'`);
    }
    case 'str':
      throw new Error('a quoted string ("…") is only valid as a pick(…) coordinate');
    case 'call':
      return evalCall(node, ctx);
    case 'neg': {
      const v = evalNode(node.operand, ctx);
      const neg = (x: Value) =>
        withHint(
          unaryMap(x, (m) => -m, x.dim),
          x.unitHint
        );
      return v.axes ? mapCells(v, neg) : neg(v);
    }
    case 'ci': {
      const lo = evalNode(node.lo, ctx);
      const hi = evalNode(node.hi, ctx);
      if (!dimEq(lo.dim, hi.dim)) {
        // One bare bound + one dimensioned bound is almost always a missing
        // parenthesis, e.g. `2 to 4 GB/s` meaning `(2 to 4) GB/s`.
        const oneBare = dimIsZero(lo.dim) !== dimIsZero(hi.dim);
        throw new Error(
          oneBare
            ? 'interval bounds differ in units — did you mean (lo to hi) unit, e.g. (2 to 4) day?'
            : 'confidence interval bounds have different units'
        );
      }
      const ciHint = lo.unitHint ?? hi.unitHint;
      const loV = scalarParam(lo, 'lo');
      const hiV = scalarParam(hi, 'hi');
      // A reversed explicit interval (`5 km to mi` → 5000 m vs 1609 m) is
      // almost always a `to`-as-conversion mistake — `to` builds a confidence
      // interval, not a conversion. Point at `in`. Percentile specs sort their
      // own bounds, so they're exempt.
      if (node.checkOrder && node.loP == null && loV > hiV)
        throw new Error(
          "interval lower bound is above the upper bound — to convert units use 'in' (e.g. '5 km in mi'), since 'to' makes a confidence interval"
        );
      // `p10: 5, p90: 50` — bounds sit at explicit percentiles. Fit the two
      // quantiles directly via Φ⁻¹, then draw from the fitted family. (The
      // default symmetric path below stays byte-identical, so existing
      // results don't shift.)
      if (node.loP != null && node.hiP != null) {
        const zLo = normalInverseCdf(node.loP);
        const zHi = normalInverseCdf(node.hiP);
        const out = new Float64Array(ctx.fns.N);
        if (loV > 0 && hiV > 0) {
          const sigma = (Math.log(hiV) - Math.log(loV)) / (zHi - zLo);
          const mu = Math.log(loV) - sigma * zLo;
          for (let i = 0; i < out.length; i++) out[i] = Math.exp(mu + sigma * ctx.fns.gaussian());
          return withHint(
            { dim: lo.dim, samples: out, meta: { kind: 'lognormal', mu, sigma } },
            ciHint
          );
        }
        const sd = (hiV - loV) / (zHi - zLo);
        const mean = loV - sd * zLo;
        for (let i = 0; i < out.length; i++) out[i] = mean + sd * ctx.fns.gaussian();
        return withHint({ dim: lo.dim, samples: out, meta: { kind: 'normal', mean, sd } }, ciHint);
      }
      // Stamp meta when the bounds are both positive → lognormal; else
      // normal. The samples are still drawn for display (sparkline, p5/p95);
      // analytical consumers (mean, p) read the meta directly.
      const z = zForLevel(ctx.fns.level);
      const meta =
        loV > 0 && hiV > 0
          ? {
              kind: 'lognormal' as const,
              mu: (Math.log(loV) + Math.log(hiV)) / 2,
              sigma: (Math.log(hiV) - Math.log(loV)) / (2 * z)
            }
          : {
              kind: 'normal' as const,
              mean: (loV + hiV) / 2,
              sd: (hiV - loV) / (2 * z)
            };
      return withHint(
        {
          dim: lo.dim,
          samples: ciSamples(loV, hiV, ctx.fns),
          meta
        },
        ciHint
      );
    }
    case 'list': {
      // A list literal: an ordered sequence of like-dimensioned scalar
      // values. Items are evaluated independently so they can be
      // expressions (`[1 + 2, 3 * 4]`); the resulting dim must agree.
      const items = node.items.map((it) => evalNode(it, ctx));
      const dim = items[0].dim;
      for (let i = 1; i < items.length; i++) {
        if (!dimEq(items[i].dim, dim))
          throw new Error(
            `list item ${i + 1} has different units (${dimToString(items[i].dim) || 'number'} vs ${dimToString(dim) || 'number'})`
          );
      }
      const out: number[] = [];
      for (const it of items) {
        if (it.samples) throw new Error(`list items must be deterministic, got a distribution`);
        out.push(it.scalar as number);
      }
      return { dim, list: out };
    }
    case 'scenario': {
      // Inline scenario constructor: evaluate each coord expression into a
      // cell. Every cell must share one dim (an axis is orthogonal to units).
      // The axis carries the coord labels in author order; cells are stored in
      // the same order (row-major over the single axis).
      const cells = node.coords.map((c) => evalNode(c.value, ctx));
      const dim = cells[0].dim;
      for (let i = 1; i < cells.length; i++) {
        if (!dimEq(cells[i].dim, dim))
          throw new Error(
            `scenario coord '${node.coords[i].label}' has different units (${dimToString(cells[i].dim) || 'number'} vs ${dimToString(dim) || 'number'})`
          );
      }
      if (cells.some((c) => c.axes))
        throw new Error('a scenario coord cannot itself be a scenario');
      const axis: Axis = { name: node.axis, coords: node.coords.map((c) => c.label) };
      return makeGrid([axis], cells);
    }
    case 'range': {
      // `lo..hi [step k]`. lo/hi/step are dimensionless scalars. The default
      // step is 1 (integer run) or, if either bound is fractional, the GCD
      // that lands on an integer count — kept simple here as 1, with floats
      // allowed when at least one bound has a fractional part.
      const loVal = evalNode(node.lo, ctx);
      const hiVal = evalNode(node.hi, ctx);
      const stepVal = node.step ? evalNode(node.step, ctx) : null;
      if (!dimIsZero(loVal.dim) || !dimIsZero(hiVal.dim) || (stepVal && !dimIsZero(stepVal.dim)))
        throw new Error('range bounds and step must be dimensionless');
      if (loVal.samples || hiVal.samples || stepVal?.samples)
        throw new Error('range bounds and step must be deterministic');
      const lo = scalarParam(loVal, 'range lower bound');
      const hi = scalarParam(hiVal, 'range upper bound');
      const step = stepVal ? scalarParam(stepVal, 'range step') : 1;
      if (![lo, hi, step].every(Number.isFinite))
        throw new Error('range bounds and step must be finite');
      if (step <= 0) throw new Error('range step must be positive');
      if (hi < lo) throw new Error(`range upper (${hi}) is below lower (${lo})`);
      const count = Math.floor((hi - lo) / step + 1e-9) + 1;
      if (!Number.isSafeInteger(count) || count > 1_000_000)
        throw new Error('range cardinality must be finite and at most 1000000 values');
      const out: number[] = [];
      for (let i = 0; i < count; i++) {
        const value = lo + i * step;
        if (!Number.isFinite(value) || (i > 0 && value <= lo + (i - 1) * step))
          throw new Error('range step cannot make forward progress at these bounds');
        out.push(Number(value.toFixed(10)));
      }
      return { dim: {}, list: out };
    }
    case 'where': {
      // Evaluate the body with extra locals bound, in a child env layered on
      // the current one. Bindings resolve in order (later may reference
      // earlier and the surrounding sheet) and never leak back out.
      const env = new Map(ctx.env);
      const childCtx: EvalCtx = { ...ctx, env };
      for (const b of node.bindings) env.set(b.name, evalNode(b.value, childCtx));
      return evalNode(node.body, childCtx);
    }
    case 'given': {
      // `X given pred` — the conditional/truncated distribution: keep the
      // draws of X where the 0/1 mask `pred` holds, then resample (with
      // replacement) back up to N so the result is a full distribution.
      const body = evalNode(node.body, ctx);
      const pred = evalNode(node.pred, ctx);
      requireDimless(pred, 'given condition');
      const n = ctx.fns.N;
      const xs = samplesOf(body, n);
      const mask = samplesOf(pred, n);
      const kept: number[] = [];
      for (let i = 0; i < n; i++) if (mask[i] !== 0) kept.push(xs[i]);
      if (kept.length === 0)
        throw new Error('given: the condition is never satisfied by the distribution');
      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) out[i] = kept[Math.floor(ctx.fns.uniform() * kept.length)];
      return { dim: body.dim, samples: out };
    }
    case 'convert': {
      const inner = evalNode(node.expr, ctx);
      const unit = evalNode(node.unit, ctx);
      // A nested conversion also re-pins the display unit, so `(… in mi)` reads
      // in miles even when it's a sub-expression. (The line root handles a
      // top-level conversion separately, in evalRoot.)
      const hint: UnitHint = {
        label: node.unitText,
        factor: scalarParam(unit, 'target unit'),
        offset: inner.temp === 'diff' ? undefined : unit.affine?.offset,
        log: unit.log
      };
      // `via bridge`: cross a dimension gap (the result takes the target dim).
      if (node.via) return withHint(applyBridge(inner, node.via, ctx, unit.dim), hint);
      // otherwise a numeric identity (base is invariant); validate dims.
      if (!dimEq(inner.dim, unit.dim))
        throw new Error(
          `cannot convert ${dimToString(inner.dim) || 'number'} to ${dimToString(unit.dim) || 'number'}`
        );
      return withHint(inner, hint);
    }
    case 'bin': {
      if (node.op === '^') {
        const base = evalNode(node.left, ctx);
        const exp = evalNode(node.right, ctx);
        requireDimless(exp, 'exponent');
        if (exp.axes) throw new Error('a scenario cannot be used as an exponent');
        const p = scalarParam(exp, 'exponent');
        const pow = (v: Value) => unaryMap(v, (x) => x ** p, dimPow(v.dim, p));
        return base.axes ? mapCells(base, pow) : pow(base);
      }
      const op = node.op; // narrowed to exclude '^'; const keeps it so in the closure
      const a = evalNode(node.left, ctx);
      const b = evalNode(node.right, ctx);
      // Scenario grids resolve axis-by-axis (align/broadcast/cross), then apply
      // the ordinary scalar op cell-by-cell. A plain (axis-free) pair skips
      // straight to the scalar path — zero overhead for today's values.
      if (a.axes || b.axes) return resolveAxisBinop(a, b, (x, y) => binScalar(op, x, y, ctx));
      return binScalar(op, a, b, ctx);
    }
  }
}

// The scalar/sample binary-op path: everything except `^` (handled inline) and
// axis resolution (handled by resolveAxisBinop, which calls back into this per
// cell). Operands here never carry axes.
function binScalar(
  op: '+' | '-' | '*' | '/' | '<' | '>' | '<=' | '>=',
  a: Value,
  b: Value,
  ctx: EvalCtx
): Value {
  const n = ctx.fns.N;
  // Display-unit hint for ordinary arithmetic: +/- keep a shared unit
  // (left wins on a tie, e.g. `5 km + 3 mi` → km); */÷ compose the typed
  // units unless a dimension cancels. Comparisons and the affine/log/temp
  // paths below carry no hint.
  const arithHint =
    op === '+' || op === '-'
      ? (a.unitHint ?? b.unitHint)
      : op === '*' || op === '/'
        ? composeHint(op, a, b)
        : undefined;

  // Affine magnitude: `20 °C` is `20 * °C`, but an offset unit isn't
  // multiplicative — apply `magnitude·scale + offset` to land an absolute
  // value in base units, tagged `abs`. Works for a scalar or a whole
  // distribution magnitude (`(20 to 30) °C`). The affine tag is consumed.
  if (op === '*') {
    if (b.affine && a.affine == null) return applyAffine(a, b.affine, b.dim);
    if (a.affine && b.affine == null) return applyAffine(b, a.affine, a.dim);
    // Logarithmic magnitude: `20 dBm` is `20 * dBm`, applied as
    // `ref·10^(magnitude/factor)` to land a linear base-unit value.
    if (b.log && a.log == null) return applyLog(a, b.log, b.dim);
    if (a.log && b.log == null) return applyLog(b, a.log, a.dim);
  }

  // Temperature absolute-vs-difference algebra. Fires only when at least
  // one operand carries a temp tag, so plain `K` arithmetic is unchanged.
  const tempRes = tempAlgebra(op, a, b);
  if (tempRes) return tempRes;

  // Try a closed-form path before sampling. When both operands carry
  // a parametric identity (or one is a scalar in the right slot), the
  // result is itself a known family — propagate `meta` so downstream
  // operations (mean, p) read the exact analytical value, not the
  // sample noise. We still run the sample-path after this so the
  // display (p5/p95/sd/sparkline) has data to render; the closed-
  // form layer reads `meta` first when present, so the samples are
  // inert for analytical consumers.
  if (op === '+' || op === '-' || op === '*' || op === '/') {
    if ((op === '+' || op === '-') && !dimEq(a.dim, b.dim))
      throw new Error(
        `incompatible dimensions: ${dimToString(a.dim) || 'number'} ${op} ${dimToString(b.dim) || 'number'}`
      );
    const outDim = op === '*' ? dimMul(a.dim, b.dim) : op === '/' ? dimDiv(a.dim, b.dim) : a.dim;
    const cf = closedFormBinop(op, a, b, outDim);
    if (cf?.meta) {
      // Compute samples from the closed-form distribution so
      // display (sparkline, p5/p95) still works. When the
      // inputs are themselves distributions, we *derive* the
      // output samples elementwise from the inputs to preserve
      // correlation-by-reuse (x + x ≡ 2x, sensitivity detects
      // a's effect on a*b, etc.). The meta rides alongside so
      // analytical reads (mean, p) stay exact regardless.
      return withHint(sampleFromMeta(cf as Value & { meta: ValueMeta }, ctx, op, a, b), arithHint);
    }
  }

  switch (op) {
    case '+':
      return withHint(
        binop(a, b, (x, y) => x + y, a.dim, n),
        arithHint
      );
    case '-':
      return withHint(
        binop(a, b, (x, y) => x - y, a.dim, n),
        arithHint
      );
    case '*':
      return withHint(
        binop(a, b, (x, y) => x * y, dimMul(a.dim, b.dim), n),
        arithHint
      );
    case '/':
      return withHint(
        binop(a, b, (x, y) => x / y, dimDiv(a.dim, b.dim), n),
        arithHint
      );
    default: {
      if (!dimEq(a.dim, b.dim))
        throw new Error(
          `cannot compare ${dimToString(a.dim) || 'number'} with ${dimToString(b.dim) || 'number'}`
        );
      const cmp =
        op === '<'
          ? (x: number, y: number) => (x < y ? 1 : 0)
          : op === '>'
            ? (x: number, y: number) => (x > y ? 1 : 0)
            : op === '<='
              ? (x: number, y: number) => (x <= y ? 1 : 0)
              : (x: number, y: number) => (x >= y ? 1 : 0);
      return binop(a, b, cmp, {}, n);
    }
  }
}

// Evaluate a line root, surfacing a top-level conversion as a pinned unit.
export function evalRoot(node: Node, ctx: EvalCtx): { value: Value; pinned?: PinnedUnit } {
  if (node.type === 'list' || node.type === 'range')
    throw new Error('a list literal needs a reducer — try sum([…]) or mean([…])');
  if (node.type === 'convert') {
    const rawValue = evalNode(node.expr, ctx);
    const unit = evalNode(node.unit, ctx);
    // `via bridge` crosses dimensions; otherwise dims must already match.
    const value = node.via ? applyBridge(rawValue, node.via, ctx, unit.dim) : rawValue;
    if (!node.via && !dimEq(value.dim, unit.dim))
      throw new Error(
        `cannot convert ${dimToString(value.dim) || 'number'} to ${dimToString(unit.dim) || 'number'}`
      );
    const factor = scalarParam(unit, 'target unit');
    // Affine target (°C/°F/barg): the display undoes the offset too — but a
    // temperature *difference* converts without the offset (10 K → 18 °F-diff,
    // not −441 °F).
    const offset = value.temp === 'diff' ? undefined : unit.affine?.offset;
    // Log target (dB/dBm/dBW): display undoes the log instead of a linear scale.
    return { value, pinned: { label: node.unitText, factor, offset, log: unit.log } };
  }
  // No explicit `in/to`: fall back to the unit the user typed, carried as a hint
  // through the expression. Absent a hint (e.g. `sum` over mixed units), the
  // formatter shows the canonical base unit, exactly as before.
  const value = evalNode(node, ctx);
  return { value, pinned: value.unitHint };
}
