/**
 * Money as integer minor units (ADR-010, CLAUDE.md §20).
 *
 * No floating point anywhere. Every amount carries its currency; operations between
 * different currencies throw rather than coerce. The LLM may explain a quote but never
 * computes one — these functions are the only arithmetic in the commercial layer.
 */

export type CurrencyCode = 'USD' | 'EUR' | 'GBP' | 'CHF' | 'AED';

export interface Money {
  /** Integer minor units (cents). May be negative for credits. */
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
}

const MINOR_UNIT_EXPONENT: Record<CurrencyCode, number> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  CHF: 2,
  AED: 2,
};

export const SUPPORTED_CURRENCIES = Object.freeze(
  Object.keys(MINOR_UNIT_EXPONENT) as CurrencyCode[],
);

export function isCurrencyCode(value: string): value is CurrencyCode {
  return Object.prototype.hasOwnProperty.call(MINOR_UNIT_EXPONENT, value);
}

export function money(amountMinor: number, currency: CurrencyCode): Money {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new RangeError(`Money amount must be a safe integer of minor units: ${amountMinor}`);
  }
  return { amountMinor, currency };
}

export function zero(currency: CurrencyCode): Money {
  return { amountMinor: 0, currency };
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new TypeError(`Cannot combine ${a.currency} with ${b.currency}`);
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor + b.amountMinor, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor - b.amountMinor, a.currency);
}

export function sum(amounts: readonly Money[], currency: CurrencyCode): Money {
  return amounts.reduce<Money>((total, next) => add(total, next), zero(currency));
}

/** Multiplies by a whole quantity (2 cars, 9 rooms). Exact by construction. */
export function multiplyByQuantity(value: Money, quantity: number): Money {
  if (!Number.isSafeInteger(quantity) || quantity < 0) {
    throw new RangeError(`Quantity must be a non-negative integer: ${quantity}`);
  }
  return money(value.amountMinor * quantity, value.currency);
}

export type RoundingMode = 'half-up' | 'half-even' | 'up' | 'down';

/**
 * Applies a rate expressed in basis points (1 bp = 0.01%). Surcharges, after-hours
 * uplifts and the platform fee are all stored as basis points so no decimal rate is ever
 * multiplied into a float.
 */
export function applyBasisPoints(
  value: Money,
  basisPoints: number,
  rounding: RoundingMode = 'half-up',
): Money {
  if (!Number.isSafeInteger(basisPoints)) {
    throw new RangeError(`Basis points must be an integer: ${basisPoints}`);
  }
  return money(divideRounded(value.amountMinor * basisPoints, 10_000, rounding), value.currency);
}

/** Integer division with an explicit rounding rule. Never produces a float. */
export function divideRounded(numerator: number, denominator: number, mode: RoundingMode): number {
  if (denominator === 0) throw new RangeError('Division by zero');
  const negative = numerator < 0 !== denominator < 0;
  const absNumerator = Math.abs(numerator);
  const absDenominator = Math.abs(denominator);

  const quotient = Math.floor(absNumerator / absDenominator);
  const remainder = absNumerator - quotient * absDenominator;

  let magnitude = quotient;
  if (remainder !== 0) {
    switch (mode) {
      case 'up':
        magnitude = quotient + 1;
        break;
      case 'down':
        magnitude = quotient;
        break;
      case 'half-up':
        magnitude = remainder * 2 >= absDenominator ? quotient + 1 : quotient;
        break;
      case 'half-even': {
        const twice = remainder * 2;
        if (twice > absDenominator) magnitude = quotient + 1;
        else if (twice < absDenominator) magnitude = quotient;
        else magnitude = quotient % 2 === 0 ? quotient : quotient + 1;
        break;
      }
    }
  }

  return negative ? -magnitude : magnitude;
}

/** Enforces a contractual minimum charge. */
export function atLeast(value: Money, minimum: Money): Money {
  assertSameCurrency(value, minimum);
  return value.amountMinor >= minimum.amountMinor ? value : minimum;
}

export function compare(a: Money, b: Money): number {
  assertSameCurrency(a, b);
  return a.amountMinor - b.amountMinor;
}

export function isZero(value: Money): boolean {
  return value.amountMinor === 0;
}

/** `$1,250.00` — fixed `en-US` locale so server and client renders are identical. */
export function formatMoney(value: Money): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: value.currency,
    minimumFractionDigits: MINOR_UNIT_EXPONENT[value.currency],
    maximumFractionDigits: MINOR_UNIT_EXPONENT[value.currency],
  }).format(value.amountMinor / 10 ** MINOR_UNIT_EXPONENT[value.currency]);
}

/** Parses `"1250.00"` / `"1,250"` into minor units. Rejects anything else. */
export function parseMajorUnits(input: string, currency: CurrencyCode): Money {
  const cleaned = input.trim().replace(/[,\s]/g, '');
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(cleaned);
  if (!match) throw new RangeError(`Not a valid monetary amount: ${input}`);

  const [, sign, whole, fraction = ''] = match;
  if (whole === undefined) throw new RangeError(`Not a valid monetary amount: ${input}`);

  const exponent = MINOR_UNIT_EXPONENT[currency];
  if (fraction.length > exponent) {
    throw new RangeError(`${currency} supports at most ${exponent} decimal places: ${input}`);
  }

  const padded = fraction.padEnd(exponent, '0');
  const minor = Number(whole) * 10 ** exponent + (padded === '' ? 0 : Number(padded));
  return money(sign === '-' ? -minor : minor, currency);
}
