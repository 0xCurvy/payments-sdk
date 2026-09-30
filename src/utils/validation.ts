import type { Hex } from "viem";
import { getAddress, isAddress } from "viem/utils";

const SIGNATURE = /^0x[0-9a-f]{130}$/i;

export function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function exactKeys(input: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(input).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} must contain exactly: ${expected.join(", ")}`);
  }
}

/** Require every `required` key, allow `optional`, reject anything else. */
export function requiredAndOptionalKeys(
  input: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!(key in input)) throw new Error(`${label} missing ${key}`);
  }
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new Error(`${label} must not contain ${key}`);
  }
}

export function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

/** Exclusive upper bound of a Solidity/EIP-712 `uint256`. */
export const UINT256_LIMIT = 1n << 256n;

/** BN254 scalar field r: Poseidon inputs and outputs (ownerHash, noteId) live below it. */
export const BN254_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** BN254 base field p: coordinates of the BN254 G1 ephemeral key R live below it. */
export const BN254_BASE_FIELD = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;

export function decimal(value: unknown, label: string): string {
  const parsed = string(value, label);
  if (!/^(0|[1-9]\d*)$/.test(parsed)) throw new Error(`${label} must be a canonical unsigned decimal string`);
  return parsed;
}

/** Canonical unsigned decimal string with `minimum <= value < limit`. */
export function boundedDecimal(value: unknown, label: string, minimum: bigint, limit: bigint): string {
  const parsed = decimal(value, label);
  const parsedValue = BigInt(parsed);
  if (parsedValue < minimum || parsedValue >= limit) {
    throw new Error(`${label} must be at least ${minimum} and below ${limit}`);
  }
  return parsed;
}

export function safeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

export function positiveSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

export function address(value: unknown, label: string) {
  const parsed = string(value, label);
  if (!isAddress(parsed)) throw new Error(`${label} must be an address`);
  return getAddress(parsed);
}

export function signature(value: unknown, label: string): Hex {
  const parsed = string(value, label);
  if (!SIGNATURE.test(parsed)) throw new Error(`${label} must be a 65-byte hex signature`);
  return parsed as Hex;
}

export function merchantOrigin(value: unknown, label: string): string {
  const parsed = string(value, label);
  const url = new URL(parsed);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== parsed) {
    throw new Error(`${label} must be a bare http or https origin`);
  }
  return parsed;
}

/** Absolute path on `merchantOrigin`. Omitted -> `/checkout/complete`. Not a free-form URL. */
export const DEFAULT_CHECKOUT_COMPLETE_PATH = "/checkout/complete";

/** Default payment request lifetime when omitted from SDK init or standalone creation. */
export const DEFAULT_PAYMENT_REQUEST_TTL_SECONDS = 600;

/**
 * Longest payment request lifetime the SDK issues (24 h). A short lifetime bounds how many issued
 * links still point at a portal factory after Curvy switches factories.
 */
export const MAX_PAYMENT_REQUEST_TTL_SECONDS = 86_400;

/** A request lifetime in seconds: a positive safe integer of at most `MAX_PAYMENT_REQUEST_TTL_SECONDS`. */
export function paymentRequestTtlSeconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("ttlSeconds must be a positive safe integer");
  }
  if (value > MAX_PAYMENT_REQUEST_TTL_SECONDS) {
    throw new Error(`ttlSeconds must be at most ${MAX_PAYMENT_REQUEST_TTL_SECONDS} (24 hours)`);
  }
  return value;
}

/** Exclusive upper bound of a `viewTag` (`uint16` in the note and in the EIP-712 intent). */
const VIEW_TAG_LIMIT = 65_536;

const HEX_VIEW_TAG = /^(?:0x)?[0-9a-f]{1,4}$/i;

/**
 * The SDK's one `viewTag` parser: returns the canonical form, a `uint16` as a number.
 *
 * A number must be a non-negative safe integer below 65536. A string is accepted only with
 * `{ hex: true }` and is always read as hexadecimal, with or without `0x` (rs-core's `send`
 * returns a bare hex byte such as `"0a"`). Wire formats that carry a JSON number, such as the
 * payment intent, parse without `hex`, so a string there is an error.
 */
export function viewTag(value: unknown, label: string, options: { hex?: boolean } = {}): number {
  let parsed: number;
  if (typeof value === "string" && options.hex) {
    if (!HEX_VIEW_TAG.test(value)) throw new Error(`${label} must be a hexadecimal uint16`);
    parsed = Number.parseInt(value.replace(/^0x/i, ""), 16);
  } else {
    parsed = safeInteger(value, label);
  }
  if (parsed >= VIEW_TAG_LIMIT) throw new Error(`${label} must fit uint16`);
  return parsed;
}

/** Longest icon path a merchant key set can carry. */
export const MAX_MERCHANT_ICON_PATH_LENGTH = 256;

/** Longest description a payment can carry: one line of receipt text, not an invoice. */
export const MAX_PAYMENT_DESCRIPTION_LENGTH = 120;

// Control characters and text-direction overrides could make a description read as something it isn't.
const HIDDEN_CHARACTERS = /[\p{Cc}\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

/** What the buyer is paying for, as the shop words it: non-empty, trimmed, at most 120 characters, plain text. */
export function paymentDescription(value: unknown, label: string): string {
  const parsed = string(value, label);
  if (parsed === "" || parsed !== parsed.trim())
    throw new Error(`${label} must be non-empty and not start or end with spaces`);
  if ([...parsed].length > MAX_PAYMENT_DESCRIPTION_LENGTH) {
    throw new Error(`${label} must be at most ${MAX_PAYMENT_DESCRIPTION_LENGTH} characters`);
  }
  if (HIDDEN_CHARACTERS.test(parsed)) throw new Error(`${label} must not contain control or text-direction characters`);
  return parsed;
}

/** Longest shop name a merchant key set can carry: what checkout shows beside the shop's own address. */
export const MAX_MERCHANT_NAME_LENGTH = 60;

/**
 * The shop's name as checkout shows it: non-empty, trimmed, at most 60 characters, plain text. The shop publishes it
 * itself, so checkout always shows its address beside it.
 */
export function merchantName(value: unknown, label: string): string {
  const parsed = string(value, label);
  if (parsed === "" || parsed !== parsed.trim())
    throw new Error(`${label} must be non-empty and not start or end with spaces`);
  if ([...parsed].length > MAX_MERCHANT_NAME_LENGTH) {
    throw new Error(`${label} must be at most ${MAX_MERCHANT_NAME_LENGTH} characters`);
  }
  if (HIDDEN_CHARACTERS.test(parsed)) throw new Error(`${label} must not contain control or text-direction characters`);
  return parsed;
}

/** A checkout icon: an absolute PNG or WebP path on the merchant origin, never another host or an SVG. */
export function merchantIconPath(value: unknown, label: string): string {
  const parsed = string(value, label);
  if (
    parsed.length > MAX_MERCHANT_ICON_PATH_LENGTH ||
    !parsed.startsWith("/") ||
    parsed.startsWith("//") ||
    parsed.includes("\\") ||
    parsed.includes("?") ||
    parsed.includes("#") ||
    parsed.includes("://") ||
    !/\.(png|webp)$/i.test(parsed)
  ) {
    throw new Error(`${label} must be an absolute path to a .png or .webp file on the merchant origin`);
  }
  const resolved = new URL(parsed, "https://merchant.invalid");
  if (resolved.pathname !== parsed) {
    throw new Error(`${label} must be an absolute path to a .png or .webp file on the merchant origin`);
  }
  return parsed;
}

export function checkoutCompletePath(value: unknown, label: string): string {
  if (value === undefined) return DEFAULT_CHECKOUT_COMPLETE_PATH;
  const parsed = string(value, label);
  if (
    !parsed.startsWith("/") ||
    parsed.startsWith("//") ||
    parsed.includes("\\") ||
    parsed.includes("?") ||
    parsed.includes("#") ||
    parsed.includes("://")
  ) {
    throw new Error(`${label} must be an absolute path on the merchant origin`);
  }
  const resolved = new URL(parsed, "https://merchant.invalid");
  if (resolved.pathname !== parsed || resolved.search !== "" || resolved.hash !== "") {
    throw new Error(`${label} must be an absolute path on the merchant origin`);
  }
  return parsed;
}
