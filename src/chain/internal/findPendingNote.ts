import type { PaymentNote } from "../../types";

export interface PendingNoteArrays {
  noteIds: readonly bigint[];
  ephemeralKeys: readonly [readonly bigint[], readonly bigint[]];
  tokens: readonly bigint[];
  amounts: readonly bigint[];
}

/** Match an ephemeral public key against the parallel PendingNotes arrays. */
export function findPendingNote(
  args: PendingNoteArrays,
  ephemeralKey: readonly [bigint | string, bigint | string],
): PaymentNote | null {
  const expectedX = BigInt(ephemeralKey[0]);
  const expectedY = BigInt(ephemeralKey[1]);
  for (let index = 0; index < args.noteIds.length; index += 1) {
    if (args.ephemeralKeys[0][index] !== expectedX || args.ephemeralKeys[1][index] !== expectedY) continue;
    const noteId = args.noteIds[index];
    const netAmount = args.amounts[index];
    const token = args.tokens[index];
    if (noteId === undefined || netAmount === undefined || token === undefined) continue;
    return { noteId, netAmount, token };
  }
  return null;
}
