// Tokenizer + recursive-descent parser for the expression language.
//
// Bare units are values (magnitude 1 in that unit), so `req/s`, `5 km`, and
// `60 km / 1 h` all fall out of ordinary arithmetic + implicit multiplication.
// `to` and `in` are disjoint, so there is no lookahead: `in` is conversion only
// (`5 km in mi`), `to` is confidence-interval only (`5 to 10`, `5 km to 8 km`).

// A call argument: a plain positional value, a `name = value` named argument,
// a `weight : value` pair (for discrete()/mixture()/bracket()), or a bare
// `weight :` (no value) — the parser accepts it as a final-position shorthand
// but no function binds it yet; reserved for future use.
export interface CallArg {
  value?: Node;
  name?: string;
  weight?: Node;
}

export type Node =
  | { type: 'num'; value: number }
  | { type: 'ident'; name: string } // resolved to a variable or unit in eval
  | { type: 'call'; name: string; args: CallArg[] }
  | {
      type: 'bin';
      op: '+' | '-' | '*' | '/' | '^' | '<' | '>' | '<=' | '>=';
      left: Node;
      right: Node;
    }
  | { type: 'neg'; operand: Node }
  // A confidence interval between two bounds. When `loP`/`hiP` are set (the
  // `p10: 5, p90: 50` form) the bounds sit at those percentiles; otherwise they
  // sit at the sheet's symmetric confidence level.
  | { type: 'ci'; lo: Node; hi: Node; loP?: number; hiP?: number; checkOrder?: boolean }
  // `expr in unit` — and `expr in unit via bridge` to cross dimensions through
  // a declared equivalence (e.g. `100 g in mol via water`).
  | { type: 'convert'; expr: Node; unit: Node; unitText: string; via?: string }
  | { type: 'list'; items: Node[] }
  | { type: 'range'; lo: Node; hi: Node; step?: Node }
  // `X given predicate` — the conditional distribution of X over the draws
  // where `pred` (a 0/1 mask) holds.
  | { type: 'given'; body: Node; pred: Node }
  // `expr where a = …, b = …` — evaluate body with extra locals bound.
  | { type: 'where'; body: Node; bindings: { name: string; value: Node }[] }
  // `scenario[axis](low: e, base: e, high: e)` — the inline scenario
  // constructor: a value carrying one named axis whose coords are labelled
  // expressions. Shorthand for a one-row scenario table.
  | { type: 'scenario'; axis: string; coords: { label: string; value: Node }[] }
  // A double-quoted string literal. Only valid as a `pick(...)` coord label;
  // the evaluator errors if one appears anywhere a value is expected.
  | { type: 'str'; value: string };

export type Line =
  | { type: 'blank' }
  | { type: 'comment' }
  | { type: 'assign'; name: string; expr: Node; comment?: string }
  | { type: 'expr'; expr: Node; comment?: string }
  // directives: `unit foo = 3 bar`, `bridge water = 18 g/mol`
  | { type: 'unitdef'; name: string; definition: string; comment?: string }
  | { type: 'bridgedef'; name: string; definition: string; comment?: string }
  // `currency BTC, bitcoin` — mint a new currency (its own base dimension);
  // the comma-separated names are aliases sharing that dimension.
  | { type: 'currencydef'; names: string[]; comment?: string };

interface Tok {
  kind: 'num' | 'ident' | 'op' | 'lparen' | 'rparen' | 'comma' | 'eq' | 'lbrack' | 'rbrack' | 'str';
  value: string;
  num?: number;
  start: number;
  end: number;
}

const OPS = new Set(['+', '-', '*', '/', '^', '×', '÷']);

// Words the parser treats specially, so they never act as an implicit-product
// factor (`between`, `about`, `and`) or get read as a unit/variable.
export const KEYWORDS = new Set([
  'in',
  'to',
  'per',
  'and',
  'between',
  'about',
  'of',
  'step',
  'seen',
  'given',
  'every',
  'where',
  'via',
  'over'
]);

// Line-leading directives (matched in parseLine, not the expression grammar).
// Exported so the generated reference can enumerate them alongside KEYWORDS.
export const DIRECTIVES = ['unit', 'currency', 'bridge'] as const;

// Spelled-out cardinals, so a non-technical user can write `two days`. Tens and
// ones combine (`twenty five`, `twenty-five`); scales multiply (`two hundred`,
// `one thousand`). `thousand`/`million`/`billion` are also dimensionless count
// units, and fold to the same magnitude either way.
const NUM_ONES: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9
};
const NUM_SMALL: Record<string, number> = {
  zero: 0,
  ...NUM_ONES,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90
};
const NUM_TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90
};
const NUM_SCALES: Record<string, number> = {
  hundred: 100,
  thousand: 1e3,
  million: 1e6,
  billion: 1e9
};

const isNumberWord = (t: Tok | undefined): boolean =>
  t?.kind === 'ident' && (t.value in NUM_SMALL || t.value in NUM_SCALES);

