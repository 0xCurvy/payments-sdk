import type { Address } from "viem";
import type { MerchantKeySet } from "../../types";
import { parseMerchantKeySet } from "./parseMerchantKeySet";

export interface MerchantSignerInput {
  address: Address;
  notAfter: string | Date;
}

export interface MerchantKeySetOptions {
  /** Checkout's icon for the shop: an absolute path on the merchant origin to a square PNG or WebP image. */
  icon?: string;
  /** The shop's name in checkout, at most 60 characters of plain text; its address is always shown beside it. */
  name?: string;
}

/** Build the versioned document served from `/.well-known/curvy-payments.json`. */
export function buildMerchantKeySet(
  signers: readonly MerchantSignerInput[],
  options: MerchantKeySetOptions = {},
): MerchantKeySet {
  return parseMerchantKeySet({
    version: 1,
    signers: signers.map((signer) => ({
      address: signer.address,
      alg: "eip712-secp256k1",
      notAfter: signer.notAfter instanceof Date ? signer.notAfter.toISOString() : signer.notAfter,
    })),
    ...(options.icon === undefined ? {} : { icon: options.icon }),
    ...(options.name === undefined ? {} : { name: options.name }),
  });
}
