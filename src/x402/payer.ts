import type { Address, Hex } from "viem";
import { getAddress, isAddress, toHex } from "viem";
import { decodeBase64Json, encodeBase64Json } from "./header";
import { parsePaymentRequired, parseSettleResponse } from "./parse";
import {
  ASSET_TRANSFER_METHOD,
  type Eip3009Authorization,
  EXACT_SCHEME,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  parseX402Network,
  TRANSFER_METHOD,
  TRANSFER_SCHEME,
  X402_VERSION,
  type X402PaymentPayload,
  type X402PaymentRequired,
  type X402PaymentRequirements,
  type X402SettleResponse,
} from "./protocol";
import { eip3009Domain, transferWithAuthorizationTypes } from "./typedData";

/** Typed data a payer signs for one `exact` payment. */
export interface Eip3009TypedData {
  domain: ReturnType<typeof eip3009Domain>;
  types: typeof transferWithAuthorizationTypes;
  primaryType: "TransferWithAuthorization";
  message: {
    from: Address;
    to: Address;
    value: bigint;
    validAfter: bigint;
    validBefore: bigint;
    nonce: Hex;
  };
}

/** A viem `LocalAccount` satisfies this, as does any wallet adapter that signs EIP-712. */
export interface X402Signer {
  address: Address;
  signTypedData(typedData: Eip3009TypedData): Promise<Hex>;
}

export interface SelectExactRequirementsOptions {
  /** Only accept this CAIP-2 network. */
  network?: string;
  /** Only accept this token. */
  asset?: Address;
  /** Refuse to pay more than this many base units. */
  maxAmount?: bigint;
}

/** Pick the first `exact` / EIP-3009 requirement on an EVM network that satisfies the options. */
export function selectExactRequirements(
  required: X402PaymentRequired,
  options: SelectExactRequirementsOptions = {},
): X402PaymentRequirements {
  const candidate = required.accepts.find((entry) => {
    if (entry.scheme !== EXACT_SCHEME) return false;
    const method = entry.extra.assetTransferMethod;
    if (method !== undefined && method !== ASSET_TRANSFER_METHOD) return false;
    if (options.network !== undefined && entry.network !== options.network) return false;
    if (options.asset !== undefined && entry.asset.toLowerCase() !== options.asset.toLowerCase()) return false;
    if (!isAddress(entry.asset) || !isAddress(entry.payTo)) return false;
    try {
      parseX402Network(entry.network);
    } catch {
      return false;
    }
    return typeof entry.extra.name === "string" && typeof entry.extra.version === "string";
  });
  if (!candidate) throw new Error("402 response offers no exact EIP-3009 payment option this payer accepts");
  if (options.maxAmount !== undefined && BigInt(candidate.amount) > options.maxAmount) {
    throw new Error(`payment of ${candidate.amount} exceeds the payer's maxAmount of ${options.maxAmount}`);
  }
  return candidate;
}

export interface CreateExactPaymentOptions extends SelectExactRequirementsOptions {
  /** Unix seconds "now"; defaults to the clock. */
  now?: number;
  /** 32-byte nonce; defaults to random. */
  nonce?: Hex;
}

function randomNonce(): Hex {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return toHex(bytes);
}

