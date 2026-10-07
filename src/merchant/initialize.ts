import { type Address, getAddress, isAddress } from "viem";
import { normalizeApiBaseUrl } from "../chain/deployment";
import { type CurvyEnvironment, getCurvyNetwork, getDefaultCurvyNetwork, resolveTokens } from "../chain/networks";
import type { PaymentIntent } from "../types";
import {
  DEFAULT_CHECKOUT_COMPLETE_PATH,
  DEFAULT_PAYMENT_REQUEST_TTL_SECONDS,
  paymentRequestTtlSeconds,
} from "../utils/validation";
import { buildPaymentRequest } from "./createPaymentRequest";
import { type RecipientParameters, resolveRecipient } from "./internal/resolveRecipient";
import {
  type PaidWhen,
  type PaymentVerification,
  type VerifyPaymentParameters,
  verifyPayment as verifyStoredPayment,
} from "./verifyPayment";

/**
 * `receivingKeys` (preferred) is the one value from the web app's Payments setup; `recipient` is the same
 * public keys as three strings. Pass exactly one.
 */
export type PaymentSDKConfig = RecipientParameters & {
  /**
   * Where the shop gets paid: `"mainnet"` (Arbitrum One, real money) or `"testnet"` (Ethereum Sepolia, test
   * money). The SDK knows Curvy's contracts there.
   */
  environment: CurvyEnvironment;
  /**
   * The Curvy deployment's API base URL, as in the Curvy SDK: `https://api.curvy.box` (production, the default) or
   * `https://api.curvy.dev` (staging). Payments are checked against the aggregator its metadata registry names
   * (`GET /networks`), read on the first check.
   */
  apiBaseUrl?: string;
  /** Used to read the deployment's contracts. Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
  /**
   * A chain other than the environment's, such as a local one. `aggregatorAddress` pins the aggregator instead of
   * reading it from `apiBaseUrl`.
   */
  network?: { chainId: number; aggregatorAddress?: Address };
  /**
   * The tokens the shop takes: symbols Curvy takes on the network (`"USDC"`, `"USDT"`) or addresses, the first one
   * preferred. Default: all of Curvy's (USDC and USDT on mainnet, USDC on testnet). On mainnet the buyer may pay in
   * any of them on any network where Curvy has a payment address; Curvy bridges it to the shop's network.
   */
  tokens?: string[];
  merchantOrigin: string;
  confirmations: number;
  /**
   * When a verified note counts as `paid`: `"shielded"` (default) once it has `confirmations`
   * blocks, or `"committed"` once it is also in a batch commit and spendable. See {@link PaidWhen}.
   */
  paidWhen?: PaidWhen;
  /** Request lifetime: a positive safe integer of at most 86400 (24 h). Default 600. */
  ttlSeconds?: number;
  checkoutCompletePath?: string;
};

export type BoundVerifyPaymentParameters = Omit<VerifyPaymentParameters, "confirmations" | "paidWhen">;

export interface PaymentSDK {
  /** The chain requests are made for and payments are checked on. Your RPC endpoint must serve it. */
  readonly chainId: number;
  /** The tokens requests take unless one names others; empty on a chain the SDK does not know, unless configured. */
  readonly tokens: readonly Address[];
  /** The Curvy deployment whose contracts payments are checked against. */
  readonly apiBaseUrl: string;
  /** The pinned aggregator (`network.aggregatorAddress`); `undefined` reads the deployment's from `apiBaseUrl`. */
  readonly aggregatorAddress: Address | undefined;
  /**
   * `amount` is in the tokens' base units (USDC and USDT: 6 decimals). `tokens` default to the configured ones.
   * `description` says what the buyer is paying for; checkout shows it and prints it on their receipt.
   */
  createPaymentRequest(parameters: { amount: bigint; tokens?: string[]; description?: string }): Promise<PaymentIntent>;
  /** `verifyPayment` with the aggregator, `confirmations` and `paidWhen` bound from `initialize`. */
  verifyPayment(parameters: BoundVerifyPaymentParameters): Promise<PaymentVerification>;
}

