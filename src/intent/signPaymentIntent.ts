import type { Hex } from "viem";
import type { PaymentIntent, SignedPaymentIntent } from "../types";
import { signature } from "../utils/validation";
import { buildPaymentIntentTypedData } from "./buildPaymentIntentTypedData";
import { parsePaymentIntent } from "./parsePaymentIntent";

export type PaymentIntentSigner = (typedData: ReturnType<typeof buildPaymentIntentTypedData>) => Promise<Hex>;

/** Sign an intent through an injected wallet, HSM, or KMS adapter. */
export async function signPaymentIntent(
  intent: PaymentIntent,
  signer: PaymentIntentSigner,
): Promise<SignedPaymentIntent> {
  const parsed = parsePaymentIntent(intent);
  const signed = await signer(buildPaymentIntentTypedData(parsed));
  return { intent: parsed, signature: signature(signed, "payment intent signature") };
}
