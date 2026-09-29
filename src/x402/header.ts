// x402 carries JSON in HTTP headers (`PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`)
// as base64. Implemented on TextEncoder + btoa/atob so it runs in browsers as well as Node.

/** Encode a value as base64 JSON for an x402 header. */
export function encodeBase64Json(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Decode an x402 header's base64 JSON. Accepts the URL-safe alphabet and missing padding. */
export function decodeBase64Json(value: string): unknown {
  const standard = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(standard);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}
