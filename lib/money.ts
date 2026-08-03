/**
 * Money utilities enforcing DECIMAL(18, 4) precision for all currency amounts.
 *
 * IEEE 754 floating-point arithmetic is unsuitable for financial calculations.
 * All currency values are represented as DECIMAL(18, 4) strings — 14 digits
 * before the decimal point, exactly 4 digits after — matching the SQL
 * DECIMAL(18, 4) column type mandated for every balance and amount field.
 *
 * Rules:
 *  - Integer part: at most 14 significant digits
 *  - Fractional part: exactly 4 decimal places (padded / truncation is rejected)
 *  - Float inputs are accepted only when they can be losslessly represented as
 *    a DECIMAL(18, 4) string; otherwise an error is thrown.
 */

const DECIMAL_PLACES = 4;
const MAX_INTEGER_DIGITS = 14; // DECIMAL(18, 4) allows 14 digits before decimal

/**
 * Normalises a currency value to a DECIMAL(18, 4) string.
 *
 * @throws {RangeError} if the value exceeds 14 integer digits.
 * @throws {RangeError} if the value carries more than 4 decimal places.
 * @throws {TypeError} if the value is not a valid numeric string or number.
 *
 * @example
 * parseMoney("12.5")      // → "12.5000"
 * parseMoney(100)         // → "100.0000"
 * parseMoney("100.12345") // throws RangeError
 */
export function parseMoney(value: string | number): string {
  const raw =
    typeof value === "number"
      ? // Convert via string to avoid implicit scientific notation for large values
        value.toLocaleString("fullwide", {
          useGrouping: false,
          maximumFractionDigits: 20,
        })
      : value.trim();

  if (!/^-?\d+(\.\d+)?$/.test(raw)) {
    throw new TypeError(`Invalid money value: "${raw}"`);
  }

  const [integerPart, fractionalPart = ""] = raw.split(".");

  // Strip leading minus for digit-count check
  const absInteger = integerPart.replace(/^-/, "");
  if (absInteger.length > MAX_INTEGER_DIGITS) {
    throw new RangeError(
      `Money value exceeds DECIMAL(18, 4) integer precision (max ${MAX_INTEGER_DIGITS} digits): "${raw}"`
    );
  }

  if (fractionalPart.length > DECIMAL_PLACES) {
    throw new RangeError(
      `Money value has more than ${DECIMAL_PLACES} decimal places: "${raw}". ` +
        `All currency fields must use DECIMAL(18, 4) precision.`
    );
  }

  const padded = fractionalPart.padEnd(DECIMAL_PLACES, "0");
  return `${integerPart}.${padded}`;
}

/**
 * Converts a DECIMAL(18, 4) string back to a JavaScript number.
 * Use for display / arithmetic comparisons only — never for storage.
 */
export function moneyToNumber(value: string): number {
  return parseFloat(parseMoney(value));
}

/**
 * Returns true when the value is a well-formed DECIMAL(18, 4) money string.
 */
export function isValidMoney(value: unknown): value is string {
  if (typeof value !== "string" && typeof value !== "number") return false;
  try {
    parseMoney(value as string | number);
    return true;
  } catch {
    return false;
  }
}
