// Display formatting: turn a base-unit Summary into human strings, honouring
// a pinned unit (from `in`/`to`) or falling back to the dimension signature.

import type { PinnedUnit } from './eval';
import type { DistSummary, Summary } from './mc';
import { type Dimension, dimToString } from './value';

// Currency symbols indexed by base-dim key. Only units whose dim matches one
// of these keys (with no other dims present) get money formatting.
const CURRENCY_SYMBOLS: Record<string, string> = {
	usd: '$',
	eur: '€',
	gbp: '£',
	jpy: '¥',
	inr: '₹'
};

// True when the unit is a pure currency (single non-zero dim key in the
// CURRENCY_SYMBOLS table). Composite units like "$/hour" are not money —
// they're a rate, and the user explicitly wants the breakdown.
function currencyKey(dim: Dimension): string | null {
	const keys = Object.keys(dim).filter((k) => dim[k] !== 0);
	if (keys.length !== 1) return null;
	const k = keys[0];
	return k in CURRENCY_SYMBOLS ? k : null;
}

// $-prefixed, 2-decimal, thousands-separated, sign-before-symbol. Always 2
// decimals (matches $/€/£ convention; ¥ shows .00 which is conventional-
// accounting-correct, if unusual for yen in headlines).
function formatMoney(n: number, symbol: string): string {
	if (Number.isNaN(n)) return 'NaN';
	// Sign before the symbol, matching the finite-negative convention below
	// (`-$5.00`), so -Infinity reads `-$∞` rather than `$-∞`.
	if (!Number.isFinite(n)) return n > 0 ? `${symbol}∞` : `-${symbol}∞`;
	const abs = Math.abs(n);
	const fixed = abs.toFixed(2);
	const [whole, frac] = fixed.split('.');
	const withSep = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
	const body = `${symbol}${withSep}.${frac}`;
	return n < 0 ? `-${body}` : body;
}

// How magnitudes are rendered. 'auto' is the smart default; the others
// let the user force a single style from settings.
export type NumberFormat = 'auto' | 'compact' | 'scientific' | 'newspaper';

// Short-scale suffixes by power-of-1000 tier: '' , K, M, B, T.
const SUFFIXES = ['', 'K', 'M', 'B', 'T'];
// Spelled-out scale words for the 'newspaper' style: '1.23 million'.
const SCALE_WORDS = ['', 'thousand', 'million', 'billion', 'trillion'];

// 1.04e9, 3.11e10, 5e-7 — 3 significant figures, trailing zeros trimmed.
function scientific(n: number): string {
	const [m, e] = n.toExponential(2).split('e');
	const mant = m.includes('.') ? m.replace(/\.?0+$/, '') : m;
	return `${mant}e${Number(e)}`;
}

// Plain decimal at ~3 significant figures (e.g. 3.14, 0.173, 12000, 250).
// Integers below 1e6 keep their full precision (the user wants to see "1024"
// not "1020"); for values where the integer form is too long to scan, the
// caller routes to `suffixed()` or `newspaper()` instead.
function plain(n: number): string {
	const exp = Math.floor(Math.log10(Math.abs(n)));
	const decimals = Math.max(0, 2 - exp);
	let s = n.toFixed(decimals);
	if (s.includes('.')) s = s.replace(/\.?0+$/, '');
	return s;
}

// 1.04B, 31.1B, 12K — mantissa in [1, 1000) followed by a tier suffix.
function suffixed(n: number): string {
	const a = Math.abs(n);
	// Clamp the tier to the table: floating-point log10 of values just below a
	// power-of-1000 boundary (e.g. 999999999999999 → log10 == 15 exactly) can
	// floor to an out-of-range tier, which would index `SUFFIXES` as undefined
	// and render "1undefined". The caller already routes a ≥ 1e15 to scientific.
	let tier = Math.min(Math.floor(Math.log10(a) / 3), SUFFIXES.length - 1);
	let mant = n / 10 ** (3 * tier);
	// Rounding the mantissa can push it to 1000 (e.g. 999_999 → "1000K"); when it
	// does, promote to the next tier so we render "1M" instead.
	if (Math.abs(mant) >= 999.5 && tier + 1 < SUFFIXES.length) {
		tier += 1;
		mant = n / 10 ** (3 * tier);
	}
	return plain(mant) + SUFFIXES[tier];
}

