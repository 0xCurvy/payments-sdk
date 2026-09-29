import { existsSync, readFileSync } from "node:fs";
import { noteId as rustNoteId } from "@0xcurvy/rs-core-wasm/core";
import type { Hex } from "viem";
import {
  createPaymentRequest,
  initialize,
  type PaidWhen,
  type PaymentVerificationErrorCode,
  type VerifyPaymentParameters,
  verifyPayment,
} from "../merchant";
import { FEE_DENOMINATOR, minimumNetAmount } from "../merchant/internal/paymentFees";
import { ensureRustCore } from "../merchant/internal/rustCore";
import type { PaymentIntent } from "../types";
import {
  AGGREGATOR,
  CHAIN_ID,
  committedNotesLog,
  computeNoteId,
  DEPOSIT_FEE_BPS,
  mockClient,
  OTHER,
  OTHER_TOKEN_ID,
  PENDING_NOTE_COMMITMENT_FEE,
  type PendingSlot,
  PORTAL_DEPLOYMENT_FEE,
  PORTAL_FACTORY,
  pendingNotesLog,
  RECIPIENT,
  receiptOf,
  shieldPortalDeployedLog,
  TOKEN,
  TOKEN_ID,
  txHashOf,
} from "./verifyPaymentFixtures";

const CONFIRMATIONS = 3;
const AMOUNT = 10_000n;
/** 10_000 - 0.1% - commitment gas - portal deployment gas. */
const PORTAL_MINIMUM =
  AMOUNT - (AMOUNT * DEPOSIT_FEE_BPS) / 10_000n - PENDING_NOTE_COMMITMENT_FEE - PORTAL_DEPLOYMENT_FEE;
const DIRECT_MINIMUM = AMOUNT - (AMOUNT * DEPOSIT_FEE_BPS) / 10_000n - PENDING_NOTE_COMMITMENT_FEE;
const SHIELD_BLOCK = 90n;
const SHIELD_TX = txHashOf("ab");

/** Another owner's ownerHash: the buyer's own note, announced under the merchant's R. */
const ATTACKER_OWNER_HASH = 1234567890123456789n;

let request: PaymentIntent;

beforeAll(async () => {
  request = await createPaymentRequest({
    recipient: RECIPIENT,
    amount: AMOUNT,
    token: TOKEN,
    chainId: CHAIN_ID,
    merchantOrigin: "https://merchant.example",
  });
});

function merchantR(): readonly [bigint, bigint] {
  return [BigInt(request.ephemeralKeyX), BigInt(request.ephemeralKeyY)];
}

async function merchantSlot(amount: bigint, token = TOKEN_ID): Promise<PendingSlot> {
  return {
    noteId: await computeNoteId(request.ownerHash, amount, token),
    ephemeralKey: merchantR(),
    viewTag: request.viewTag,
    token,
    amount,
  };
}

async function spoofSlot(amount: bigint): Promise<PendingSlot> {
  return {
    noteId: await computeNoteId(ATTACKER_OWNER_HASH, amount, TOKEN_ID),
    ephemeralKey: merchantR(),
    viewTag: request.viewTag,
    token: TOKEN_ID,
    amount,
  };
}

async function unrelatedSlot(): Promise<PendingSlot> {
  return {
    noteId: await computeNoteId(42n, 5_000n, TOKEN_ID),
    ephemeralKey: [11n, 22n],
    viewTag: 7,
    token: TOKEN_ID,
    amount: 5_000n,
  };
}

/** A portal-shield receipt paying `slots` (plus the factory's ShieldPortalDeployed log unless `direct`). */
function shieldReceipt(slots: readonly PendingSlot[], options: { direct?: boolean; hash?: Hex; block?: bigint } = {}) {
  const location = { blockNumber: options.block ?? SHIELD_BLOCK, transactionHash: options.hash ?? SHIELD_TX };
  const logs = [pendingNotesLog(AGGREGATOR, slots, { ...location, logIndex: 0 })];
  if (!options.direct)
    logs.push(shieldPortalDeployedLog(PORTAL_FACTORY, request.ownerHash, { ...location, logIndex: 1 }));
  return receiptOf(location.transactionHash, location.blockNumber, logs);
}

function withHash(client: ReturnType<typeof mockClient>, txHash: Hex = SHIELD_TX): VerifyPaymentParameters {
  return { publicClient: client.client, aggregatorAddress: AGGREGATOR, request, confirmations: CONFIRMATIONS, txHash };
}

