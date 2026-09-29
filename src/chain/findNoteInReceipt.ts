import type { Address } from "viem";
import { isAddressEqual, parseEventLogs } from "viem/utils";
import { pendingNotesAbi } from "../contracts";
import type { PaymentNote, PaymentReceipt } from "../types";
import { findPendingNote } from "./internal/findPendingNote";

/**
 * Find an ephemeral key in every parallel-array slot of every PendingNotes log and
 * return the first matching slot as `{ noteId, netAmount, token }` (`token` is the vault
 * token id), or null. The aggregator address is required because an arbitrary contract
 * can emit a look-alike event containing a public R.
 *
 * Discovery hint only: this does NOT prove the merchant was paid. R and viewTag are
 * caller-chosen and are not part of noteId, so anyone can shield a note they own under
 * the merchant's R, for any amount or token. Confirm payments with `verifyPayment` from
 * `@0xcurvy/payments-sdk/merchant`, which recomputes noteId from the stored ownerHash and
 * checks the token and amount.
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
