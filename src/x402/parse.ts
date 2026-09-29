import { type Address, getAddress, type Hex, isAddress, isHex } from "viem";
import { record } from "../utils/validation";
import {
  type CurvyDeployment,
  type Eip3009Authorization,
  type ExactPaymentPayload,
  type TransferPaymentPayload,
  X402_VERSION,
  type X402PaymentPayload,
  type X402PaymentRequired,
  type X402PaymentRequirements,
  type X402ResourceInfo,
  type X402SettleResponse,
  type X402SupportedResponse,
  type X402VerifyResponse,
} from "./protocol";

export function parseUint(value: unknown, label: string): bigint {
  if (typeof value !== "string" && typeof value !== "number") throw new Error(`${label} must be an unsigned integer`);
  const text = String(value);
  if (!/^\d+$/.test(text)) throw new Error(`${label} must be an unsigned integer`);
  return BigInt(text);
}

export function parseAddress(value: unknown, label: string): Address {
  if (typeof value !== "string" || !isAddress(value)) throw new Error(`${label} must be an address`);
  return getAddress(value);
}

export function parseHex(value: unknown, label: string, bytes?: number): Hex {
  if (typeof value !== "string" || !isHex(value)) throw new Error(`${label} must be hex`);
  if (bytes !== undefined && value.length !== bytes * 2 + 2) throw new Error(`${label} must be ${bytes} bytes`);
  return value;
}

// --- x402 v2 wire objects ---

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

export function parseResourceInfo(value: unknown): X402ResourceInfo {
  const input = record(value, "resource");
  if (typeof input.url !== "string") throw new Error("resource.url must be a string");
  const description = optionalString(input.description, "resource.description");
  const mimeType = optionalString(input.mimeType, "resource.mimeType");
  return {
    ...input,
    url: input.url,
    ...(description === undefined ? {} : { description }),
    ...(mimeType === undefined ? {} : { mimeType }),
  };
}

