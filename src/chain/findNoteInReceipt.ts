import type { Address } from "viem";
import { isAddressEqual, parseEventLogs } from "viem/utils";
import { pendingNotesAbi } from "../contracts";
import type { PaymentNote, PaymentReceipt } from "../types";
import { findPendingNote } from "./internal/findPendingNote";

/**
 * Find an ephemeral key in every parallel-array slot of every PendingNotes log.
 * The aggregator address is required because an arbitrary contract can emit a
 * look-alike event containing a public R.
 */
export function findNoteInReceipt(
  receipt: PaymentReceipt,
  ephemeralKey: readonly [bigint | string, bigint | string],
  aggregatorAddress: Address,
): PaymentNote | null {
  const logs = parseEventLogs({ abi: pendingNotesAbi, eventName: "PendingNotes", logs: receipt.logs, strict: true });
  for (const log of logs) {
    if (!isAddressEqual(log.address, aggregatorAddress)) continue;
    const note = findPendingNote(log.args, ephemeralKey);
    if (note) return note;
  }
  return null;
}
