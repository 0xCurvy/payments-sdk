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
}

export interface PaymentNote {
  noteId: bigint;
  netAmount: bigint;
  token: bigint;
}

export type PaymentReceipt = Pick<TransactionReceipt, "logs">;

export interface PaymentReadClient extends Pick<PublicClient, "readContract"> {}

export interface PaymentReceiptClient extends Pick<PublicClient, "getTransaction" | "getTransactionReceipt"> {}

export interface PaymentVerifyClient
  extends Pick<PublicClient, "getTransaction" | "getTransactionReceipt" | "getBlockNumber" | "getLogs"> {}

export interface PaymentPublicClient extends PaymentReadClient {}