/** Sign one `exact` payment for a 402 and return the `PAYMENT-SIGNATURE` payload. */
export async function createExactPayment(
  required: X402PaymentRequired,
  signer: X402Signer,
  options: CreateExactPaymentOptions = {},
): Promise<X402PaymentPayload> {
  const accepted = selectExactRequirements(required, options);
  const chainId = parseX402Network(accepted.network);
  const now = options.now ?? Math.floor(Date.now() / 1_000);
  const authorization: Eip3009Authorization = {
    from: getAddress(signer.address),
    to: getAddress(accepted.payTo),
    value: accepted.amount,
    validAfter: "0",
    validBefore: String(now + accepted.maxTimeoutSeconds),
    nonce: options.nonce ?? randomNonce(),
  };
  const signature = await signer.signTypedData({
    domain: eip3009Domain({
      chainId,
      token: getAddress(accepted.asset),
      name: accepted.extra.name as string,
      version: accepted.extra.version as string,
    }),
    types: transferWithAuthorizationTypes,
    primaryType: "TransferWithAuthorization",
    message: {
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  });
  return {
    x402Version: X402_VERSION,
    resource: required.resource,
    accepted,
    payload: { signature, authorization },
  };
}

/** Encode a payment payload for the `PAYMENT-SIGNATURE` request header. */
export function encodePaymentSignature(payload: X402PaymentPayload): string {
  return encodeBase64Json(payload);
}

/** Decode a `PAYMENT-REQUIRED` response header. */
export function decodePaymentRequired(header: string): X402PaymentRequired {
  return parsePaymentRequired(decodeBase64Json(header));
}

/** Decode a `PAYMENT-RESPONSE` response header. */
export function decodePaymentResponse(header: string): X402SettleResponse {
  return parseSettleResponse(decodeBase64Json(header));
}

/** The 402 challenge on a response, if it carries one. */
export function paymentRequiredFrom(response: Response): X402PaymentRequired | undefined {
  const header = response.headers.get(PAYMENT_REQUIRED_HEADER);
  return header === null ? undefined : decodePaymentRequired(header);
}

/** The settlement on a paid response, if the server reported one. */
export function paymentResponseFrom(response: Response): X402SettleResponse | undefined {
  const header = response.headers.get(PAYMENT_RESPONSE_HEADER);
  return header === null ? undefined : decodePaymentResponse(header);
}

/** Sends `amount` of `token` to `to` from the payer's own wallet and resolves with the transaction hash. */
export type X402TransferSender = (transfer: {
  chainId: number;
  token: Address;
  to: Address;
  amount: bigint;
}) => Promise<Hex>;

/** A `curvy-transfer` option the payer can settle itself. */
export function selectTransferRequirements(
  required: X402PaymentRequired,
  options: SelectExactRequirementsOptions = {},
): X402PaymentRequirements {
  const candidate = required.accepts.find((entry) => {
    if (entry.scheme !== TRANSFER_SCHEME) return false;
    const method = entry.extra.assetTransferMethod;
    if (method !== undefined && method !== TRANSFER_METHOD) return false;
    if (options.network !== undefined && entry.network !== options.network) return false;
    if (options.asset !== undefined && entry.asset.toLowerCase() !== options.asset.toLowerCase()) return false;
    if (!isAddress(entry.asset) || !isAddress(entry.payTo)) return false;
    try {
      parseX402Network(entry.network);
    } catch {
      return false;
    }
    return true;
  });
  if (!candidate) throw new Error("402 response offers no curvy-transfer option this payer accepts");
  if (options.maxAmount !== undefined && BigInt(candidate.amount) > options.maxAmount) {
    throw new Error(`payment of ${candidate.amount} exceeds the payer's maxAmount of ${options.maxAmount}`);
  }
  return candidate;
}

/** Pay a `curvy-transfer` option by sending the tokens yourself; returns the `PAYMENT-SIGNATURE` payload. */
export async function createTransferPayment(
  required: X402PaymentRequired,
  send: X402TransferSender,
  options: SelectExactRequirementsOptions = {},
): Promise<X402PaymentPayload> {
  const accepted = selectTransferRequirements(required, options);
  const txHash = await send({
    chainId: parseX402Network(accepted.network),
    token: getAddress(accepted.asset),
    to: getAddress(accepted.payTo),
    amount: BigInt(accepted.amount),
  });
  return { x402Version: X402_VERSION, resource: required.resource, accepted, payload: { txHash } };
}

export interface X402PayerOptions extends SelectExactRequirementsOptions {
  /** Signs EIP-3009 authorizations for the `exact` scheme. Omit to pay by transfer only. */
  signer?: X402Signer;
  /**
   * Sends plain ERC-20 transfers for the `curvy-transfer` scheme, paying gas itself. When both `signer` and
   * `send` are given, `exact` is preferred and `curvy-transfer` is the fallback.
   */
  send?: X402TransferSender;
  /** The most this payer will ever sign for one request, in token base units. Required: a 402 names its own price. */
  maxAmount: bigint;
  fetch?: typeof globalThis.fetch;
  /** How long `fetch` keeps retrying the same header while the merchant re-offers the same portal. Defaults to 90 s. */
  retryForMs?: number;
  /** Interval between those retries. Defaults to 2 s. */
  retryEveryMs?: number;
  /**
   * Clock in Unix seconds for the authorization's `validBefore`. Defaults to `Date.now()`. Pass the
   * chain's latest block timestamp when the chain clock is skewed, for example on a local Anvil after
   * `evm_increaseTime`, since the token checks `block.timestamp < validBefore`.
   */
  now?: () => number;
}

export interface X402Payer {
  /**
   * `fetch` that pays one 402 automatically and returns the paid response. While the merchant keeps
   * re-offering the same portal (a transfer not mined yet), the same header is retried rather than paying
   * again, and an unfinished transfer for a URL is reused by the next call for that URL.
   */
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  /** Sign a payment for a 402 you already hold and return the `PAYMENT-SIGNATURE` header value. */
  pay(required: X402PaymentRequired): Promise<string>;
}

/**
 * Payer-side helper for the `exact` scheme: wraps `fetch`, and when the server answers 402 with a
 * `PAYMENT-REQUIRED` header, signs one EIP-3009 authorization and retries once with `PAYMENT-SIGNATURE`.
 * The request is replayed, so a `Request` or `init.body` must be re-readable (strings, buffers; not a stream).
 */
export function createX402Payer(options: X402PayerOptions): X402Payer {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("a fetch implementation is required");
  const { signer, send, fetch: _fetch, now, ...selection } = options;
  if (typeof selection.maxAmount !== "bigint" || selection.maxAmount <= 0n)
    throw new Error("maxAmount must be a positive bigint");
  if (!signer && !send) throw new Error("a signer (exact) or a send function (curvy-transfer) is required");

  async function createPayment(required: X402PaymentRequired): Promise<X402PaymentPayload> {
    const offersExact = required.accepts.some((entry) => entry.scheme === EXACT_SCHEME);
    if (signer && (offersExact || !send)) {
      return createExactPayment(required, signer, { ...selection, ...(now ? { now: now() } : {}) });
    }
    if (!send) throw new Error("402 response offers no exact option and this payer cannot send transfers");
    return createTransferPayment(required, send, selection);
  }

  async function pay(required: X402PaymentRequired): Promise<string> {
    return encodePaymentSignature(await createPayment(required));
  }

  /** Transfers sent for a URL whose paid retry has not been accepted yet, by URL. */
  const outstandingTransfers = new Map<string, { header: string; payTo: string; until: number }>();
  const retryForMs = options.retryForMs ?? 90_000;
  const retryEveryMs = options.retryEveryMs ?? 2_000;

  return {
    pay,
    async fetch(input, init) {
      const url = input instanceof Request ? input.url : String(input);
      // Keep an unread copy so the paid retry can resend the same body.
      let retryInput = input instanceof Request ? input.clone() : input;
      const first = await fetchImpl(input, init);
      if (first.status !== 402) return first;
      let required = paymentRequiredFrom(first);
      if (!required) return first;

      for (const [key, entry] of outstandingTransfers) if (entry.until <= Date.now()) outstandingTransfers.delete(key);
      // A transfer already sent for this URL and not yet accepted: present it again instead of paying twice.
      const outstanding = outstandingTransfers.get(url);
      const stillOffered = outstanding && required.accepts.some((row) => row.payTo.toLowerCase() === outstanding.payTo);
      let header: string;
      let payTo: string;
      if (outstanding && (stillOffered || Date.now() < outstanding.until)) {
        header = outstanding.header;
        payTo = outstanding.payTo;
      } else {
        outstandingTransfers.delete(url);
        const payload = await createPayment(required);
        header = encodePaymentSignature(payload);
        payTo = payload.accepted.payTo.toLowerCase();
        if (payload.accepted.scheme === TRANSFER_SCHEME) {
          outstandingTransfers.set(url, {
            header,
            payTo,
            until: Date.now() + payload.accepted.maxTimeoutSeconds * 1_000,
          });
        }
      }

      // Retry with the header; while the merchant re-offers the same portal (transfer not mined yet), keep going.
      const deadline = Date.now() + retryForMs;
      for (;;) {
        const headers = new Headers(init?.headers ?? (retryInput instanceof Request ? retryInput.headers : undefined));
        headers.set(PAYMENT_SIGNATURE_HEADER, header);
        const nextInput = retryInput instanceof Request ? retryInput.clone() : retryInput;
        const response = await fetchImpl(retryInput, { ...init, headers });
        retryInput = nextInput;
        if (response.status !== 402) {
          outstandingTransfers.delete(url);
          return response;
        }
        required = paymentRequiredFrom(response);
        const samePortal = required?.accepts.some((row) => row.payTo.toLowerCase() === payTo) ?? false;
        if (!samePortal || Date.now() >= deadline) return response;
        await new Promise((resolve) => setTimeout(resolve, retryEveryMs));
      }
    },
  };
}