// 1.23 million, 31.1 billion, 12 thousand — like suffixed(), but the tier is a
// spelled-out word. Below a thousand there is no word, so it reads as plain.
function newspaper(n: number): string {
	const a = Math.abs(n);
	let tier = Math.min(Math.floor(Math.log10(a) / 3), SCALE_WORDS.length - 1);
	let mant = n / 10 ** (3 * tier);
	if (Math.abs(mant) >= 999.5 && tier + 1 < SCALE_WORDS.length) {
		tier += 1;
		mant = n / 10 ** (3 * tier);
	}
	return tier === 0 ? plain(mant) : `${plain(mant)} ${SCALE_WORDS[tier]}`;
}

export function formatNumber(n: number, fmt: NumberFormat = 'auto'): string {
	if (Number.isNaN(n)) return 'NaN';
	if (!Number.isFinite(n)) return n > 0 ? '∞' : '-∞';
	if (n === 0) return '0';
	const a = Math.abs(n);

	// Tiny magnitudes have no clean suffix in any human-readable mode.
	if (a < 1e-4) return scientific(n);
	// Beyond trillions there is no common short-scale letter either.
	if (a >= 1e15) return scientific(n);

	switch (fmt) {
		case 'scientific':
			return a >= 1e6 ? scientific(n) : plain(n);
		case 'compact':
			// Suffixes from thousands upward: 12K, 1.04B.
			return a >= 1e3 ? suffixed(n) : plain(n);
		case 'newspaper':
			// Spelled-out scale words from thousands upward: 12 thousand, 1.04 billion.
			return a >= 1e3 ? newspaper(n) : plain(n);
		default:
			// auto: keep ordinary numbers literal, but abbreviate from thousands
			// upward so 225689 reads as 226K instead of bloating the result line.
			return a >= 1e3 ? suffixed(n) : plain(n);
	}
}

export interface DisplayValue {
	kind: 'point' | 'dist';
	unit: string;
	// point
	value?: string;
	// dist: raw, machine-parseable percentiles (Number()/clipboard/share rely on
	// these staying full-precision).
	p5?: string;
	p50?: string;
	p95?: string;
	// dist: human-facing stats for the inspector, each scaled into the display
	// unit and formatted per the number-format setting. Labels: mean, std dev,
	// min, p5, p25, median, p75, p95, max. The unit label is appended by the UI.
	stats?: { label: string; value: string }[];
	text: string; // combined one-line label
	// Active confidence level (the quantile range [pLower, pUpper] that
	// the user picked via the sheet's `confidence` setting or a `ci(...)` call).
	// The dist's p5/p25/p50/p75/p95 percentiles are always the literal
	// percentiles regardless of this value — this just records which tail
	// the CI syntax is targeting so the UI can label the interval honestly.
	level?: number;
}

function unitLabel(dim: Dimension, pinned?: PinnedUnit): string {
	if (pinned) return pinned.label;
	return dimToString(dim);
}

// Symbol to use for money formatting. A pinned currency label (`$`, `k$`)
// wins; otherwise look up the single non-zero dim key in the currency table.
// Composite pinned labels (`$/req`, `€/kWh`) are rates, not money.
function moneySymbol(dim: Dimension, pinned?: PinnedUnit): string | null {
	if (pinned) {
		const stripped = pinned.label.replace(/[$€£¥]/g, '');
		if (stripped === '') {
			const m = pinned.label.match(/[$€£¥]/);
			return m ? m[0] : null;
		}
	}
	return CURRENCY_SYMBOLS[currencyKey(dim) ?? ''] ?? null;
}

