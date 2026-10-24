// Engine facade: parse + evaluate a whole sheet, build rate cards, accumulate.
// Framework-agnostic and fully synchronous so it stays unit-testable and could
// later ship as a library/CLI. The worker (worker.ts) is a thin wrapper.

import { type EvalCtx, evalRoot, type PinnedUnit } from './eval';
import { type DisplayValue, formatNumber, formatSummary, type NumberFormat } from './format';
import { errorHint, errorTopic } from './friendly';
import { correlateJoint, type DistFns, makeGaussian, makeRng, type Summary, summarize } from './mc';
import { type Line, type Node, parseLine } from './parse';
import { correlation } from './stats';
import { buildUnitTable, type UnitDef } from './units';
import { type Dimension, dimMul, dimToString, type Value } from './value';

export interface EngineOptions {
  N: number;
  seed: number;
  monthDays: number;
  yearDays: number;
  numberFormat: NumberFormat;
  // Confidence level used by `lo to hi` and `about` / `~` to map the interval
  // onto a normal/lognormal. In (0, 1). Default 0.90 (5th–95th pct). The
  // per-call `ci(lo, hi, level)` overrides this for one line.
  confidence: number;
}

export const DEFAULT_OPTIONS: EngineOptions = {
  N: 10000,
  seed: 0x9e3779b9,
  monthDays: 30.436875,
  yearDays: 365.25,
  numberFormat: 'auto',
  confidence: 0.9
};

export const RATE_PERIODS = ['second', 'minute', 'hour', 'day', 'week', 'month', 'year'] as const;
export type RatePeriod = (typeof RATE_PERIODS)[number];

const PERIOD_UNIT: Record<RatePeriod, string> = {
  second: 's',
  minute: 'min',
  hour: 'h',
  day: 'day',
  week: 'week',
  month: 'month',
  year: 'year'
};

export interface RateCardEntry {
  period: RatePeriod;
  display: DisplayValue;
}

export interface LineResult {
  index: number;
  kind: 'blank' | 'comment' | 'unitdef' | 'value';
  raw: string;
  name?: string;
  comment?: string;
  error?: string; // precise developer message
  errorHint?: string; // plain-language overlay (UI shows this first)
  errorTopic?: string; // cheat-sheet group addressing this error (UI links to it)
  display?: DisplayValue;
  summary?: Summary;
  isRate?: boolean;
  isDist?: boolean;
  // True when the distribution's |skew| exceeds the tail-awareness threshold
  // (mean and median diverge meaningfully). UI can flag the line as
  // right-/left-tailed so users don't read the mean as the "typical" value.
  skewed?: boolean;
  rateCard?: RateCardEntry[];
  ast?: Node; // parsed expression tree for `expr`/`assign` lines; absent on parse failure
}

export interface SheetResult {
  lines: LineResult[];
}

export interface SensitivityEntry {
  name: string;
  r2: number; // share of output variance explained (correlation squared)
}

// Σ_{k=0}^{n-1} (1+g)^k — the geometric series for accumulating a rate that
// grows by `g` each period. g = 0 reduces to `n`, so plain accumulation is the
// special case growth = 0.
export function geometricSum(n: number, g: number): number {
  if (n <= 0) return 0;
  if (g === 0) return n;
  return ((1 + g) ** n - 1) / g;
}

function scaleValue(v: Value, k: number, dimOut: Dimension): Value {
  if (v.scalar != null) return { dim: dimOut, scalar: v.scalar * k };
  const xs = v.samples as Float64Array;
  const out = new Float64Array(xs.length);
  for (let i = 0; i < xs.length; i++) out[i] = xs[i] * k;
  return { dim: dimOut, samples: out };
}

export class Engine {
  opts: EngineOptions;
  units: Map<string, UnitDef>;
  private customUnits = new Map<string, string>();
  private bridges = new Map<string, Value>();
  private lineValues: (Value | null)[] = [];
  private lastEnv = new Map<string, Value>();
  private periodSeconds: Record<RatePeriod, number>;

