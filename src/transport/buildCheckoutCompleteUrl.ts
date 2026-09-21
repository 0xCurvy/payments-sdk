import type { Hex } from "viem";
import { parsePaymentIntent } from "../intent/parsePaymentIntent";
import type { PaymentIntent } from "../types";

/** Build the top-level merchant return URL after a successful shield. */
export function buildCheckoutCompleteUrl(intent: PaymentIntent, txHash: Hex): string {
  const parsed = parsePaymentIntent(intent);
  const url = new URL(parsed.checkoutCompletePath, parsed.merchantOrigin);
  if (url.origin !== parsed.merchantOrigin) {
    throw new Error("checkoutCompletePath must stay on merchantOrigin");
  }
  url.search = "";
  url.hash = `txHash=${txHash}`;
  return url.toString();
}