// Express a base-unit stat in the pinned unit. For affine units (°C/°F/barg)
// the pinned `offset` is removed first: displayed = (base − offset) / factor.
// For log units (dB/dBm/dBW) the inverse is the log: factor · log10(base / ref).
const scaled = (x: number, pinned?: PinnedUnit): number => {
	if (!pinned) return x;
	if (pinned.log) return pinned.log.factor * Math.log10(x / pinned.log.ref);
	return (x - (pinned.offset ?? 0)) / pinned.factor;
};

export function formatSummary(
	summary: Summary,
	pinned?: PinnedUnit,
	fmt: NumberFormat = 'auto',
	level?: number
): DisplayValue {
	const unit = unitLabel(summary.dim, pinned);
	const sym = moneySymbol(summary.dim, pinned);
	// Money strings already include the symbol; skip the suffix so we don't
	// render "$5.00 $". For composite pinned labels (e.g. `k$`), the label
	// is non-symbolic so still appended to preserve the unit.
	const suffix =
		unit && (sym == null || (pinned && !/[$€£¥]/.test(pinned.label))) ? ` ${unit}` : '';
	// The numeric fields stay as plain `String(n)` so they're always machine-
	// parseable (Number(value) works, the share-link roundtrip works, copy-
	// as-expression works). The formatted display lives in `text` via
	// formatNumber — that's where the user-facing K/M/B suffix kicks in.
	const numeric = (n: number) => String(scaled(n, pinned));
	if (summary.kind === 'point') {
		const value = numeric(summary.value);
		// `text` follows the user's format preference; the `value` field stays
		// raw so tests / clipboard / share-links can re-parse it.
		const text = sym
			? formatMoney(scaled(summary.value, pinned), sym)
			: `${formatNumber(scaled(summary.value, pinned), fmt)}${suffix}`;
		return { kind: 'point', unit, value, text };
	}
	const d = summary as DistSummary;
	// A distribution with no spread (e.g. x - x via correlation-by-reuse) is an
	// exact value — render it as a point, not a degenerate interval.
	if (d.min === d.max) {
		const value = numeric(d.min);
		const text = sym
			? formatMoney(scaled(d.min, pinned), sym)
			: `${formatNumber(scaled(d.min, pinned), fmt)}${suffix}`;
		return { kind: 'point', unit, value, text };
	}
	const p5 = numeric(d.p5);
	const p50 = numeric(d.p50);
	const p95 = numeric(d.p95);
	// The human-facing string follows the user's number-format setting
	// (auto/compact/newspaper/scientific) — see formatNumber.
	const tfmt = (n: number) => formatNumber(scaled(n, pinned), fmt);
	const fp5 = tfmt(d.p5);
	const fp50 = tfmt(d.p50);
	const fp95 = tfmt(d.p95);
	const text = sym
		? `${formatMoney(scaled(d.p50, pinned), sym)} (${formatMoney(scaled(d.p5, pinned), sym)} … ${formatMoney(scaled(d.p95, pinned), sym)})`
		: `${fp50} (${fp5} … ${fp95})${suffix}`;
	// Per-stat figures for the inspector, in the display unit. Percentiles, mean,
	// min and max are absolute values, so they go through the full scaling
	// (including any affine offset / log). Std dev is a *spread*, so it scales by
	// the factor only — never the offset — and isn't meaningful under a log unit,
	// where we leave it in base units.
	const fmtSpread = (n: number) => formatNumber(pinned?.log ? n : n / (pinned?.factor ?? 1), fmt);
	const stats = [
		{ label: 'mean', value: tfmt(d.mean) },
		{ label: 'std dev', value: fmtSpread(d.sd) },
		{ label: 'min', value: tfmt(d.min) },
		{ label: 'p5', value: fp5 },
		{ label: 'p25', value: tfmt(d.p25) },
		{ label: 'median', value: fp50 },
		{ label: 'p75', value: tfmt(d.p75) },
		{ label: 'p95', value: fp95 },
		{ label: 'max', value: tfmt(d.max) }
	];
	return {
		kind: 'dist',
		unit,
		p5,
		p50,
		p95,
		stats,
		text,
		level
	};
}
