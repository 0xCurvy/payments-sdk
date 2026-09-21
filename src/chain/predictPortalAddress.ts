import type { Address } from "viem";
import { portalFactoryAbi } from "../contracts";
import type { PaymentReadClient } from "../types";

export interface PredictPortalAddressParameters {
  publicClient: PaymentReadClient;
  portalFactoryAddress: Address;
  ownerHash: bigint | string;
  recovery: Address;
}

/** Resolve `PortalFactory.getEntryPortalAddress(ownerHash, recovery)`. */
export async function predictPortalAddress(parameters: PredictPortalAddressParameters): Promise<Address> {
  return parameters.publicClient.readContract({
    address: parameters.portalFactoryAddress,
    abi: portalFactoryAbi,
    functionName: "getEntryPortalAddress",
    args: [BigInt(parameters.ownerHash), parameters.recovery],
  });
}
