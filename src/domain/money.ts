/** Monetary values are exact integer centavos. No IEEE-754 decimal arithmetic. */
export type Cents = number & { readonly __currencyCents: unique symbol };

// Intentionally below Number.MAX_SAFE_INTEGER and SQLite's signed 64-bit max.
export const MAX_CENTS = 9_000_000_000_000;

/** Strict decimal input for an API: e.g. "0", "125", "125.90". Never a JS float. */
export function parseCents(decimal: string): Cents {
  if (typeof decimal !== 'string' || !/^(?:0|[1-9]\d{0,10})(?:\.\d{1,2})?$/.test(decimal)) {
    throw new RangeError('Amount must be a nonnegative decimal with at most two places');
  }
  const [whole, fraction = ''] = decimal.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents > MAX_CENTS) {
    throw new RangeError('Amount exceeds supported financial range');
  }
  return cents as Cents;
}

export function assertCents(value: number): asserts value is Cents {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_CENTS) {
    throw new RangeError('Amount must be a nonnegative safe integer in centavos');
  }
}

export function asDecimal(cents: Cents): string {
  assertCents(cents);
  const whole = Math.floor(cents / 100);
  const fraction = (cents % 100).toString().padStart(2, '0');
  return `${whole}.${fraction}`;
}
