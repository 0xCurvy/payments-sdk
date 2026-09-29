import type { Address, Log } from "viem";
import { isAddressEqual, parseEventLogs } from "viem/utils";
import { pendingNotesAbi } from "../../contracts";
import { findPendingNote } from "./findPendingNote";

export function noteIdInCommittedLogs(noteId: bigint, logs: Log[], aggregatorAddress: Address): boolean {
  const events = parseEventLogs({ abi: pendingNotesAbi, eventName: "CommittedNotes", logs, strict: true });
  return events.some(
    (log) => isAddressEqual(log.address, aggregatorAddress) && log.args.noteIds.some((id) => id === noteId),
  );
}

export function findNoteIdInPendingLogs(
  logs: Log[],
  ephemeralKey: readonly [bigint | string, bigint | string],
  aggregatorAddress: Address,
): bigint | null {
  const events = parseEventLogs({ abi: pendingNotesAbi, eventName: "PendingNotes", logs, strict: true });
  for (const log of events) {
    if (!isAddressEqual(log.address, aggregatorAddress)) continue;
    const note = findPendingNote(log.args, ephemeralKey);
    if (note) return note.noteId;
  }
  return null;
}