async function expectCode(promise: Promise<unknown>, code: PaymentVerificationErrorCode) {
  await expect(promise).rejects.toMatchObject({ name: "PaymentVerificationError", code });
}

describe("rs-core noteId", () => {
  it("matches the on-chain PoseidonT4 known-answer vectors", async () => {
    // Vectors pinned in packages/contracts/evm/test/solidity/utils/poseidonT4.test.sol.
    const r = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
    await ensureRustCore();
    expect(rustNoteId("0", "0", "0")).toBe(
      "5317387130258456662214331362918410991734007599705406860481038345552731150762",
    );
    expect(rustNoteId("1", "2", "3")).toBe(
      "6542985608222806190361240322586112750744169038454362455181422643027100751666",
    );
    expect(rustNoteId((r - 1n).toString(), (r - 2n).toString(), (r - 3n).toString())).toBe(
      "20133197287301041945818928843432871492701166386418821647132231623255907241873",
    );
  });

  const vaultSource = new URL("../../../../contracts/evm/src/v2/vault/CurvyVaultV2.sol", import.meta.url);
  it.skipIf(!existsSync(vaultSource))("pins FEE_DENOMINATOR to CurvyVaultV2", () => {
    const match = readFileSync(vaultSource, "utf8").match(/FEE_DENOMINATOR\s*=\s*(\d+)\s*;/);
    expect(match?.[1]).toBe(FEE_DENOMINATOR.toString());
  });

  it("floors the minimum net amount at 1", () => {
    expect(minimumNetAmount(100n, { depositFee: 10n, pendingNoteCommitment: 500n, portalDeployment: 0n }, false)).toBe(
      1n,
    );
  });
});

