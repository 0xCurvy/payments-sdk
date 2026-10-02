import {
  type Address,
  BaseError,
  ContractFunctionRevertedError,
  type Hex,
  isHex,
  type Log,
  type PublicClient,
  parseAbiItem,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
} from "viem";
import { isAddress, isAddressEqual } from "viem/utils";
import { getCurvyNetwork, ROUTED_PAYMENT_CHAIN_ID, ROUTED_PAYMENT_TOLERANCE_BPS } from "../chain/networks";
import { aggregatorAbi, vaultAbi } from "../contracts";
import { acceptedTokens, parsePaymentIntent } from "../intent/parsePaymentIntent";
import type { PaymentIntent } from "../types";
import { minimumNetAmount } from "./internal/paymentFees";
import {
  committedNoteBlock,
  findPaymentNotes,
  type PaymentNoteMatch,
  shieldPortalEmitters,
} from "./internal/paymentNotes";
import { ensureRustCore } from "./internal/rustCore";

const pendingNotesEvent = parseAbiItem(
  "event PendingNotes(uint256[] noteIds, uint256[][2] ephemeralKeys, uint16[] viewTags, uint256[] tokens, uint256[] amounts, bool[] isPlaintext)",
);
const committedNotesEvent = parseAbiItem("event CommittedNotes(uint256 indexed batchIndex, uint256[] noteIds)");

/** The public-client surface `verifyPayment` reads through (a viem `PublicClient` satisfies it). */
export interface PaymentVerifyClient
  extends Pick<
    PublicClient,
    "getChainId" | "getBlockNumber" | "getLogs" | "getTransaction" | "getTransactionReceipt" | "readContract"
  > {}

/**
 * When a note that passes every check and has enough confirmations counts as `paid`.
 *
 * - `"shielded"` (default): once the shield transaction has `confirmations` blocks. The money is
 *   in the Curvy vault and only the merchant's keys can move it, but the note is not spendable
 *   yet: the batch prover still has to commit it into the notes tree.
 * - `"committed"`: additionally, once the note appears in a CommittedNotes batch from the
 *   aggregator whose block also has `confirmations` blocks, so the merchant can spend it right
 *   away. Until then the status stays `confirming`, for as long as the batch prover takes to
 *   commit it (plus `confirmations` blocks). A local demo stack
 *   without a batch prover never commits, so a payment there stays `confirming` in this mode.
 *
 * `underpaid`, `wrong_token` and `not_found` do not depend on it. Pick `"committed"` when you
 * spend or forward the money right after the sale; `"shielded"` is enough to release goods.
 * A later protocol version (v4) will likely make `"committed"` required.
 */
export type PaidWhen = "shielded" | "committed";

const PAID_WHEN_VALUES: readonly PaidWhen[] = ["shielded", "committed"];

export interface VerifyPaymentParameters {
  /** Client for the chain the request was created for (`request.chainId`). */
  publicClient: PaymentVerifyClient;
  /**
   * Aggregator proxy address; only PendingNotes/CommittedNotes it emitted count. Defaults to Curvy's aggregator on
   * `request.chainId`; required on a chain the SDK does not know.
   */
  aggregatorAddress?: Address;
  /** The request `createPaymentRequest` returned, as the merchant persisted it server-side. */
  request: PaymentIntent;
  /** Blocks (inclusive of the shield block) required before `paid`. Positive safe integer. */
  confirmations: number;
  /** When a note counts as `paid`: see {@link PaidWhen}. Default `"shielded"`. */
  paidWhen?: PaidWhen;
  /**
   * Whether a payment on `ROUTED_PAYMENT_CHAIN_ID` may arrive up to `ROUTED_PAYMENT_TOLERANCE_BPS` short, because
   * it may have been bridged from another network. Default true; pass false for a payment that can't have been
   * bridged, which must arrive in full.
   */
  allowBridgeShortfall?: boolean;
  /** Untrusted hint, typically from the checkout return URL. */
  txHash?: Hex;
  /**
   * First block to scan when `txHash` is omitted (record the block number when the request is
   * created). Required without `txHash`; ignored with it.
   */
  fromBlock?: bigint;
}

