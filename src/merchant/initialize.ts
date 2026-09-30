import type { Address } from "viem";
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
  chainId: number;
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
  /** `description` says what the buyer is paying for; checkout shows it and prints it on their receipt. */
  createPaymentRequest(parameters: { amount: bigint; token: Address; description?: string }): Promise<PaymentIntent>;
  /** `verifyPayment` with `confirmations` and `paidWhen` bound from `initialize`. */
  verifyPayment(parameters: BoundVerifyPaymentParameters): Promise<PaymentVerification>;
}

export function initialize(config: PaymentSDKConfig): PaymentSDK {
  const recipient = resolveRecipient(config);
  if (!Number.isSafeInteger(config.chainId) || config.chainId <= 0) {
    throw new Error("chainId must be a positive safe integer");
  }
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
    createPaymentRequest(parameters) {
      return buildPaymentRequest({
        recipient,
        amount: parameters.amount,
        token: parameters.token,
        chainId: config.chainId,
        merchantOrigin: resolvedMerchantOrigin,
        checkoutCompletePath:
          resolvedCheckoutCompletePath === DEFAULT_CHECKOUT_COMPLETE_PATH ? undefined : resolvedCheckoutCompletePath,
        ttlSeconds: resolvedTtlSeconds,
        ...(parameters.description === undefined ? {} : { description: parameters.description }),
      });
    },
    verifyPayment(parameters) {
      return verifyStoredPayment({ ...parameters, confirmations: config.confirmations, paidWhen: resolvedPaidWhen });
    },
  };
}