describe("verifyPayment with a txHash hint", () => {
  it("accepts an exact portal payment and reports the note", async () => {
    const slot = await merchantSlot(PORTAL_MINIMUM);
    const client = mockClient({ receipts: [shieldReceipt([slot])] });
    await expect(verifyPayment(withHash(client))).resolves.toEqual({
      status: "paid",
      payment: {
        txHash: SHIELD_TX,
        blockNumber: SHIELD_BLOCK,
        confirmations: 11n,
        noteId: slot.noteId,
        vaultTokenId: TOKEN_ID,
        netAmount: PORTAL_MINIMUM,
        minimumNetAmount: PORTAL_MINIMUM,
        portalShield: true,
        committed: false,
        siblingNoteIds: [],
      },
    });
    // Fees and config are read at the shield block, not at latest.
    for (const [call] of client.readContract.mock.calls) expect(call).toMatchObject({ blockNumber: SHIELD_BLOCK });
    expect(client.getLogs).toHaveBeenCalledWith(
      expect.objectContaining({ address: AGGREGATOR, fromBlock: SHIELD_BLOCK, toBlock: 100n }),
    );
  });

  it("accepts an overpayment", async () => {
    const client = mockClient({ receipts: [shieldReceipt([await merchantSlot(PORTAL_MINIMUM + 5_000n)])] });
    await expect(verifyPayment(withHash(client))).resolves.toMatchObject({ status: "paid" });
  });

  it("reports an underpayment regardless of confirmations", async () => {
    const client = mockClient({
      latestBlock: SHIELD_BLOCK,
      receipts: [shieldReceipt([await merchantSlot(PORTAL_MINIMUM - 1n)])],
    });
    await expect(verifyPayment(withHash(client))).resolves.toMatchObject({
      status: "underpaid",
      payment: { netAmount: PORTAL_MINIMUM - 1n, minimumNetAmount: PORTAL_MINIMUM, confirmations: 1n },
    });
  });

  it("does not deduct the portal fee from a direct shield", async () => {
    const between = DIRECT_MINIMUM - 1n;
    const direct = mockClient({ receipts: [shieldReceipt([await merchantSlot(between)], { direct: true })] });
    await expect(verifyPayment(withHash(direct))).resolves.toMatchObject({
      status: "underpaid",
      payment: { portalShield: false, minimumNetAmount: DIRECT_MINIMUM },
    });

    const portal = mockClient({ receipts: [shieldReceipt([await merchantSlot(between)])] });
    await expect(verifyPayment(withHash(portal))).resolves.toMatchObject({
      status: "paid",
      payment: { portalShield: true, minimumNetAmount: PORTAL_MINIMUM },
    });
  });

  it("ignores ShieldPortalDeployed from a contract other than the aggregator's factory", async () => {
    const slot = await merchantSlot(PORTAL_MINIMUM);
    const location = { blockNumber: SHIELD_BLOCK, transactionHash: SHIELD_TX };
    const receipt = receiptOf(SHIELD_TX, SHIELD_BLOCK, [
      pendingNotesLog(AGGREGATOR, [slot], location),
      shieldPortalDeployedLog(OTHER, request.ownerHash, { ...location, logIndex: 1 }),
    ]);
    await expect(verifyPayment(withHash(mockClient({ receipts: [receipt] })))).resolves.toMatchObject({
      status: "underpaid",
      payment: { portalShield: false, minimumNetAmount: DIRECT_MINIMUM },
    });
  });

  it("reports a note in another vault token as wrong_token", async () => {
    const client = mockClient({ receipts: [shieldReceipt([await merchantSlot(AMOUNT, OTHER_TOKEN_ID)])] });
    await expect(verifyPayment(withHash(client))).resolves.toMatchObject({
      status: "wrong_token",
      payment: { vaultTokenId: OTHER_TOKEN_ID },
    });
  });

  it("reports wrong_token when the request token is not registered in the vault", async () => {
    const client = mockClient({
      receipts: [shieldReceipt([await merchantSlot(AMOUNT)])],
      tokenIds: new Map(),
    });
    await expect(verifyPayment(withHash(client))).resolves.toMatchObject({ status: "wrong_token" });
  });

  it("reports confirming until enough blocks pass", async () => {
    const receipts = [shieldReceipt([await merchantSlot(PORTAL_MINIMUM)])];
    await expect(verifyPayment(withHash(mockClient({ receipts, latestBlock: 91n })))).resolves.toMatchObject({
      status: "confirming",
      payment: { confirmations: 2n },
    });
    await expect(verifyPayment(withHash(mockClient({ receipts, latestBlock: 92n })))).resolves.toMatchObject({
      status: "paid",
      payment: { confirmations: 3n },
    });
    // An RPC behind the shield block counts zero confirmations rather than going negative.
    await expect(verifyPayment(withHash(mockClient({ receipts, latestBlock: 80n })))).resolves.toMatchObject({
      status: "confirming",
      payment: { confirmations: 0n, committed: false },
    });
  });

  it("reports whether the note was batch-committed by the aggregator", async () => {
    const slot = await merchantSlot(PORTAL_MINIMUM);
    const receipts = [shieldReceipt([slot])];
    const location = { blockNumber: 95n, transactionHash: txHashOf("c0") };
    const committed = mockClient({
      receipts,
      committedNotesLogs: [committedNotesLog(AGGREGATOR, [7n, slot.noteId], location)],
    });
    await expect(verifyPayment(withHash(committed))).resolves.toMatchObject({ payment: { committed: true } });

    const elsewhere = mockClient({ receipts, committedNotesLogs: [committedNotesLog(OTHER, [slot.noteId], location)] });
    await expect(verifyPayment(withHash(elsewhere))).resolves.toMatchObject({ payment: { committed: false } });
  });

  it("uses a full note over an earlier dust note in the same transaction and reports the sibling", async () => {
    const dust = await merchantSlot(1n);
    const full = await merchantSlot(PORTAL_MINIMUM);
    const client = mockClient({ receipts: [shieldReceipt([dust, full])] });
    await expect(verifyPayment(withHash(client))).resolves.toMatchObject({
      status: "paid",
      payment: { noteId: full.noteId, netAmount: PORTAL_MINIMUM, siblingNoteIds: [dust.noteId] },
    });
    // curvyVault, getTokenId, depositFee, perTokenGasFees and portalFactory, each read once for the block.
    expect(client.readContract).toHaveBeenCalledTimes(5);
  });

  it("keeps the earliest note's status when no note in the transaction pays", async () => {
    const dust = await merchantSlot(1n);
    const other = await merchantSlot(AMOUNT, OTHER_TOKEN_ID);
    const client = mockClient({ receipts: [shieldReceipt([dust, other])] });
    await expect(verifyPayment(withHash(client))).resolves.toMatchObject({
      status: "underpaid",
      payment: { noteId: dust.noteId, siblingNoteIds: [other.noteId] },
    });
  });

  it("names the block when a read at the shield block fails", async () => {
    const client = mockClient({ receipts: [shieldReceipt([await merchantSlot(PORTAL_MINIMUM)])] });
    client.readContract.mockRejectedValueOnce(new Error("missing trie node"));
    await expect(verifyPayment(withHash(client))).rejects.toThrow(
      /reading curvyVault at block 90 failed \(missing trie node\); the RPC must serve contract state/,
    );
  });

  it("rejects the merchant's R on a note owned by someone else as UNRELATED", async () => {
    const client = mockClient({ receipts: [shieldReceipt([await spoofSlot(AMOUNT)])] });
    await expectCode(verifyPayment(withHash(client)), "UNRELATED");
  });

  it("rejects a matching note announced with a different viewTag or as ciphertext", async () => {
    const slot = await merchantSlot(PORTAL_MINIMUM);
    const wrongViewTag = mockClient({ receipts: [shieldReceipt([{ ...slot, viewTag: (request.viewTag + 1) % 256 }])] });
    await expectCode(verifyPayment(withHash(wrongViewTag)), "UNRELATED");
    const encrypted = mockClient({ receipts: [shieldReceipt([{ ...slot, isPlaintext: false }])] });
    await expectCode(verifyPayment(withHash(encrypted)), "UNRELATED");
  });

  it("checks every slot of every log and pins the aggregator", async () => {
    const real = await merchantSlot(PORTAL_MINIMUM);
    const location = { blockNumber: SHIELD_BLOCK, transactionHash: SHIELD_TX };
    const receipt = receiptOf(SHIELD_TX, SHIELD_BLOCK, [
      pendingNotesLog(OTHER, [real], { ...location, logIndex: 0 }),
      pendingNotesLog(AGGREGATOR, [await unrelatedSlot(), await spoofSlot(AMOUNT)], { ...location, logIndex: 1 }),
      pendingNotesLog(AGGREGATOR, [await unrelatedSlot(), real], { ...location, logIndex: 2 }),
      shieldPortalDeployedLog(PORTAL_FACTORY, request.ownerHash, { ...location, logIndex: 3 }),
    ]);
    await expect(verifyPayment(withHash(mockClient({ receipts: [receipt] })))).resolves.toMatchObject({
      status: "paid",
      payment: { noteId: real.noteId },
    });

    const lookalikeOnly = receiptOf(SHIELD_TX, SHIELD_BLOCK, [pendingNotesLog(OTHER, [real], location)]);
    await expectCode(verifyPayment(withHash(mockClient({ receipts: [lookalikeOnly] }))), "NOT_A_SHIELD");
  });

  it("throws REVERTED for a reverted transaction", async () => {
    const receipt = receiptOf(SHIELD_TX, SHIELD_BLOCK, [], "reverted");
    await expectCode(verifyPayment(withHash(mockClient({ receipts: [receipt] }))), "REVERTED");
  });

  it("throws NOT_A_SHIELD when the transaction emitted no aggregator PendingNotes", async () => {
    const receipt = receiptOf(SHIELD_TX, SHIELD_BLOCK, []);
    await expectCode(verifyPayment(withHash(mockClient({ receipts: [receipt] }))), "NOT_A_SHIELD");
  });

  it("returns not_found while the hinted transaction is pending", async () => {
    await expect(verifyPayment(withHash(mockClient({ pending: [SHIELD_TX] })))).resolves.toEqual({
      status: "not_found",
      payment: null,
    });
  });

  it("throws TX_NOT_FOUND for a hash the RPC does not know", async () => {
    await expectCode(verifyPayment(withHash(mockClient())), "TX_NOT_FOUND");
  });

  it("throws WRONG_CHAIN before any other RPC call", async () => {
    const client = mockClient({ chainId: 1 });
    await expectCode(verifyPayment(withHash(client)), "WRONG_CHAIN");
    expect(client.getTransactionReceipt).not.toHaveBeenCalled();
  });

  it("rejects invalid input", async () => {
    const client = mockClient();
    await expectCode(verifyPayment({ ...withHash(client), confirmations: 0 }), "INVALID_INPUT");
    await expectCode(verifyPayment({ ...withHash(client), txHash: "0x1234" }), "INVALID_INPUT");
    await expectCode(verifyPayment({ ...withHash(client), request: { ...request, amount: "0" } }), "INVALID_INPUT");
    await expectCode(verifyPayment({ ...withHash(client), aggregatorAddress: "0x1234" }), "INVALID_INPUT");
    expect(client.getChainId).not.toHaveBeenCalled();
  });
});

