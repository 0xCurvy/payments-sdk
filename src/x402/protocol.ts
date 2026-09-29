import type { Address, Hex } from "viem";

/** x402 protocol version Curvy's facilitator speaks. */
export const X402_VERSION = 2 as const;
/** One payment per request, settled by the facilitator through an entry portal. */
export const EXACT_SCHEME = "exact" as const;
/** Token authorization method payers sign for the `exact` scheme. */
export const ASSET_TRANSFER_METHOD = "eip3009" as const;
/**
 * Curvy scheme: the payer sends a plain ERC-20 transfer of `amount` to `payTo` from its own wallet and
 * presents the transaction hash. No facilitator; the portal broadcaster shields the portal.
 */
export const TRANSFER_SCHEME = "curvy-transfer" as const;
export const TRANSFER_METHOD = "erc20-transfer" as const;
/**
 * Recovery address for portals nobody can drain: the well-known burn address. `Portal.recover()` requires
 * `tx.origin == recovery`, which no transaction can satisfy, and the factory rejects the zero address.
 * Funds that reach such a portal and are never shielded are lost for good.
 */
export const NO_RECOVERY_ADDRESS = "0x000000000000000000000000000000000000dEaD" as const;

export type X402Network = `eip155:${number}`;

/** CAIP-2 network id for an EVM chain, as used in x402 payment requirements. */
export function x402Network(chainId: number): X402Network {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("chainId must be a positive integer");
  return `eip155:${chainId}`;
}

/** Parse a CAIP-2 `eip155:<chainId>` network id back to its chain id. */
export function parseX402Network(network: string): number {
  const match = /^eip155:([1-9]\d*)$/.exec(network);
  if (!match) throw new Error(`unsupported x402 network: ${network}`);
  return Number(match[1]);
}

// --- HTTP wire format (x402 v2) ---

/** Response header carrying the base64 JSON `X402PaymentRequired` on a 402. */
export const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
/** Request header carrying the base64 JSON `X402PaymentPayload` on the paid retry. */
export const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";
/** Response header carrying the base64 JSON `X402SettleResponse` on the paid response. */
export const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";

export interface X402ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
  [key: string]: unknown;
}

/** One way to pay for a resource, as advertised in `accepts` and echoed back in `accepted`. */
export interface X402PaymentRequirements {
  scheme: string;
  network: string;
  /** Token identifier; an address on EVM networks. */
  asset: string;
  /** Token base units. */
  amount: string;
  /** Recipient; an address on EVM networks. */
  payTo: string;
  /** Seconds the payer's authorization stays valid after signing. */
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}

/** Body of the `PAYMENT-REQUIRED` header. */
export interface X402PaymentRequired {
  x402Version: number;
  error?: string;
  resource: X402ResourceInfo;
  accepts: X402PaymentRequirements[];
}

/** Body of the `PAYMENT-SIGNATURE` header. */
export interface X402PaymentPayload {
  x402Version: number;
  resource?: X402ResourceInfo;
  accepted: X402PaymentRequirements;
  payload: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

/** EIP-3009 `TransferWithAuthorization` message a payer signs for the `exact` scheme. */
export interface Eip3009Authorization {
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
}

/** `payload` of an `exact` payment. */
export interface ExactPaymentPayload {
  signature: Hex;
  authorization: Eip3009Authorization;
}

/** `payload` of a `curvy-transfer` payment: the transfer transaction, if the payer knows it yet. */
export interface TransferPaymentPayload {
  txHash?: Hex;
}

export interface X402VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  invalidMessage?: string;
  payer?: string;
}

export interface X402SettleResponse {
  success: boolean;
  errorReason?: string;
  errorMessage?: string;
  payer?: string;
  transaction: string;
  network: string;
}

export interface X402SupportedKind {
  x402Version: number;
  scheme: string;
  network: string;
  extra?: Record<string, unknown>;
}

/** `GET {facilitator}/supported`. */
export interface X402SupportedResponse {
  kinds: X402SupportedKind[];
  extensions?: string[];
  /** Facilitator signer addresses by CAIP-2 family (`eip155:*`) or network. */
  signers?: Record<string, string[]>;
}

/** The Curvy contracts a merchant needs on one chain, as the portal broadcaster reports them. */
export interface CurvyDeployment {
  aggregator: Address;
  portalFactory: Address;
  vault: Address;
}
