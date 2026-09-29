import type { PaymentIntent } from "../types";
import {
  address,
  BN254_BASE_FIELD,
  BN254_SCALAR_FIELD,
  boundedDecimal,
  checkoutCompletePath,
  merchantOrigin,
  positiveSafeInteger,
  record,
  requiredAndOptionalKeys,
  UINT256_LIMIT,
  viewTag,
} from "../utils/validation";

const REQUIRED_PAYMENT_INTENT_KEYS = [
  "token",
  "amount",
  "chainId",
  "ownerHash",
  "ephemeralKeyX",
  "ephemeralKeyY",
  "viewTag",
  "merchantOrigin",
  "expiry",
] as const;

const OPTIONAL_PAYMENT_INTENT_KEYS = ["checkoutCompletePath"] as const;

/**
 * Parse and canonicalize an untrusted payment intent. Unknown fields are rejected.
 * Numeric fields are range-checked against what the protocol can use: `amount` is a
 * non-zero `uint256`, `ownerHash` is a non-zero BN254 scalar-field element (a Poseidon
 * output), and `ephemeralKeyX/Y` are BN254 base-field coordinates (R is a BN254 G1 point).
 */
export function parsePaymentIntent(value: unknown): PaymentIntent {
  const input = record(value, "intent");
  requiredAndOptionalKeys(input, REQUIRED_PAYMENT_INTENT_KEYS, OPTIONAL_PAYMENT_INTENT_KEYS, "intent");
  return {
    token: address(input.token, "intent.token"),
    amount: boundedDecimal(input.amount, "intent.amount", 1n, UINT256_LIMIT),
    chainId: positiveSafeInteger(input.chainId, "intent.chainId"),
    ownerHash: boundedDecimal(input.ownerHash, "intent.ownerHash", 1n, BN254_SCALAR_FIELD),
    ephemeralKeyX: boundedDecimal(input.ephemeralKeyX, "intent.ephemeralKeyX", 0n, BN254_BASE_FIELD),
    ephemeralKeyY: boundedDecimal(input.ephemeralKeyY, "intent.ephemeralKeyY", 0n, BN254_BASE_FIELD),
    viewTag: viewTag(input.viewTag, "intent.viewTag"),
    merchantOrigin: merchantOrigin(input.merchantOrigin, "intent.merchantOrigin"),
    checkoutCompletePath: checkoutCompletePath(input.checkoutCompletePath, "intent.checkoutCompletePath"),
    expiry: positiveSafeInteger(input.expiry, "intent.expiry"),
  };
}
