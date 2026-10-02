import type { SignedPaymentIntent } from "../types";
import { encodePaymentIntentFragment } from "./encodePaymentIntentFragment";

/** Curvy's hosted checkout page in production. */
export const CURVY_CHECKOUT_URL = "https://app.curvy.box/checkout";

/** Place a signed payment package in the fragment of Curvy's checkout page, or of `checkoutUrl` (a staging page). */
export function buildCheckoutUrl(payment: SignedPaymentIntent): string;
export function buildCheckoutUrl(checkoutUrl: string | URL, payment: SignedPaymentIntent): string;
export function buildCheckoutUrl(first: string | URL | SignedPaymentIntent, second?: SignedPaymentIntent): string {
  const [checkoutUrl, payment] =
    typeof first === "string" || first instanceof URL
      ? [first, second as SignedPaymentIntent]
      : [CURVY_CHECKOUT_URL, first];
  if (payment === undefined) throw new Error("buildCheckoutUrl needs the signed payment");
  const url = new URL(checkoutUrl);
  url.hash = encodePaymentIntentFragment(payment);
  return url.toString();
}
