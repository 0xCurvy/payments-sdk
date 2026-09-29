import type { Address } from "viem";
import { portalFactoryAbi } from "../contracts";
import type { PaymentReadClient } from "../types";

export interface PredictPortalAddressParameters {
  publicClient: PaymentReadClient;
  portalFactoryAddress: Address;
  ownerHash: bigint | string;
  recovery: Address;
}

/**
 * Resolve `PortalFactory.getEntryPortalAddress(ownerHash, recovery)`.
 *
 * @internal Unstable: for Curvy's own checkout and services. The inputs and the formula change
 * when Curvy migrates portal factories, without a deprecation period. Merchants should not
 * compute portal addresses; an x402 merchant uses `createX402Merchant` from
 * `@0xcurvy/payments-sdk/x402/merchant`, whose challenge carries `payTo`.
 */
export async function predictPortalAddress(parameters: PredictPortalAddressParameters): Promise<Address> {
  return parameters.publicClient.readContract({
    address: parameters.portalFactoryAddress,
    abi: portalFactoryAbi,
    functionName: "getEntryPortalAddress",
    args: [BigInt(parameters.ownerHash), parameters.recovery],
  });
}
