import { noteId as rustNoteId } from "@0xcurvy/rs-core-wasm/core";
import type { Address, Hash, Log } from "viem";
import { isAddressEqual, parseEventLogs } from "viem/utils";
import { aggregatorAbi, portalFactoryAbi } from "../../contracts";
import type { PaymentIntent } from "../../types";
import { BN254_SCALAR_FIELD } from "../../utils/validation";

/** One PendingNotes slot that provably pays the request. */
export interface PaymentNoteMatch {
  noteId: bigint;
  netAmount: bigint;
  token: bigint;
  transactionHash: Hash;
  blockNumber: bigint;
  logIndex: number;
}

export interface PaymentNoteScan {
  /** Whether any PendingNotes log from the aggregator was present. */
  hasAggregatorPendingNotes: boolean;
  /** Every slot, across every log, that passes the commitment check; in log order. */
  matches: PaymentNoteMatch[];
}

/**
 * `noteId = PoseidonT4(ownerHash, netAmount, token)` as the aggregator computes it
 * (CurvyAggregatorAlphaV2.sol `_shield`). rs-core must be initialized first.
 */
function computeNoteId(ownerHash: bigint, amount: bigint, token: bigint): bigint {
  return BigInt(rustNoteId(ownerHash.toString(), amount.toString(), token.toString()));
}

/**
 * Find the request's note in PendingNotes logs. A slot pays the request only when it was
 * emitted by the aggregator, is a plaintext shield slot, carries the request's R and viewTag,
 * and its noteId recomputes from the request's ownerHash. R and viewTag are caller-chosen and
 * not part of noteId, so an R match alone proves nothing: anyone can emit the merchant's R on
 * a note they own. Every slot of every log is checked.
 */
export function findPaymentNotes(
  logs: readonly Log[],
  request: PaymentIntent,
  aggregatorAddress: Address,
): PaymentNoteScan {
  const ownerHash = BigInt(request.ownerHash);
  const ephemeralKeyX = BigInt(request.ephemeralKeyX);
  const ephemeralKeyY = BigInt(request.ephemeralKeyY);
  const events = parseEventLogs({
    abi: aggregatorAbi,
    eventName: "PendingNotes",
    logs: [...logs],
    strict: true,
  });

  let hasAggregatorPendingNotes = false;
  const matches: PaymentNoteMatch[] = [];
  for (const event of events) {
    if (event.removed || !isAddressEqual(event.address, aggregatorAddress)) continue;
    hasAggregatorPendingNotes = true;
    const { transactionHash, blockNumber, logIndex } = event;
    if (transactionHash === null || blockNumber === null || logIndex === null) continue;
    const { noteIds, ephemeralKeys, viewTags, tokens, amounts, isPlaintext } = event.args;
    for (let index = 0; index < noteIds.length; index += 1) {
      const noteId = noteIds[index];
      const netAmount = amounts[index];
      const token = tokens[index];
      if (noteId === undefined || netAmount === undefined || token === undefined) continue;
      if (ephemeralKeys[0][index] !== ephemeralKeyX || ephemeralKeys[1][index] !== ephemeralKeyY) continue;
      if (viewTags[index] !== request.viewTag || isPlaintext[index] !== true) continue;
      // Poseidon reduces its inputs mod r; the contract never emits values at or above it.
      if (netAmount >= BN254_SCALAR_FIELD || token >= BN254_SCALAR_FIELD) continue;
      if (computeNoteId(ownerHash, netAmount, token) !== noteId) continue;
      matches.push({
        noteId,
        netAmount,
        token,
        transactionHash,
        blockNumber,
        logIndex,
      });
    }
  }
  return { hasAggregatorPendingNotes, matches };
}

/** Emitters of the `ShieldPortalDeployed` logs for `ownerHash`; the caller pins the factory. */
export function shieldPortalEmitters(logs: readonly Log[], ownerHash: bigint): Address[] {
  const events = parseEventLogs({
    abi: portalFactoryAbi,
    eventName: "ShieldPortalDeployed",
    logs: [...logs],
    strict: true,
  });
  return events.filter((event) => event.args.ownerHash === ownerHash).map((event) => event.address);
}

/**
 * Block of the earliest CommittedNotes log from the aggregator that contains `noteId`, or null
 * when none does.
 */
export function committedNoteBlock(logs: readonly Log[], noteId: bigint, aggregatorAddress: Address): bigint | null {
  const events = parseEventLogs({
    abi: aggregatorAbi,
    eventName: "CommittedNotes",
    logs: [...logs],
    strict: true,
  });
  let earliest: bigint | null = null;
  for (const event of events) {
    if (event.removed || !isAddressEqual(event.address, aggregatorAddress) || !event.args.noteIds.includes(noteId)) {
      continue;
    }
    // A log without a block number is pending, not committed.
    if (event.blockNumber === null) continue;
    if (earliest === null || event.blockNumber < earliest) earliest = event.blockNumber;
  }
  return earliest;
}