/**
 * - `not_found`: no payment yet (or the hinted transaction is still pending). Keep polling.
 * - `confirming`: correct note, token and amount; fewer than `confirmations` blocks so far, or
 *   (with `paidWhen: "committed"`) not yet in a CommittedNotes batch with `confirmations` blocks.
 * - `paid`: correct note, token and amount with enough confirmations (and, with
 *   `paidWhen: "committed"`, in a CommittedNotes batch whose block also has `confirmations` blocks).
 * - `underpaid`: the note pays this request but its net amount is below `minimumNetAmount`.
 * - `wrong_token`: the note pays this request's owner in a vault token the request doesn't take.
 */
export type PaymentStatus = "not_found" | "confirming" | "paid" | "underpaid" | "wrong_token";

export interface VerifiedPayment {
  txHash: Hex;
  blockNumber: bigint;
  /** `latest - blockNumber + 1` at verification time (0 when the RPC is behind the shield block). */
  confirmations: bigint;
  noteId: bigint;
  /** Vault token id of the note. */
  vaultTokenId: bigint;
  /** Which of the request's tokens the note is in (`request.token` or one of `request.tokens`); null for `wrong_token`. */
  token: Address | null;
  /** Amount of the note, after vault fees. */
  netAmount: bigint;
  /**
   * The least the note may carry: what a gross deposit of `request.amount` yields under the fees at the shield block,
   * less up to `ROUTED_PAYMENT_TOLERANCE_BPS` of it on `ROUTED_PAYMENT_CHAIN_ID`, where a payment may have been
   * bridged from another network.
   */
  minimumNetAmount: bigint;
  /**
   * How much less the note carries than the full `request.amount` would have yielded: what bridging the payment from
   * another network cost the shop. 0 when it was paid in full.
   */
  shortfall: bigint;
  /** Whether the note was shielded through a Curvy portal (which also pays `portalDeployment`). */
  portalShield: boolean;
  /**
   * Whether the note was already in a CommittedNotes batch, i.e. spendable. Required for `paid`
   * only with `paidWhen: "committed"`; informational otherwise.
   */
  committed: boolean;
  /**
   * Other notes that also pay this request's ownerHash, seen in the hinted transaction (with
   * `txHash`) or the scanned range (without), in log order. Informational: every note to one
   * ownerHash shares one nullifier, so only one of them can ever be spent; spend `noteId`. A
   * sibling can also appear after verification, so an empty list is not a guarantee.
   */
  siblingNoteIds: bigint[];
}

export interface PaymentVerification {
  status: PaymentStatus;
  /** Null only when `status` is `not_found`. */
  payment: VerifiedPayment | null;
}

export type PaymentVerificationErrorCode =
  | "WRONG_CHAIN"
  | "TX_NOT_FOUND"
  | "REVERTED"
  | "NOT_A_SHIELD"
  | "UNRELATED"
  | "MISSING_FROM_BLOCK"
  | "INVALID_INPUT";

/**
 * Thrown when a verification cannot produce a status.
 * - `WRONG_CHAIN`: `publicClient` is not on `request.chainId`.
 * - `TX_NOT_FOUND`: the RPC knows no such transaction (a lagging RPC can cause this; retry briefly).
 * - `REVERTED`: the hinted transaction reverted.
 * - `NOT_A_SHIELD`: the hinted transaction emitted no PendingNotes from the aggregator.
 * - `UNRELATED`: the hinted transaction shielded notes but none pays this request. Reject the hint.
 * - `MISSING_FROM_BLOCK`: neither `txHash` nor `fromBlock` was given.
 * - `INVALID_INPUT`: malformed request, address, hash, confirmations, `paidWhen` or `fromBlock`.
 */
export class PaymentVerificationError extends Error {
  override readonly name = "PaymentVerificationError";
  readonly code: PaymentVerificationErrorCode;

