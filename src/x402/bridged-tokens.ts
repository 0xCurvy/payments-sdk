import type { Address } from "viem";

/** A stablecoin on another network that an x402 merchant on Arbitrum One can take `exact` payments in. */
export interface X402BridgedToken {
  chainId: number;
  /** The network's name, for messages. */
  network: string;
  address: Address;
  symbol: string;
  decimals: number;
  /** The EIP-712 domain of its signed transfers (EIP-3009). */
  eip712: { name: string; version: string };
}

/**
 * Stablecoins with signed transfers (EIP-3009) on networks Curvy bridges payments from to Arbitrum One: what
 * `otherNetworks` can offer. Checked on chain in October 2026 (each has `TRANSFER_WITH_AUTHORIZATION_TYPEHASH`
 * and a domain separator that matches this domain). USDT outside Arbitrum One, and BNB Chain's and Gnosis's
 * stablecoins, have no signed transfers, so x402 can't take them there.
 */
export const X402_BRIDGED_TOKENS: readonly Readonly<X402BridgedToken>[] = Object.freeze(
  (
    [
      [1, "Ethereum", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "USD Coin"],
      [8453, "Base", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "USD Coin"],
      [10, "Optimism", "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", "USD Coin"],
      [137, "Polygon", "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", "USD Coin"],
      [59144, "Linea", "0x176211869cA2b568f2A7D4EE941E073a821EE1ff", "USDC"],
    ] as const
  ).map(([chainId, network, address, name]) =>
    Object.freeze({
      chainId,
      network,
      address: address as Address,
      symbol: "USDC",
      decimals: 6,
      eip712: Object.freeze({ name, version: "2" }),
    }),
  ),
);
