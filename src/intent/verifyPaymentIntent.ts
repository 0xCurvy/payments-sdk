import type { Address } from "viem";
import { isAddressEqual, recoverTypedDataAddress } from "viem/utils";
import { parseMerchantKeySet } from "../merchant/keys/parseMerchantKeySet";
import type { MerchantKeySet, PaymentIntent, SignedPaymentIntent } from "../types";
import { buildPaymentIntentTypedData } from "./buildPaymentIntentTypedData";
import { parseSignedPaymentIntent } from "./parseSignedPaymentIntent";

export interface VerifyPaymentIntentParameters {
  keySet: MerchantKeySet | unknown;
  expectedChainId: number;
  expectedToken: Address;
  nowSeconds?: number;
}

export interface VerifiedPaymentIntent {
  intent: PaymentIntent;
  signer: Address;
}

/** Verify the signature, active signer membership, expiry, chain, and currency. */
export async function verifyPaymentIntent(
  payment: SignedPaymentIntent | unknown,
  parameters: VerifyPaymentIntentParameters,
): Promise<VerifiedPaymentIntent> {
  const parsed = parseSignedPaymentIntent(payment);
  const keySet = parseMerchantKeySet(parameters.keySet);
  const now = parameters.nowSeconds ?? Math.floor(Date.now() / 1_000);
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("nowSeconds must be a non-negative safe integer");
  if (parsed.intent.chainId !== parameters.expectedChainId) {
    throw new Error(`wrong chainId: expected ${parameters.expectedChainId}`);
  }
  if (!isAddressEqual(parsed.intent.token, parameters.expectedToken)) {
    throw new Error(`wrong token: expected ${parameters.expectedToken}`);
  }
  if (now >= parsed.intent.expiry) throw new Error("payment intent has expired");

  const signer = await recoverTypedDataAddress({
    ...buildPaymentIntentTypedData(parsed.intent),
    signature: parsed.signature,
  });
  const published = keySet.signers.find((candidate) => isAddressEqual(candidate.address, signer));
  if (!published) throw new Error(`unknown payment intent signer ${signer}`);
  if (now * 1_000 >= Date.parse(published.notAfter)) throw new Error(`payment intent signer ${signer} has expired`);
  return { intent: parsed.intent, signer };
}
