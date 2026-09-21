import type { SignedPaymentIntent } from "../types";
import { exactKeys, record, signature } from "../utils/validation";
import { parsePaymentIntent } from "./parsePaymentIntent";

/** Parse an untrusted signed payment package. */
export function parseSignedPaymentIntent(value: unknown): SignedPaymentIntent {
  const input = record(value, "payment package");
  exactKeys(input, ["intent", "signature"], "payment package");
  return {
    intent: parsePaymentIntent(input.intent),
    signature: signature(input.signature, "payment package.signature"),
  };
}