  constructor(opts: Partial<EngineOptions> = {}, customUnits: Record<string, string> = {}) {
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
    this.units = buildUnitTable({ monthDays: this.opts.monthDays, yearDays: this.opts.yearDays });
    for (const [name, def] of Object.entries(customUnits)) this.defineUnit(name, def);
    this.periodSeconds = {
      second: 1,
      minute: 60,
      hour: 3600,
      day: 86400,
      week: 604800,
      month: this.opts.monthDays * 86400,
      year: this.opts.yearDays * 86400
    };
  }

  private makeFns(seed: number): DistFns {
    const rng = makeRng(seed);
    return {
      N: this.opts.N,
      gaussian: makeGaussian(rng),
      uniform: rng,
      level: this.opts.confidence
    };
  }

  // Define a custom unit from `name = definition` text, e.g. `sprint = 2 week`.
  defineUnit(name: string, definition: string): void {
    const ctx = this.ctxFor(this.makeFns(1));
    const line = parseLine(definition, { isUnit: (n) => this.units.has(n) });
    if (line.type !== 'expr') throw new Error('unit definition must be an expression');
    const v = evalRoot(line.expr, ctx).value;
    if (v.scalar == null) throw new Error('unit definition must be deterministic');
    if (!Number.isFinite(v.scalar) || v.scalar === 0)
      throw new Error('unit definition scale must be finite and non-zero');
    this.units.set(name, { dim: v.dim, scale: v.scalar });
    this.customUnits.set(name, definition);
  }

  // Declare a cross-dimension equivalence, e.g. `water = 18.015 g/mol`. Used by
  // `X in Y via name` to bridge otherwise-incompatible dimensions.
  defineBridge(name: string, definition: string): void {
    const ctx = this.ctxFor(this.makeFns(1));
    const line = parseLine(definition, { isUnit: (n) => this.units.has(n) });
    if (line.type !== 'expr') throw new Error('bridge definition must be an expression');
    const v = evalRoot(line.expr, ctx).value;
    if (v.scalar == null) throw new Error('bridge definition must be deterministic');
    this.bridges.set(name, v);
  }

