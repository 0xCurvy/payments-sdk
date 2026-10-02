import type { Address, Hex, PublicClient } from "viem";
import { createPublicClient, erc20Abi, getAddress, http, isAddress, isHex, parseEventLogs } from "viem";
import {
  getCurvyNetwork,
  ROUTED_PAYMENT_CHAIN_ID,
  ROUTED_PAYMENT_TOLERANCE_BPS,
  resolveTokens,
} from "../../chain/networks";
import { predictPortalAddress } from "../../chain/predictPortalAddress";
import { vaultAbi } from "../../contracts";
import {
  type ChainFees,
  type FeeBreakdown,
  minimumPaymentAmount,
  quotePayment,
  readChainFees,
} from "../../economics/fees";
import { createPaymentRequest } from "../../merchant/createPaymentRequest";
import { type RecipientParameters, resolveRecipient } from "../../merchant/internal/resolveRecipient";
import { PaymentVerificationError, verifyPayment } from "../../merchant/verifyPayment";
import type { PaymentIntent } from "../../types";
import { DEFAULT_CHECKOUT_COMPLETE_PATH } from "../../utils/validation";
import { X402_BRIDGED_TOKENS, type X402BridgedToken } from "../bridged-tokens";
import {
  type BroadcasterClient,
  createBroadcasterClient,
  type PortalPaymentStatus,
  TERMINAL_PORTAL_FAILURES,
} from "../broadcaster";
import { facilitatorUrlFor } from "../defaults";
import { createFacilitatorClient, type FacilitatorClient } from "../facilitator";
import { decodeBase64Json, encodeBase64Json } from "../header";
import { parsePaymentPayload, parseTransferPayload, requirementsEqual } from "../parse";
import {
  ASSET_TRANSFER_METHOD,
  type CurvyDeployment,
  EXACT_SCHEME,
  NO_RECOVERY_ADDRESS,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  TRANSFER_METHOD,
  TRANSFER_SCHEME,
  X402_VERSION,
  type X402Network,
  type X402PaymentPayload,
  type X402PaymentRequired,
  type X402PaymentRequirements,
  type X402ResourceInfo,
  type X402SettleResponse,
  x402Network,
} from "../protocol";
import { createMemoryPaymentStore, type X402Payment, type X402PaymentStore } from "./store";

/** The viem `PublicClient` methods the merchant needs. */
export type X402MerchantClient = Pick<
  PublicClient,
  "readContract" | "getChainId" | "getTransactionReceipt" | "getTransaction" | "getBlockNumber" | "getLogs"
>;

export interface X402PaymentEvent {
  type: "challenged" | "settled" | "shielded" | "confirmed" | "failed" | "error";
  payment: X402Payment;
  error?: unknown;
}

/** Payment schemes a merchant can offer in its 402. */
export type X402Scheme = typeof EXACT_SCHEME | typeof TRANSFER_SCHEME;

/**
 * `receivingKeys` (preferred) is the one value from the web app's Payments setup
 * (`CURVY_PAYMENTS_PUBLIC_KEY`); `recipient` is the same public keys as three strings. Pass exactly one.
 */
export type X402MerchantConfig = RecipientParameters & X402MerchantOptions;

