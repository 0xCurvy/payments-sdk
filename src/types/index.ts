import type { Address, Hex, PublicClient, TransactionReceipt } from "viem";

export interface PaymentRecipient {
  S: string;
  V: string;
  babyJubjubPublicKey: string;
}

export interface PaymentIntent {
  token: Address;
  amount: string;
  chainId: number;
  ownerHash: string;
  ephemeralKeyX: string;
  ephemeralKeyY: string;
  viewTag: number;
  merchantOrigin: string;
  checkoutCompletePath: string;
  expiry: number;
  /**
   * What the buyer is paying for, e.g. "Order #1048 · Blue hour print". Optional; checkout shows it and prints it on
   * the buyer's receipt. Signed with the payment, so it can't be changed, added or removed on the way. It travels in
   * the checkout link's fragment and is not part of what checkout registers with Curvy's payment service.
   */
  description?: string;
}

export interface SignedPaymentIntent {
  intent: PaymentIntent;
  signature: Hex;
}

export interface PublishedSigner {
  address: Address;
  alg: "eip712-secp256k1";
  notAfter: string;
}

export interface MerchantKeySet {
  version: 1;
  signers: PublishedSigner[];
  /**
   * Optional icon the hosted checkout shows next to the shop's name: an absolute path on the merchant origin to a
   * square PNG or WebP image, e.g. `/curvy-icon.png`. Checkout shows the shop's initial without one.
   */
  icon?: string;
  /**
   * Optional name the hosted checkout shows for the shop, e.g. `Overprint`, at most 60 characters of plain text.
   * Checkout always shows the shop's address beside it; without one, the address alone.
   */
  name?: string;
}

export interface PaymentNote {
  noteId: bigint;
  netAmount: bigint;
  token: bigint;
}

export type PaymentReceipt = Pick<TransactionReceipt, "logs">;

export interface PaymentReadClient extends Pick<PublicClient, "readContract"> {}

export interface PaymentReceiptClient extends Pick<PublicClient, "getTransaction" | "getTransactionReceipt"> {}

export interface PaymentPublicClient extends PaymentReadClient {}
