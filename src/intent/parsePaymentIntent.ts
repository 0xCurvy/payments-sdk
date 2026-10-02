import type { Address } from "viem";
import type { PaymentIntent } from "../types";
import {
  address,
  BN254_BASE_FIELD,
  BN254_SCALAR_FIELD,
  boundedDecimal,
  checkoutCompletePath,
  merchantOrigin,
  paymentDescription,
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

const OPTIONAL_PAYMENT_INTENT_KEYS = ["checkoutCompletePath", "description", "tokens"] as const;

/** A shop takes a handful of stablecoins at most; a longer list is not a payment request. */
const MAX_PAYMENT_TOKENS = 8;

/** Every token a payment may be made in: `token` first, each once, more than one (one is just `token`). */
function paymentTokens(value: unknown, token: Address): Address[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > MAX_PAYMENT_TOKENS) {
    throw new Error(`intent.tokens must list 2 to ${MAX_PAYMENT_TOKENS} tokens`);
  }
  const tokens = value.map((entry, index) => address(entry, `intent.tokens[${index}]`));
  if (tokens[0] !== token) throw new Error("intent.tokens must start with intent.token");
  if (new Set(tokens).size !== tokens.length) throw new Error("intent.tokens must not list a token twice");
  return tokens;
}

/**
 * Parse and canonicalize an untrusted payment intent. Unknown fields are rejected.
 * Numeric fields are range-checked against what the protocol can use: `amount` is a
 * non-zero `uint256`, `ownerHash` is a non-zero BN254 scalar-field element (a Poseidon
 * output), and `ephemeralKeyX/Y` are BN254 base-field coordinates (R is a BN254 G1 point).
 */
export function parsePaymentIntent(value: unknown): PaymentIntent {
  const input = record(value, "intent");
  requiredAndOptionalKeys(input, REQUIRED_PAYMENT_INTENT_KEYS, OPTIONAL_PAYMENT_INTENT_KEYS, "intent");
  const amount = boundedDecimal(input.amount, "intent.amount", 1n, UINT256_LIMIT);
  const token = address(input.token, "intent.token");
  return {
    token,
    amount,
    chainId: positiveSafeInteger(input.chainId, "intent.chainId"),
    ownerHash: boundedDecimal(input.ownerHash, "intent.ownerHash", 1n, BN254_SCALAR_FIELD),
    ephemeralKeyX: boundedDecimal(input.ephemeralKeyX, "intent.ephemeralKeyX", 0n, BN254_BASE_FIELD),
    ephemeralKeyY: boundedDecimal(input.ephemeralKeyY, "intent.ephemeralKeyY", 0n, BN254_BASE_FIELD),
    viewTag: viewTag(input.viewTag, "intent.viewTag"),
    merchantOrigin: merchantOrigin(input.merchantOrigin, "intent.merchantOrigin"),
    checkoutCompletePath: checkoutCompletePath(input.checkoutCompletePath, "intent.checkoutCompletePath"),
    expiry: positiveSafeInteger(input.expiry, "intent.expiry"),
    ...(input.description === undefined
      ? {}
      : { description: paymentDescription(input.description, "intent.description") }),
    ...(input.tokens === undefined ? {} : { tokens: paymentTokens(input.tokens, token) }),
  };
}

/** Every token a payment may be made in: `intent.tokens` when the shop takes more than one, else `intent.token`. */
export function acceptedTokens(intent: Pick<PaymentIntent, "token" | "tokens">): Address[] {
  return intent.tokens ?? [intent.token];
}
