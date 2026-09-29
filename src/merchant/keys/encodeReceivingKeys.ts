import type { PaymentRecipient } from "../../types";
import {
  COORDINATE_BYTES,
  checkPoint,
  encodeBase64url,
  KEY_BYTES,
  KEY_SPECS,
  MAGIC_BYTES,
  parseDecimalPoint,
  RECEIVING_KEYS_V1_BODY_BYTES,
  RECEIVING_KEYS_VERSION,
  receivingKeysChecksum,
  writeCoordinate,
} from "./internal/receivingKeysFormat";

/**
 * Encode a merchant's public receiving keys (S, V and the BabyJubjub public key) as one
 * versioned, checksummed line: `"01"` followed by base64url of `"CRK" || six 32-byte coordinates ||
 * 4-byte checksum`. Throws unless every key is a point on its curve.
 *
 * The value holds only public keys. Encoding is not encryption: it only makes the three keys one
 * opaque line that is safe to copy between the web app, an environment variable and the SDK.
 */
export function encodeReceivingKeys(recipient: PaymentRecipient): string {
  if (typeof recipient !== "object" || recipient === null) throw new Error("recipient must be an object");
  const keyBytes = new Uint8Array(KEY_BYTES);
  for (const [index, spec] of KEY_SPECS.entries()) {
    const point = parseDecimalPoint(recipient[spec.name], `recipient ${spec.name}`);
    checkPoint(spec, point, "recipient");
    writeCoordinate(keyBytes, index * 2 * COORDINATE_BYTES, point[0]);
    writeCoordinate(keyBytes, (index * 2 + 1) * COORDINATE_BYTES, point[1]);
  }
  const body = new Uint8Array(RECEIVING_KEYS_V1_BODY_BYTES);
  body.set(MAGIC_BYTES, 0);
  body.set(keyBytes, MAGIC_BYTES.length);
  body.set(receivingKeysChecksum(RECEIVING_KEYS_VERSION, keyBytes), MAGIC_BYTES.length + KEY_BYTES);
  return RECEIVING_KEYS_VERSION + encodeBase64url(body);
}