// Combine a run of cardinal words into a single value, e.g.
// ['one','thousand','two','hundred'] -> 1200, ['twenty','five'] -> 25.
function combineWords(words: string[]): number {
  let result = 0;
  let current = 0;
  for (const w of words) {
    if (w in NUM_SCALES) {
      const s = NUM_SCALES[w];
      if (s >= 1000) {
        result += (current || 1) * s;
        current = 0;
      } else {
        current = (current || 1) * s; // hundred
      }
    } else {
      current += NUM_SMALL[w];
    }
  }
  return result + current;
}

// Collapse maximal runs of cardinal words into numeric literals. A `-` between
// a tens word and a ones word is absorbed (`twenty-five`); other `-` ends the
// run so ordinary subtraction is untouched.
function foldNumberWords(toks: Tok[]): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < toks.length) {
    if (!isNumberWord(toks[i])) {
      out.push(toks[i]);
      i++;
      continue;
    }
    const run: Tok[] = [toks[i]];
    let j = i + 1;
    for (;;) {
      const t = toks[j];
      if (isNumberWord(t)) {
        run.push(t as Tok);
        j++;
        continue;
      }
      const prev = run[run.length - 1].value;
      if (
        t?.kind === 'op' &&
        t.value === '-' &&
        prev in NUM_TENS &&
        toks[j + 1]?.kind === 'ident' &&
        toks[j + 1].value in NUM_ONES
      ) {
        run.push(toks[j + 1]);
        j += 2;
        continue;
      }
      // British "and" inside a number, but only after a scale word
      // (`two hundred and fifty`) so it never eats `between A and B`.
      if (
        t?.kind === 'ident' &&
        t.value === 'and' &&
        prev in NUM_SCALES &&
        isNumberWord(toks[j + 1])
      ) {
        j++; // drop the connector; the next number word joins the run
        continue;
      }
      break;
    }
    const value = combineWords(run.map((r) => r.value));
    out.push({
      kind: 'num',
      value: String(value),
      num: value,
      start: run[0].start,
      end: run[run.length - 1].end
    });
    i = j;
  }
  return out;
}