export interface X402MerchantOptions {
  /**
   * Curvy's portal broadcaster URL or client. It shields every funded portal into your note, the same way it
   * does for human checkout, and tells the SDK the Curvy contract addresses on the chain. Defaults to Curvy's
   * production broadcaster, `https://api.curvy.box`.
   */
  broadcaster?: string | BroadcasterClient;
  /**
   * The x402 v2 facilitator that settles `exact` (EIP-3009) payments. Defaults to Curvy's, served by the
   * broadcaster in use under `/portal/x402` (`https://api.curvy.box/portal/x402` in production). Pass any other
   * x402 v2 facilitator URL (for example Coinbase's) to use it instead, or `false` to offer only `curvy-transfer`,
   * where the payer sends the tokens itself.
   */
  facilitator?: string | FacilitatorClient | false;
  /** Schemes to offer. Defaults to `exact` and `curvy-transfer`, or `curvy-transfer` alone when `facilitator` is false. */
  schemes?: X402Scheme[];
  /** JSON-RPC endpoint of the payment chain. Alternatively pass `publicClient`. */
  rpcUrl?: string;
  publicClient?: X402MerchantClient;
  /**
   * The tokens you charge in, preferred first: symbols Curvy takes on the chain (`"USDC"`, `"USDT"`) or addresses,
   * each registered in the Curvy vault, all with the same decimals. Default: every token Curvy takes there (USDC
   * and USDT on Arbitrum One, USDC on Sepolia); required on any other chain. The 402 offers each of them.
   */
  tokens?: string[];
  /**
   * EIP-712 domains of tokens the SDK doesn't know, by address. Curvy's tokens have theirs built in; any other is
   * read from the contract (`name()`, `version()`) when omitted.
   */
  tokenDomains?: Record<string, { name: string; version: string }>;
  /**
   * Also take `exact` payments on these networks (chain ids), such as Base (`8453`), in the same token. Curvy
   * bridges them to Arbitrum One, and what that costs, at most 3% of the price, comes out of what you receive. For a
   * merchant on Arbitrum One with a facilitator that settles there (Curvy's does). Only USDC has signed transfers on
   * those networks: Ethereum, Base, Optimism, Polygon and Linea (`X402_BRIDGED_TOKENS`). A network is offered for a
   * price only while its bridge is quoted under 3%. The merchant reads no chain but its own, so there the
   * facilitator's settlement is what lets the resource be served, as with any x402 merchant; the shield on Arbitrum
   * One is still verified before the payment counts as confirmed.
   */
  otherNetworks?: number[];
  /**
   * Curvy contract addresses. Built into the SDK for Curvy's networks (Arbitrum One, Ethereum Sepolia); on any
   * other chain, discovered from the broadcaster (`GET /portal/networks/:chainId`) when omitted. Pass them for such
   * a chain in production, so confirmation does not depend on what a service says.
   */
  addresses?: Partial<CurvyDeployment>;
  /**
   * The portal recovery address. Defaults to `NO_RECOVERY_ADDRESS`, which nobody controls, so funds in a
   * portal the broadcaster never shields are lost. Set your own key to be able to `Portal.recover()` them.
   */
  recovery?: Address;
  /** Seconds the broadcaster keeps trying to shield a funded portal. Defaults to 86 400. */
  shieldDeadlineSeconds?: number;
  /**
   * Refuse prices below the broadcaster's USD minimum per portal (`minPortalUsd` from
   * `GET /portal/networks/:chainId`), treating the token as USD-pegged with the decimals the broadcaster
   * reports. Portals below that minimum are never shielded and, without a recovery address, their funds
   * are lost, so this defaults to true. Set false only for non-USD tokens with your own guard.
   */
  enforceBroadcasterMinimum?: boolean;
  /** `curvy-transfer` only: how long to wait for a presented transfer transaction to be mined. Defaults to 60 s. */
  settleTimeoutMs?: number;
  /** `curvy-transfer` only: blocks the transfer must have before the resource is served. Defaults to 1 (inclusion). */
  transferConfirmations?: number;
  /** Blocks before `confirm` treats a shield as final. Defaults to 12. */
  confirmations?: number;
  /** Seconds a 402 challenge (and the payer's authorization) stays valid. Defaults to 300. */
  challengeTtlSeconds?: number;
  /**
   * Your public origin, for example `https://api.example.com`. Defaults to the request URL's origin, or
   * the `Host` header (+ `X-Forwarded-Proto`) when the framework gives a relative URL. Set it behind a proxy.
   */
  merchantOrigin?: string;
  /** Payment persistence. Defaults to an in-memory map. */
  store?: X402PaymentStore;
  /** Lifecycle notifications. Exceptions thrown here are swallowed. */
  onEvent?: (event: X402PaymentEvent) => void;
  /** Shield and confirm in the background after every settlement. Defaults to true. */
  autoShield?: boolean;
  /** Background shield/confirmation cadence and give-up time. Defaults: 2 s, 10 min. Positive integers. */
  confirmPollMs?: number;
  confirmTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export interface X402ChargeOptions {
  /** Gross price of this call in token base units. */
  price: bigint;
  description?: string;
  /** Defaults to `application/json`. */
  mimeType?: string;
  /** Public URL of the resource. Defaults to the request URL (resolved against `merchantOrigin`). */
  resource?: string;
}

type HeadersLike = { get(name: string): string | null } | Record<string, string | string[] | undefined>;

/** A Fetch `Request` satisfies this; so does `{ method, url, headers }` from Express or Fastify. */
export interface X402RequestLike {
  method?: string;
  url: string;
  headers: HeadersLike;
}

export interface X402HttpResponse {
  status: 402;
  headers: Record<string, string>;
  body: X402PaymentRequired;
}

export type X402ChargeResult =
  | {
      status: "payment-required";
      /** The challenge to answer. Send `response` to the client. */
      payment: X402Payment;
      response: X402HttpResponse;
      /** Why a presented payment was not accepted, if one was. */
      error?: string;
    }
  | {
      status: "paid";
      payment: X402Payment;
      /** Add these to your 200 response (`PAYMENT-RESPONSE`, `Cache-Control`). */
      headers: Record<string, string>;
    };

/** A token an x402 merchant charges in. */
export interface X402MerchantToken {
  address: Address;
  symbol?: string;
  decimals: number;
  /** The token's id in the Curvy vault. */
  vaultTokenId: bigint;
  /** Its EIP-712 domain, for `exact`; absent when only `curvy-transfer` is offered. */
  domain?: { name: string; version: string };
}

export interface X402Merchant {
  readonly chainId: number;
  readonly network: X402Network;
  /** The tokens the 402 offers on this network, preferred first. */
  readonly tokens: readonly X402MerchantToken[];
  /** Other networks the 402 may offer `exact` on, with the token there; Curvy bridges those payments over. */
  readonly otherNetworks: readonly Readonly<X402BridgedToken>[];
  readonly addresses: CurvyDeployment;
  readonly schemes: readonly X402Scheme[];
  /** The recovery address every `payTo` is derived with. */
  readonly recovery: Address;
  readonly broadcaster: BroadcasterClient;
  readonly facilitator?: FacilitatorClient;
  /**
   * Handle one request to a paid resource. Without a valid `PAYMENT-SIGNATURE` you get a 402 to send back.
   * With one, the payment is verified and settled before this resolves as `paid`. Facilitator hiccups
   * become 402s that re-offer the same challenge; it throws only when the chain cannot be read, the price is
   * below the fee floor, or the merchant was closed.
   */
  charge(request: X402RequestLike, options: X402ChargeOptions): Promise<X402ChargeResult>;
  getPayment(payTo: string): Promise<X402Payment | undefined>;
  listPayments(): Promise<X402Payment[]>;
  /**
   * Shield a settled payment into your note by registering the funded portal with the broadcaster and reading
   * its progress. Automatic unless `autoShield` is false. For a `settling` payment whose settlement reply was
   * lost, it first checks the portal's balance.
   */
  shield(payTo: string): Promise<X402Payment>;
  /**
   * One `verifyPayment` attempt: by shield transaction when known, otherwise by scanning the aggregator for
   * your payment reference (slower, works even if the shield reply was lost). Automatic unless `autoShield` is false.
   */
  confirm(payTo: string): Promise<X402Payment>;
  /** Current on-chain fees for one of your tokens (cached); the first by default. */
  fees(token?: string): Promise<ChainFees>;
  /** What a payer's `price` leaves in your note after fees, in one of your tokens; the first by default. */
  quote(price: bigint, token?: string): Promise<FeeBreakdown>;
  /**
   * The smallest price that still credits your note in every one of your tokens: the on-chain fee floor, or the
   * broadcaster's minimum if higher.
   */
  minimumPrice(): Promise<bigint>;
  /** The broadcaster's USD minimum per portal, if it reports one. */
  readonly minimumPortalUsd?: number;
  /** Stop background shield/confirm work. */
  close(): void;
}

const erc20DomainAbi = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "version", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

/** The broadcaster will never shield this portal; retrying is pointless. */
export class ShieldRefusedError extends Error {
  constructor(
    readonly state: string,
    detail?: string,
  ) {
    super(`portal ${state}${detail ? `: ${detail}` : ""}`);
    this.name = "ShieldRefusedError";
  }
}

function headerValue(headers: HeadersLike, name: string): string | undefined {
  if (typeof (headers as { get?: unknown }).get === "function") {
    return (headers as { get(name: string): string | null }).get(name) ?? undefined;
  }
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    if (key.toLowerCase() !== wanted) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Build a Fetch `Response` from a 402 result, for Hono, Bun, Deno or Node's `Response`-based servers. */
export function toResponse(response: X402HttpResponse): Response {
  return new Response(JSON.stringify(response.body), { status: response.status, headers: response.headers });
}

export async function createX402Merchant(config: X402MerchantConfig): Promise<X402Merchant> {
  // A mistyped or cut-off receiving key fails here, before any network call.
  const recipient = resolveRecipient(config);
  const fetchOption = config.fetch ? { fetch: config.fetch } : {};
  const broadcaster =
    config.broadcaster === undefined || typeof config.broadcaster === "string"
      ? createBroadcasterClient({
          ...(config.broadcaster === undefined ? {} : { url: config.broadcaster }),
          ...fetchOption,
        })
      : config.broadcaster;
  // The facilitator travels with the broadcaster: a local stack's broadcaster serves its own under /portal/x402.
  const facilitator =
    config.facilitator === false
      ? undefined
      : config.facilitator === undefined
        ? createFacilitatorClient({ url: facilitatorUrlFor(broadcaster.url), ...fetchOption })
        : typeof config.facilitator === "string"
          ? createFacilitatorClient({ url: config.facilitator, ...fetchOption })
          : config.facilitator;
  const schemes: X402Scheme[] = config.schemes ?? [...(facilitator ? [EXACT_SCHEME] : []), TRANSFER_SCHEME];
  if (schemes.length === 0) throw new Error("at least one scheme must be offered");
  for (const scheme of schemes) {
    if (scheme === EXACT_SCHEME && !facilitator) throw new Error('the "exact" scheme needs a facilitator');
    if (scheme !== EXACT_SCHEME && scheme !== TRANSFER_SCHEME) throw new Error(`unknown scheme ${String(scheme)}`);
  }
  if (config.publicClient === undefined && config.rpcUrl === undefined)
    throw new Error("rpcUrl or publicClient is required");
  const publicClient: X402MerchantClient =
    config.publicClient ?? createPublicClient({ transport: http(config.rpcUrl as string) });
  const confirmations = config.confirmations ?? 12;
  const challengeTtlSeconds = config.challengeTtlSeconds ?? 300;
  const confirmPollMs = config.confirmPollMs ?? 2_000;
  const confirmTimeoutMs = config.confirmTimeoutMs ?? 600_000;
  const shieldDeadlineSeconds = config.shieldDeadlineSeconds ?? 86_400;
  const settleTimeoutMs = config.settleTimeoutMs ?? 60_000;
  const transferConfirmations = config.transferConfirmations ?? 1;
  for (const [name, value] of [
    ["transferConfirmations", transferConfirmations],
    ["confirmations", confirmations],
    ["challengeTtlSeconds", challengeTtlSeconds],
    ["confirmPollMs", confirmPollMs],
    ["confirmTimeoutMs", confirmTimeoutMs],
    ["shieldDeadlineSeconds", shieldDeadlineSeconds],
    ["settleTimeoutMs", settleTimeoutMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  }
  const autoShield = config.autoShield ?? true;
  const store = config.store ?? createMemoryPaymentStore();
  const merchantOrigin = (() => {
    if (config.merchantOrigin === undefined) return undefined;
    const url = new URL(config.merchantOrigin);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("merchantOrigin must be http(s)");
    return url.origin;
  })();

  const chainId = await publicClient.getChainId();
  const network = x402Network(chainId);
  const tokenAddresses = resolveTokens(chainId, config.tokens);
  if (tokenAddresses.length === 0) throw new Error(`tokens are required: chain ${chainId} is not a Curvy network`);

  // The facilitator only needs to speak x402 v2 `exact` on this chain; any standard one will do.
  if (facilitator && schemes.includes(EXACT_SCHEME)) {
    const supported = await facilitator.supported();
    const offersExact = supported.kinds.some(
      (kind) => kind.x402Version === X402_VERSION && kind.scheme === EXACT_SCHEME && kind.network === network,
    );
    if (!offersExact) {
      throw new Error(
        `facilitator ${facilitator.url} does not support x402 v${X402_VERSION} "${EXACT_SCHEME}" on ${network}`,
      );
    }
  }
  const recovery: Address = getAddress(config.recovery ?? NO_RECOVERY_ADDRESS);
  // Configured addresses first, then the SDK's own for Curvy's networks; only other chains need the broadcaster's.
  const builtIn = getCurvyNetwork(chainId);
  const configured = {
    aggregator: config.addresses?.aggregator ?? builtIn?.aggregator,
    portalFactory: config.addresses?.portalFactory ?? builtIn?.portalFactory,
    vault: config.addresses?.vault ?? builtIn?.vault,
  };
  const discovered =
    configured.aggregator && configured.portalFactory && configured.vault && config.enforceBroadcasterMinimum === false
      ? undefined
      : await broadcaster.network(chainId);
  const addresses = {
    aggregator: configured.aggregator ?? discovered?.aggregator,
    portalFactory: configured.portalFactory ?? discovered?.portalFactory,
    vault: configured.vault ?? discovered?.vault,
  };
  for (const [name, value] of Object.entries(addresses)) {
    if (!value) throw new Error(`addresses.${name} is required: the broadcaster does not serve chain ${chainId}`);
  }
  const deployment = {
    aggregator: getAddress(addresses.aggregator as Address),
    portalFactory: getAddress(addresses.portalFactory as Address),
    vault: getAddress(addresses.vault as Address),
  };

  const curvyCurrencies = getCurvyNetwork(chainId)?.currencies ?? [];
  const offersExact = schemes.includes(EXACT_SCHEME);
  const tokens: X402MerchantToken[] = await Promise.all(
    tokenAddresses.map(async (address): Promise<X402MerchantToken> => {
      const vaultTokenId = await publicClient.readContract({
        address: deployment.vault,
        abi: vaultAbi,
        functionName: "getTokenId",
        args: [address],
      });
      if (vaultTokenId === 0n) throw new Error(`token ${address} is not registered in vault ${deployment.vault}`);
      const known = curvyCurrencies.find((currency) => currency.address === address);
      const configuredDomain = Object.entries(config.tokenDomains ?? {}).find(
        ([key]) => isAddress(key) && getAddress(key) === address,
      )?.[1];
      const [symbol, decimals, domain] = await Promise.all([
        known?.symbol ?? readSymbol(address),
        known?.decimals ?? publicClient.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
        // Only `exact` signs with the token's domain; a transfer-only merchant needs none.
        offersExact ? (configuredDomain ?? known?.eip712 ?? readTokenDomain(address)) : undefined,
      ]);
      return {
        address,
        ...(symbol === undefined ? {} : { symbol }),
        decimals: Number(decimals),
        vaultTokenId,
        ...(domain === undefined ? {} : { domain }),
      };
    }),
  );
  // One price is charged in any of them.
  if (new Set(tokens.map((token) => token.decimals)).size > 1) throw new Error("tokens must share decimals");
  const [primary] = tokens as [X402MerchantToken, ...X402MerchantToken[]];

  async function readSymbol(address: Address): Promise<string | undefined> {
    return publicClient.readContract({ address, abi: erc20Abi, functionName: "symbol" }).catch(() => undefined);
  }

  async function readTokenDomain(address: Address): Promise<{ name: string; version: string }> {
    try {
      const [name, version] = await Promise.all([
        publicClient.readContract({ address, abi: erc20DomainAbi, functionName: "name" }),
        publicClient.readContract({ address, abi: erc20DomainAbi, functionName: "version" }),
      ]);
      return { name, version };
    } catch (error) {
      throw new Error(`could not read the EIP-712 domain of ${address}; set tokenDomains: ${errorMessage(error)}`);
    }
  }

  /** The merchant's token with this address, or the first. */
  function tokenFor(address: string | undefined): X402MerchantToken {
    return (
      tokens.find((token) => address !== undefined && token.address.toLowerCase() === address.toLowerCase()) ?? primary
    );
  }

  // Other networks: the same token there (by symbol), with signed transfers, bridged here by Curvy.
  const otherNetworks = (config.otherNetworks ?? []).map((otherChainId) => {
    if (otherChainId === chainId) throw new Error(`otherNetworks must not include this network (${chainId})`);
    if (chainId !== ROUTED_PAYMENT_CHAIN_ID) {
      throw new Error(
        `otherNetworks needs a merchant on Arbitrum One (${ROUTED_PAYMENT_CHAIN_ID}): Curvy bridges only there`,
      );
    }
    if (!facilitator || !offersExact) throw new Error('otherNetworks needs the "exact" scheme and a facilitator');
    const option = X402_BRIDGED_TOKENS.find(
      (candidate) =>
        candidate.chainId === otherChainId &&
        tokens.some((token) => token.symbol === candidate.symbol && token.decimals === candidate.decimals),
    );
    if (!option) {
      throw new Error(`chain ${otherChainId} has no token with signed transfers like yours (see X402_BRIDGED_TOKENS)`);
    }
    return option;
  });
  if (otherNetworks.length > 0) {
    if (!broadcaster.estimateBridge) throw new Error("otherNetworks needs a broadcaster that quotes bridges");
    const supported = await (facilitator as FacilitatorClient).supported();
    for (const option of otherNetworks) {
      const served = supported.kinds.some(
        (kind) =>
          kind.x402Version === X402_VERSION &&
          kind.scheme === EXACT_SCHEME &&
          kind.network === x402Network(option.chainId),
      );
      if (!served) throw new Error(`the facilitator does not settle "${EXACT_SCHEME}" on ${option.network}`);
    }
  }

  /** The merchant's token a payment on `requirements` counts in: the one paid here, or the one bridged into. */
  function tokenPaidBy(requirements: X402PaymentRequirements): X402MerchantToken {
    if (requirements.network === network) return tokenFor(requirements.asset);
    const option = otherNetworks.find((candidate) => x402Network(candidate.chainId) === requirements.network);
    return tokens.find((token) => token.symbol === option?.symbol) ?? primary;
  }

  // The broadcaster's USD minimum, in token base units, assuming USD-pegged tokens (they share decimals).
  const broadcasterFloor = (() => {
    if (config.enforceBroadcasterMinimum === false || !discovered?.minPortalUsd) return 0n;
    const currency = discovered.currencies.find((entry) => tokens.some((token) => token.address === entry.address));
    if (!currency) return 0n;
    return BigInt(Math.ceil(discovered.minPortalUsd * 10 ** currency.decimals));
  })();

  const feesCache = new Map<Address, Promise<ChainFees>>();
  function fees(address?: string): Promise<ChainFees> {
    const token = tokenFor(address).address;
    let cached = feesCache.get(token);
    if (!cached) {
      cached = readChainFees({ publicClient, vaultAddress: deployment.vault, token }).catch((error) => {
        feesCache.delete(token);
        throw error;
      });
      feesCache.set(token, cached);
    }
    return cached;
  }
  /** The highest floor among the tokens, so a price is payable in every one of them. */
  async function minimumPrice(): Promise<bigint> {
    const floors = await Promise.all(
      tokens.map(async (token) => minimumPaymentAmount({ fees: await fees(token.address), rail: "portal" })),
    );
    return [...floors, broadcasterFloor].reduce((highest, floor) => (floor > highest ? floor : highest), 0n);
  }

  /** A bridge quote per network, token and price, kept a minute: one 402 shouldn't wait on every network each time. */
  const BRIDGE_QUOTE_TTL_MS = 60_000;
  const bridgeQuotes = new Map<string, { at: number; offered: Promise<boolean> }>();

  /**
   * Other networks a price can be paid on: those whose bridge here is quoted to deliver at least the price less
   * `ROUTED_PAYMENT_TOLERANCE_BPS`. A network whose quote fails isn't offered this time.
   */
  async function bridgedOptions(price: bigint, payTo: Address): Promise<Readonly<X402BridgedToken>[]> {
    const offered = await Promise.all(
      otherNetworks.map((option) => {
        const key = `${option.chainId}:${price}`;
        const cached = bridgeQuotes.get(key);
        if (cached && Date.now() - cached.at < BRIDGE_QUOTE_TTL_MS) return cached.offered;
        const into = tokens.find((token) => token.symbol === option.symbol) ?? primary;
        const quote = (broadcaster.estimateBridge as NonNullable<BroadcasterClient["estimateBridge"]>)({
          fromChainId: option.chainId,
          toChainId: chainId,
          fromToken: option.address,
          toToken: into.address,
          fromAmount: price,
          fromAddress: payTo,
        }).then(
          ({ toAmountMin }) => toAmountMin >= price - (price * BigInt(ROUTED_PAYMENT_TOLERANCE_BPS)) / 10_000n,
          () => {
            bridgeQuotes.delete(key);
            return false;
          },
        );
        bridgeQuotes.set(key, { at: Date.now(), offered: quote });
        return quote;
      }),
    );
    return otherNetworks.filter((_, index) => offered[index]);
  }

  const timers = new Map<ReturnType<typeof setTimeout>, () => void>();
  let closed = false;
  /** Payments with a verify/settle or shield in flight in this process, by lowercase payTo. */
  const inFlight = new Set<string>();

  /** Move a payment between statuses exactly once, through the store's atomic claim when it has one. */
  async function claim(payment: X402Payment, from: X402Payment["status"], to: X402Payment["status"]): Promise<boolean> {
    if (store.claim) {
      const ok = await store.claim(payment.payTo, from, to);
      if (ok) payment.status = to;
      return ok;
    }
    const current = await store.get(payment.payTo);
    if (!current || current.status !== from) return false;
    current.status = to;
    payment.status = to;
    await store.put(current);
    return true;
  }

  function emit(type: X402PaymentEvent["type"], payment: X402Payment, error?: unknown): void {
    try {
      config.onEvent?.({ type, payment, ...(error === undefined ? {} : { error }) });
    } catch {
      // Listener failures must not affect payment handling.
    }
  }

  async function load(payTo: string): Promise<X402Payment | undefined> {
    if (!/^0x[0-9a-fA-F]{40}$/.test(payTo)) return undefined;
    const payment = await store.get(payTo);
    if (payment?.status === "pending" && payment.expiresAt <= Date.now()) {
      payment.status = "expired";
      await store.put(payment);
    }
    return payment;
  }

  /** Sleep that wakes early on `close()`, so nothing awaiting it hangs. */
  function later(ms: number): Promise<void> {
    if (closed) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        resolve();
      }, ms);
      timers.set(timer, resolve);
    });
  }

