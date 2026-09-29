import { sha256 } from "viem";
import type { PaymentRecipient } from "../../../types";
import { BN254_BASE_FIELD, BN254_SCALAR_FIELD } from "../../../utils/validation";

/**
 * Receiving-keys value: `VERSION + BODY`.
 *
 * - `VERSION`: two lowercase hex digits. `"01"` = S, V and the BabyJubjub public key. `"00"` is never valid.
 * - `BODY`: base64url (RFC 4648 section 5, no padding) of
 *   `"CRK" || S.x || S.y || V.x || V.y || BJJ.x || BJJ.y || checksum`, each coordinate a 32-byte
 *   big-endian unsigned integer.
 * - `checksum`: the first 4 bytes of `SHA-256(ASCII(VERSION) || "CRK" || the 192 key bytes)`, so the
 *   version digits are bound to the body.
 *
 * Encoding is not encryption: every field is a public key.
 */
export const RECEIVING_KEYS_VERSION = "01";

export const MAGIC_BYTES = new Uint8Array([0x43, 0x52, 0x4b]);
export const COORDINATE_BYTES = 32;
export const KEY_BYTES = 6 * COORDINATE_BYTES;
const CHECKSUM_BYTES = 4;
/** Decoded v1 body: magic, six coordinates, checksum. */
export const RECEIVING_KEYS_V1_BODY_BYTES = MAGIC_BYTES.length + KEY_BYTES + CHECKSUM_BYTES;

export const VERSION_PATTERN = /^[0-9a-f]{2}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;
const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** secp256k1 base field p. */
const SECP256K1_FIELD = 2n ** 256n - 2n ** 32n - 977n;
/** BabyJubjub twisted Edwards parameters (a*x^2 + y^2 = 1 + d*x^2*y^2 over the BN254 scalar field). */
const BABYJUBJUB_A = 168_700n;
const BABYJUBJUB_D = 168_696n;

export type Point = readonly [bigint, bigint];

interface KeySpec {
  name: keyof PaymentRecipient;
  curve: string;
  modulus: bigint;
  onCurve(point: Point): boolean;
}

function mod(value: bigint, modulus: bigint): bigint {
  const reduced = value % modulus;
  return reduced < 0n ? reduced + modulus : reduced;
}

export const KEY_SPECS: readonly KeySpec[] = [
  {
    name: "S",
    curve: "secp256k1",
    modulus: SECP256K1_FIELD,
    onCurve: ([x, y]) => mod(y * y - (x * x * x + 7n), SECP256K1_FIELD) === 0n,
  },
  {
    name: "V",
    curve: "BN254 G1",
    modulus: BN254_BASE_FIELD,
    onCurve: ([x, y]) => mod(y * y - (x * x * x + 3n), BN254_BASE_FIELD) === 0n,
  },
  {
    name: "babyJubjubPublicKey",
    curve: "BabyJubjub",
    modulus: BN254_SCALAR_FIELD,
    onCurve: ([x, y]) => {
      const xx = x * x;
      const yy = y * y;
      return mod(BABYJUBJUB_A * xx + yy - 1n - BABYJUBJUB_D * xx * yy, BN254_SCALAR_FIELD) === 0n;
    },
  },
];

/** Each coordinate must be nonzero and below its field modulus, and the point on its curve. */
export function checkPoint(spec: KeySpec, point: Point, label: string): void {
  for (const [index, coordinate] of point.entries()) {
    const axis = index === 0 ? "x" : "y";
    if (coordinate === 0n || coordinate >= spec.modulus) {
      throw new Error(`${label} ${spec.name}.${axis} must be nonzero and below the ${spec.curve} field modulus`);
    }
  }
  if (!spec.onCurve(point)) throw new Error(`${label} ${spec.name} is not a point on ${spec.curve}`);
}

const DECIMAL_POINT = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseDecimalPoint(value: unknown, label: string): Point {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const match = DECIMAL_POINT.exec(value);
  if (!match) throw new Error(`${label} must be two canonical unsigned decimal coordinates separated by a dot`);
  return [BigInt(match[1] as string), BigInt(match[2] as string)];
}

export function writeCoordinate(target: Uint8Array, offset: number, value: bigint): void {
  let remaining = value;
  for (let index = COORDINATE_BYTES - 1; index >= 0; index--) {
    target[offset + index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
}

export function readCoordinate(source: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let index = 0; index < COORDINATE_BYTES; index++) {
    value = (value << 8n) | BigInt(source[offset + index] as number);
  }
  return value;
}

function asciiBytes(value: string): Uint8Array {
  return Uint8Array.from(value, (character) => character.charCodeAt(0));
}

/** First 4 bytes of `SHA-256(ASCII(version) || "CRK" || keyBytes)`. */
export function receivingKeysChecksum(version: string, keyBytes: Uint8Array): Uint8Array {
  const versionBytes = asciiBytes(version);
  const input = new Uint8Array(versionBytes.length + MAGIC_BYTES.length + keyBytes.length);
  input.set(versionBytes, 0);
  input.set(MAGIC_BYTES, versionBytes.length);
  input.set(keyBytes, versionBytes.length + MAGIC_BYTES.length);
  return sha256(input, "bytes").slice(0, CHECKSUM_BYTES);
}

export function encodeBase64url(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const chunk = bytes.subarray(index, index + 3);
    const bits = ((chunk[0] ?? 0) << 16) | ((chunk[1] ?? 0) << 8) | (chunk[2] ?? 0);
    const characters = chunk.length + 1;
    for (let position = 0; position < characters; position++) {
      output += BASE64URL_ALPHABET[(bits >> (18 - 6 * position)) & 0x3f];
    }
  }
  return output;
}

/** Strict: base64url alphabet only, no padding, canonical trailing bits. Returns undefined otherwise. */
export function decodeBase64url(value: string): Uint8Array | undefined {
  if (!BASE64URL_PATTERN.test(value) || value.length % 4 === 1) return undefined;
  const bytes = new Uint8Array(Math.floor((value.length * 3) / 4));
  let byteIndex = 0;
  for (let index = 0; index < value.length; index += 4) {
    const group = value.slice(index, index + 4);
    let bits = 0;
    for (let position = 0; position < 4; position++) {
      const character = group[position];
      bits = (bits << 6) | (character === undefined ? 0 : BASE64URL_ALPHABET.indexOf(character));
    }
    for (let position = 0; position < group.length - 1; position++) {
      bytes[byteIndex++] = (bits >> (16 - 8 * position)) & 0xff;
    }
  }
  return encodeBase64url(bytes) === value ? bytes : undefined;
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}