// Unicode superscript digits/minus → their ASCII decode, so `m²` lexes as
// `m ^ 2` and `s⁻¹` lexes as `s ^ -1`. Pure syntactic sugar for `^<integer>`:
// emitting a real `^` token here means operator precedence (parsePow) just
// works with no further changes. Deliberately no subscript support.
const SUPERSCRIPT_DECODE: Record<string, string> = {
  '⁰': '0',
  '¹': '1',
  '²': '2',
  '³': '3',
  '⁴': '4',
  '⁵': '5',
  '⁶': '6',
  '⁷': '7',
  '⁸': '8',
  '⁹': '9',
  '⁻': '-'
};
const SUPERSCRIPT_CHARS = Object.keys(SUPERSCRIPT_DECODE).join('');
// A run: one optional leading superscript minus, then 1+ superscript digits.
const SUPERSCRIPT_RUN = new RegExp(`^⁻?[${SUPERSCRIPT_CHARS.replace('⁻', '')}]+`, 'u');

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  // Unit/currency symbols that may appear in identifiers (e.g. °, Ω, £, %).
  const SYM = '$€£¥₹µ°ΩÅ‰%Δπτ';
  const isIdentStart = (c: string) => /[A-Za-z_]/.test(c) || SYM.includes(c);
  const isIdentPart = (c: string) => /[A-Za-z0-9_]/.test(c) || SYM.includes(c);
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    const start = i;
    // Superscript exponent shorthand: `m²` -> `m` `^` `2`, `s⁻¹` -> `s` `^` `-1`.
    // Emitted as a real `^` + `num` pair so parsePow handles precedence with
    // no other changes. A run with no preceding value token still parses
    // fine here (the token stream is context-free); the parser will error
    // on it downstream (e.g. `²5`), which is expected/acceptable.
    if (c in SUPERSCRIPT_DECODE) {
      const m = SUPERSCRIPT_RUN.exec(src.slice(i));
      if (m) {
        const digits = m[0]
          .split('')
          .map((ch) => SUPERSCRIPT_DECODE[ch])
          .join('');
        const end = i + m[0].length;
        toks.push({ kind: 'op', value: '^', start: i, end: i });
        toks.push({
          kind: 'num',
          value: digits,
          num: Number.parseFloat(digits),
          start: i,
          end
        });
        i = end;
        continue;
      }
    }
    // Hex (`0x…`) / binary (`0b…`) integer literals, checked before the
    // decimal path so `0xFF`/`0b1010` don't fall into the ordinary number
    // lexer (which would stop at `x`/`b`). `_` separators are allowed and
    // stripped, same as decimal literals. No magnitude suffix (`k`/`M`)
    // applies here — `0x10k` is `0x10` followed by the identifier `k`. A
    // `0x`/`0b` with no valid digits after it isn't consumed here, so it
    // falls through to the decimal path (`0`) followed by an identifier
    // (`x…`/`b…`), which is the existing/expected error behaviour.
    if (
      c === '0' &&
      (src[i + 1] === 'x' || src[i + 1] === 'X') &&
      /[0-9a-fA-F_]/.test(src[i + 2] ?? '')
    ) {
      let s = '';
      let j = i + 2;
      while (j < src.length && /[0-9a-fA-F_]/.test(src[j])) {
        if (src[j] !== '_') s += src[j];
        j++;
      }
      if (s.length > 0) {
        toks.push({
          kind: 'num',
          value: src.slice(i, j),
          num: Number.parseInt(s, 16),
          start,
          end: j
        });
        i = j;
        continue;
      }
    }
    if (c === '0' && (src[i + 1] === 'b' || src[i + 1] === 'B') && /[01_]/.test(src[i + 2] ?? '')) {
      let s = '';
      let j = i + 2;
      while (j < src.length && /[01_]/.test(src[j])) {
        if (src[j] !== '_') s += src[j];
        j++;
      }
      if (s.length > 0) {
        toks.push({
          kind: 'num',
          value: src.slice(i, j),
          num: Number.parseInt(s, 2),
          start,
          end: j
        });
        i = j;
        continue;
      }
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let s = '';
      while (i < src.length && /[0-9_.eE]/.test(src[i])) {
        if ((src[i] === 'e' || src[i] === 'E') && /[+-]/.test(src[i + 1] ?? '')) {
          s += src[i] + src[i + 1];
          i += 2;
          continue;
        }
        if (src[i] === '.' && src[i + 1] === '.') break;
        s += src[i++];
      }
      const literal = s.replaceAll('_', '');
      if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(literal))
        throw new Error(`invalid number '${s}'`);
      const numeric = Number(literal);
      const SUFFIX: Record<string, number> = { k: 1000, K: 1000, M: 1e6 };
      let mult = 1;
      const suf = src[i];
      if (suf in SUFFIX && (src[i + 1] === undefined || !isIdentPart(src[i + 1]))) {
        mult = SUFFIX[suf];
        i++;
      }
      if (!Number.isFinite(numeric * mult)) throw new Error(`invalid number '${s}'`);
      toks.push({
        kind: 'num',
        value: mult === 1 ? s : s + suf,
        num: numeric * mult,
        start,
        end: i
      });
      continue;
    }
    // Currency prefix: `$5`, `€20`, `£5.50`. A currency glyph directly followed
    // by a digit (or decimal point) lexes as the bare unit alone, so the number
    // tokenizes next and the parser reads it as `$ * 5`. `$x` and `k$` are
    // unaffected (the glyph isn't followed by a digit / doesn't lead).
    const CURRENCY = '$€£¥₹';
    if (CURRENCY.includes(c) && /[0-9.]/.test(src[i + 1] ?? '')) {
      toks.push({ kind: 'ident', value: c, start, end: ++i });
      continue;
    }
    if (isIdentStart(c)) {
      let s = '';
      while (i < src.length && isIdentPart(src[i])) {
        s += src[i];
        i++;
      }
      toks.push({ kind: 'ident', value: s, start, end: i });
      continue;
    }
    // Double-quoted string literal. Only meaningful as a `pick(...)` coord
    // label (a bare identifier there would be ambiguous with a variable), so
    // the grammar accepts it narrowly and the evaluator rejects it elsewhere.
    // No escapes — coord labels are plain words.
    if (c === '"') {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== '"') {
        s += src[j];
        j++;
      }
      if (j >= src.length) throw new Error('unterminated string literal — missing closing "');
      toks.push({ kind: 'str', value: s, start, end: j + 1 });
      i = j + 1;
      continue;
    }
    if (c === '(') {
      toks.push({ kind: 'lparen', value: c, start, end: ++i });
      continue;
    }
    if (c === ')') {
      toks.push({ kind: 'rparen', value: c, start, end: ++i });
      continue;
    }
    if (c === ',') {
      toks.push({ kind: 'comma', value: c, start, end: ++i });
      continue;
    }
    if (c === '=') {
      toks.push({ kind: 'eq', value: c, start, end: ++i });
      continue;
    }
    if (c === '<' || c === '>') {
      if (src[i + 1] === '=') {
        i += 2;
        toks.push({ kind: 'op', value: `${c}=`, start, end: i });
      } else {
        toks.push({ kind: 'op', value: c, start, end: ++i });
      }
      continue;
    }
    // `±` and the ASCII spelling `+-` both build a symmetric interval.
    if (c === '±') {
      toks.push({ kind: 'op', value: '±', start, end: ++i });
      continue;
    }
    if (c === '+' && src[i + 1] === '-') {
      i += 2;
      toks.push({ kind: 'op', value: '±', start, end: i });
      continue;
    }
    // `~` is shorthand for `about`; tokenize it as the keyword.
    if (c === '~') {
      toks.push({ kind: 'ident', value: 'about', start, end: ++i });
      continue;
    }
    // `|>` pipe: feeds the left expression as the first argument of a call.
    if (c === '|' && src[i + 1] === '>') {
      i += 2;
      toks.push({ kind: 'op', value: '|>', start, end: i });
      continue;
    }
    // `:` separates a weight from its value in discrete()/mixture().
    if (c === ':') {
      toks.push({ kind: 'op', value: ':', start, end: ++i });
      continue;
    }
    // `[` and `]` delimit list literals; `..` builds a stepped range.
    if (c === '[') {
      toks.push({ kind: 'lbrack', value: '[', start, end: ++i });
      continue;
    }
    if (c === ']') {
      toks.push({ kind: 'rbrack', value: ']', start, end: ++i });
      continue;
    }
    if (c === '.' && src[i + 1] === '.') {
      i += 2;
      toks.push({ kind: 'op', value: '..', start, end: i });
      continue;
    }
    if (OPS.has(c)) {
      toks.push({ kind: 'op', value: c, start, end: ++i });
      continue;
    }
    throw new Error(`unexpected character '${c}'`);
  }
  return toks;
}

