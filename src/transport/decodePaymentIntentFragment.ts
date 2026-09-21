import { parseSignedPaymentIntent } from "../intent/parseSignedPaymentIntent";
import type { SignedPaymentIntent } from "../types";

/** Decode and validate a base64url payment fragment, with or without a leading `#`. */
export function decodePaymentIntentFragment(fragment: string): SignedPaymentIntent {
  const encoded = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  if (!/^[\w-]+$/.test(encoded)) throw new Error("payment fragment must be unpadded base64url");
  const padded = encoded
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(encoded.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return parseSignedPaymentIntent(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
  } catch (error) {
    throw new Error("payment fragment is not a valid signed payment intent", { cause: error });
  }
}