  // Mint a new currency: each alias maps to a fresh base dimension (keyed by the
  // first name), so it adds/subtracts only with itself and converts to other
  // currencies through a `bridge` FX rate — never silently mixing. Unlike
  // `unit btc = 50000 $`, which would alias dollars. Re-running with the same
  // names just re-sets identical entries (idempotent across re-evals).
  defineCurrency(names: string[]): void {
    if (names.length === 0) throw new Error('currency needs a name, e.g. `currency BTC`');
    for (const n of names)
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n))
        throw new Error(
          `currency: '${n}' isn't a valid name — use letters/digits, e.g. \`currency BTC, bitcoin\``
        );
    const key = names[0];
    for (const n of names) this.units.set(n, { dim: { [key]: 1 }, scale: 1 });
  }

  private ctxFor(fns: DistFns): EvalCtx {
    return { env: new Map(), units: this.units, fns, above: [], bridges: this.bridges };
  }

  evalSheet(text: string): SheetResult {
    // Deterministic per sheet: each re-eval resets the RNG to the seed.
    const fns = this.makeFns(this.opts.seed);
    const env = new Map<string, Value>();
    const ctx: EvalCtx = { env, units: this.units, fns, above: [], bridges: this.bridges };
    const rawLines = text.split('\n');
    this.lineValues = new Array(rawLines.length).fill(null);
    // Grouping pre-pass: a block header (`correlate:`) plus the body lines
    // indented deeper than it evaluate together; everything else stays strictly
    // one statement per line. Each physical line still yields one LineResult, so
    // gutter and numbering are unchanged.
    const lines: LineResult[] = new Array(rawLines.length);
    let i = 0;
    while (i < rawLines.length) {
      const header = blockHeader(rawLines[i]);
      if (header) {
        const headerIndent = indentOf(rawLines[i]);
        let j = i + 1;
        // Body runs until the first non-blank, non-comment line indented at or
        // below the header. Blank and comment lines never close the block.
        while (j < rawLines.length) {
          const t = rawLines[j].trim();
          if (t === '' || t.startsWith('#') || indentOf(rawLines[j]) > headerIndent) j++;
          else break;
        }
        const group =
          header.kind === 'correlate'
            ? this.evalCorrelateBlock(i, j, rawLines, ctx)
            : this.evalScenarioBlock(i, j, rawLines, ctx, header.axis);
        for (let k = i; k < j; k++) lines[k] = group[k - i];
        i = j;
      } else {
        lines[i] = this.evalLine(rawLines[i], i, ctx);
        i++;
      }
    }
    this.lastEnv = env;
    return { lines };
  }

  // Evaluate a `correlate:` block spanning physical lines [headerIndex, bodyEnd).
  // Members are independent draws defined inside the block; `cor(a, b) = r` sets
  // the target rank correlation for a pair. On success the members are jointly
  // reordered (Iman–Conover) so their pairwise correlations match the targets
  // while each marginal is preserved exactly, then leaked to the sheet env so
  // downstream lines see the coupled arrays via correlation-by-reuse. A member
  // sees only units — referencing another member or an outside variable is
  // rejected, keeping the "no uncorrelated leak" invariant.
  private evalCorrelateBlock(
    headerIndex: number,
    bodyEnd: number,
    rawLines: string[],
    ctx: EvalCtx
  ): LineResult[] {
    const results = new Map<number, LineResult>();
    // Members evaluate against a fresh env (units only), so no member can pull
    // in another member's or the sheet's sample array.
    const blockCtx: EvalCtx = {
      env: new Map(),
      units: this.units,
      fns: ctx.fns,
      above: [],
      bridges: this.bridges
    };
    interface Member {
      name: string;
      index: number;
      value: Value;
      pinned?: PinnedUnit;
      ast: Node;
      comment?: string;
    }
    const members: Member[] = [];
    const byName = new Map<string, Member>();
    interface Pair {
      a: string;
      b: string;
      r: number;
      index: number;
    }
    const pairs: Pair[] = [];
    let sound = true; // cleared by any per-line error — suppresses the reorder

    for (let idx = headerIndex + 1; idx < bodyEnd; idx++) {
      const raw = rawLines[idx];
      const hash = raw.indexOf('#');
      const code = (hash >= 0 ? raw.slice(0, hash) : raw).trim();
      const comment = hash >= 0 ? raw.slice(hash + 1).trim() : undefined;
      if (code === '') {
        results.set(idx, { index: idx, kind: comment != null ? 'comment' : 'blank', raw });
        continue;
      }
      const corMatch = /^cor\s*\(\s*([A-Za-z_]\w*)\s*,\s*([A-Za-z_]\w*)\s*\)\s*=\s*(.+)$/.exec(
        code
      );
      if (corMatch) {
        const [, a, b, rExpr] = corMatch;
        try {
          const r = this.evalCorrelation(a, b, rExpr, byName, blockCtx);
          pairs.push({ a, b, r, index: idx });
          results.set(idx, { index: idx, kind: 'unitdef', raw, name: `cor(${a}, ${b})`, comment });
        } catch (e) {
          sound = false;
          results.set(idx, {
            index: idx,
            kind: 'unitdef',
            raw,
            name: `cor(${a}, ${b})`,
            ...toError(e)
          });
        }
        continue;
      }
      // Otherwise a member definition: `name = distribution`.
      try {
        const line = parseLine(raw, { isUnit: (n) => this.units.has(n) });
        if (line.type !== 'assign')
          throw new Error('a correlate: member must be `name = distribution`');
        if (byName.has(line.name))
          throw new Error(`correlate: member '${line.name}' defined twice`);
        const { value, pinned } = evalRoot(line.expr, blockCtx);
        if (!value.samples)
          throw new Error(
            `correlate: member '${line.name}' must be a distribution — it has no samples to reorder`
          );
        const m: Member = { name: line.name, index: idx, value, pinned, ast: line.expr, comment };
        members.push(m);
        byName.set(line.name, m);
      } catch (e) {
        sound = false;
        results.set(idx, { index: idx, kind: 'value', raw, ...toError(e) });
      }
    }

    let headerError: string | undefined;
    if (sound && members.length >= 2) {
      // Assemble the target matrix (identity + each pair's r) and jointly reorder.
      const k = members.length;
      const target: number[][] = Array.from({ length: k }, (_, a) =>
        Array.from({ length: k }, (_, b): number => (a === b ? 1 : 0))
      );
      const pos = new Map(members.map((m, p) => [m.name, p]));
      for (const pr of pairs) {
        const pa = pos.get(pr.a) as number;
        const pb = pos.get(pr.b) as number;
        target[pa][pb] = pr.r;
        target[pb][pa] = pr.r;
      }
      try {
        const reordered = correlateJoint(
          members.map((m) => m.value.samples as Float64Array),
          target,
          ctx.fns
        );
        members.forEach((m, p) => {
          const value: Value = { ...m.value, samples: reordered[p] };
          ctx.env.set(m.name, value);
          this.lineValues[m.index] = value;
          ctx.above.push(value);
          results.set(
            m.index,
            this.valueLine(m.index, rawLines[m.index], m.name, m.comment, value, m.pinned, m.ast)
          );
        });
      } catch (e) {
        headerError = errMsg(e);
      }
    }
    // Members that never got a coupled result (block unsound or reorder failed)
    // still render their independent value, but are NOT leaked to the sheet.
    for (const m of members)
      if (!results.has(m.index))
        results.set(
          m.index,
          this.valueLine(m.index, rawLines[m.index], m.name, m.comment, m.value, m.pinned, m.ast)
        );

    const header: LineResult = headerError
      ? {
          index: headerIndex,
          kind: 'unitdef',
          raw: rawLines[headerIndex],
          name: 'correlate',
          ...toError(new Error(headerError))
        }
      : { index: headerIndex, kind: 'unitdef', raw: rawLines[headerIndex], name: 'correlate' };
    const out: LineResult[] = [];
    for (let idx = headerIndex; idx < bodyEnd; idx++)
      out.push(idx === headerIndex ? header : (results.get(idx) as LineResult));
    return out;
  }

  // Evaluate a `scenario <axis>:` table spanning physical lines
  // [headerIndex, bodyEnd). The first non-blank body line must be a `# coordA
  // coordB …` header naming the axis coords; each subsequent `name = c1 c2 …
  // [unit]` row desugars to the inline scenario[axis](…) constructor (cells are
  // split on runs of two or more spaces, so a cell may hold a spaced expression
  // like `1 to 10`; a trailing token beyond the coord count is a shared unit
  // applied to every cell). Rows leak to the sheet and, sharing one axis, zip.
  private evalScenarioBlock(
    headerIndex: number,
    bodyEnd: number,
    rawLines: string[],
    ctx: EvalCtx,
    axis: string
  ): LineResult[] {
    const results = new Map<number, LineResult>();
    let coords: string[] | null = null;

    for (let idx = headerIndex + 1; idx < bodyEnd; idx++) {
      const raw = rawLines[idx];
      const hash = raw.indexOf('#');
      const code = (hash >= 0 ? raw.slice(0, hash) : raw).trim();
      const afterHash = hash >= 0 ? raw.slice(hash + 1).trim() : '';
      if (code === '') {
        // The first `# …` line is the coord header; later ones are comments.
        if (hash >= 0 && coords == null) {
          coords = afterHash.split(/\s+/).filter(Boolean);
          if (coords.length === 0) coords = null;
          results.set(idx, { index: idx, kind: 'comment', raw });
          continue;
        }
        results.set(idx, { index: idx, kind: hash >= 0 ? 'comment' : 'blank', raw });
        continue;
      }
      const rowMatch = /^([A-Za-z_$€µ][\w$€µ]*)\s*=\s*(.+)$/.exec(code);
      if (!rowMatch) {
        results.set(idx, {
          index: idx,
          kind: 'value',
          raw,
          ...toError(new Error('scenario row must be `name = cell cell …`'))
        });
        continue;
      }
      const [, name, rhs] = rowMatch;
      const comment = hash >= 0 ? afterHash : undefined;
      try {
        if (coords == null)
          throw new Error('scenario table needs a coord header row first, e.g. `# low base high`');
        const tokens = rhs
          .trim()
          .split(/\s{2,}/)
          .filter(Boolean);
        if (tokens.length !== coords.length && tokens.length !== coords.length + 1)
          throw new Error(
            `scenario row '${name}' has ${tokens.length} cell(s) but the axis has ${coords.length} coord(s)`
          );
        const unit = tokens.length > coords.length ? tokens[coords.length] : '';
        const parts = coords.map((c, k) => `${c}: (${tokens[k]})${unit ? ` ${unit}` : ''}`);
        const src = `${name} = scenario[${axis}](${parts.join(', ')})`;
        const line = parseLine(src, { isUnit: (n) => this.units.has(n) });
        if (line.type !== 'assign') throw new Error('scenario row did not parse as an assignment');
        const { value, pinned } = evalRoot(line.expr, ctx);
        ctx.env.set(name, value);
        this.lineValues[idx] = value;
        ctx.above.push(value);
        results.set(idx, this.valueLine(idx, raw, name, comment, value, pinned, line.expr));
      } catch (e) {
        results.set(idx, { index: idx, kind: 'value', raw, name, comment, ...toError(e) });
      }
    }

    const header: LineResult = {
      index: headerIndex,
      kind: 'unitdef',
      raw: rawLines[headerIndex],
      name: `scenario ${axis}`
    };
    const out: LineResult[] = [];
    for (let idx = headerIndex; idx < bodyEnd; idx++)
      out.push(idx === headerIndex ? header : (results.get(idx) as LineResult));
    return out;
  }

  // Evaluate the `r` of a `cor(a, b) = r` line, validating both members exist
  // and r is a dimensionless magnitude with |r| < 1.
  private evalCorrelation(
    a: string,
    b: string,
    rExpr: string,
    byName: Map<string, unknown>,
    blockCtx: EvalCtx
  ): number {
    if (a === b) throw new Error(`cor: a variable cannot correlate with itself ('${a}')`);
    if (!byName.has(a)) throw new Error(`cor: unknown member '${a}'`);
    if (!byName.has(b)) throw new Error(`cor: unknown member '${b}'`);
    const line = parseLine(rExpr, { isUnit: (n) => this.units.has(n) });
    if (line.type !== 'expr' && line.type !== 'assign') throw new Error('cor: r must be a number');
    const v = evalRoot(line.expr, blockCtx).value;
    if (v.scalar == null) throw new Error('cor: r must be a deterministic number');
    if (Object.values(v.dim).some((e) => e)) throw new Error('cor: r must be dimensionless');
    if (!(Math.abs(v.scalar) < 1))
      throw new Error(
        'cor: r must satisfy |r| < 1 — express perfect coupling as a formula (e.g. b = -a)'
      );
    return v.scalar;
  }

  // Build the value-bearing LineResult for a successfully evaluated expression:
  // summary, display, rate/skew flags. Shared by ordinary lines and correlate:
  // members (which supply a pre-reordered value).
  private valueLine(
    index: number,
    raw: string,
    name: string | undefined,
    comment: string | undefined,
    value: Value,
    pinned: PinnedUnit | undefined,
    ast: Node
  ): LineResult {
    const summary = summarize(value, this.opts.confidence);
    const display = formatSummary(summary, pinned, this.opts.numberFormat, this.opts.confidence);
    // A list result (e.g. interval(...)) or a scenario grid is never a rate —
    // neither has a single magnitude to re-express across time.
    const isRate = !value.list && !value.axes && (value.dim.time ?? 0) === -1;
    const res: LineResult = {
      index,
      kind: 'value',
      raw,
      name,
      comment,
      display,
      summary,
      isRate,
      isDist: summary.kind === 'dist',
      // Threshold for "skewed" flagging: |(mean − median) / sd| > 0.1.
      // Empirically this proxy plateaus near 0.1 for genuinely heavy-tailed
      // lognormal products (sd itself grows with the tail, so the normalised
      // skew saturates); 0.3 was too conservative and missed most user-visible
      // tail divergence.
      skewed:
        summary.kind === 'dist' && Number.isFinite(summary.skew) && Math.abs(summary.skew) > 0.1,
      ast
    };
    if (isRate) res.rateCard = this.buildRateCard(value);
    return res;
  }

  private evalLine(raw: string, index: number, ctx: EvalCtx): LineResult {
    let parsed: Line;
    try {
      parsed = parseLine(raw, { isUnit: (n) => this.units.has(n) });
    } catch (e) {
      return { index, kind: 'value', raw, ...toError(e) };
    }
    switch (parsed.type) {
      case 'blank':
        return { index, kind: 'blank', raw };
      case 'comment':
        return { index, kind: 'comment', raw };
      case 'unitdef':
        try {
          this.defineUnit(parsed.name, parsed.definition);
          return { index, kind: 'unitdef', raw, name: parsed.name, comment: parsed.comment };
        } catch (e) {
          return { index, kind: 'unitdef', raw, name: parsed.name, ...toError(e) };
        }
      case 'bridgedef':
        // Rendered like a unitdef (a no-value definition directive).
        try {
          this.defineBridge(parsed.name, parsed.definition);
          return { index, kind: 'unitdef', raw, name: parsed.name, comment: parsed.comment };
        } catch (e) {
          return { index, kind: 'unitdef', raw, name: parsed.name, ...toError(e) };
        }
      case 'currencydef':
        // Rendered like a unitdef (a no-value definition directive).
        try {
          this.defineCurrency(parsed.names);
          return { index, kind: 'unitdef', raw, name: parsed.names[0], comment: parsed.comment };
        } catch (e) {
          return { index, kind: 'unitdef', raw, name: parsed.names[0], ...toError(e) };
        }
      case 'assign':
      case 'expr': {
        const ast = parsed.expr;
        try {
          const { value, pinned } = evalRoot(parsed.expr, ctx);
          // A deterministic result that came out ∞ or NaN is almost always a
          // mistake (÷ by zero, √ of a negative). Surface it as a reported
          // error rather than a bare "∞"/"NaN" cell. Distributions are left
          // alone — their summary stats stay finite even with heavy tails.
          if (value.scalar != null && !Number.isFinite(value.scalar)) {
            const msg = Number.isNaN(value.scalar)
              ? 'result is not a real number'
              : 'result is infinite';
            return {
              index,
              kind: 'value',
              raw,
              name: parsed.type === 'assign' ? parsed.name : undefined,
              comment: parsed.comment,
              ast,
              ...toError(new Error(msg))
            };
          }
          if (parsed.type === 'assign') ctx.env.set(parsed.name, value);
          this.lineValues[index] = value;
          ctx.above.push(value); // visible to sum(above) on later lines
          return this.valueLine(
            index,
            raw,
            parsed.type === 'assign' ? parsed.name : undefined,
            parsed.comment,
            value,
            pinned,
            ast
          );
        } catch (e) {
          return {
            index,
            kind: 'value',
            raw,
            name: parsed.type === 'assign' ? parsed.name : undefined,
            comment: parsed.comment,
            ast,
            ...toError(e)
          };
        }
      }
    }
  }

  // Re-express a `…/time` rate across every time base.
  private buildRateCard(rate: Value): RateCardEntry[] {
    // numerator label = dimension with the time^-1 removed
    const numDim = dimMul(rate.dim, { time: 1 });
    return RATE_PERIODS.map((period) => {
      const secs = this.periodSeconds[period];
      const scaled = scaleValue(rate, secs, rate.dim); // keep rate dim, relabel time
      const summary = summarize(scaled, this.opts.confidence);
      const numLabel = dimLabelOf(numDim);
      const unit = `${numLabel || '1'}/${PERIOD_UNIT[period]}`;
      const display = formatSummary(
        summary,
        { label: unit, factor: 1 },
        this.opts.numberFormat,
        this.opts.confidence
      );
      return { period, display };
    });
  }

  // Accumulate a rate over a window: rate × duration, time cancels.
  // With `growth` (fractional change per period), the window is summed as a
  // geometric series instead of a flat product.
  accumulate(index: number, period: RatePeriod, count: number, growth = 0): DisplayValue | null {
    const v = this.lineValues[index];
    if (!v || (v.dim.time ?? 0) !== -1) return null;
    const seconds = this.periodSeconds[period] * geometricSum(count, growth);
    const totalDim = dimMul(v.dim, { time: 1 });
    const total = scaleValue(v, seconds, totalDim);
    return formatSummary(
      summarize(total, this.opts.confidence),
      undefined,
      this.opts.numberFormat,
      this.opts.confidence
    );
  }

  // Which input variables drive this line's variance. For a
  // distribution line, correlate its samples with each distribution variable's
  // samples; r² is the share of variance explained. Variables sharing the
  // line's own sample array (correlation-by-reuse — i.e. the line *is* that
  // variable) are skipped, as are near-zero contributors.
  sensitivity(index: number): SensitivityEntry[] | null {
    const v = this.lineValues[index];
    if (!v?.samples) return null;
    const out: SensitivityEntry[] = [];
    for (const [name, val] of this.lastEnv) {
      if (!val.samples || val.samples === v.samples || val.samples.length !== v.samples.length)
        continue;
      const r = correlation(v.samples, val.samples);
      const r2 = r * r;
      if (r2 >= 0.01) out.push({ name, r2 });
    }
    return out.sort((a, b) => b.r2 - a.r2);
  }

  // Full per-period stats for a distribution line (datagrid panel).
  statsTable(index: number): { label: string; value: string }[] | null {
    const v = this.lineValues[index];
    if (!v || v.scalar != null || v.list || v.axes) return null;
    const s = summarize(v) as Extract<Summary, { kind: 'dist' }>;
    const f = this.opts.numberFormat;
    return [
      { label: 'mean', value: formatNumber(s.mean, f) },
      { label: 'sd', value: formatNumber(s.sd, f) },
      { label: 'min', value: formatNumber(s.min, f) },
      { label: 'p5', value: formatNumber(s.p5, f) },
      { label: 'p25', value: formatNumber(s.p25, f) },
      { label: 'median', value: formatNumber(s.p50, f) },
      { label: 'p75', value: formatNumber(s.p75, f) },
      { label: 'p95', value: formatNumber(s.p95, f) },
      { label: 'max', value: formatNumber(s.max, f) }
    ];
  }
}