export interface ParseDeps {
  isUnit: (name: string) => boolean;
}

class Parser {
  private toks: Tok[];
  private pos = 0;
  constructor(
    private src: string,
    toks: Tok[],
    private deps: ParseDeps
  ) {
    this.toks = toks;
  }

  private peek(): Tok | undefined {
    return this.toks[this.pos];
  }
  private next(): Tok {
    return this.toks[this.pos++];
  }
  private expect(kind: Tok['kind']): Tok {
    const t = this.peek();
    if (!t || t.kind !== kind) throw new Error(`expected ${kind}`);
    return this.next();
  }

  parseExpr(): Node {
    return this.parseWhere();
  }

  // `body where name = value, …` — trailing local bindings, the outermost
  // (loosest) production. Bindings are kept local to this expression.
  private parseWhere(): Node {
    const body = this.parseConvert();
    const t = this.peek();
    if (!(t?.kind === 'ident' && t.value === 'where')) return body;
    this.next(); // 'where'
    const bindings: { name: string; value: Node }[] = [];
    for (;;) {
      const name = this.peek();
      if (name?.kind !== 'ident')
        throw new Error('where: expected a name, e.g. `where x = 1, y = 2`');
      this.next();
      const eq = this.peek();
      if (eq?.kind !== 'eq') throw new Error(`where: expected '=' after '${name.value}'`);
      this.next();
      bindings.push({ name: name.value, value: this.parseConvert() });
      if (this.peek()?.kind === 'comma') {
        this.next();
        continue;
      }
      break;
    }
    return { type: 'where', body, bindings };
  }

  atEnd(): boolean {
    return this.pos >= this.toks.length;
  }

  // convert/CI live at the same (lowest) precedence. `in` is conversion ONLY,
  // `to` is confidence-interval ONLY — no RHS lookahead, no ambiguity. (Use
  // `in` to convert, e.g. `5 km in mi`; `5 km to mi` is a CI between 5 km and
  // 1 mi.)
  private parseConvert(): Node {
    let left = this.parsePipe();
    for (;;) {
      const t = this.peek();
      if (t?.kind !== 'ident') break;
      if (t.value === 'in') {
        this.next();
        const startTok = this.peek();
        const unit = this.parseMul();
        const endPos = this.pos > 0 ? this.toks[this.pos - 1].end : 0;
        const text = startTok ? this.src.slice(startTok.start, endPos).trim() : '';
        // optional `via <bridge>` to cross dimensions
        let via: string | undefined;
        const v = this.peek();
        if (v?.kind === 'ident' && v.value === 'via') {
          this.next();
          const name = this.peek();
          if (name?.kind !== 'ident')
            throw new Error('via: expected a bridge name, e.g. `in mol via water`');
          this.next();
          via = name.value;
        }
        left = { type: 'convert', expr: left, unit, unitText: text, via };
      } else if (t.value === 'to') {
        this.next();
        const hi = this.parsePlusMinus();
        left = this.makeCi(left, hi);
      } else if (t.value === 'seen' || t.value === 'given') {
        // `seen`/`given` is polymorphic:
        //   • `prior seen|given k of n` → Bayesian update(prior, k, n).
        //   • `X given <comparison>`    → conditioning (truncation).
        // Parse the RHS head at the juxtaposition tier, which stops at the
        // `of` keyword and at comparison ops. (parseMul would consume `of`
        // as multiplication and swallow the `k of n` separator.)
        this.next(); // seen | given
        const head = this.parseJuxt();
        const after = this.peek();
        const isCmp = (v: string) => v === '<' || v === '>' || v === '<=' || v === '>=';
        if (after?.kind === 'ident' && after.value === 'of') {
          this.next(); // 'of'
          const n = this.parseJuxt();
          left = {
            type: 'call',
            name: 'update',
            args: [{ value: left }, { value: head }, { value: n }]
          };
        } else if (t.value === 'given' && after?.kind === 'op' && isCmp(after.value)) {
          // `X given head <op> rhs` — head is the predicate's left operand.
          const op = after.value as '<' | '>' | '<=' | '>=';
          this.next();
          const pred: Node = { type: 'bin', op, left: head, right: this.parseAdd() };
          left = { type: 'given', body: left, pred };
        } else if (t.value === 'given') {
          // `X given <mask>` — the head is already a 0/1 condition.
          left = { type: 'given', body: left, pred: head };
        } else {
          throw new Error(`${t.value} needs 'of', e.g. beta(2, 8) ${t.value} 3 of 10`);
        }
      } else if (t.value === 'every') {
        // Prose rate form: `1 req every 200 ms` ≡ `1 req / 200 ms`. Same
        // precedence as `to` so it chains off any expression; sits below
        // it lexically so `1 req every 200 ms in req/s` still pins a unit.
        this.next(); // 'every'
        const period = this.parseMul();
        left = { type: 'bin', op: '/', left, right: period };
      } else break;
    }
    return left;
  }