describe("verifyPayment by scanning from fromBlock", () => {
  function scanParameters(client: ReturnType<typeof mockClient>, fromBlock = 80n): VerifyPaymentParameters {
    return {
      publicClient: client.client,
      aggregatorAddress: AGGREGATOR,
      request,
      confirmations: CONFIRMATIONS,
      fromBlock,
    };
  }

  it("requires fromBlock when txHash is omitted", async () => {
    const client = mockClient();
    await expectCode(
      verifyPayment({ publicClient: client.client, aggregatorAddress: AGGREGATOR, request, confirmations: 1 }),
      "MISSING_FROM_BLOCK",
    );
    expect(client.getChainId).not.toHaveBeenCalled();
  });

  it("skips spoofed notes and returns the earliest real one", async () => {
    const spoofHash = txHashOf("5a");
    const realHash = txHashOf("5b");
    const laterHash = txHashOf("5c");
    const spoof = await spoofSlot(AMOUNT);
    const real = await merchantSlot(PORTAL_MINIMUM);
    const later = await merchantSlot(PORTAL_MINIMUM + 1n);
    const client = mockClient({
      pendingNotesLogs: [
        pendingNotesLog(AGGREGATOR, [spoof], { blockNumber: 85n, transactionHash: spoofHash }),
        pendingNotesLog(AGGREGATOR, [later], { blockNumber: 88n, transactionHash: laterHash }),
        pendingNotesLog(AGGREGATOR, [await unrelatedSlot(), real], { blockNumber: 87n, transactionHash: realHash }),
      ],
      receipts: [shieldReceipt([await unrelatedSlot(), real], { hash: realHash, block: 87n })],
    });
    await expect(verifyPayment(scanParameters(client))).resolves.toMatchObject({
      status: "paid",
      payment: { txHash: realHash, blockNumber: 87n, noteId: real.noteId, confirmations: 14n },
    });
    expect(client.getLogs).toHaveBeenCalledWith(
      expect.objectContaining({ address: AGGREGATOR, fromBlock: 80n, toBlock: 100n }),
    );
    expect(client.getTransactionReceipt).toHaveBeenCalledTimes(1);
    expect(client.getTransactionReceipt).toHaveBeenCalledWith({ hash: realHash });
  });

  it("uses a full payment over an earlier dust note to the same request", async () => {
    const dustHash = txHashOf("6a");
    const fullHash = txHashOf("6b");
    const dust = await merchantSlot(1n);
    const full = await merchantSlot(PORTAL_MINIMUM);
    const client = mockClient({
      pendingNotesLogs: [
        pendingNotesLog(AGGREGATOR, [full], { blockNumber: 87n, transactionHash: fullHash }),
        pendingNotesLog(AGGREGATOR, [dust], { blockNumber: 85n, transactionHash: dustHash }),
      ],
      receipts: [
        shieldReceipt([dust], { hash: dustHash, block: 85n }),
        shieldReceipt([full], { hash: fullHash, block: 87n }),
      ],
    });
    await expect(verifyPayment(scanParameters(client))).resolves.toMatchObject({
      status: "paid",
      payment: { txHash: fullHash, noteId: full.noteId, confirmations: 14n, siblingNoteIds: [dust.noteId] },
    });
    // Reads at block 85 and block 87 each hit the chain once.
    for (const block of [85n, 87n]) {
      expect(client.readContract.mock.calls.filter(([call]) => call.blockNumber === block)).toHaveLength(5);
    }
  });

  it("reports underpaid when only a dust note pays the request", async () => {
    const dust = await merchantSlot(1n);
    const client = mockClient({
      pendingNotesLogs: [pendingNotesLog(AGGREGATOR, [dust], { blockNumber: 85n, transactionHash: SHIELD_TX })],
      receipts: [shieldReceipt([dust], { block: 85n })],
    });
    await expect(verifyPayment(scanParameters(client))).resolves.toMatchObject({
      status: "underpaid",
      payment: { noteId: dust.noteId, netAmount: 1n, minimumNetAmount: PORTAL_MINIMUM, siblingNoteIds: [] },
    });
  });

  it("names the range when eth_getLogs fails", async () => {
    const client = mockClient();
    client.getLogs.mockRejectedValueOnce(new Error("block range too large"));
    await expect(verifyPayment(scanParameters(client))).rejects.toThrow(
      /eth_getLogs over blocks 80-100 failed \(block range too large\)/,
    );
  });

  it("returns not_found when only look-alike notes exist", async () => {
    const client = mockClient({
      pendingNotesLogs: [
        pendingNotesLog(AGGREGATOR, [await spoofSlot(AMOUNT)], { blockNumber: 85n, transactionHash: SHIELD_TX }),
      ],
    });
    await expect(verifyPayment(scanParameters(client))).resolves.toEqual({ status: "not_found", payment: null });
    expect(client.getTransactionReceipt).not.toHaveBeenCalled();
  });

  it("returns not_found without querying logs when fromBlock is ahead of the chain", async () => {
    const client = mockClient();
    await expect(verifyPayment(scanParameters(client, 101n))).resolves.toEqual({ status: "not_found", payment: null });
    expect(client.getLogs).not.toHaveBeenCalled();
  });

  it("does not trust a log that is missing from its receipt (reorged out)", async () => {
    const real = await merchantSlot(PORTAL_MINIMUM);
    const client = mockClient({
      pendingNotesLogs: [pendingNotesLog(AGGREGATOR, [real], { blockNumber: 87n, transactionHash: SHIELD_TX })],
      receipts: [receiptOf(SHIELD_TX, 87n, [])],
    });
    await expect(verifyPayment(scanParameters(client))).resolves.toEqual({ status: "not_found", payment: null });

    const noReceipt = mockClient({
      pendingNotesLogs: [pendingNotesLog(AGGREGATOR, [real], { blockNumber: 87n, transactionHash: SHIELD_TX })],
    });
    await expect(verifyPayment(scanParameters(noReceipt))).resolves.toEqual({ status: "not_found", payment: null });
  });

  it("applies the same token, amount and confirmation rules", async () => {
    const underpaid = await merchantSlot(PORTAL_MINIMUM - 10n);
    const client = mockClient({
      latestBlock: 88n,
      pendingNotesLogs: [pendingNotesLog(AGGREGATOR, [underpaid], { blockNumber: 87n, transactionHash: SHIELD_TX })],
      receipts: [shieldReceipt([underpaid], { block: 87n })],
    });
    await expect(verifyPayment(scanParameters(client))).resolves.toMatchObject({ status: "underpaid" });

    const exact = await merchantSlot(PORTAL_MINIMUM);
    const confirming = mockClient({
      latestBlock: 88n,
      pendingNotesLogs: [pendingNotesLog(AGGREGATOR, [exact], { blockNumber: 87n, transactionHash: SHIELD_TX })],
      receipts: [shieldReceipt([exact], { block: 87n })],
    });
    await expect(verifyPayment(scanParameters(confirming))).resolves.toMatchObject({
      status: "confirming",
      payment: { confirmations: 2n },
    });
  });
});

