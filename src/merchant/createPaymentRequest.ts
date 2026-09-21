import type { Address } from "viem";
import { parsePaymentIntent } from "../intent/parsePaymentIntent";
import type { PaymentIntent, PaymentRecipient } from "../types";
import { DEFAULT_PAYMENT_REQUEST_TTL_SECONDS } from "../utils/validation";
import { derivePaymentNote } from "./internal/derivePaymentNote";

export interface BuildPaymentRequestParameters {
  recipient: PaymentRecipient;
  amount: bigint;
  token: Address;
  chainId: number;
  merchantOrigin: string;
  checkoutCompletePath?: string;
  ttlSeconds: number;
}

export interface CreatePaymentRequestParameters {
  recipient: PaymentRecipient;
  amount: bigint;
  token: Address;
  chainId: number;
  merchantOrigin: string;
  checkoutCompletePath?: string;
  ttlSeconds?: number;
}

export async function buildPaymentRequest(parameters: BuildPaymentRequestParameters): Promise<PaymentIntent> {
  if (parameters.amount <= 0n) throw new Error("amount must be greater than zero");
  if (!Number.isSafeInteger(parameters.ttlSeconds) || parameters.ttlSeconds <= 0) {
    throw new Error("ttlSeconds must be a positive safe integer");
  }
  const now = Math.floor(Date.now() / 1_000);
  const expiry = now + parameters.ttlSeconds;
  if (!Number.isSafeInteger(expiry)) throw new Error("payment request expiry exceeds the safe integer range");

  const note = await derivePaymentNote(parameters.recipient);
  return parsePaymentIntent({
    token: parameters.token,
    amount: parameters.amount.toString(),
    chainId: parameters.chainId,
    ownerHash: note.ownerHash.toString(),
    ephemeralKeyX: note.ephemeralKey[0].toString(),
    ephemeralKeyY: note.ephemeralKey[1].toString(),
    viewTag: Number(note.viewTag),
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