  // `x |> f(args)` feeds x as f's first argument; `x |> f` is f(x). Left-assoc
  // and just below convert, so `x |> p(0.95) in ms` pipes then converts.
  private parsePipe(): Node {
    let left = this.parsePlusMinus();
    for (;;) {
      const t = this.peek();
      if (t?.kind === 'op' && t.value === '|>') {
        this.next();
        const fn = this.peek();
        if (fn?.kind !== 'ident')
          throw new Error("'|>' must be followed by a function, e.g. x |> mean");
        this.next();
        let rest: CallArg[] = [];
        if (this.peek()?.kind === 'lparen') {
          this.next();
          rest = this.parseCallArgs();
        }
        left = { type: 'call', name: fn.value, args: [{ value: left }, ...rest] };
      } else break;
    }
    return left;
  }

  // `center ± half` builds a symmetric interval: `3 ± 1` → (2 to 4). Sits just
  // below convert/CI so it composes with a trailing-unit `to`-style interval.
  private parsePlusMinus(): Node {
    const left = this.parseCompare();
    const t = this.peek();
    if (t?.kind === 'op' && t.value === '±') {
      this.next();
      return this.makePmCi(left, this.parseCompare());
    }
    return left;
  }

  // `3 ± 1 day` → (2 to 4) day: distribute a trailing single unit over a bare
  // centre, mirroring makeCi. Otherwise both bounds are (center ∓ half).
  private makePmCi(center: Node, half: Node): Node {
    if (
      center.type === 'num' &&
      half.type === 'bin' &&
      half.op === '*' &&
      half.left.type === 'num' &&
      half.right.type === 'ident' &&
      this.deps.isUnit(half.right.name)
    ) {
      const name = half.right.name;
      const c = center.value;
      const h = half.left.value;
      return {
        type: 'ci',
        lo: {
          type: 'bin',
          op: '*',
          left: { type: 'num', value: c - h },
          right: { type: 'ident', name }
        },
        hi: {
          type: 'bin',
          op: '*',
          left: { type: 'num', value: c + h },
          right: { type: 'ident', name }
        }
      };
    }
    return {
      type: 'ci',
      lo: { type: 'bin', op: '-', left: center, right: half },
      hi: { type: 'bin', op: '+', left: center, right: half }
    };
  }

  // `about 5 days` / `~5 days` → a light ±10% range (0.9·x to 1.1·x). For a
  // tighter or wider spread, write an explicit interval instead.
  private makeAbout(x: Node): Node {
    const scale = (f: number): Node => ({
      type: 'bin',
      op: '*',
      left: { type: 'num', value: f },
      right: x
    });
    return { type: 'ci', lo: scale(0.9), hi: scale(1.1) };
  }

  // Build a CI, distributing a trailing single unit over a bare-number low
  // bound: `2 to 4 day` → `(2 to 4) day`. Fires only for the unambiguous
  // `num to num·unit` shape; complex units (`2 to 4 GB/s`) still need parens,
  // and the evaluator hints at that when the bounds' dimensions disagree.
  private makeCi(lo: Node, hi: Node): Node {
    if (
      lo.type === 'num' &&
      hi.type === 'bin' &&
      hi.op === '*' &&
      hi.left.type === 'num' &&
      hi.right.type === 'ident' &&
      this.deps.isUnit(hi.right.name)
    ) {
      const unit: Node = { type: 'ident', name: hi.right.name };
      return {
        type: 'ci',
        lo: { type: 'bin', op: '*', left: lo, right: unit },
        hi,
        checkOrder: true
      };
    }
    // `checkOrder` marks an explicit two-bound interval (`lo to hi`, `between
    // a and b`) so the evaluator can reject a reversed pair — almost always a
    // `to`-as-conversion mistake (`5 km to mi`). Symmetric forms (±/about) build
    // their bounds in order and are never flagged.
    return { type: 'ci', lo, hi, checkOrder: true };
  }