describe("initialize().verifyPayment", () => {
  it("binds confirmations from init", async () => {
    const sdk = initialize({
      recipient: RECIPIENT,
      chainId: CHAIN_ID,
      merchantOrigin: "https://merchant.example",
      confirmations: 12,
    });
    const receipts = [shieldReceipt([await merchantSlot(PORTAL_MINIMUM)])];
    const parameters = { publicClient: mockClient({ receipts }).client, aggregatorAddress: AGGREGATOR, request };
    await expect(sdk.verifyPayment({ ...parameters, txHash: SHIELD_TX })).resolves.toMatchObject({
      status: "confirming",
      payment: { confirmations: 11n },
    });
    const later = mockClient({ receipts, latestBlock: 101n }).client;
    await expect(sdk.verifyPayment({ ...parameters, publicClient: later, txHash: SHIELD_TX })).resolves.toMatchObject({
      status: "paid",
    });
    await expect(sdk.verifyPayment(parameters)).rejects.toMatchObject({ code: "MISSING_FROM_BLOCK" });
  });

  it("binds paidWhen from init", async () => {
    const slot = await merchantSlot(PORTAL_MINIMUM);
    const config = { recipient: RECIPIENT, chainId: CHAIN_ID, merchantOrigin: "https://merchant.example" };
    const receipts = [shieldReceipt([slot])];
    const uncommitted = { publicClient: mockClient({ receipts }).client, aggregatorAddress: AGGREGATOR, request };
    const committedClient = mockClient({
      receipts,
      committedNotesLogs: [
        committedNotesLog(AGGREGATOR, [slot.noteId], { blockNumber: 95n, transactionHash: SHIELD_TX }),
      ],
    }).client;

    const committed = initialize({ ...config, confirmations: CONFIRMATIONS, paidWhen: "committed" });
    await expect(committed.verifyPayment({ ...uncommitted, txHash: SHIELD_TX })).resolves.toMatchObject({
      status: "confirming",
      payment: { committed: false },
    });
    await expect(
      committed.verifyPayment({ ...uncommitted, publicClient: committedClient, txHash: SHIELD_TX }),
    ).resolves.toMatchObject({ status: "paid", payment: { committed: true } });

    // The default binds "shielded".
    const shielded = initialize({ ...config, confirmations: CONFIRMATIONS });
    await expect(shielded.verifyPayment({ ...uncommitted, txHash: SHIELD_TX })).resolves.toMatchObject({
      status: "paid",
      payment: { committed: false },
    });
  });

  it("rejects an unknown paidWhen at init", () => {
    const config = { recipient: RECIPIENT, chainId: CHAIN_ID, merchantOrigin: "https://merchant.example" };
    for (const paidWhen of ["finality", null]) {
      expect(() => initialize({ ...config, confirmations: 1, paidWhen: paidWhen as PaidWhen })).toThrow(
        'paidWhen must be "shielded" or "committed"',
      );
    }
  });
});

