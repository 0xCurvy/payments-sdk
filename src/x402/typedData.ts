import type { Address } from "viem";

/** EIP-3009 `transferWithAuthorization` types a payer signs for the `exact` scheme. */
export const transferWithAuthorizationTypes = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export interface Eip3009DomainParameters {
  chainId: number;
  /** The EIP-3009 token contract. */
  token: Address;
  /** The token's EIP-712 domain name and version (for USDC: `"USD Coin"`, `"2"`). */
  name: string;
  version: string;
}

/** EIP-712 domain of an EIP-3009 token, as carried in exact requirements' `extra.name` / `extra.version`. */
export function eip3009Domain({ chainId, token, name, version }: Eip3009DomainParameters) {
  return { name, version, chainId, verifyingContract: token } as const;
}
