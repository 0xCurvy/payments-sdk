import type { Address } from "viem";
import { vaultAbi } from "../contracts";
import type { PaymentReadClient } from "../types";

/** Per-token protocol fees read from the Curvy vault, in token base units (bps for `depositFeeBps`). */
export interface ChainFees {
  depositFeeBps: bigint;
  portalDeployment: bigint;
  pendingNoteCommitment: bigint;
}

/** Fee split for one shielded note. All amounts are decimal strings in token base units. */
export interface FeeBreakdown {
  depositFeeBps: string;
  percentageFee: string;
  portalDeployment: string;
  pendingNoteCommitment: string;
  totalFees: string;
  netAmount: string;
}

export interface QuoteResponse {
  baseAmount: string;
  grossAmount: string;
  feeBreakdown: FeeBreakdown;
}

/**
 * How the payment reaches the aggregator, which decides the fixed fees:
 * - `portal`: human checkout and x402 `exact` (a one-time entry portal is deployed per payment)
 * - `direct`: a direct shield into the vault (no portal deployment)
 */
export type PaymentRail = "portal" | "direct";

const BPS = 10_000n;

/** Split `grossAmount` into protocol fees and the net amount credited to the merchant's note. */
export function feeBreakdown(
  grossAmount: bigint,
  depositFeeBps: bigint,
  portalDeployment: bigint,
  pendingNoteCommitment: bigint,
): FeeBreakdown {
  const percentageFee = (grossAmount * depositFeeBps) / BPS;
  const totalFees = percentageFee + portalDeployment + pendingNoteCommitment;
  return {
    depositFeeBps: depositFeeBps.toString(),
    percentageFee: percentageFee.toString(),
    portalDeployment: portalDeployment.toString(),
    pendingNoteCommitment: pendingNoteCommitment.toString(),
    totalFees: totalFees.toString(),
    netAmount: (grossAmount - totalFees).toString(),
  };
}

export interface QuotePaymentParameters {
  grossAmount: bigint;
  fees: ChainFees;
  rail: PaymentRail;
}

/** `feeBreakdown` for a rail: the portal deployment fee only applies to the `portal` rail. */
export function quotePayment({ grossAmount, fees, rail }: QuotePaymentParameters): FeeBreakdown {
  return feeBreakdown(
    grossAmount,
    fees.depositFeeBps,
    rail === "portal" ? fees.portalDeployment : 0n,
    fees.pendingNoteCommitment,
  );
}

export interface MinimumPaymentAmountParameters {
  fees: ChainFees;
  rail: PaymentRail;
  /** Smallest net amount the merchant must receive. Defaults to 1 base unit. */
  minNetAmount?: bigint;
}

/**
 * Smallest gross amount whose net (after protocol fees) is at least `minNetAmount`.
 *
 * This is the on-chain floor only. Off-chain services can impose their own minimum on top
 * (the portal broadcaster that settles human checkout rejects portals worth under $0.50),
 * so the effective minimum for a rail is the larger of the two.
 */
export function minimumPaymentAmount({ fees, rail, minNetAmount = 1n }: MinimumPaymentAmountParameters): bigint {
  if (minNetAmount < 0n) throw new Error("minNetAmount must not be negative");
  if (fees.depositFeeBps >= BPS) throw new Error("depositFeeBps must be below 10000");
  const net = (gross: bigint) => BigInt(quotePayment({ grossAmount: gross, fees, rail }).netAmount);
  const fixed = (rail === "portal" ? fees.portalDeployment : 0n) + fees.pendingNoteCommitment;
  // Closed-form estimate ignoring the percentage fee's floor division, then settle exactly.
  let gross = ((minNetAmount + fixed) * BPS + (BPS - fees.depositFeeBps - 1n)) / (BPS - fees.depositFeeBps);
  while (gross > 0n && net(gross - 1n) >= minNetAmount) gross -= 1n;
  while (net(gross) < minNetAmount) gross += 1n;
  return gross;
}

export interface ReadChainFeesParameters {
  publicClient: PaymentReadClient;
  vaultAddress: Address;
  /** ERC-20 the customer pays with; resolved to the vault's token id. */
  token: Address;
  /** Read fees as of a past block, e.g. the block that shielded a payment. */
  blockNumber?: bigint;
}

/** Read the vault's current fees for `token`. */
export async function readChainFees({
  publicClient,
  vaultAddress,
  token,
  blockNumber,
}: ReadChainFeesParameters): Promise<ChainFees> {
  const tokenId = await publicClient.readContract({
    address: vaultAddress,
    abi: vaultAbi,
    functionName: "getTokenId",
    args: [token],
    blockNumber,
  });
  if (tokenId === 0n) throw new Error(`token ${token} is not registered in vault ${vaultAddress}`);
  const [depositFeeBps, gasFees] = await Promise.all([
    publicClient.readContract({ address: vaultAddress, abi: vaultAbi, functionName: "depositFee", blockNumber }),
    publicClient.readContract({
      address: vaultAddress,
      abi: vaultAbi,
      functionName: "perTokenGasFees",
      args: [tokenId],
      blockNumber,
    }),
  ]);
  return {
    depositFeeBps: BigInt(depositFeeBps),
    portalDeployment: gasFees.portalDeployment,
    pendingNoteCommitment: gasFees.pendingNoteCommitment,
  };
}