export function parsePaymentRequirements(value: unknown, label = "payment requirements"): X402PaymentRequirements {
  const input = record(value, label);
  if (typeof input.scheme !== "string" || input.scheme === "") throw new Error(`${label}.scheme must be a string`);
  if (typeof input.network !== "string" || input.network === "") throw new Error(`${label}.network must be a string`);
  const maxTimeoutSeconds = parseUint(input.maxTimeoutSeconds, `${label}.maxTimeoutSeconds`);
  if (maxTimeoutSeconds > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label}.maxTimeoutSeconds is too large`);
  // Other networks use other identifier formats; EVM address checks happen where a row is selected or used.
  if (typeof input.asset !== "string" || input.asset === "") throw new Error(`${label}.asset must be a string`);
  if (typeof input.payTo !== "string" || input.payTo === "") throw new Error(`${label}.payTo must be a string`);
  return {
    scheme: input.scheme,
    network: input.network,
    asset: input.asset,
    amount: parseUint(input.amount, `${label}.amount`).toString(),
    payTo: input.payTo,
    maxTimeoutSeconds: Number(maxTimeoutSeconds),
    extra: input.extra === undefined || input.extra === null ? {} : record(input.extra, `${label}.extra`),
  };
}

export function parsePaymentRequired(value: unknown): X402PaymentRequired {
  const input = record(value, "payment required");
  if (input.x402Version !== X402_VERSION) throw new Error(`unsupported x402 version: ${String(input.x402Version)}`);
  if (!Array.isArray(input.accepts)) throw new Error("payment required.accepts must be an array");
  const error = optionalString(input.error, "payment required.error");
  return {
    x402Version: X402_VERSION,
    ...(error === undefined ? {} : { error }),
    resource: parseResourceInfo(input.resource),
    accepts: input.accepts.map((entry, index) => parsePaymentRequirements(entry, `accepts[${index}]`)),
  };
}

export function parsePaymentPayload(value: unknown): X402PaymentPayload {
  const input = record(value, "payment payload");
  if (input.x402Version !== X402_VERSION) throw new Error(`unsupported x402 version: ${String(input.x402Version)}`);
  return {
    x402Version: X402_VERSION,
    ...(input.resource === undefined ? {} : { resource: parseResourceInfo(input.resource) }),
    accepted: parsePaymentRequirements(input.accepted, "accepted"),
    payload: record(input.payload, "payment payload.payload"),
    ...(input.extensions === undefined ? {} : { extensions: record(input.extensions, "payment payload.extensions") }),
  };
}

/** Parse the `payload` of an `exact` payment: an EIP-3009 authorization and its signature. */
export function parseExactPayload(value: unknown): ExactPaymentPayload {
  const input = record(value, "exact payload");
  const authorization = record(input.authorization, "exact payload.authorization");
  const parsed: Eip3009Authorization = {
    from: parseAddress(authorization.from, "authorization.from"),
    to: parseAddress(authorization.to, "authorization.to"),
    value: parseUint(authorization.value, "authorization.value").toString(),
    validAfter: parseUint(authorization.validAfter, "authorization.validAfter").toString(),
    validBefore: parseUint(authorization.validBefore, "authorization.validBefore").toString(),
    nonce: parseHex(authorization.nonce, "authorization.nonce", 32),
  };
  return { signature: parseHex(input.signature, "exact payload.signature"), authorization: parsed };
}

/** Parse the `payload` of a `curvy-transfer` payment. */
export function parseTransferPayload(value: unknown): TransferPaymentPayload {
  const input = record(value, "transfer payload");
  return input.txHash === undefined ? {} : { txHash: parseHex(input.txHash, "transfer payload.txHash", 32) };
}

export function parseVerifyResponse(value: unknown): X402VerifyResponse {
  const input = record(value, "verify response");
  if (typeof input.isValid !== "boolean") throw new Error("verify response.isValid must be a boolean");
  const invalidReason = optionalString(input.invalidReason, "verify response.invalidReason");
  const invalidMessage = optionalString(input.invalidMessage, "verify response.invalidMessage");
  const payer = optionalString(input.payer, "verify response.payer");
  return {
    isValid: input.isValid,
    ...(invalidReason === undefined ? {} : { invalidReason }),
    ...(invalidMessage === undefined ? {} : { invalidMessage }),
    ...(payer === undefined ? {} : { payer }),
  };
}

export function parseSettleResponse(value: unknown): X402SettleResponse {
  const input = record(value, "settle response");
  if (typeof input.success !== "boolean") throw new Error("settle response.success must be a boolean");
  const errorReason = optionalString(input.errorReason, "settle response.errorReason");
  const errorMessage = optionalString(input.errorMessage, "settle response.errorMessage");
  const payer = optionalString(input.payer, "settle response.payer");
  return {
    success: input.success,
    transaction: typeof input.transaction === "string" ? input.transaction : "",
    network: typeof input.network === "string" ? input.network : "",
    ...(errorReason === undefined ? {} : { errorReason }),
    ...(errorMessage === undefined ? {} : { errorMessage }),
    ...(payer === undefined ? {} : { payer }),
  };
}

export function parseSupportedResponse(value: unknown): X402SupportedResponse {
  const input = record(value, "supported response");
  if (!Array.isArray(input.kinds)) throw new Error("supported response.kinds must be an array");
  const kinds = input.kinds.map((entry, index) => {
    const kind = record(entry, `kinds[${index}]`);
    if (typeof kind.scheme !== "string") throw new Error(`kinds[${index}].scheme must be a string`);
    if (typeof kind.network !== "string") throw new Error(`kinds[${index}].network must be a string`);
    return {
      x402Version: Number(parseUint(kind.x402Version, `kinds[${index}].x402Version`)),
      scheme: kind.scheme,
      network: kind.network,
      ...(kind.extra === undefined ? {} : { extra: record(kind.extra, `kinds[${index}].extra`) }),
    };
  });
  const signers: Record<string, string[]> = {};
  if (input.signers !== undefined) {
    for (const [family, list] of Object.entries(record(input.signers, "supported response.signers"))) {
      if (!Array.isArray(list) || !list.every((item) => typeof item === "string")) {
        throw new Error(`supported response.signers.${family} must be a string array`);
      }
      signers[family] = list;
    }
  }
  return {
    kinds,
    extensions: Array.isArray(input.extensions)
      ? input.extensions.filter((e): e is string => typeof e === "string")
      : [],
    signers,
  };
}

/** Parse the contract addresses of a Curvy deployment. */
export function parseCurvyDeployment(value: unknown): CurvyDeployment {
  const input = record(value, "curvy deployment");
  return {
    aggregator: parseAddress(input.aggregator, "curvy deployment.aggregator"),
    portalFactory: parseAddress(input.portalFactory, "curvy deployment.portalFactory"),
    vault: parseAddress(input.vault, "curvy deployment.vault"),
  };
}

/** Deterministic JSON with sorted object keys, for comparing `extra` records. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** True when two requirement rows describe the same payment, ignoring address casing and key order. */
export function requirementsEqual(left: X402PaymentRequirements, right: X402PaymentRequirements): boolean {
  return (
    left.scheme === right.scheme &&
    left.network === right.network &&
    left.asset.toLowerCase() === right.asset.toLowerCase() &&
    BigInt(left.amount) === BigInt(right.amount) &&
    left.payTo.toLowerCase() === right.payTo.toLowerCase() &&
    left.maxTimeoutSeconds === right.maxTimeoutSeconds &&
    canonicalJson(left.extra) === canonicalJson(right.extra)
  );
}
