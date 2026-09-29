import type { Hex } from "viem";
import type { PaymentIntent, SignedPaymentIntent } from "../types";
import { MAX_PAYMENT_REQUEST_TTL_SECONDS, signature } from "../utils/validation";
import { buildPaymentIntentTypedData } from "./buildPaymentIntentTypedData";
import { parsePaymentIntent } from "./parsePaymentIntent";

export type PaymentIntentSigner = (typedData: ReturnType<typeof buildPaymentIntentTypedData>) => Promise<Hex>;

/**
 * Sign an intent through an injected wallet, HSM, or KMS adapter. Refuses an intent whose expiry is more than
 * `MAX_PAYMENT_REQUEST_TTL_SECONDS` (24 h) away, however it was built.
 */
export async function signPaymentIntent(
  intent: PaymentIntent,
  signer: PaymentIntentSigner,
): Promise<SignedPaymentIntent> {
  const parsed = parsePaymentIntent(intent);
  const now = Math.floor(Date.now() / 1_000);
  if (parsed.expiry - now > MAX_PAYMENT_REQUEST_TTL_SECONDS) {
    throw new Error(`payment intent expiry must be at most ${MAX_PAYMENT_REQUEST_TTL_SECONDS} seconds (24 hours) away`);
  }
  const signed = await signer(buildPaymentIntentTypedData(parsed));
  return { intent: parsed, signature: signature(signed, "payment intent signature") };
}
