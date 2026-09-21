import {
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
  isHex,
  parseAbiItem,
} from "viem";
import { isAddressEqual, parseEventLogs } from "viem/utils";
import { pendingNotesAbi } from "../contracts";
import type { PaymentReceipt, PaymentVerifyClient } from "../types";
import { findNoteInReceipt } from "./findNoteInReceipt";
import { findNoteIdInPendingLogs, noteIdInCommittedLogs } from "./internal/findCommittedNote";

const pendingNotesEvent = parseAbiItem(
  "event PendingNotes(uint256[] noteIds, uint256[][2] ephemeralKeys, uint16[] viewTags, uint256[] tokens, uint256[] amounts, bool[] isPlaintext)",
);
const committedNotesEvent = parseAbiItem("event CommittedNotes(uint256 indexed batchIndex, uint256[] noteIds)");

export interface VerifyPaymentParameters {
  publicClient: PaymentVerifyClient;
  aggregatorAddress: Address;
  ephemeralKey: readonly [bigint | string, bigint | string];
  confirmations: number;
  txHash?: Hex;
  fromBlock?: bigint;
}

const State = {
  FAILED: "FAILED",
  MISSING: "MISSING",
  INVALID: "INVALID",
  UNRELATED: "UNRELATED",
  INCLUDED: "INCLUDED",
  CONFIRMED: "CONFIRMED",
  SETTLED: "SETTLED",
} as const;

type InternalState = (typeof State)[keyof typeof State];

function parseTxHash(txHash: Hex): Hex {
  if (!isHex(txHash) || txHash.length !== 66) {
    throw new Error("txHash must be a 32-byte hex string");
  }
  return txHash;
}

function isVerified(state: InternalState): boolean {
  return state === State.CONFIRMED || state === State.SETTLED;
}

function finalizeVerification(state: InternalState): boolean {
  if (state === State.FAILED) {
    throw new Error("shield transaction reverted");
  }
  if (state === State.INVALID) {
    throw new Error("transaction is not a valid Curvy shield payment");
  }
  return isVerified(state);
}

function hasAggregatorPendingNotes(receipt: PaymentReceipt, aggregatorAddress: Address): boolean {
  const logs = parseEventLogs({ abi: pendingNotesAbi, eventName: "PendingNotes", logs: receipt.logs, strict: true });
  return logs.some((log) => isAddressEqual(log.address, aggregatorAddress));
}

async function verifyWithoutTxHash(parameters: VerifyPaymentParameters): Promise<InternalState> {
  const fromBlock = parameters.fromBlock ?? 0n;
  const pendingLogs = await parameters.publicClient.getLogs({
    address: parameters.aggregatorAddress,
    event: pendingNotesEvent,
    fromBlock,
    toBlock: "latest",
  });
  const noteId = findNoteIdInPendingLogs(pendingLogs, parameters.ephemeralKey, parameters.aggregatorAddress);
  if (noteId === null) return State.MISSING;

  const committedLogs = await parameters.publicClient.getLogs({
    address: parameters.aggregatorAddress,
    event: committedNotesEvent,
    fromBlock,
    toBlock: "latest",
  });
  return noteIdInCommittedLogs(noteId, committedLogs, parameters.aggregatorAddress) ? State.SETTLED : State.MISSING;
}

async function verifyWithTxHash(parameters: VerifyPaymentParameters, txHash: Hex): Promise<InternalState> {
  let receipt: Awaited<ReturnType<PaymentVerifyClient["getTransactionReceipt"]>>;
  try {
    receipt = await parameters.publicClient.getTransactionReceipt({ hash: txHash });
  } catch (error) {
    if (error instanceof TransactionReceiptNotFoundError) {
      try {
        await parameters.publicClient.getTransaction({ hash: txHash });
        return State.MISSING;
      } catch (lookupError) {
        if (lookupError instanceof TransactionNotFoundError) {
          return State.INVALID;
        }
        throw lookupError;
      }
    }
    throw error;
  }

  if (receipt.status !== "success") {
    return State.FAILED;
  }

  if (!hasAggregatorPendingNotes(receipt, parameters.aggregatorAddress)) {
    return State.INVALID;
  }

  const note = findNoteInReceipt(receipt, parameters.ephemeralKey, parameters.aggregatorAddress);
  if (!note) {
    return State.UNRELATED;
  }

  const currentBlock = await parameters.publicClient.getBlockNumber();
  const includedConfirmations = currentBlock - receipt.blockNumber + 1n;
  if (includedConfirmations < BigInt(parameters.confirmations)) {
    return State.INCLUDED;
  }

  const committedLogs = await parameters.publicClient.getLogs({
    address: parameters.aggregatorAddress,
    event: committedNotesEvent,
    fromBlock: receipt.blockNumber,
    toBlock: "latest",
  });
  return noteIdInCommittedLogs(note.noteId, committedLogs, parameters.aggregatorAddress)
    ? State.SETTLED
    : State.CONFIRMED;
}

export async function verifyPayment(parameters: VerifyPaymentParameters): Promise<boolean> {
  if (!Number.isSafeInteger(parameters.confirmations) || parameters.confirmations <= 0) {
    throw new Error("confirmations must be a positive safe integer");
  }

  if (parameters.txHash === undefined) {
    const state = await verifyWithoutTxHash(parameters);
    return state === State.SETTLED;
  }

  const state = await verifyWithTxHash(parameters, parseTxHash(parameters.txHash));
  return finalizeVerification(state);
}