  // `p10: 5, p90: 50` — a confidence interval pinned to two explicit
  // percentiles. Exactly two points; both percentiles in (0, 100) and distinct.
  // Builds a `ci` node carrying the (sorted) percentile levels.
  private parsePercentileSpec(): Node {
    const points: { p: number; value: Node }[] = [];
    for (;;) {
      const tok = this.peek();
      const m = tok?.kind === 'ident' ? /^p(\d+)$/.exec(tok.value) : null;
      if (!m) throw new Error('percentile spec: expected pNN, e.g. p10: 5, p90: 50');
      this.next(); // pNN
      const colon = this.peek();
      if (!(colon?.kind === 'op' && colon.value === ':'))
        throw new Error(`percentile spec: expected ':' after ${tok?.value}`);
      this.next(); // ':'
      points.push({ p: Number(m[1]) / 100, value: this.parseMul() });
      if (this.peek()?.kind === 'comma') {
        this.next();
        continue;
      }
      break;
    }
    if (points.length !== 2)
      throw new Error('percentile spec needs exactly two points, e.g. p10: 5, p90: 50');
    for (const pt of points)
      if (!(pt.p > 0 && pt.p < 1))
        throw new Error('percentile spec: percentiles must be in (0, 100), e.g. p10, p90');
    if (points[0].p === points[1].p)
      throw new Error('percentile spec: the two percentiles must differ');
    const [lo, hi] = points[0].p < points[1].p ? points : [points[1], points[0]];
    return { type: 'ci', lo: lo.value, hi: hi.value, loP: lo.p, hiP: hi.p };
  }

  // Comparison: tighter than CI/convert, looser than +/-. A single `a < b`
  // yields a 0/1 mask used by chance(...). A chain `a < b < c` reads as
  // `(a < b) and (b < c)` — the product of its links, 1 only where every link
  // holds. All links must point the same way: `<`/`<=` together, or `>`/`>=`
  // together; mixing directions (`a < b > c`) is a parse error.
  private parseCompare(): Node {
    const left = this.parseAdd();
    const isCmp = (v: string) => v === '<' || v === '>' || v === '<=' || v === '>=';
    const dir = (v: string) => (v === '<' || v === '<=' ? 'lt' : 'gt');
    const first = this.peek();
    if (!(first?.kind === 'op' && isCmp(first.value))) return left;

    const op0 = first.value as '<' | '>' | '<=' | '>=';
    this.next();
    let prev = this.parseAdd();
    let result: Node = { type: 'bin', op: op0, left, right: prev };
    const chainDir = dir(op0);
    for (;;) {
      const t = this.peek();
      if (!(t?.kind === 'op' && isCmp(t.value))) break;
      if (dir(t.value) !== chainDir)
        throw new Error('mixed comparison directions — use one of < <= or > >=, not both');
      const op = t.value as '<' | '>' | '<=' | '>=';
      this.next();
      const next = this.parseAdd();
      // AND of two 0/1 masks is their product.
      result = {
        type: 'bin',
        op: '*',
        left: result,
        right: { type: 'bin', op, left: prev, right: next }
      };
      prev = next;
    }
    return result;
  }

  private parseAdd(): Node {
    let left = this.parseMul();
    for (;;) {
      const t = this.peek();
      if (t?.kind === 'op' && (t.value === '+' || t.value === '-')) {
        this.next();
        const right = this.parseMul();
        left = { type: 'bin', op: t.value as '+' | '-', left, right };
      } else break;
    }
    return left;
  }

  private parseMul(): Node {
    let left = this.parseJuxt();
    for (;;) {
      const t = this.peek();
      if (t?.kind === 'op' && ['*', '/', '×', '÷'].includes(t.value)) {
        this.next();
        const op = t.value === '×' ? '*' : t.value === '÷' ? '/' : (t.value as '*' | '/');
        const right = this.parseJuxt();
        left = { type: 'bin', op, left, right };
      } else if (t?.kind === 'ident' && t.value === 'of') {
        // `value of value` is multiplication: `20% of 200` → 40, `0.2 of 200`
        // → 40. (Function application, `mean of x`, is handled in
        // parsePrimary, which consumes the `of` before it can reach here.)
        this.next();
        const right = this.parseJuxt();
        left = { type: 'bin', op: '*', left, right };
      } else break;
    }
    return left;
  }

  // Juxtaposition (implicit multiplication) binds tighter than * and /, so
  // `60 km / 1 h` is (60 km)/(1 h), not ((60 km)/1) h.
  private parseJuxt(): Node {
    let left = this.parsePow();
    while (this.startsImplicitFactor(this.peek())) {
      const right = this.parsePow();
      left = { type: 'bin', op: '*', left, right };
    }
    return left;
  }

  private startsImplicitFactor(t: Tok | undefined): boolean {
    if (!t) return false;
    if (t.kind === 'num' || t.kind === 'lparen') return true;
    if (t.kind === 'ident') {
      // keywords never start an implicit factor
      return !KEYWORDS.has(t.value);
    }
    return false;
  }

