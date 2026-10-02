import type { Address, Hex } from "viem";
import type { X402Network, X402PaymentRequirements } from "../protocol";

export type X402PaymentStatus =
  /** 402 issued; waiting for the payer. */
  | "pending"
  /**
   * The payer's authorization verified and settlement was requested. Stays here if the facilitator's
   * reply was lost: the payer may retry the same `PAYMENT-SIGNATURE`, and `shield()` checks the portal.
   */
  | "settling"
  /** The facilitator moved the payer's funds to the one-time portal. */
  | "settled"
  /** The portal is deployed and the note is pending in the aggregator. */
  | "shielded"
  /** `verifyPayment` saw the note with enough confirmations. */
  | "confirmed"
  /** The facilitator definitively refused settlement and the portal holds nothing. */
  | "failed"
  /** Nobody paid before the challenge expired. */
  | "expired";

/** The merchant's private payment reference. Never send it to the payer. */
export interface X402PaymentNote {
  ownerHash: string;
  ephemeralKey: readonly [string, string];
  viewTag: number;
}

export interface X402Payment {
  /** The one-time `payTo` portal address; unique per payment. */
  payTo: Address;
  status: X402PaymentStatus;
  /** Gross price in token base units. */
  amount: string;
  resource: string;
  /** Unix milliseconds. */
  createdAt: number;
  expiresAt: number;
  /** The payment options sent in the 402, one per scheme; the paid retry must echo one of them exactly. */
  accepts: X402PaymentRequirements[];
  note: X402PaymentNote;
  payer?: Address;
  /**
   * The merchant's token this payment counts in: the one paid, or for a payment on another network the one it is
   * bridged into. Set when the payer pays.
   */
  token?: Address;
  /** The network the payer paid on, when not the merchant's: Curvy bridges it over. Set when the payer pays. */
  paidOn?: X402Network;
  /** The facilitator's EIP-3009 transfer to `payTo` (on `paidOn` when set). */
  settleTxHash?: Hex;
  /** The portal deployment that shielded the funds. */
  shieldTxHash?: Hex;
  noteId?: string;
  /** Gross minus on-chain fees, as credited to the note. */
  netAmount?: string;
  /** Broadcaster mode: the portal's last reported state (`compliance_checking`, `shielding`, …). */
  portalState?: string;
  /** Last error on this payment (settlement, shield or confirmation). */
  error?: string;
}

/**
 * Where payments live. The default is an in-memory map; provide your own for restarts or several instances.
 *
 * Within one process the merchant serialises work per `payTo`, so `get`/`put` alone are safe. Across
 * processes, implement `claim` as an atomic compare-and-set (SQL `UPDATE … WHERE status = $from`, Redis
 * Lua, …) so that only one instance settles a challenge. Without `claim`, run a single instance.
 */
export interface X402PaymentStore {
  get(payTo: string): Promise<X402Payment | undefined> | X402Payment | undefined;
  put(payment: X402Payment): Promise<void> | void;
  list(): Promise<X402Payment[]> | X402Payment[];
  /**
   * Atomically move `payTo` from status `from` to `to`. Return `false` when the payment is missing or not in
   * `from`. The merchant uses it to guarantee one settlement per challenge.
   */
  claim?(payTo: string, from: X402PaymentStatus, to: X402PaymentStatus): Promise<boolean> | boolean;
}

export interface MemoryPaymentStoreOptions {
  /**
   * Beyond this many entries, unpaid challenges (expired first, then the ones expiring soonest) and finished
   * `failed`/`expired`/`confirmed` rows are dropped. Payments with funds in flight (`settling`, `settled`,
   * `shielded`) are never evicted. Defaults to 10 000.
   */
  maxEntries?: number;
}

export function createMemoryPaymentStore(options: MemoryPaymentStoreOptions = {}): X402PaymentStore {
  const maxEntries = options.maxEntries ?? 10_000;
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) throw new Error("maxEntries must be a positive integer");
  const payments = new Map<string, X402Payment>();
  return {
    get(payTo) {
      return payments.get(payTo.toLowerCase());
    },
    put(payment) {
      const key = payment.payTo.toLowerCase();
      payments.set(key, payment);
      if (payments.size <= maxEntries) return;
      const now = Date.now();
      const evictable = [...payments.entries()].filter(
        ([, candidate]) =>
          candidate.status === "pending" ||
          candidate.status === "expired" ||
          candidate.status === "failed" ||
          candidate.status === "confirmed",
      );
      // Lapsed and finished rows first, then unpaid challenges by soonest expiry. Never anything with funds in flight.
      evictable.sort(([, a], [, b]) => {
        const rank = (p: X402Payment) => (p.status !== "pending" || p.expiresAt <= now ? 0 : 1);
        return rank(a) - rank(b) || a.expiresAt - b.expiresAt;
      });
      for (const [candidateKey] of evictable) {
        if (payments.size <= maxEntries) break;
        if (candidateKey !== key) payments.delete(candidateKey);
      }
    },
    list() {
      return [...payments.values()];
    },
    claim(payTo, from, to) {
      const payment = payments.get(payTo.toLowerCase());
      if (!payment || payment.status !== from) return false;
      payment.status = to;
      return true;
    },
  };
}