  /** What `payTo` holds of one of the merchant's tokens on this network. */
  function portalBalance(payTo: Address, token: Address): Promise<bigint> {
    return publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [payTo] });
  }

  /**
   * The public URL of the resource. Fetch `Request`s carry an absolute URL; Express and Fastify give a
   * path, which is resolved against `merchantOrigin` or, failing that, the request's `Host` header.
   */
  function resolveResource(request: X402RequestLike, explicit: string | undefined): string {
    const raw = explicit ?? request.url;
    let base = merchantOrigin;
    if (base === undefined && !/^https?:\/\//i.test(raw)) {
      const host = headerValue(request.headers, "host");
      if (!host) throw new Error("request.url is relative and no merchantOrigin or Host header is available");
      const proto = headerValue(request.headers, "x-forwarded-proto")?.split(",")[0]?.trim() || "http";
      base = `${proto}://${host}`;
    }
    const url = new URL(raw, base);
    url.hash = "";
    return url.href;
  }

  function resourceInfo(resource: string, options: X402ChargeOptions): X402ResourceInfo {
    return {
      url: resource,
      ...(options.description === undefined ? {} : { description: options.description }),
      mimeType: options.mimeType ?? "application/json",
    };
  }

  function paymentRequired(payment: X402Payment, resource: X402ResourceInfo, error?: string): X402ChargeResult {
    const body: X402PaymentRequired = {
      x402Version: X402_VERSION,
      ...(error === undefined ? {} : { error }),
      resource,
      accepts: payment.accepts,
    };
    return {
      status: "payment-required",
      payment,
      ...(error === undefined ? {} : { error }),
      response: {
        status: 402,
        headers: {
          [PAYMENT_REQUIRED_HEADER]: encodeBase64Json(body),
          "content-type": "application/json",
          "cache-control": "no-store",
        },
        body,
      },
    };
  }

  async function challenge(resource: string, options: X402ChargeOptions, error?: string): Promise<X402ChargeResult> {
    const intent = await createPaymentRequest({
      recipient,
      amount: options.price,
      token: primary.address,
      chainId,
      merchantOrigin: merchantOrigin ?? new URL(resource).origin,
      ttlSeconds: challengeTtlSeconds,
    });
    const payTo = await predictPortalAddress({
      publicClient,
      portalFactoryAddress: deployment.portalFactory,
      ownerHash: intent.ownerHash,
      recovery,
    });
    const base = { amount: options.price.toString(), payTo, maxTimeoutSeconds: challengeTtlSeconds };
    const exact = (on: X402Network, asset: Address, domain: { name: string; version: string }) => ({
      ...base,
      network: on,
      asset,
      scheme: EXACT_SCHEME,
      extra: { name: domain.name, version: domain.version, assetTransferMethod: ASSET_TRANSFER_METHOD },
    });
    // Each token here in each scheme, then `exact` on the other networks whose bridge is quoted under the limit.
    const accepts: X402PaymentRequirements[] = [
      ...tokens.flatMap((token) =>
        schemes.map((scheme) =>
          scheme === EXACT_SCHEME
            ? exact(network, token.address, token.domain as { name: string; version: string })
            : {
                ...base,
                network,
                asset: token.address,
                scheme: TRANSFER_SCHEME,
                extra: { assetTransferMethod: TRANSFER_METHOD },
              },
        ),
      ),
      ...(await bridgedOptions(options.price, payTo)).map((option) =>
        exact(x402Network(option.chainId), option.address, option.eip712),
      ),
    ];
    const payment: X402Payment = {
      payTo,
      status: "pending",
      amount: options.price.toString(),
      resource,
      createdAt: Date.now(),
      expiresAt: intent.expiry * 1_000,
      accepts,
      note: {
        ownerHash: intent.ownerHash,
        ephemeralKey: [intent.ephemeralKeyX, intent.ephemeralKeyY],
        viewTag: intent.viewTag,
      },
    };
    await store.put(payment);
    emit("challenged", payment);
    return paymentRequired(payment, resourceInfo(resource, options), error);
  }

  async function fail(payment: X402Payment, error: string): Promise<void> {
    payment.status = "failed";
    payment.error = error;
    await store.put(payment);
    emit("failed", payment);
  }

  async function markSettled(payment: X402Payment, settlement: X402SettleResponse): Promise<X402ChargeResult> {
    payment.status = "settled";
    delete payment.error;
    if (settlement.payer && isAddress(settlement.payer)) payment.payer = getAddress(settlement.payer);
    if (isHex(settlement.transaction) && settlement.transaction.length === 66) {
      payment.settleTxHash = settlement.transaction as Hex;
    }
    await store.put(payment);
    emit("settled", payment);
    if (autoShield) void shieldAndConfirm(payment.payTo);
    return {
      status: "paid",
      payment,
      headers: { [PAYMENT_RESPONSE_HEADER]: encodeBase64Json(settlement), "cache-control": "no-store" },
    };
  }

  /** `exact`: settle a claimed (`settling`) payment through the facilitator. */
  async function settleExact(
    payment: X402Payment,
    requirements: X402PaymentRequirements,
    payload: X402PaymentPayload,
    resource: string,
    options: X402ChargeOptions,
    info: X402ResourceInfo,
  ): Promise<X402ChargeResult> {
    if (!facilitator) throw new Error("no facilitator configured");
    // On another network the merchant reads no chain: the facilitator's settlement is the go-ahead there.
    const bridged = requirements.network !== network;
    const asset = getAddress(requirements.asset);
    let settlement: X402SettleResponse;
    try {
      settlement = await facilitator.settle(payload, requirements);
    } catch (error) {
      // Indeterminate: the transfer may have landed. Keep the challenge so the same header can be retried
      // (the facilitator dedupes by payer + nonce) and `shield()` can check the portal.
      payment.error = `settlement outcome unknown: ${errorMessage(error)}`;
      await store.put(payment);
      emit("error", payment, error);
      return paymentRequired(payment, info, "settlement could not be completed; retry the same payment");
    }
    if (!settlement.success) {
      // A retry after a lost reply makes standard facilitators answer "nonce already used" although the
      // transfer landed. The portal balance decides, never the facilitator's word.
      if (!bridged && (await portalBalance(payment.payTo, asset)) >= BigInt(payment.amount)) {
        return markSettled(payment, {
          success: true,
          transaction: "",
          network,
          ...(payment.payer ? { payer: payment.payer } : {}),
        });
      }
      await fail(payment, `settlement failed: ${settlement.errorMessage ?? settlement.errorReason ?? "unknown"}`);
      return challenge(
        resource,
        options,
        `settlement failed: ${settlement.errorReason ?? "rejected by the facilitator"}`,
      );
    }
    // The facilitator's word is not the gate here: the portal must actually hold the amount. On another network, as
    // with any x402 merchant, it is; the shield on this network is still verified before the payment is confirmed.
    if (!bridged && (await portalBalance(payment.payTo, asset)) < BigInt(payment.amount)) {
      payment.error = "facilitator reported success but the portal is not funded";
      await store.put(payment);
      emit("error", payment, new Error(payment.error));
      return paymentRequired(payment, info, "settlement is not visible on chain yet; retry the same payment");
    }
    return markSettled(payment, settlement);
  }

  /** `curvy-transfer`: the payer moved the tokens itself; the proof is the portal's balance. */
  async function settleTransfer(
    payment: X402Payment,
    requirements: X402PaymentRequirements,
    payload: X402PaymentPayload,
    info: X402ResourceInfo,
  ): Promise<X402ChargeResult> {
    const asset = getAddress(requirements.asset);
    let transfer: ReturnType<typeof parseTransferPayload>;
    try {
      transfer = parseTransferPayload(payload.payload);
    } catch (error) {
      return paymentRequired(payment, info, `invalid transfer payload: ${errorMessage(error)}`);
    }
    let payer: Address | undefined;
    if (transfer.txHash) {
      // Wait for the presented transaction (and its confirmations), then take the sender from its receipt.
      const deadline = Date.now() + settleTimeoutMs;
      let receipt: Awaited<ReturnType<X402MerchantClient["getTransactionReceipt"]>> | undefined;
      while (!receipt && !closed) {
        try {
          const candidate = await publicClient.getTransactionReceipt({ hash: transfer.txHash });
          const head = await publicClient.getBlockNumber();
          if (head - candidate.blockNumber + 1n >= BigInt(transferConfirmations)) receipt = candidate;
        } catch {
          // Not mined yet.
        }
        if (!receipt) {
          if (Date.now() >= deadline) {
            return paymentRequired(payment, info, "the transfer transaction was not found; retry once it is mined");
          }
          await later(Math.min(1_000, confirmPollMs));
        }
      }
      if (!receipt) return paymentRequired(payment, info, "merchant is shutting down; retry the same payment");
      if (receipt.status !== "success") return paymentRequired(payment, info, "the transfer transaction reverted");
      const transfers = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs, strict: true });
      const toPortal = transfers.find(
        (log) =>
          log.address.toLowerCase() === asset.toLowerCase() &&
          log.args.to.toLowerCase() === payment.payTo.toLowerCase(),
      );
      if (toPortal) payer = getAddress(toPortal.args.from);
      else if (typeof receipt.from === "string" && isAddress(receipt.from)) payer = getAddress(receipt.from);
    }
    const balance = await portalBalance(payment.payTo, asset);
    if (balance < BigInt(payment.amount)) {
      return paymentRequired(
        payment,
        info,
        `portal ${payment.payTo} holds ${balance} of the ${payment.amount} base units required; retry once funded`,
      );
    }
    // A transfer is irrevocable, so a challenge that expired while it was in flight is still honoured:
    // the balance is the real gate, and the funds could not be recovered otherwise.
    if (!(await claim(payment, payment.status, "settled")))
      return paymentRequired(payment, info, "payment challenge was already used");
    return markSettled(payment, {
      success: true,
      transaction: transfer.txHash ?? "",
      network,
      ...(payer ? { payer } : {}),
    });
  }

  async function charge(request: X402RequestLike, options: X402ChargeOptions): Promise<X402ChargeResult> {
    if (closed) throw new Error("this merchant was closed");
    if (typeof options.price !== "bigint" || options.price <= 0n) throw new Error("price must be a positive bigint");
    const resource = resolveResource(request, options.resource);
    const info = resourceInfo(resource, options);
    const floor = await minimumPrice();
    if (options.price < floor) {
      throw new Error(
        `price ${options.price} is below the minimum of ${floor} base units for these tokens (on-chain fees` +
          `${broadcasterFloor > 0n ? ` and the broadcaster's ${discovered?.minPortalUsd} USD per portal` : ""})`,
      );
    }

    const header = headerValue(request.headers, PAYMENT_SIGNATURE_HEADER);
    if (!header) return challenge(resource, options);

    let payload: X402PaymentPayload;
    try {
      payload = parsePaymentPayload(decodeBase64Json(header));
    } catch (error) {
      return challenge(resource, options, `invalid ${PAYMENT_SIGNATURE_HEADER}: ${errorMessage(error)}`);
    }
    const scheme = payload.accepted.scheme;
    if (!schemes.includes(scheme as X402Scheme)) return challenge(resource, options, `unsupported scheme ${scheme}`);
    if (!isAddress(payload.accepted.payTo)) return challenge(resource, options, "accepted.payTo must be an address");
    const key = payload.accepted.payTo.toLowerCase();
    // Claimed synchronously, before any await, so concurrent retries of one header cannot interleave.
    if (inFlight.has(key)) return challenge(resource, options, "payment challenge is being settled");
    inFlight.add(key);
    try {
      const payment = await load(payload.accepted.payTo);
      if (!payment) return await challenge(resource, options, "unknown payment challenge");
      const lateTransfer = scheme === TRANSFER_SCHEME && payment.status === "expired";
      if (payment.status !== "pending" && payment.status !== "settling" && !lateTransfer) {
        return await challenge(resource, options, `payment challenge is ${payment.status}`);
      }
      const requirements = payment.accepts.find(
        (row) => row.scheme === scheme && requirementsEqual(row, payload.accepted),
      );
      if (!requirements) return paymentRequired(payment, info, "accepted requirements do not match the challenge");
      if (BigInt(payment.amount) !== options.price) {
        return await challenge(resource, options, "the price of this resource changed");
      }
      // Which of the merchant's tokens it counts in, and where it is paid when that's another network.
      payment.token = tokenPaidBy(requirements).address;
      if (requirements.network === network) delete payment.paidOn;
      else payment.paidOn = requirements.network as X402Network;

      if (scheme === TRANSFER_SCHEME) {
        if (payment.status === "settling") return paymentRequired(payment, info, "payment challenge is being settled");
        return await settleTransfer(payment, requirements, payload, info);
      }

      if (payment.status === "pending") {
        if (!facilitator) throw new Error("no facilitator configured");
        let verification: Awaited<ReturnType<FacilitatorClient["verify"]>>;
        try {
          verification = await facilitator.verify(payload, requirements);
        } catch (error) {
          emit("error", payment, error);
          return paymentRequired(payment, info, "facilitator unavailable; retry shortly");
        }
        if (!verification.isValid) {
          return paymentRequired(
            payment,
            info,
            `payment rejected: ${verification.invalidMessage ?? verification.invalidReason ?? "invalid payment"}`,
          );
        }
        // Exactly one settlement per challenge, even across instances sharing a store.
        if (!(await claim(payment, "pending", "settling"))) {
          return await challenge(resource, options, "payment challenge was already used");
        }
        if (verification.payer && isAddress(verification.payer)) payment.payer = getAddress(verification.payer);
        await store.put(payment);
      }
      // `settling` here means an earlier attempt lost the facilitator's reply; settling again is idempotent.
      return await settleExact(payment, requirements, payload, resource, options, info);
    } finally {
      inFlight.delete(key);
    }
  }

  /** For a payment whose settlement reply was lost: does the portal hold the funds? */
  async function reconcileSettling(payment: X402Payment): Promise<boolean> {
    // On another network the merchant can't read the portal; the payer's retry of the same header settles it.
    if (payment.paidOn) return false;
    if ((await portalBalance(payment.payTo, tokenFor(payment.token).address)) < BigInt(payment.amount)) return false;
    payment.status = "settled";
    delete payment.error;
    await store.put(payment);
    emit("settled", payment);
    return true;
  }

  /** Reflect the broadcaster's view of a portal on the payment record. */
  async function applyPortalStatus(payment: X402Payment, status: PortalPaymentStatus): Promise<X402Payment> {
    if (status.portalAddress.toLowerCase() !== payment.payTo.toLowerCase()) {
      throw new Error(`broadcaster answered for portal ${status.portalAddress}, expected ${payment.payTo}`);
    }
    payment.portalState = status.state;
    if (status.state === "shielded") {
      payment.status = "shielded";
      // Without a hash, `confirm()` still finds the note by the payment reference.
      if (status.txHash) payment.shieldTxHash = status.txHash;
      delete payment.error;
      await store.put(payment);
      emit("shielded", payment);
      return payment;
    }
    if (TERMINAL_PORTAL_FAILURES.has(status.state)) {
      const refused = new ShieldRefusedError(status.state, status.error);
      payment.error = `shield refused: ${refused.message}`;
      await store.put(payment);
      emit("error", payment, refused);
      throw refused;
    }
    await store.put(payment);
    return payment;
  }

  async function shieldViaBroadcaster(payment: X402Payment): Promise<X402Payment> {
    const known = await broadcaster.status(payment.payTo);
    const status =
      known ??
      (await broadcaster.registerPayment({
        ownerHash: payment.note.ownerHash,
        ephemeralKeyX: payment.note.ephemeralKey[0],
        ephemeralKeyY: payment.note.ephemeralKey[1],
        viewTag: payment.note.viewTag,
        recovery,
        expectedAmount: payment.amount,
        expiry: Math.floor(Date.now() / 1_000) + shieldDeadlineSeconds,
        chainId,
        // The token it counts in here; Curvy finds it wherever it was paid and bridges it over.
        token: tokenFor(payment.token).address,
      }));
    return applyPortalStatus(payment, status);
  }

  async function shield(payTo: string): Promise<X402Payment> {
    const payment = await load(payTo);
    if (!payment) throw new Error(`unknown payment ${payTo}`);
    if (payment.status === "shielded" || payment.status === "confirmed") return payment;
    const key = payment.payTo.toLowerCase();
    if (inFlight.has(key)) throw new Error(`payment ${payment.payTo} is busy`);
    inFlight.add(key);
    try {
      if (payment.status === "settling" && !(await reconcileSettling(payment))) {
        throw new Error("settlement outcome unknown: the portal holds no funds yet");
      }
      if (payment.status !== "settled") throw new Error(`cannot shield a ${payment.status} payment`);
      return await shieldViaBroadcaster(payment);
    } catch (error) {
      if (!(error instanceof ShieldRefusedError)) {
        payment.error = `shield failed: ${errorMessage(error)}`;
        await store.put(payment);
        emit("error", payment, error);
      }
      throw error;
    } finally {
      inFlight.delete(key);
    }
  }

  async function confirm(payTo: string): Promise<X402Payment> {
    const payment = await load(payTo);
    if (!payment) throw new Error(`unknown payment ${payTo}`);
    if (payment.status === "confirmed") return payment;
    if (payment.status !== "shielded" && payment.status !== "settled") {
      throw new Error(`cannot confirm a ${payment.status} payment`);
    }
    // The shield transaction when the broadcaster reported it; otherwise scan from the transfer into the portal,
    // which always comes first. With neither, wait: the shield poll fills in the shield transaction.
    // A transfer on another network has no block here to scan from.
    const lookup = payment.shieldTxHash
      ? { txHash: payment.shieldTxHash }
      : payment.settleTxHash && !payment.paidOn
        ? { fromBlock: (await publicClient.getTransactionReceipt({ hash: payment.settleTxHash })).blockNumber }
        : null;
    if (!lookup) return payment;
    // The note must pay this request's owner, token and amount after fees, not merely carry its payment reference.
    const verification = await verifyPayment({
      publicClient,
      aggregatorAddress: deployment.aggregator,
      request: paymentRequest(payment),
      confirmations,
      // Only a payment bridged from another network may arrive short, by what the bridge cost; one paid here can't.
      allowBridgeShortfall: payment.paidOn !== undefined,
      ...lookup,
    });
    if (verification.status === "underpaid" || verification.status === "wrong_token") {
      payment.error = `payment ${verification.status.replace("_", " ")}`;
      await store.put(payment);
      emit("error", payment, new Error(payment.error));
      return payment;
    }
    if (verification.status !== "paid" || !verification.payment) return payment;
    payment.noteId = verification.payment.noteId.toString();
    payment.netAmount = verification.payment.netAmount.toString();
    payment.status = "confirmed";
    delete payment.error;
    await store.put(payment);
    emit("confirmed", payment);
    return payment;
  }

  /** `verifyPayment` throws these for a transaction that can never become our shield. */
  function isDefinitiveConfirmError(error: unknown): boolean {
    return (
      error instanceof PaymentVerificationError &&
      (error.code === "REVERTED" || error.code === "NOT_A_SHIELD" || error.code === "UNRELATED")
    );
  }

  /** The request this payment's 402 was issued for, rebuilt from the record and this merchant's settings. */
  function paymentRequest(payment: X402Payment): PaymentIntent {
    return {
      token: tokenFor(payment.token).address,
      amount: payment.amount,
      chainId,
      ownerHash: payment.note.ownerHash,
      ephemeralKeyX: payment.note.ephemeralKey[0],
      ephemeralKeyY: payment.note.ephemeralKey[1],
      viewTag: payment.note.viewTag,
      merchantOrigin: merchantOrigin ?? new URL(payment.resource).origin,
      checkoutCompletePath: DEFAULT_CHECKOUT_COMPLETE_PATH,
      expiry: Math.floor(payment.expiresAt / 1_000),
    };
  }

  async function shieldAndConfirm(payTo: string): Promise<void> {
    // Poll the broadcaster for as long as it keeps trying itself (`shieldDeadlineSeconds`), then confirm.
    const shieldDeadline = Date.now() + shieldDeadlineSeconds * 1_000;
    try {
      while (!closed && Date.now() < shieldDeadline) {
        try {
          const payment = await shield(payTo);
          if (payment.status === "shielded" || payment.status === "confirmed") break;
        } catch (error) {
          if (error instanceof ShieldRefusedError) return;
        }
        await later(confirmPollMs);
      }
      const deadline = Date.now() + confirmTimeoutMs;
      while (!closed && Date.now() < deadline) {
        try {
          const payment = await confirm(payTo);
          if (payment.status === "confirmed") return;
        } catch (error) {
          const payment = await load(payTo);
          if (payment) {
            payment.error = `confirmation failed: ${errorMessage(error)}`;
            await store.put(payment);
            emit("error", payment, error);
          }
          if (isDefinitiveConfirmError(error)) return;
        }
        await later(confirmPollMs);
      }
    } catch (error) {
      // Store failures and the like must not become unhandled rejections.
      let payment: X402Payment | undefined;
      try {
        payment = await store.get(payTo);
      } catch {
        payment = undefined;
      }
      if (payment) emit("error", payment, error);
    }
  }

  return {
    chainId,
    network,
    tokens,
    otherNetworks,
    addresses: deployment,
    schemes,
    recovery,
    broadcaster,
    ...(discovered?.minPortalUsd === undefined ? {} : { minimumPortalUsd: discovered.minPortalUsd }),
    ...(facilitator ? { facilitator } : {}),
    charge,
    getPayment: load,
    listPayments: () => Promise.resolve(store.list()),
    shield,
    confirm,
    fees,
    async quote(price, token) {
      return quotePayment({ grossAmount: price, fees: await fees(token), rail: "portal" });
    },
    minimumPrice,
    close() {
      closed = true;
      for (const [timer, resolve] of timers) {
        clearTimeout(timer);
        resolve();
      }
      timers.clear();
    },
  };
}