// Number of leading spaces/tabs — the block indentation depth. Only ever
// compared for strict-greater, so no fixed step is imposed.
function indentOf(raw: string): number {
  const m = /^[ \t]*/.exec(raw);
  return m ? m[0].length : 0;
}

type BlockHeader = { kind: 'correlate' } | { kind: 'scenario'; axis: string };

// Recognise a multi-line block header (trailing comment allowed): `correlate:`,
// or `scenario:` / `scenario <axis>:` (the axis defaults to `case`). Returns
// null for everything else, so ordinary lines are untouched.
function blockHeader(raw: string): BlockHeader | null {
  const hash = raw.indexOf('#');
  const code = (hash >= 0 ? raw.slice(0, hash) : raw).trim();
  if (code === 'correlate:') return { kind: 'correlate' };
  const m = /^scenario(?:\s+([A-Za-z_]\w*))?\s*:$/.exec(code);
  if (m) return { kind: 'scenario', axis: m[1] ?? 'case' };
  return null;
}

function dimLabelOf(dim: Dimension): string {
  const { time: _time, ...rest } = dim;
  return dimToString(rest);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Raw developer message plus, for the UI, an optional plain-language hint and
// the cheat-sheet topic that addresses this class of error.
function toError(e: unknown): { error: string; errorHint?: string; errorTopic?: string } {
  const error = errMsg(e);
  const hint = errorHint(error);
  const topic = errorTopic(error);
  return { error, ...(hint && { errorHint: hint }), ...(topic && { errorTopic: topic }) };
}

export { astText } from './ast';
export { type FnDoc, FUNCTIONS } from './eval';
export type { DisplayValue, NumberFormat } from './format';