describe("verifyPayment with paidWhen", () => {
  const COMMIT_BLOCK = { blockNumber: 95n, transactionHash: txHashOf("c0") };

  function committedMode(client: ReturnType<typeof mockClient>): VerifyPaymentParameters {
    return { ...withHash(client), paidWhen: "committed" };
  }

  it('defaults to "shielded": enough confirmations is paid whether or not the note is committed', async () => {
    const receipts = [shieldReceipt([await merchantSlot(PORTAL_MINIMUM)])];
    const expected = { status: "paid", payment: { committed: false } };
    await expect(verifyPayment(withHash(mockClient({ receipts })))).resolves.toMatchObject(expected);
    await expect(verifyPayment({ ...withHash(mockClient({ receipts })), paidWhen: "shielded" })).resolves.toMatchObject(
      expected,
    );
  });

  it('keeps a confirmed but uncommitted note confirming with "committed"', async () => {
    const client = mockClient({ receipts: [shieldReceipt([await merchantSlot(PORTAL_MINIMUM)])] });
    await expect(verifyPayment(committedMode(client))).resolves.toMatchObject({
      status: "confirming",
      payment: { confirmations: 11n, committed: false },
    });
    expect(client.getLogs).toHaveBeenCalledWith(
      expect.objectContaining({ address: AGGREGATOR, fromBlock: SHIELD_BLOCK, toBlock: 100n }),
    );
    // The commit lookup runs once per verification.
    expect(client.getLogs).toHaveBeenCalledTimes(1);
  });

  it('reports paid once the note is in a CommittedNotes batch with "committed"', async () => {
    const slot = await merchantSlot(PORTAL_MINIMUM);
    const client = mockClient({
      receipts: [shieldReceipt([slot])],
      committedNotesLogs: [committedNotesLog(AGGREGATOR, [7n, slot.noteId], COMMIT_BLOCK)],
    });
    await expect(verifyPayment(committedMode(client))).resolves.toMatchObject({
      status: "paid",
      payment: { noteId: slot.noteId, committed: true },
    });

    // A batch from another contract does not count.
    const elsewhere = mockClient({
      receipts: [shieldReceipt([slot])],
      committedNotesLogs: [committedNotesLog(OTHER, [slot.noteId], COMMIT_BLOCK)],
    });
    await expect(verifyPayment(committedMode(elsewhere))).resolves.toMatchObject({
      status: "confirming",
      payment: { committed: false },
    });
  });

  it('still requires confirmations for a committed note with "committed"', async () => {
    const slot = await merchantSlot(PORTAL_MINIMUM);
    const client = mockClient({
      latestBlock: 91n,
      receipts: [shieldReceipt([slot])],
      committedNotesLogs: [committedNotesLog(AGGREGATOR, [slot.noteId], { ...COMMIT_BLOCK, blockNumber: 91n })],
    });
    await expect(verifyPayment(committedMode(client))).resolves.toMatchObject({
      status: "confirming",
      payment: { confirmations: 2n, committed: true },
    });
  });

  it('requires confirmations on the commit block too with "committed"', async () => {
    const slot = await merchantSlot(PORTAL_MINIMUM);
    const commitAt = (blockNumber: bigint) =>
      mockClient({
        receipts: [shieldReceipt([slot])],
        committedNotesLogs: [committedNotesLog(AGGREGATOR, [slot.noteId], { ...COMMIT_BLOCK, blockNumber })],
      });
    // Commit at the head (1 block deep, CONFIRMATIONS > 1): a reorg could still undo it.
    expect(CONFIRMATIONS).toBeGreaterThan(1);
    await expect(verifyPayment(committedMode(commitAt(100n)))).resolves.toMatchObject({
      status: "confirming",
      payment: { confirmations: 11n, committed: true },
    });
    // Exactly CONFIRMATIONS blocks deep is enough.
    await expect(verifyPayment(committedMode(commitAt(100n - BigInt(CONFIRMATIONS) + 1n)))).resolves.toMatchObject({
      status: "paid",
      payment: { committed: true },
    });
    // "shielded" ignores the commit depth.
    await expect(verifyPayment(withHash(commitAt(100n)))).resolves.toMatchObject({
      status: "paid",
      payment: { committed: true },
    });
  });

  it('leaves underpaid and wrong_token unchanged with "committed"', async () => {
    const dust = await merchantSlot(PORTAL_MINIMUM - 1n);
    const underpaid = mockClient({
      receipts: [shieldReceipt([dust])],
      committedNotesLogs: [committedNotesLog(AGGREGATOR, [dust.noteId], COMMIT_BLOCK)],
    });
    await expect(verifyPayment(committedMode(underpaid))).resolves.toMatchObject({
      status: "underpaid",
      payment: { committed: true },
    });
    const uncommitted = mockClient({ receipts: [shieldReceipt([dust])] });
    await expect(verifyPayment(committedMode(uncommitted))).resolves.toMatchObject({ status: "underpaid" });

    const other = mockClient({ receipts: [shieldReceipt([await merchantSlot(AMOUNT, OTHER_TOKEN_ID)])] });
    await expect(verifyPayment(committedMode(other))).resolves.toMatchObject({ status: "wrong_token" });
  });

  it('uses a committed sibling over an earlier uncommitted note with "committed"', async () => {
    const first = await merchantSlot(PORTAL_MINIMUM);
    const second = await merchantSlot(PORTAL_MINIMUM + 1n);
    const receipts = [shieldReceipt([first, second])];
    const secondCommitted = mockClient({
      receipts,
      committedNotesLogs: [committedNotesLog(AGGREGATOR, [second.noteId], COMMIT_BLOCK)],
    });
    await expect(verifyPayment(committedMode(secondCommitted))).resolves.toMatchObject({
      status: "paid",
      payment: { noteId: second.noteId, committed: true, siblingNoteIds: [first.noteId] },
    });
    expect(secondCommitted.getLogs).toHaveBeenCalledTimes(1);

    // Neither committed yet: the earliest note is the one reported as confirming.
    await expect(verifyPayment(committedMode(mockClient({ receipts })))).resolves.toMatchObject({
      status: "confirming",
      payment: { noteId: first.noteId, committed: false, siblingNoteIds: [second.noteId] },
    });

    // With "shielded" the earliest paid note ends the search, as before.
    await expect(verifyPayment(withHash(secondCommitted))).resolves.toMatchObject({
      status: "paid",
      payment: { noteId: first.noteId, committed: false },
    });
  });

  it('applies "committed" when scanning from fromBlock', async () => {
    const slot = await merchantSlot(PORTAL_MINIMUM);
    const chain = {
      pendingNotesLogs: [pendingNotesLog(AGGREGATOR, [slot], { blockNumber: 87n, transactionHash: SHIELD_TX })],
      receipts: [shieldReceipt([slot], { block: 87n })],
    };
    const parameters = (client: ReturnType<typeof mockClient>): VerifyPaymentParameters => ({
      publicClient: client.client,
      aggregatorAddress: AGGREGATOR,
      request,
      confirmations: CONFIRMATIONS,
      fromBlock: 80n,
      paidWhen: "committed",
    });
    await expect(verifyPayment(parameters(mockClient(chain)))).resolves.toMatchObject({ status: "confirming" });
    const committed = mockClient({
      ...chain,
      committedNotesLogs: [committedNotesLog(AGGREGATOR, [slot.noteId], COMMIT_BLOCK)],
    });
    await expect(verifyPayment(parameters(committed))).resolves.toMatchObject({
      status: "paid",
      payment: { committed: true },
    });
  });

  it("rejects an unknown paidWhen", async () => {
    const client = mockClient();
    for (const paidWhen of ["finalized", "", null, 1]) {
      await expectCode(verifyPayment({ ...withHash(client), paidWhen: paidWhen as PaidWhen }), "INVALID_INPUT");
    }
    expect(client.getChainId).not.toHaveBeenCalled();
  });
});
