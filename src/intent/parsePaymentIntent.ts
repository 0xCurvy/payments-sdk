import type { PaymentIntent } from "../types";
import {
  address,
  checkoutCompletePath,
  decimal,
  merchantOrigin,
  record,
  requiredAndOptionalKeys,
  safeInteger,
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

/** Parse and canonicalize an untrusted payment intent. Unknown fields are rejected. */
export function parsePaymentIntent(value: unknown): PaymentIntent {
  const input = record(value, "intent");
  requiredAndOptionalKeys(input, REQUIRED_PAYMENT_INTENT_KEYS, OPTIONAL_PAYMENT_INTENT_KEYS, "intent");
  const viewTag = safeInteger(input.viewTag, "intent.viewTag");
  if (viewTag > 65_535) throw new Error("intent.viewTag must fit uint16");
  return {
    token: address(input.token, "intent.token"),
    amount: decimal(input.amount, "intent.amount"),
    chainId: safeInteger(input.chainId, "intent.chainId"),
    ownerHash: decimal(input.ownerHash, "intent.ownerHash"),
    ephemeralKeyX: decimal(input.ephemeralKeyX, "intent.ephemeralKeyX"),
    ephemeralKeyY: decimal(input.ephemeralKeyY, "intent.ephemeralKeyY"),
    viewTag,
    merchantOrigin: merchantOrigin(input.merchantOrigin, "intent.merchantOrigin"),
    checkoutCompletePath: checkoutCompletePath(input.checkoutCompletePath, "intent.checkoutCompletePath"),
    expiry: safeInteger(input.expiry, "intent.expiry"),
  };
}
