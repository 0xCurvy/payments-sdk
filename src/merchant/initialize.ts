import type { Address } from "viem";
import type { PaymentIntent, PaymentRecipient } from "../types";
import {
  DEFAULT_CHECKOUT_COMPLETE_PATH,
  DEFAULT_PAYMENT_REQUEST_TTL_SECONDS,
} from "../utils/validation";
import { verifyPayment as verifyPaymentOnChain, type VerifyPaymentParameters } from "../chain/verifyPayment";
import { buildPaymentRequest } from "./createPaymentRequest";

export interface PaymentSDKConfig {
  recipient: PaymentRecipient;
  chainId: number;
  merchantOrigin: string;
  confirmations: number;
  ttlSeconds?: number;
  checkoutCompletePath?: string;
}

export type BoundVerifyPaymentParameters = Omit<VerifyPaymentParameters, "confirmations">;

export interface PaymentSDK {
  createPaymentRequest(parameters: { amount: bigint; token: Address }): Promise<PaymentIntent>;
  verifyPayment(parameters: BoundVerifyPaymentParameters): Promise<boolean>;
}

export function initialize(config: PaymentSDKConfig): PaymentSDK {
  if (!Number.isSafeInteger(config.chainId) || config.chainId <= 0) {
    throw new Error("chainId must be a positive safe integer");
  }
  if (!Number.isSafeInteger(config.confirmations) || config.confirmations <= 0) {
    throw new Error("confirmations must be a positive safe integer");
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

  const resolvedTtlSeconds = config.ttlSeconds ?? DEFAULT_PAYMENT_REQUEST_TTL_SECONDS;
  if (!Number.isSafeInteger(resolvedTtlSeconds) || resolvedTtlSeconds <= 0) {
    throw new Error("ttlSeconds must be a positive safe integer");
  }

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
        recipient: config.recipient,
        amount: parameters.amount,
        token: parameters.token,
        chainId: config.chainId,
        merchantOrigin: resolvedMerchantOrigin,
        checkoutCompletePath:
          resolvedCheckoutCompletePath === DEFAULT_CHECKOUT_COMPLETE_PATH
            ? undefined
            : resolvedCheckoutCompletePath,
        ttlSeconds: resolvedTtlSeconds,
      });
    },
    verifyPayment(parameters) {
      return verifyPaymentOnChain({ ...parameters, confirmations: config.confirmations });
    },
  };
}
