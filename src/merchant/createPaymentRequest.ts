import type { Address } from "viem";
import { parsePaymentIntent } from "../intent/parsePaymentIntent";
import type { PaymentIntent } from "../types";
import { DEFAULT_PAYMENT_REQUEST_TTL_SECONDS, paymentRequestTtlSeconds } from "../utils/validation";
import { derivePaymentNote } from "./internal/derivePaymentNote";
import { type RecipientParameters, resolveRecipient } from "./internal/resolveRecipient";

export type BuildPaymentRequestParameters = RecipientParameters & {
  amount: bigint;
  token: Address;
  chainId: number;
  merchantOrigin: string;
  checkoutCompletePath?: string;
  /** Request lifetime: a positive safe integer of at most 86400 (24 h). */
  ttlSeconds: number;
};

export type CreatePaymentRequestParameters = RecipientParameters & {
  amount: bigint;
  token: Address;
  chainId: number;
  merchantOrigin: string;
  checkoutCompletePath?: string;
  /** Request lifetime: a positive safe integer of at most 86400 (24 h). Default 600. */
  ttlSeconds?: number;
};

export async function buildPaymentRequest(parameters: BuildPaymentRequestParameters): Promise<PaymentIntent> {
  const recipient = resolveRecipient(parameters);
  if (parameters.amount <= 0n) throw new Error("amount must be greater than zero");
  const ttlSeconds = paymentRequestTtlSeconds(parameters.ttlSeconds);
  const now = Math.floor(Date.now() / 1_000);
  const expiry = now + ttlSeconds;
  if (!Number.isSafeInteger(expiry)) throw new Error("payment request expiry exceeds the safe integer range");

  const note = await derivePaymentNote(recipient);
  return parsePaymentIntent({
    token: parameters.token,
    amount: parameters.amount.toString(),
    chainId: parameters.chainId,
    ownerHash: note.ownerHash.toString(),
    ephemeralKeyX: note.ephemeralKey[0].toString(),
    ephemeralKeyY: note.ephemeralKey[1].toString(),
    viewTag: note.viewTag,
    merchantOrigin: parameters.merchantOrigin,
    ...(parameters.checkoutCompletePath === undefined ? {} : { checkoutCompletePath: parameters.checkoutCompletePath }),
    expiry,
  });
}

export async function createPaymentRequest(parameters: CreatePaymentRequestParameters): Promise<PaymentIntent> {
  return buildPaymentRequest({
    ...parameters,
    ttlSeconds: parameters.ttlSeconds ?? DEFAULT_PAYMENT_REQUEST_TTL_SECONDS,
  });
}
