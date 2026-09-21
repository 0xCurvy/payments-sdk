import type { SignedPaymentIntent } from "../types";
import { encodePaymentIntentFragment } from "./encodePaymentIntentFragment";

/** Place a signed payment package in a checkout URL fragment. */
export function buildCheckoutUrl(checkoutUrl: string | URL, payment: SignedPaymentIntent): string {
  const url = new URL(checkoutUrl);
  url.hash = encodePaymentIntentFragment(payment);
  return url.toString();
}
