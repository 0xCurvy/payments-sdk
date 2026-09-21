import type { Address } from "viem";
import type { MerchantKeySet } from "../../types";
import { parseMerchantKeySet } from "./parseMerchantKeySet";

export interface MerchantSignerInput {
  address: Address;
  notAfter: string | Date;
}

/** Build the versioned document served from `/.well-known/curvy-payments.json`. */
export function buildMerchantKeySet(signers: readonly MerchantSignerInput[]): MerchantKeySet {
  return parseMerchantKeySet({
    version: 1,
    signers: signers.map((signer) => ({
      address: signer.address,
      alg: "eip712-secp256k1",
      notAfter: signer.notAfter instanceof Date ? signer.notAfter.toISOString() : signer.notAfter,
    })),
  });
}
