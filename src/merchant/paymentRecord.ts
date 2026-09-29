import type { Hex } from "viem";
import { parseSignedPaymentIntent } from "../intent/parseSignedPaymentIntent";
import type { SignedPaymentIntent } from "../types";
import { decimal, exactKeys, record, string } from "../utils/validation";
import type { PaymentStatus, PaymentVerification, VerifiedPayment } from "./verifyPayment";

/** Version of the stored value `serializePaymentRecord` writes. `parsePaymentRecord` refuses any other. */
export const PAYMENT_RECORD_VERSION = 1;

/**
 * Everything a merchant stores for one payment attempt. Keep it as the one opaque value
 * `serializePaymentRecord` returns, not split into your own columns: later SDK versions add fields
 * under a new version, and `parsePaymentRecord` reads the versions it knows.
 */
export interface PaymentRecord {
  /** The signed payment package the checkout link carries. Its `intent` is the request `verifyPayment` takes. */
  payment: SignedPaymentIntent;
  /** First block `verifyPayment` scans when there is no `txHash` (read it before creating the request). */
  fromBlock: bigint;
  /** The latest `verifyPayment` result you accepted; `null` before the first one. */
  verification: PaymentVerification | null;
}

const RECORD_KEYS = ["version", "payment", "fromBlock", "verification"] as const;
const VERIFICATION_KEYS = ["status", "payment"] as const;
const VERIFIED_PAYMENT_KEYS = [
  "txHash",
  "blockNumber",
  "confirmations",
  "noteId",
  "vaultTokenId",
  "netAmount",
  "minimumNetAmount",
  "portalShield",
  "committed",
  "siblingNoteIds",
] as const;
const PAYMENT_STATUSES: readonly PaymentStatus[] = ["not_found", "confirming", "paid", "underpaid", "wrong_token"];
const TX_HASH = /^0x[0-9a-f]{64}$/i;

function serializeVerifiedPayment(payment: VerifiedPayment) {
  return {
    txHash: payment.txHash,
    blockNumber: payment.blockNumber.toString(),
    confirmations: payment.confirmations.toString(),
    noteId: payment.noteId.toString(),
    vaultTokenId: payment.vaultTokenId.toString(),
    netAmount: payment.netAmount.toString(),
    minimumNetAmount: payment.minimumNetAmount.toString(),
    portalShield: payment.portalShield,
    committed: payment.committed,
    siblingNoteIds: payment.siblingNoteIds.map((noteId) => noteId.toString()),
  };
}

function bigintField(value: unknown, label: string): bigint {
  return BigInt(decimal(value, label));
}

function booleanField(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function parseVerifiedPayment(value: unknown, label: string): VerifiedPayment {
  const input = record(value, label);
  exactKeys(input, VERIFIED_PAYMENT_KEYS, label);
  const txHash = string(input.txHash, `${label}.txHash`);
  if (!TX_HASH.test(txHash)) throw new Error(`${label}.txHash must be a 32-byte hex hash`);
  if (!Array.isArray(input.siblingNoteIds)) throw new Error(`${label}.siblingNoteIds must be an array`);
  return {
    txHash: txHash as Hex,
    blockNumber: bigintField(input.blockNumber, `${label}.blockNumber`),
    confirmations: bigintField(input.confirmations, `${label}.confirmations`),
    noteId: bigintField(input.noteId, `${label}.noteId`),
    vaultTokenId: bigintField(input.vaultTokenId, `${label}.vaultTokenId`),
    netAmount: bigintField(input.netAmount, `${label}.netAmount`),
    minimumNetAmount: bigintField(input.minimumNetAmount, `${label}.minimumNetAmount`),
    portalShield: booleanField(input.portalShield, `${label}.portalShield`),
    committed: booleanField(input.committed, `${label}.committed`),
    siblingNoteIds: input.siblingNoteIds.map((noteId, index) =>
      bigintField(noteId, `${label}.siblingNoteIds[${index}]`),
    ),
  };
}

function parseVerification(value: unknown, label: string): PaymentVerification | null {
  if (value === null) return null;
  const input = record(value, label);
  exactKeys(input, VERIFICATION_KEYS, label);
  const status = string(input.status, `${label}.status`);
  if (!PAYMENT_STATUSES.includes(status as PaymentStatus)) {
    throw new Error(`${label}.status must be one of ${PAYMENT_STATUSES.join(", ")}`);
  }
  if (status === "not_found") {
    if (input.payment !== null) throw new Error(`${label}.payment must be null when status is not_found`);
    return { status, payment: null };
  }
  return { status: status as PaymentStatus, payment: parseVerifiedPayment(input.payment, `${label}.payment`) };
}

/**
 * Parse a stored payment record. Strict: the value must be one `serializePaymentRecord` wrote,
 * with a known `version`; unknown fields, a malformed package or verification, and any other
 * version are errors.
 */
export function parsePaymentRecord(value: unknown): PaymentRecord {
  const text = string(value, "payment record");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("payment record must be JSON");
  }
  const input = record(json, "payment record");
  if (input.version !== PAYMENT_RECORD_VERSION) {
    throw new Error(`unsupported payment record version ${JSON.stringify(input.version ?? null)}`);
  }
  exactKeys(input, RECORD_KEYS, "payment record");
  return {
    payment: parseSignedPaymentIntent(input.payment),
    fromBlock: bigintField(input.fromBlock, "payment record.fromBlock"),
    verification: parseVerification(input.verification, "payment record.verification"),
  };
}

/**
 * Serialize one payment attempt into the single value a merchant stores: a JSON string with an
 * explicit `version`, and bigints as decimal strings. Throws when the record would not parse back.
 */
export function serializePaymentRecord(paymentRecord: PaymentRecord): string {
  const { verification } = paymentRecord;
  const text = JSON.stringify({
    version: PAYMENT_RECORD_VERSION,
    payment: { intent: paymentRecord.payment.intent, signature: paymentRecord.payment.signature },
    fromBlock: paymentRecord.fromBlock.toString(),
    verification:
      verification === null
        ? null
        : {
            status: verification.status,
            payment: verification.payment === null ? null : serializeVerifiedPayment(verification.payment),
          },
  });
  parsePaymentRecord(text);
  return text;
}
