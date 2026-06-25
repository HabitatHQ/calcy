import { describe, expect, it } from 'vitest';
import { one, values } from './helpers';

// Calculations stay in canonical base units, but the *display* carries the unit
// the user actually typed (issue #1). `two days to four days` should read in
// days, not 244K seconds; `120 km/h` should stay km/h, not 33.3 m/s. When the
// units interact in a way that cancels a dimension (rate × time → count), there
// is no clean typed unit to carry, so we fall back to the base unit.
const AUTO = { numberFormat: 'auto' as const };
const unit = (t: string, opts = {}) => one(t, { ...AUTO, ...opts }).display?.unit;
const txt = (t: string, opts = {}) => one(t, { ...AUTO, ...opts }).display?.text;

describe('display unit follows the unit you typed', () => {
	it('a bare time range stays in days, not seconds', () => {
		// label echoes the unit as typed (plural "days" here), never seconds
		expect(unit('two days to four days')).toBe('days');
		expect(txt('two days to four days')).toMatch(/ days?$/);
	});

	it('±/about forms keep their unit', () => {
		expect(unit('3 ± 1 day')).toBe('day');
		expect(unit('about 5 days')).toBe('days');
	});

	it('a speed stays in km/h', () => {
		expect(unit('120 km/h')).toBe('km/h');
		expect(txt('120 km/h')).toBe('120 km/h');
	});

	it('a single dimensioned value keeps its unit', () => {
		expect(unit('5 km')).toBe('km');
		expect(txt('5 km')).toBe('5 km');
	});

	it('mixed length units take the left operand', () => {
		// 5 km + 3 mi = 9.83 km (not 9.83K m)
		expect(unit('5 km + 3 mi')).toBe('km');
		expect(txt('5 km + 3 mi')).toBe('9.83 km');
	});

	it('a data rate stays in GB/s', () => {
		expect(unit('2 GB / 30 s')).toBe('GB/s');
	});

	it('sum(above) inherits the inputs’ unit', () => {
		const ls = values('a = 2 day\nb = 3 day\nsum(above) in day', AUTO).filter(
			(l) => l.kind === 'value'
		);
		// even without the explicit `in day`, a bare sum should read in days
		const bare = values('a = 2 day\nb = 3 day\nsum(above)', AUTO).filter((l) => l.kind === 'value');
		expect(bare[2].display?.unit).toBe('day');
		expect(ls[2].display?.unit).toBe('day');
	});

	it('does not invent a unit when a dimension cancels', () => {
		// req/s × day → req (a count); show the base count, never "req/s day".
		const ls = values('rate = 12000 req/s\nrate * 30 day', AUTO).filter((l) => l.kind === 'value');
		expect(ls[1].display?.unit).toBe('req');
	});

	it('count rates already read naturally (regression)', () => {
		expect(unit('12000 req/s')).toBe('req/s');
	});

	it('plain numbers carry no unit', () => {
		expect(unit('5 + 3')).toBe('');
	});

	it('explicit in/to conversion still wins', () => {
		expect(unit('5 km in mi')).toBe('mi');
	});

	it('inspector stats are formatted and scaled, not raw floats', () => {
		// Regression: the distribution panel showed median/p5/p95 as full-precision
		// base-unit floats (e.g. "2.8374996102079937 day"). They must be formatted
		// and in the displayed unit (days, not seconds).
		const d = one('two days to four days', AUTO).display;
		const median = d?.stats?.find((s) => s.label === 'median')?.value;
		expect(median, 'median stat present').toBeDefined();
		expect(median ?? '', 'no full-precision float').not.toMatch(/\d\.\d{5,}/);
		expect(Number(median)).toBeGreaterThan(2);
		expect(Number(median)).toBeLessThan(4); // days, not ~244000 seconds
	});
});