  private parsePow(): Node {
    const base = this.parseUnary();
    const t = this.peek();
    if (t?.kind === 'op' && t.value === '^') {
      this.next();
      const exp = this.parsePow(); // right-assoc
      return { type: 'bin', op: '^', left: base, right: exp };
    }
    return base;
  }
  private parseUnary(): Node {
    const t = this.peek();
    if (t?.kind === 'op' && t.value === '-') {
      this.next();
      return { type: 'neg', operand: this.parseUnary() };
    }
    if (t?.kind === 'op' && t.value === '+') {
      this.next();
      return this.parseUnary();
    }
    const base = this.parsePrimary();
    // `lo..hi [step k]` — a stepped range. Only fires when the base is a
    // bare numeric literal, so `60 km..120 km` is a parse error rather than
    // a silently-wrong numeric range.
    const next = this.peek();
    if (
      next?.kind === 'op' &&
      next.value === '..' &&
      (base.type === 'num' || base.type === 'neg')
    ) {
      this.next(); // '..'
      const hi = this.parseUnary();
      let step: Node | undefined;
      const maybeStep = this.peek();
      if (maybeStep?.kind === 'ident' && maybeStep.value === 'step') {
        this.next();
        step = this.parseUnary();
      }
      return { type: 'range', lo: base, hi, step };
    }
    return base;
  }

  private parsePrimary(): Node {
    const t = this.peek();
    if (!t) throw new Error('unexpected end of expression');
    if (t.kind === 'str') {
      this.next();
      return { type: 'str', value: t.value };
    }
    if (t.kind === 'num') {
      this.next();
      if (Number.isNaN(t.num)) throw new Error(`invalid number '${t.value}'`);
      return { type: 'num', value: t.num as number };
    }
    if (t.kind === 'lparen') {
      this.next();
      const e = this.parseExpr();
      this.expect('rparen');
      return e;
    }
    if (t.kind === 'lbrack') {
      this.next();
      const items: Node[] = [];
      if (this.peek()?.kind !== 'rbrack') {
        items.push(this.parseExpr());
        while (this.peek()?.kind === 'comma') {
          this.next();
          items.push(this.parseExpr());
        }
      }
      if (items.length === 0) throw new Error('empty list — [] is not allowed');
      this.expect('rbrack');
      return { type: 'list', items };
    }
    if (t.kind === 'ident') {
      // `scenario[axis](label: expr, …)` — the inline scenario constructor,
      // or `scenario(…)` with the axis name defaulting to `case`. Detected by
      // the `scenario` keyword immediately followed by `[` or `(`.
      if (
        t.value === 'scenario' &&
        (this.toks[this.pos + 1]?.kind === 'lbrack' || this.toks[this.pos + 1]?.kind === 'lparen')
      ) {
        return this.parseScenario();
      }
      // Percentile spec: `p10: 5, p90: 50` fits a distribution to two named
      // percentiles. Detected by a `pNN` ident immediately followed by `:`.
      const next1 = this.toks[this.pos + 1];
      if (/^p\d+$/.test(t.value) && next1?.kind === 'op' && next1.value === ':') {
        return this.parsePercentileSpec();
      }
      // `between A and B` — a natural-language confidence interval.
      if (t.value === 'between') {
        this.next();
        const lo = this.parseMul();
        const a = this.peek();
        if (!(a?.kind === 'ident' && a.value === 'and'))
          throw new Error("between needs 'and', e.g. between 2 and 4");
        this.next();
        return this.makeCi(lo, this.parseMul());
      }
      // `about X` / `~X` — a rough ±10% estimate.
      if (t.value === 'about') {
        this.next();
        return this.makeAbout(this.parseMul());
      }
      this.next();
      if (this.peek()?.kind === 'lparen') {
        this.next();
        return { type: 'call', name: t.value, args: this.parseCallArgs() };
      }
      // `f of x` — single-argument application sugar (f of x ≡ f(x)). Skipped
      // when the ident is a unit (e.g. `%`): there `of` means multiplication
      // (`20% of 200`), handled one tier up in parseMul.
      const nx = this.peek();
      if (nx?.kind === 'ident' && nx.value === 'of' && !this.deps.isUnit(t.value)) {
        this.next();
        return { type: 'call', name: t.value, args: [{ value: this.parseJuxt() }] };
      }
      return { type: 'ident', name: t.value };
    }
    throw new Error(`unexpected token '${t.value}'`);
  }

  // `scenario[axis](label: expr, …)`. The `scenario` keyword is at the cursor;
  // axis and coord labels are always explicit (no positional/anonymous form).
  private parseScenario(): Node {
    this.next(); // 'scenario'
    // `[axis]` is optional; when omitted the axis name defaults to `case`, the
    // dominant convention for a low/base/high what-if. `scenario[geo](…)` still
    // names any other axis explicitly.
    let axis = 'case';
    if (this.peek()?.kind === 'lbrack') {
      this.next();
      const axisTok = this.peek();
      if (axisTok?.kind !== 'ident')
        throw new Error('scenario needs an axis name, e.g. scenario[case](low: 8, base: 10)');
      this.next();
      this.expect('rbrack');
      axis = axisTok.value;
    }
    this.expect('lparen');
    const coords: { label: string; value: Node }[] = [];
    if (this.peek()?.kind !== 'rparen') {
      for (;;) {
        const lt = this.peek();
        if (lt?.kind !== 'ident') throw new Error('scenario coord needs a label, e.g. low: 8');
        this.next();
        const colon = this.peek();
        if (!(colon?.kind === 'op' && colon.value === ':'))
          throw new Error(
            `scenario coord '${lt.value}' needs ':' then a value, e.g. ${lt.value}: 8`
          );
        this.next();
        coords.push({ label: lt.value, value: this.parseExpr() });
        if (this.peek()?.kind === 'comma') {
          this.next();
          continue;
        }
        break;
      }
    }
    this.expect('rparen');
    if (coords.length === 0) throw new Error('scenario needs at least one coord');
    const seen = new Set<string>();
    for (const c of coords) {
      if (seen.has(c.label))
        throw new Error(`scenario axis '${axis}': duplicate coord '${c.label}'`);
      seen.add(c.label);
    }
    return { type: 'scenario', axis, coords };
  }