  constructor(code: PaymentVerificationErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

type PaymentReceipt = Awaited<ReturnType<PaymentVerifyClient["getTransactionReceipt"]>>;

interface ParsedParameters {
  publicClient: PaymentVerifyClient;
  aggregatorAddress: Address;
  request: PaymentIntent;
  confirmations: bigint;
  paidWhen: PaidWhen;
  allowBridgeShortfall: boolean;
  lookup: { txHash: Hex } | { fromBlock: bigint };
}

interface PaymentCandidate {
  note: PaymentNoteMatch;
  receipt: PaymentReceipt;
}

interface LocatedPayments {
  /** Commitment-valid notes whose receipt confirms them, earliest first. */
  candidates: AsyncIterable<PaymentCandidate>;
  /** Every commitment-matching noteId seen for the request, in log order. */
  noteIds: bigint[];
}

function parseParameters(parameters: VerifyPaymentParameters): ParsedParameters {
  let request: PaymentIntent;
  try {
    request = parsePaymentIntent(parameters.request);
  } catch (error) {
    throw new PaymentVerificationError("INVALID_INPUT", `invalid payment request: ${(error as Error).message}`, {
      cause: error,
    });
  }
  const aggregatorAddress = parameters.aggregatorAddress ?? getCurvyNetwork(request.chainId)?.aggregator;
  if (aggregatorAddress === undefined) {
    throw new PaymentVerificationError(
      "INVALID_INPUT",
      `aggregatorAddress is required: chain ${request.chainId} is not a Curvy network this SDK knows`,
    );
  }
  if (typeof aggregatorAddress !== "string" || !isAddress(aggregatorAddress, { strict: false })) {
    throw new PaymentVerificationError("INVALID_INPUT", "aggregatorAddress must be an address");
  }
  if (!Number.isSafeInteger(parameters.confirmations) || parameters.confirmations <= 0) {
    throw new PaymentVerificationError("INVALID_INPUT", "confirmations must be a positive safe integer");
  }
  const paidWhen = parameters.paidWhen === undefined ? "shielded" : parameters.paidWhen;
  if (!PAID_WHEN_VALUES.includes(paidWhen)) {
    throw new PaymentVerificationError("INVALID_INPUT", `paidWhen must be one of ${PAID_WHEN_VALUES.join(", ")}`);
  }
  const { txHash, fromBlock } = parameters;
  if (txHash !== undefined && (!isHex(txHash) || txHash.length !== 66)) {
    throw new PaymentVerificationError("INVALID_INPUT", "txHash must be a 32-byte hex string");
  }
  if (fromBlock !== undefined && (typeof fromBlock !== "bigint" || fromBlock < 0n)) {
    throw new PaymentVerificationError("INVALID_INPUT", "fromBlock must be a non-negative bigint");
  }
  let lookup: ParsedParameters["lookup"];
  if (txHash !== undefined) lookup = { txHash };
  else if (fromBlock !== undefined) lookup = { fromBlock };
  else {
    throw new PaymentVerificationError(
      "MISSING_FROM_BLOCK",
      "fromBlock is required when txHash is omitted (store the block number when the request is created)",
    );
  }
  return {
    publicClient: parameters.publicClient,
    aggregatorAddress,
    request,
    confirmations: BigInt(parameters.confirmations),
    paidWhen,
    allowBridgeShortfall: parameters.allowBridgeShortfall !== false,
    lookup,
  };
}

async function locateByTxHash(parameters: ParsedParameters, txHash: Hex): Promise<LocatedPayments | null> {
  const { publicClient } = parameters;
  let receipt: PaymentReceipt;
  try {
    receipt = await publicClient.getTransactionReceipt({ hash: txHash });
  } catch (error) {
    if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
    try {
      await publicClient.getTransaction({ hash: txHash });
    } catch (lookupError) {
      if (lookupError instanceof TransactionNotFoundError) {
        throw new PaymentVerificationError("TX_NOT_FOUND", `transaction ${txHash} was not found`, {
          cause: lookupError,
        });
      }
      throw lookupError;
    }
    return null;
  }

  if (receipt.status !== "success") {
    throw new PaymentVerificationError("REVERTED", `transaction ${txHash} reverted`);
  }
  const scan = findPaymentNotes(receipt.logs, parameters.request, parameters.aggregatorAddress);
  if (!scan.hasAggregatorPendingNotes) {
    throw new PaymentVerificationError("NOT_A_SHIELD", `transaction ${txHash} is not a Curvy shield`);
  }
  if (scan.matches.length === 0) {
    throw new PaymentVerificationError("UNRELATED", `transaction ${txHash} does not pay this request`);
  }
  const matches = scan.matches.sort(compareMatches);
  return {
    candidates: (async function* () {
      for (const note of matches) yield { note, receipt };
    })(),
    noteIds: matches.map((note) => note.noteId),
  };
}

function compareMatches(left: PaymentNoteMatch, right: PaymentNoteMatch): number {
  if (left.blockNumber !== right.blockNumber) return left.blockNumber < right.blockNumber ? -1 : 1;
  return left.logIndex - right.logIndex;
}

function rpcErrorMessage(error: unknown): string {
  if (error instanceof BaseError) return error.shortMessage;
  return error instanceof Error ? error.message : String(error);
}

/** A contract read pinned to the shield block; a failure other than a revert names the block. */
async function readAtBlock<T>(read: Promise<T>, what: string, blockNumber: bigint): Promise<T> {
  try {
    return await read;
  } catch (error) {
    if (isContractRevert(error)) throw error;
    throw new Error(
      `reading ${what} at block ${blockNumber} failed (${rpcErrorMessage(error)}); the RPC must serve contract state at the shield block (an archive node, or verification soon after the shield)`,
      { cause: error },
    );
  }
}

/** An eth_getLogs call; a failure names the block range. */
async function getLogsInRange<T>(read: Promise<T>, fromBlock: bigint, toBlock: bigint): Promise<T> {
  try {
    return await read;
  } catch (error) {
    throw new Error(
      `eth_getLogs over blocks ${fromBlock}-${toBlock} failed (${rpcErrorMessage(error)}); use an RPC that serves this block range, or a more recent fromBlock`,
      { cause: error },
    );
  }
}

async function locateByScan(
  parameters: ParsedParameters,
  fromBlock: bigint,
  latestBlock: bigint,
): Promise<LocatedPayments | null> {
  if (fromBlock > latestBlock) return null;
  const { publicClient, request, aggregatorAddress } = parameters;
  const logs = await getLogsInRange(
    publicClient.getLogs({ address: aggregatorAddress, event: pendingNotesEvent, fromBlock, toBlock: latestBlock }),
    fromBlock,
    latestBlock,
  );
  // Look-alike notes (the merchant's R on someone else's ownerHash) fail the commitment and are skipped.
  const matches = findPaymentNotes(logs, request, aggregatorAddress).matches.sort(compareMatches);
  if (matches.length === 0) return null;

  const receipts = new Map<Hex, Promise<PaymentReceipt | null>>();
  const receiptOf = (hash: Hex) => {
    let receipt = receipts.get(hash);
    if (receipt === undefined) {
      receipt = publicClient.getTransactionReceipt({ hash }).catch((error: unknown) => {
        // A lagging RPC node, or a log that was reorged out: skip the note and let the caller retry.
        if (error instanceof TransactionReceiptNotFoundError) return null;
        throw error;
      });
      receipts.set(hash, receipt);
    }
    return receipt;
  };
  return {
    candidates: (async function* () {
      for (const note of matches) {
        const receipt = await receiptOf(note.transactionHash);
        if (receipt === null) continue;
        if (receipt.status !== "success") {
          throw new PaymentVerificationError("REVERTED", `transaction ${note.transactionHash} reverted`);
        }
        // Re-read the note from the receipt so a log reorged out between the two calls is not trusted.
        const confirmed = findPaymentNotes(receipt.logs, request, aggregatorAddress).matches.find(
          (candidate) => candidate.noteId === note.noteId,
        );
        if (confirmed !== undefined) yield { note: confirmed, receipt };
      }
    })(),
    noteIds: matches.map((note) => note.noteId),
  };
}

function isContractRevert(error: unknown): boolean {
  return error instanceof BaseError && error.walk((cause) => cause instanceof ContractFunctionRevertedError) !== null;
}

type ShieldBlockReader = ReturnType<typeof shieldBlockReader>;

/** Contract state at shield blocks, read once per block (and token) within one verification. */
function shieldBlockReader({ publicClient, aggregatorAddress, request }: ParsedParameters) {
  const cache = new Map<string, Promise<unknown>>();
  function cached<T>(key: string, read: () => Promise<T>): Promise<T> {
    let value = cache.get(key) as Promise<T> | undefined;
    if (value === undefined) {
      value = read();
      cache.set(key, value);
    }
    return value;
  }
  const vault = (blockNumber: bigint) =>
    cached(`vault:${blockNumber}`, () =>
      readAtBlock(
        publicClient.readContract({
          address: aggregatorAddress,
          abi: aggregatorAbi,
          functionName: "curvyVault",
          blockNumber,
        }),
        "curvyVault",
        blockNumber,
      ),
    );
  return {
    /** Each of the request's tokens with its vault id; null for a token the vault doesn't know. */
    tokenIds: (blockNumber: bigint) =>
      cached(`tokenIds:${blockNumber}`, async () => {
        const vaultAddress = await vault(blockNumber);
        return Promise.all(
          acceptedTokens(request).map(async (token) => ({
            token,
            id: await readAtBlock(
              publicClient.readContract({
                address: vaultAddress,
                abi: vaultAbi,
                functionName: "getTokenId",
                args: [token],
                blockNumber,
              }),
              "getTokenId",
              blockNumber,
            ).catch((error: unknown) => {
              // getTokenId reverts TokenNotRegistered: the token has no vault id, so no note can be in it.
              if (isContractRevert(error)) return null;
              throw error;
            }),
          })),
        );
      }),
    depositFee: (blockNumber: bigint) =>
      cached(`depositFee:${blockNumber}`, async () =>
        readAtBlock(
          publicClient.readContract({
            address: await vault(blockNumber),
            abi: vaultAbi,
            functionName: "depositFee",
            blockNumber,
          }),
          "depositFee",
          blockNumber,
        ),
      ),
    gasFees: (blockNumber: bigint, token: bigint) =>
      cached(`gasFees:${blockNumber}:${token}`, async () =>
        readAtBlock(
          publicClient.readContract({
            address: await vault(blockNumber),
            abi: vaultAbi,
            functionName: "perTokenGasFees",
            args: [token],
            blockNumber,
          }),
          "perTokenGasFees",
          blockNumber,
        ),
      ),
    portalFactory: (blockNumber: bigint) =>
      cached(`portalFactory:${blockNumber}`, () =>
        readAtBlock(
          publicClient.readContract({
            address: aggregatorAddress,
            abi: aggregatorAbi,
            functionName: "portalFactory",
            blockNumber,
          }),
          "portalFactory",
          blockNumber,
        ),
      ),
  };
}

interface Assessment {
  status: Exclude<PaymentStatus, "not_found">;
  payment: Omit<VerifiedPayment, "committed" | "siblingNoteIds">;
}

async function assessNote(
  parameters: ParsedParameters,
  state: ShieldBlockReader,
  { note, receipt }: PaymentCandidate,
  latestBlock: bigint,
): Promise<Assessment> {
  const { request } = parameters;
  const blockNumber = receipt.blockNumber;
  const portalEmitters = shieldPortalEmitters(receipt.logs, BigInt(request.ownerHash));
  const [tokenIds, depositFee, gasFees, portalFactory] = await Promise.all([
    state.tokenIds(blockNumber),
    state.depositFee(blockNumber),
    // The vault charged the note's own token's gas fees, so the minimum uses them.
    state.gasFees(blockNumber, note.token),
    portalEmitters.length === 0 ? null : state.portalFactory(blockNumber),
  ]);

  const portalShield =
    portalFactory !== null && portalEmitters.some((emitter) => isAddressEqual(emitter, portalFactory));
  const fees = {
    depositFee: BigInt(depositFee),
    pendingNoteCommitment: gasFees.pendingNoteCommitment,
    portalDeployment: gasFees.portalDeployment,
  };
  const amount = BigInt(request.amount);
  const full = minimumNetAmount(amount, fees, portalShield);
  // On the routed network a payment may have been bridged from another one, and arrive short by what that cost.
  const tolerance =
    parameters.allowBridgeShortfall && request.chainId === ROUTED_PAYMENT_CHAIN_ID
      ? (amount * BigInt(ROUTED_PAYMENT_TOLERANCE_BPS)) / 10_000n
      : 0n;
  const minimum = minimumNetAmount(amount - tolerance, fees, portalShield);
  const token = tokenIds.find((entry) => entry.id !== null && entry.id === note.token)?.token ?? null;
  const confirmations = latestBlock >= blockNumber ? latestBlock - blockNumber + 1n : 0n;
  const payment = {
    txHash: receipt.transactionHash,
    blockNumber,
    confirmations,
    noteId: note.noteId,
    vaultTokenId: note.token,
    token,
    netAmount: note.netAmount,
    minimumNetAmount: minimum,
    shortfall: note.netAmount < full ? full - note.netAmount : 0n,
    portalShield,
  };
  if (token === null) return { status: "wrong_token", payment };
  if (note.netAmount < minimum) return { status: "underpaid", payment };
  if (confirmations < parameters.confirmations) return { status: "confirming", payment };
  return { status: "paid", payment };
}

/**
 * The block of the CommittedNotes batch from the aggregator that holds a note, or null when it is
 * not committed. The logs are fetched once per verification, from the first shield block asked
 * about (candidates come earliest first) to `latestBlock`; a note commits only after its shield,
 * so later blocks reuse them.
 */
function committedNotesReader({ publicClient, aggregatorAddress }: ParsedParameters, latestBlock: bigint) {
  let fetched: { fromBlock: bigint; logs: Promise<Log[]> } | undefined;
  return async ({ blockNumber, noteId }: { blockNumber: bigint; noteId: bigint }): Promise<bigint | null> => {
    if (latestBlock < blockNumber) return null;
    if (fetched === undefined || blockNumber < fetched.fromBlock) {
      fetched = {
        fromBlock: blockNumber,
        logs: getLogsInRange(
          publicClient.getLogs({
            address: aggregatorAddress,
            event: committedNotesEvent,
            fromBlock: blockNumber,
            toBlock: latestBlock,
          }),
          blockNumber,
          latestBlock,
        ),
      };
    }
    return committedNoteBlock(await fetched.logs, noteId, aggregatorAddress);
  };
}

/**
 * Assess the candidates in order and take the first that is paid, else the first that is
 * confirming, else the earliest (with its underpaid or wrong_token status).
 *
 * A note short of `confirmations` ends the search: later notes have no more confirmations, so
 * none can be paid instead. With `paidWhen: "committed"`, a note waiting only for its batch
 * commit is `confirming` and the search goes on: the batch prover picks which pending notes to
 * commit, so a later sibling can be committed first.
 */
async function assessPayment(
  parameters: ParsedParameters,
  located: LocatedPayments,
  latestBlock: bigint,
): Promise<PaymentVerification> {
  const state = shieldBlockReader(parameters);
  const commitBlockOf = committedNotesReader(parameters, latestBlock);
  // A commit shallower than `confirmations` could still be reorged away, like a shallow shield.
  const isCommitDeep = (commitBlock: bigint | null) =>
    commitBlock !== null && latestBlock - commitBlock + 1n >= parameters.confirmations;
  let paid: Assessment | undefined;
  let confirming: Assessment | undefined;
  let earliest: Assessment | undefined;
  for await (const candidate of located.candidates) {
    const assessment = await assessNote(parameters, state, candidate, latestBlock);
    earliest ??= assessment;
    const awaitingCommit =
      assessment.status === "paid" &&
      parameters.paidWhen === "committed" &&
      !isCommitDeep(await commitBlockOf(assessment.payment));
    if (assessment.status === "paid" && !awaitingCommit) {
      paid = assessment;
      break;
    }
    if (awaitingCommit) {
      confirming ??= { ...assessment, status: "confirming" };
    } else if (assessment.status === "confirming") {
      confirming ??= assessment;
      break;
    }
  }
  const chosen = paid ?? confirming ?? earliest;
  if (chosen === undefined) return { status: "not_found", payment: null };

  const { noteId } = chosen.payment;
  const committed = (await commitBlockOf(chosen.payment)) !== null;
  const siblingNoteIds = [...new Set(located.noteIds)].filter((candidate) => candidate !== noteId);
  return { status: chosen.status, payment: { ...chosen.payment, committed, siblingNoteIds } };
}

/**
 * Decide whether a stored payment request has been paid on chain. Node-only (loads rs-core).
 *
 * A note pays the request only when its noteId recomputes as
 * `Poseidon(request.ownerHash, netAmount, token)` and it carries the request's R and viewTag,
 * in a PendingNotes log emitted by `aggregatorAddress`. The token must be the vault id of
 * `request.token` or one of `request.tokens`, and the net amount must reach what `request.amount`
 * yields after the vault's deposit fee and gas fees at the shield block (overpayment is accepted).
 * On `ROUTED_PAYMENT_CHAIN_ID` it may fall short by up to `ROUTED_PAYMENT_TOLERANCE_BPS` of the
 * amount: what bridging a payment made on another network may cost the shop.
 *
 * With `paidWhen: "committed"` (see {@link PaidWhen}), a note that would be `paid` stays
 * `confirming` until it appears in a CommittedNotes batch from the aggregator whose block also
 * has `confirmations` blocks.
 *
 * With `txHash`, only that transaction is examined; a pending transaction is `not_found`, and a
 * transaction that does not pay the request throws `UNRELATED`. Without it, PendingNotes logs are
 * scanned from `fromBlock` to the latest block. Either way the matching notes are assessed in
 * (block, log) order: the first that is `paid` is used, else the first that is `confirming`, and
 * when none is either, the earliest one with its `underpaid` or `wrong_token` status.
 *
 * Fees and vault config are read at the shield block, so the RPC must serve contract state at
 * that block (an archive node, or verification soon after the shield); a failed read throws an
 * error naming the block. Keep the scan window short on providers that cap `eth_getLogs` ranges;
 * a failed `eth_getLogs` throws an error naming the range.
 */
export async function verifyPayment(parameters: VerifyPaymentParameters): Promise<PaymentVerification> {
  const parsed = parseParameters(parameters);
  const chainId = await parsed.publicClient.getChainId();
  if (chainId !== parsed.request.chainId) {
    throw new PaymentVerificationError(
      "WRONG_CHAIN",
      `publicClient is on chain ${chainId}, but the request is for chain ${parsed.request.chainId}`,
    );
  }
  await ensureRustCore();

  if ("txHash" in parsed.lookup) {
    const located = await locateByTxHash(parsed, parsed.lookup.txHash);
    if (located === null) return { status: "not_found", payment: null };
    return assessPayment(parsed, located, await parsed.publicClient.getBlockNumber());
  }

  const latestBlock = await parsed.publicClient.getBlockNumber();
  const located = await locateByScan(parsed, parsed.lookup.fromBlock, latestBlock);
  if (located === null) return { status: "not_found", payment: null };
  return assessPayment(parsed, located, latestBlock);
}