/** The chain, and a pinned aggregator if any: the environment's Curvy network, or the `network` override. */
function resolveNetwork(config: PaymentSDKConfig): { chainId: number; aggregatorAddress: Address | undefined } {
  const preset = getDefaultCurvyNetwork(config.environment);
  if (config.network === undefined) return { chainId: preset.chainId, aggregatorAddress: undefined };

  const { chainId, aggregatorAddress } = config.network;
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error("network.chainId must be a positive safe integer");
  }
  if (aggregatorAddress !== undefined && !isAddress(aggregatorAddress, { strict: false })) {
    throw new Error("network.aggregatorAddress must be an address");
  }
  const known = getCurvyNetwork(chainId);
  if (known && known.testnet !== (config.environment === "testnet")) {
    throw new Error(
      `chain ${chainId} is a ${known.testnet ? "testnet" : "mainnet"} network, not ${config.environment}`,
    );
  }
  return { chainId, aggregatorAddress: aggregatorAddress === undefined ? undefined : getAddress(aggregatorAddress) };
}

export function initialize(config: PaymentSDKConfig): PaymentSDK {
  const recipient = resolveRecipient(config);
  const { chainId, aggregatorAddress } = resolveNetwork(config);
  const apiBaseUrl = normalizeApiBaseUrl(config.apiBaseUrl);
  const defaultTokens = resolveTokens(chainId, config.tokens);
  if (!Number.isSafeInteger(config.confirmations) || config.confirmations <= 0) {
    throw new Error("confirmations must be a positive safe integer");
  }
  const resolvedPaidWhen = config.paidWhen === undefined ? "shielded" : config.paidWhen;
  if (resolvedPaidWhen !== "shielded" && resolvedPaidWhen !== "committed") {
    throw new Error('paidWhen must be "shielded" or "committed"');
  }

  const resolvedMerchantOrigin = (() => {
    if (typeof config.merchantOrigin !== "string") {
      throw new Error("merchantOrigin must be a string");
    }
    const url = new URL(config.merchantOrigin);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== config.merchantOrigin) {
      throw new Error("merchantOrigin must be a bare http or https origin");
    }
    return config.merchantOrigin;
  })();

  const resolvedTtlSeconds = paymentRequestTtlSeconds(config.ttlSeconds ?? DEFAULT_PAYMENT_REQUEST_TTL_SECONDS);

  const resolvedCheckoutCompletePath = (() => {
    const value = config.checkoutCompletePath;
    if (value === undefined) return DEFAULT_CHECKOUT_COMPLETE_PATH;
    if (typeof value !== "string") {
      throw new Error("checkoutCompletePath must be a string");
    }
    if (
      !value.startsWith("/") ||
      value.startsWith("//") ||
      value.includes("\\") ||
      value.includes("?") ||
      value.includes("#") ||
      value.includes("://")
    ) {
      throw new Error("checkoutCompletePath must be an absolute path on the merchant origin");
    }
    const resolved = new URL(value, "https://merchant.invalid");
    if (resolved.pathname !== value || resolved.search !== "" || resolved.hash !== "") {
      throw new Error("checkoutCompletePath must be an absolute path on the merchant origin");
    }
    return value;
  })();

  return {
    chainId,
    tokens: defaultTokens,
    apiBaseUrl,
    aggregatorAddress,
    async createPaymentRequest(parameters) {
      const tokens = parameters.tokens === undefined ? defaultTokens : resolveTokens(chainId, parameters.tokens);
      if (tokens.length === 0) throw new Error(`tokens are required: chain ${chainId} has no default tokens`);
      return buildPaymentRequest({
        recipient,
        amount: parameters.amount,
        token: tokens[0],
        tokens,
        chainId,
        merchantOrigin: resolvedMerchantOrigin,
        checkoutCompletePath:
          resolvedCheckoutCompletePath === DEFAULT_CHECKOUT_COMPLETE_PATH ? undefined : resolvedCheckoutCompletePath,
        ttlSeconds: resolvedTtlSeconds,
        ...(parameters.description === undefined ? {} : { description: parameters.description }),
      });
    },
    verifyPayment(parameters) {
      return verifyStoredPayment({
        ...parameters,
        aggregatorAddress: parameters.aggregatorAddress ?? aggregatorAddress,
        apiBaseUrl,
        ...(config.fetch ? { fetch: config.fetch } : {}),
        confirmations: config.confirmations,
        paidWhen: resolvedPaidWhen,
      });
    },
  };
}