  // Parse a call's argument list up to and including the closing paren (the
  // opening paren is already consumed). Each arg may be positional, a named
  // `name = value`, or a `weight : value` pair. A bare `weight:` (no value)
  // is allowed only as the final positional argument — accepted as a parser-
  // level extension; no function binds it yet.
  private parseCallArgs(): CallArg[] {
    const args: CallArg[] = [];
    if (this.peek()?.kind !== 'rparen') {
      args.push(...this.parseArgWithOver());
      while (this.peek()?.kind === 'comma') {
        this.next();
        args.push(...this.parseArgWithOver());
      }
    }
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a.value === undefined && a.weight !== undefined && i !== args.length - 1)
        throw new Error("'weight:' with no value must be the last argument");
    }
    this.expect('rparen');
    return args;
  }

  // An argument, plus the prose reducer sugar `X over <axis>` which desugars
  // to a trailing `over = <axis>` named argument (identical to the kwarg form).
  // `over` is a keyword only here — a plain identifier everywhere else — so it
  // never mis-parses as an implicit-product factor.
  private parseArgWithOver(): CallArg[] {
    const arg = this.parseArg();
    const t = this.peek();
    if (t?.kind === 'ident' && t.value === 'over') {
      this.next();
      const axis = this.peek();
      if (axis?.kind !== 'ident')
        throw new Error('over: expected an axis name, e.g. `min(x over case)`');
      this.next();
      return [arg, { name: 'over', value: { type: 'ident', name: axis.value } }];
    }
    return [arg];
  }

  private parseArg(): CallArg {
    const t = this.peek();
    if (t?.kind === 'ident' && this.toks[this.pos + 1]?.kind === 'eq') {
      this.next(); // name
      this.next(); // '='
      return { name: t.value, value: this.parseExpr() };
    }
    const first = this.parseExpr();
    const c = this.peek();
    if (c?.kind === 'op' && c.value === ':') {
      this.next();
      const v = this.peek();
      if (v?.kind === 'comma' || v?.kind === 'rparen') return { weight: first };
      return { weight: first, value: this.parseExpr() };
    }
    return { value: first };
  }
}

// Split a raw line into (code, trailing comment). `#` starts a comment.
function splitComment(line: string): { code: string; comment?: string } {
  const idx = line.indexOf('#');
  if (idx === -1) return { code: line };
  return { code: line.slice(0, idx), comment: line.slice(idx + 1).trim() };
}

export function parseLine(raw: string, deps: ParseDeps): Line {
  const { code, comment } = splitComment(raw);
  const trimmed = code.trim();
  if (trimmed === '') return comment != null ? { type: 'comment' } : { type: 'blank' };

  // directive: `unit name = definition`
  const unitMatch = /^unit\s+([A-Za-z_$€µ][\w$€µ]*)\s*=\s*(.+)$/.exec(trimmed);
  if (unitMatch) {
    return { type: 'unitdef', name: unitMatch[1], definition: unitMatch[2].trim(), comment };
  }

  // directive: `bridge name = definition` (a cross-dimension equivalence)
  const bridgeMatch = /^bridge\s+([A-Za-z_$€µ][\w$€µ]*)\s*=\s*(.+)$/.exec(trimmed);
  if (bridgeMatch) {
    return { type: 'bridgedef', name: bridgeMatch[1], definition: bridgeMatch[2].trim(), comment };
  }

  // directive: `currency BTC` or `currency BTC, btc, bitcoin` — mint a new
  // currency dimension. Names are validated in the engine so errors surface on
  // the line.
  const currencyMatch = /^currency\s+(.+)$/.exec(trimmed);
  if (currencyMatch) {
    const names = currencyMatch[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return { type: 'currencydef', names, comment };
  }

  const toks = foldNumberWords(tokenize(code));
  // assignment: IDENT '=' expr   (lookahead: ident then '=')
  if (toks.length >= 2 && toks[0].kind === 'ident' && toks[1].kind === 'eq') {
    const name = toks[0].value;
    const rest = toks.slice(2);
    const p = new Parser(code, rest, deps);
    const expr = p.parseExpr();
    if (!p.atEnd()) throw new Error('trailing tokens after expression');
    return { type: 'assign', name, expr, comment };
  }

  const p = new Parser(code, toks, deps);
  const expr = p.parseExpr();
  if (!p.atEnd()) throw new Error('trailing tokens after expression');
  return { type: 'expr', expr, comment };
}

export { tokenize };
