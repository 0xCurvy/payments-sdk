import type { PaymentRecipient } from "../../types";
import { parseReceivingKeys } from "../keys/parseReceivingKeys";

/**
 * Who a payment request pays: exactly one of `receivingKeys` (the preferred single value from the
 * web app's Payments setup, see `encodeReceivingKeys`) or `recipient` (the same keys as three strings).
 */
export type RecipientParameters =
  | { receivingKeys: string; recipient?: undefined }
  | { recipient: PaymentRecipient; receivingKeys?: undefined };

export function resolveRecipient(parameters: {
  recipient?: PaymentRecipient;
  receivingKeys?: string;
}): PaymentRecipient {
  const hasRecipient = parameters.recipient !== undefined;
  const hasReceivingKeys = parameters.receivingKeys !== undefined;
  if (hasRecipient === hasReceivingKeys) {
    throw new Error("pass exactly one of receivingKeys (preferred) or recipient");
  }
  return hasReceivingKeys
    ? parseReceivingKeys(parameters.receivingKeys as string)
    : (parameters.recipient as PaymentRecipient);
}
