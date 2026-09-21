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

export function decimal(value: unknown, label: string): string {
  const parsed = string(value, label);
  if (!/^\d+$/.test(parsed)) throw new Error(`${label} must be an unsigned decimal string`);
  return parsed;
}

export function safeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
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

/** Absolute path on `merchantOrigin`. Omitted â†’ `/checkout/complete`. Not a free-form URL. */
export const DEFAULT_CHECKOUT_COMPLETE_PATH = "/checkout/complete";

/** Default payment request lifetime when omitted from SDK init or standalone creation. */
export const DEFAULT_PAYMENT_REQUEST_TTL_SECONDS = 600;

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
