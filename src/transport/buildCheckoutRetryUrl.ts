import { parsePaymentIntent } from "../intent/parsePaymentIntent";
import type { PaymentIntent } from "../types";

/**
 * Build the top-level merchant return URL asking for a fresh payment attempt after this one failed.
 * The merchant's completion page recognises the attempt by its ephemeral key X and issues a new request.
 */
export function buildCheckoutRetryUrl(intent: PaymentIntent): string {
  const parsed = parsePaymentIntent(intent);
  const url = new URL(parsed.checkoutCompletePath, parsed.merchantOrigin);
  if (url.origin !== parsed.merchantOrigin) {
    throw new Error("checkoutCompletePath must stay on merchantOrigin");
  }
  url.search = "";
  url.hash = new URLSearchParams({ retry: parsed.ephemeralKeyX }).toString();
  return url.toString();
}
