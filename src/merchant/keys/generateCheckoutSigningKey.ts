import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";

export interface CheckoutSigningKey {
  /** Secret. Keep it in the backend's secret store; never in website code or the signer list. */
  privateKey: Hex;
  /** Public. Publish it in `/.well-known/curvy-payments.json` with `buildMerchantKeySet`. */
  address: Address;
}

/**
 * Create a new random secp256k1 key used only to sign checkout requests. It holds no funds and pays no gas,
 * and it is independent of any wallet or Curvy key. A KMS or HSM can hold the key instead: sign through your
 * own `PaymentIntentSigner` function.
 */
export function generateCheckoutSigningKey(): CheckoutSigningKey {
  const privateKey = generatePrivateKey();
  return { privateKey, address: privateKeyToAddress(privateKey) };
}
