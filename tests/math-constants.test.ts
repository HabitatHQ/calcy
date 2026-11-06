import { describe, expect, it } from 'vitest';
import { num, one } from './helpers';

// Usability fix #3 — built-in math constants and trig functions. `pi`, `tau`,
// `e` are dimensionless catalogue constants; `sin/cos/tan` (and inverses) take a
// dimensionless (radian) argument. This unblocks geometry, AC and resonance
// formulas that every calculator is expected to handle.

describe('math constants', () => {
  it('pi and π', () => {
    expect(num('pi')).toBeCloseTo(Math.PI, 10);
    expect(num('π')).toBeCloseTo(Math.PI, 10);
    expect(num('2 * pi')).toBeCloseTo(2 * Math.PI, 10);
    expect(num('2 pi')).toBeCloseTo(2 * Math.PI, 10); // juxtaposition
  });

  it('tau is 2π', () => {
    expect(num('tau')).toBeCloseTo(2 * Math.PI, 10);
  });

  it('e is Euler’s number', () => {
    expect(num('e')).toBeCloseTo(Math.E, 10);
  });

  it('does not consume Euler constants as incomplete exponents', () => {
    expect(num('2e')).toBeCloseTo(2 * Math.E, 10);
    expect(num('2e+x where x = 3')).toBeCloseTo(2 * Math.E + 3, 10);
    expect(num('2e-x where x = 3')).toBeCloseTo(2 * Math.E - 3, 10);
    expect(num('2e3')).toBe(2000);
  });

  it.each([
    ['-2^2', -4],
    ['(-2)^2', 4],
    ['-4^0.5', -2],
    ['2^-2', 0.25],
    ['2^3^2', 512],
    ['-3²', -9]
  ] as const)('respects sign and exponent precedence in %s', (source, expected) => {
    expect(num(source)).toBeCloseTo(expected, 10);
  });

  it('a real resonance formula now parses', () => {
    // f = 1 / (2π√(LC)); 100 µH, 100 nF → ~50.3 kHz
    expect(num('1 / (2 * pi * sqrt(100 uH * 100 nF)) in kHz')).toBeCloseTo(50.329, 2);
  });
});

describe('trig functions (radians)', () => {
  it('sin/cos/tan', () => {
    expect(num('sin(0)')).toBeCloseTo(0, 10);
    expect(num('sin(pi / 2)')).toBeCloseTo(1, 10);
    expect(num('cos(0)')).toBeCloseTo(1, 10);
    expect(num('cos(pi)')).toBeCloseTo(-1, 10);
    expect(num('tan(0)')).toBeCloseTo(0, 10);
  });

  it('degrees convert through the angle unit', () => {
    // `deg` is a dimensionless angle (π/180), so 90 deg is π/2 radians.
    expect(num('sin(90 deg)')).toBeCloseTo(1, 10);
  });

  it('inverse trig returns radians', () => {
    expect(num('asin(1)')).toBeCloseTo(Math.PI / 2, 10);
    expect(num('atan(1)')).toBeCloseTo(Math.PI / 4, 10);
  });

  it('a dimensioned trig argument is rejected', () => {
    expect(one('sin(5 m)').error).toBeTruthy();
  });
});
