import type { TypedData, TypedDataDomain } from "viem";
import type { PaymentIntent } from "../types";

/**
 * The EIP-712 payload a checkout signer signs: a plain `PaymentIntent`, a `DescribedPaymentIntent` when the intent
 * carries a description, or a `MultiTokenPaymentIntent` when it takes more than one token. Typed loosely so one signer
 * adapter (viem, ethers, a wallet, a KMS) handles all three.
 */
export interface PaymentIntentTypedData {
  domain: TypedDataDomain;
  types: TypedData;
  primaryType: "PaymentIntent" | "DescribedPaymentIntent" | "MultiTokenPaymentIntent";
  message: Record<string, unknown>;
}

const paymentIntentFields = [
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
] as const;

/** Canonical EIP-712 field definition for a Curvy payment intent. */
export const paymentIntentTypes = { PaymentIntent: paymentIntentFields } as const;

/**
 * A payment intent that carries the shop's description. It is signed as its own type, so a signature over one can't
 * be passed off as the other: a description can't be added to a signed intent, or removed from one.
 */
export const describedPaymentIntentTypes = {
  DescribedPaymentIntent: [...paymentIntentFields, { name: "description", type: "string" }],
} as const;

/**
 * A payment intent the shop takes in more than one token (`tokens`, `token` first). Its own type, so a token can be
 * neither added to a signed intent nor the list stripped from one. `description` is always present here (empty when
 * the intent has none).
 */
export const multiTokenPaymentIntentTypes = {
  MultiTokenPaymentIntent: [
    ...paymentIntentFields,
    { name: "description", type: "string" },
    { name: "tokens", type: "address[]" },
  ],
} as const;

/** Build the canonical EIP-712 payload for a payment intent. */
export function buildPaymentIntentTypedData(intent: PaymentIntent): PaymentIntentTypedData {
  const domain = { name: "Curvy Payments", version: "1", chainId: intent.chainId } as const;

  const message = {
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
  };

  if (intent.tokens !== undefined) {
    return {
      domain,
      types: multiTokenPaymentIntentTypes,
      primaryType: "MultiTokenPaymentIntent",
      message: { ...message, description: intent.description ?? "", tokens: intent.tokens },
    };
  }

  if (intent.description === undefined) {
    return { domain, types: paymentIntentTypes, primaryType: "PaymentIntent", message };
  }

  return {
    domain,
    types: describedPaymentIntentTypes,
    primaryType: "DescribedPaymentIntent",
    message: { ...message, description: intent.description },
  };
}
