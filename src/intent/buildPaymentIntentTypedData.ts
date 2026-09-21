import type { PaymentIntent } from "../types";

/** Canonical EIP-712 field definition for a Curvy payment intent. */
export const paymentIntentTypes = {
  PaymentIntent: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "chainId", type: "uint256" },
    { name: "ownerHash", type: "uint256" },
    { name: "ephemeralKeyX", type: "uint256" },
    { name: "ephemeralKeyY", type: "uint256" },
    { name: "viewTag", type: "uint16" },
    { name: "merchantOrigin", type: "string" },
    { name: "checkoutCompletePath", type: "string" },
    { name: "expiry", type: "uint64" },
  ],
} as const;

/** Build the canonical EIP-712 payload for a payment intent. */
export function buildPaymentIntentTypedData(intent: PaymentIntent) {
  return {
    domain: {
      name: "Curvy Payments",
      version: "1",
      chainId: intent.chainId,
    },
    types: paymentIntentTypes,
    primaryType: "PaymentIntent" as const,
    message: {
      token: intent.token,
      amount: BigInt(intent.amount),
      chainId: BigInt(intent.chainId),
      ownerHash: BigInt(intent.ownerHash),
      ephemeralKeyX: BigInt(intent.ephemeralKeyX),
      ephemeralKeyY: BigInt(intent.ephemeralKeyY),
      viewTag: intent.viewTag,
      merchantOrigin: intent.merchantOrigin,
      checkoutCompletePath: intent.checkoutCompletePath,
      expiry: BigInt(intent.expiry),
    },
  } as const;
}
