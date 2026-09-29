import type { PaymentRecipient } from "../../types";
import {
  bytesEqual,
  COORDINATE_BYTES,
  checkPoint,
  decodeBase64url,
  KEY_BYTES,
  KEY_SPECS,
  MAGIC_BYTES,
  type Point,
  RECEIVING_KEYS_V1_BODY_BYTES,
  RECEIVING_KEYS_VERSION,
  readCoordinate,
  receivingKeysChecksum,
  VERSION_PATTERN,
} from "./internal/receivingKeysFormat";

const LABEL = "receiving keys";

/**
 * Parse a receiving-keys value from {@link encodeReceivingKeys} (as copied from the web app's
 * Payments setup) into the recipient the SDK derives payment notes for.
 *
 * Strict: the version must be `"01"`, the body canonical base64url without padding, the length,
 * `"CRK"` marker and checksum exact, and every key a point on its curve. A newer version throws
 * an error that names it and asks for an SDK upgrade.
 */
export function parseReceivingKeys(value: string): PaymentRecipient {
  if (typeof value !== "string") throw new Error(`${LABEL} must be a string`);
  const version = value.slice(0, 2);
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`${LABEL} must start with two lowercase hexadecimal version digits`);
  }
  if (version === "00") throw new Error(`${LABEL} version 00 is not valid`);
  if (version !== RECEIVING_KEYS_VERSION) {
    throw new Error(
      `${LABEL} version ${version} is not supported by this SDK, which reads version ${RECEIVING_KEYS_VERSION}: upgrade @0xcurvy/payments-sdk`,
    );
  }

  const body = decodeBase64url(value.slice(2));
  if (!body) {
    throw new Error(`${LABEL} must continue with base64url characters (A-Z, a-z, 0-9, -, _) and no padding`);
  }
  if (body.length < MAGIC_BYTES.length || !bytesEqual(body.subarray(0, MAGIC_BYTES.length), MAGIC_BYTES)) {
    throw new Error("not a Curvy receiving-keys value");
  }
  if (body.length !== RECEIVING_KEYS_V1_BODY_BYTES) {
    throw new Error(
      `${LABEL} version ${version} must decode to ${RECEIVING_KEYS_V1_BODY_BYTES} bytes, got ${body.length}: copy the whole value`,
    );
  }

  const keyBytes = body.subarray(MAGIC_BYTES.length, MAGIC_BYTES.length + KEY_BYTES);
  if (!bytesEqual(body.subarray(MAGIC_BYTES.length + KEY_BYTES), receivingKeysChecksum(version, keyBytes))) {
    throw new Error(`${LABEL} checksum does not match: the value was changed or copied incompletely`);
  }

  const keys: Partial<PaymentRecipient> = {};
  for (const [index, spec] of KEY_SPECS.entries()) {
    const point: Point = [
      readCoordinate(keyBytes, index * 2 * COORDINATE_BYTES),
      readCoordinate(keyBytes, (index * 2 + 1) * COORDINATE_BYTES),
    ];
    checkPoint(spec, point, LABEL);
    keys[spec.name] = `${point[0]}.${point[1]}`;
  }
  return keys as PaymentRecipient;
}
