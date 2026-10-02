import { type Address, getAddress, isAddress } from "viem";

/** `"mainnet"` takes real money, `"testnet"` test money. */
export type CurvyEnvironment = "mainnet" | "testnet";

/** The Curvy contracts a merchant needs on one chain. */
export interface CurvyDeployment {
  aggregator: Address;
  portalFactory: Address;
  vault: Address;
}

/** A token Curvy shields on a network. */
export interface CurvyCurrency {
  address: Address;
  symbol: string;
  decimals: number;
  /** The token's id in the Curvy vault. */
  vaultTokenId: string;
  /** The EIP-712 domain of the token's signed transfers (EIP-3009), which x402 `exact` payments use. */
  eip712?: { name: string; version: string };
}

/** A Curvy network: the shape of the portal broadcaster's `GET /portal/networks/:chainId`. */
export interface CurvyNetwork extends CurvyDeployment {
  chainId: number;
  name?: string;
  testnet?: boolean;
  /** Portals worth less than this many USD are failed instead of shielded. */
  minPortalUsd?: number;
  currencies: CurvyCurrency[];
}

/** The portal factory shares one address on every chain. */
const PORTAL_FACTORY: Address = "0x4f32082C5647F8fE0f0Fb567b98F2a5516361389";

/**
 * Curvy's production networks and the stablecoins merchants take payments in. Built into the SDK, so confirming a
 * payment never depends on what a service reports: whoever controls the aggregator address decides what counts as
 * a payment. The aggregator and vault are upgradeable proxies, so their addresses stay fixed across upgrades.
 */
export const CURVY_NETWORKS: readonly Readonly<CurvyNetwork>[] = deepFreeze([
  {
    chainId: 42_161,
    name: "Arbitrum One",
    testnet: false,
    aggregator: "0xE51924cEF003a654EC9735c4d97f5D4862cBcbB1",
    portalFactory: PORTAL_FACTORY,
    vault: "0xcC8d5c60A8fb15Aa3793647eF531f1bA7dF24f00",
    minPortalUsd: 0.5,
    currencies: [
      {
        address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
        symbol: "USDC",
        decimals: 6,
        vaultTokenId: "2",
        eip712: { name: "USD Coin", version: "2" },
      },
      {
        address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
        symbol: "USDT",
        decimals: 6,
        vaultTokenId: "3",
        // USD₮0 has no version(); its domain separator matches version "1".
        eip712: { name: "USD₮0", version: "1" },
      },
    ],
  },
  {
    chainId: 11_155_111,
    name: "Ethereum Sepolia",
    testnet: true,
    aggregator: "0x5D4A04d6c9Bdf4613e7acD92E570539A5a6DBa84",
    portalFactory: PORTAL_FACTORY,
    vault: "0x4a817f82210F17b24577ebAd474E14333A1cB85d",
    minPortalUsd: 0.5,
    currencies: [
      {
        address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
        symbol: "USDC",
        decimals: 6,
        vaultTokenId: "2",
        eip712: { name: "USDC", version: "2" },
      },
    ],
  },
]);

/**
 * The network checkout routes payments to. A request on it can be paid in one of its tokens on any network where
 * Curvy has a payment address; Curvy bridges the same token here (Arbitrum One: Curvy's entry bridges deliver nowhere
 * else).
 */
export const ROUTED_PAYMENT_CHAIN_ID = 42_161;

/**
 * What bridging may cost the shop, at most, in basis points of the amount: a payment on `ROUTED_PAYMENT_CHAIN_ID`
 * that arrives up to this much short still counts as paid. Curvy doesn't bridge at a higher loss.
 */
export const ROUTED_PAYMENT_TOLERANCE_BPS = 300;

/** The network an environment pays into: Arbitrum One for `"mainnet"`, Ethereum Sepolia for `"testnet"`. */
export function getDefaultCurvyNetwork(environment: CurvyEnvironment): Readonly<CurvyNetwork> {
  if (environment !== "mainnet" && environment !== "testnet") {
    throw new Error('environment must be "mainnet" or "testnet"');
  }
  const network = CURVY_NETWORKS.find((candidate) => candidate.testnet === (environment === "testnet"));
  if (!network) throw new Error(`no Curvy network for ${environment}`);
  return network;
}

/** The Curvy network the SDK knows for `chainId`, or `undefined` for any other chain. */
export function getCurvyNetwork(chainId: number): Readonly<CurvyNetwork> | undefined {
  return CURVY_NETWORKS.find((network) => network.chainId === chainId);
}

/**
 * A token given by address, or by symbol among the tokens Curvy takes on `chainId` (`"USDC"`). An address is taken
 * as is: the vault decides whether it accepts it.
 */
export function resolveToken(chainId: number, token: string): Address {
  if (typeof token !== "string") throw new Error("token must be an address or a token symbol such as USDC");
  if (isAddress(token, { strict: false })) return getAddress(token);
  const symbol = token.trim().toUpperCase();
  const currency = getCurvyNetwork(chainId)?.currencies.find((candidate) => candidate.symbol === symbol);
  if (!currency) {
    throw new Error(`token ${JSON.stringify(token)} is not a Curvy token on chain ${chainId}; pass its address`);
  }
  return currency.address;
}

/**
 * The tokens a shop takes on `chainId`: `tokens` resolved one by one (symbols or addresses), or by default every
 * token Curvy takes there (USDC and USDT on Arbitrum One, USDC on Sepolia). Empty on a chain the SDK doesn't know,
 * unless given. Known tokens must share decimals, so one amount means the same in each.
 */
export function resolveTokens(chainId: number, tokens?: readonly string[]): Address[] {
  if (tokens === undefined) return (getCurvyNetwork(chainId)?.currencies ?? []).map((currency) => currency.address);
  if (!Array.isArray(tokens) || tokens.length === 0) throw new Error("tokens must list at least one token");

  const resolved = tokens.map((token) => resolveToken(chainId, token));
  if (new Set(resolved).size !== resolved.length) throw new Error("tokens must not list a token twice");
  const decimals = new Set(
    resolved.flatMap((token) => {
      const currency = getCurvyNetwork(chainId)?.currencies.find((candidate) => candidate.address === token);
      return currency ? [currency.decimals] : [];
    }),
  );
  if (decimals.size > 1) throw new Error("tokens must share decimals, so one amount means the same in each");
  return resolved;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}
