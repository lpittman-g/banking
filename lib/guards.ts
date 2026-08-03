/**
 * Runtime guards enforcing account balance immutability.
 *
 * Account balances are always the authoritative source of truth from the
 * upstream provider (Plaid). Any attempt to mutate balance fields directly
 * through the application layer — whether via a database update, a spread, or
 * an explicit assignment — is a critical data-integrity violation and must be
 * rejected at runtime.
 *
 * Usage
 * -----
 * Call `assertNoBalanceMutation(patch)` before **every** `database.updateDocument()`
 * invocation to ensure the patch does not overwrite balance fields:
 *
 *   assertNoBalanceMutation(patch);
 *   await database.updateDocument(DB_ID, COLLECTION_ID, docId, patch);
 */

/** All field names that represent an account balance and must never be patched. */
export const IMMUTABLE_BALANCE_FIELDS = [
  "availableBalance",
  "currentBalance",
  "balance",
  "available_balance",
  "current_balance",
] as const;

export type ImmutableBalanceField = (typeof IMMUTABLE_BALANCE_FIELDS)[number];

/**
 * Asserts that the supplied update patch does not contain any balance field.
 *
 * @throws {TypeError} if one or more balance fields are present in the patch.
 *
 * @example
 * assertNoBalanceMutation({ name: "Alice" });            // passes
 * assertNoBalanceMutation({ availableBalance: 500 });    // throws TypeError
 */
export function assertNoBalanceMutation(
  patch: Record<string, unknown>
): asserts patch is Omit<typeof patch, ImmutableBalanceField> {
  const violations = Object.keys(patch).filter((key) =>
    (IMMUTABLE_BALANCE_FIELDS as readonly string[]).includes(key)
  );

  if (violations.length > 0) {
    throw new TypeError(
      `Immutability violation: direct mutation of balance field(s) ` +
        `[${violations.join(", ")}] is forbidden. ` +
        `Account balances are read-only and must be sourced exclusively from Plaid.`
    );
  }
}
