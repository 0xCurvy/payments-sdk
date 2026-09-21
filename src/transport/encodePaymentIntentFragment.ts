import { parseSignedPaymentIntent } from "../intent/parseSignedPaymentIntent";
import type { SignedPaymentIntent } from "../types";

/** Encode a signed payment package as an unpadded base64url fragment. */
export function encodePaymentIntentFragment(payment: SignedPaymentIntent): string {
  const bytes = new TextEncoder().encode(JSON.stringify(parseSignedPaymentIntent(payment)));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
