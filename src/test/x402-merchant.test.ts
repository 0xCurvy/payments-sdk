/**
 * Unit coverage for the x402 exact merchant integrator path:
 * createPaymentRequest → predictPortalAddress(facilitator recovery) → verifyPayment / findNoteInReceipt.
 * No Express, @x402/*, or facilitator HTTP.
 */
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  type Hex,
  type TransactionReceipt,
  zeroHash,
} from "viem";
import { findNoteInReceipt, pendingNotesAbi, predictPortalAddress, verifyPayment } from "../index";
import { createPaymentRequest } from "../merchant";

const TOKEN = getAddress("0x0000000000000000000000000000000000000003");
const AGGREGATOR = getAddress("0x0000000000000000000000000000000000000004");
const PORTAL_FACTORY = getAddress("0x0000000000000000000000000000000000000006");
/** Anvil #0 — facilitator submitter / CREATE2 recovery on the exact rail. */
const FACILITATOR_SUBMITTER = getAddress("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
const PREDICTED_PAY_TO = getAddress("0x00000000000000000000000000000000000000A1");
const CONFIRMATIONS = 12;
const PRICE = 10_000n;
const RECIPIENT = {
  S: "18841156662615403723520443807716409278140486251221355574263061434503921265588.98357793752770194678499426326386336085357653965912017495890904868125096440617",
  V: "1760020198064161165795911805578555709740706783603233189380229091027759021973.19520756004562638043874842910851983303596751292314679321770725659462577589821",
  babyJubjubPublicKey:
    "5509359784107808046541889973707062912186356978136525798140528612444721440004.5125768395023217094469327424244994953312297627197683956739233494456001838760",
};

function pendingLog(
  address: `0x${string}`,
  ephemeralKey: readonly [bigint, bigint],
  noteId = 202n,
  netAmount = 1_800n,
): TransactionReceipt["logs"][number] {
  return {
    address,
    blockHash: zeroHash,
    blockNumber: 12n,
    data: encodeAbiParameters(
      [
        { type: "uint256[]" },
        { type: "uint256[][2]" },
        { type: "uint16[]" },
        { type: "uint256[]" },
        { type: "uint256[]" },
        { type: "bool[]" },
      ],
      [
        [101n, noteId],
        [
          [11n, ephemeralKey[0]],
          [22n, ephemeralKey[1]],
        ],
        [1, 2],
        [7n, 8n],
        [900n, netAmount],
        [false, false],
      ],
    ),
    logIndex: 3,
    removed: false,
    topics: encodeEventTopics({ abi: pendingNotesAbi, eventName: "PendingNotes" }) as [Hex, ...Hex[]],
    transactionHash: `0x${"12".repeat(32)}`,
    transactionIndex: 1,
  };
}

describe("x402 merchant payments-sdk helpers", () => {
  it("creates challenge note fields without checkout signing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));
    const intent = await createPaymentRequest({
      recipient: RECIPIENT,
      amount: PRICE,
      token: TOKEN,
      chainId: 31_337,
      merchantOrigin: "http://127.0.0.1:4041",
      ttlSeconds: 300,
    });
    vi.useRealTimers();

    expect(intent.amount).toBe(PRICE.toString());
    expect(intent.token).toBe(TOKEN);
    expect(intent.chainId).toBe(31_337);
    expect(intent.merchantOrigin).toBe("http://127.0.0.1:4041");
    expect(intent.expiry).toBe(1_000 + 300);
    expect(intent.ownerHash).toMatch(/^\d+$/);
    expect(intent.ephemeralKeyX).toMatch(/^\d+$/);
    expect(intent.ephemeralKeyY).toMatch(/^\d+$/);
    expect(intent.viewTag).toBeGreaterThanOrEqual(0);
    // Human-checkout fields exist on the type but are unused for x402 challenges.
    expect(intent.checkoutCompletePath).toBe("/checkout/complete");
  });

  it("predicts payTo with facilitator submitter as recovery", async () => {
    const intent = await createPaymentRequest({
      recipient: RECIPIENT,
      amount: PRICE,
      token: TOKEN,
      chainId: 31_337,
      merchantOrigin: "http://127.0.0.1:4041",
      ttlSeconds: 300,
    });
    const readContract = vi.fn().mockResolvedValue(PREDICTED_PAY_TO);

    const payTo = await predictPortalAddress({
      publicClient: { readContract },
      portalFactoryAddress: PORTAL_FACTORY,
      ownerHash: intent.ownerHash,
      recovery: FACILITATOR_SUBMITTER,
    });

    expect(payTo).toBe(PREDICTED_PAY_TO);
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: PORTAL_FACTORY,
        functionName: "getEntryPortalAddress",
        args: [BigInt(intent.ownerHash), FACILITATOR_SUBMITTER],
      }),
    );
  });

  it("confirms shield evidence for the challenge ephemeral key", async () => {
    const intent = await createPaymentRequest({
      recipient: RECIPIENT,
      amount: PRICE,
      token: TOKEN,
      chainId: 31_337,
      merchantOrigin: "http://127.0.0.1:4041",
      ttlSeconds: 300,
    });
    const ephemeralKey = [BigInt(intent.ephemeralKeyX), BigInt(intent.ephemeralKeyY)] as const;
    const txHash = `0x${"ab".repeat(32)}` as Hex;
    const receipt = {
      status: "success" as const,
      blockNumber: 12n,
      logs: [pendingLog(AGGREGATOR, ephemeralKey)],
    };

    await expect(
      verifyPayment({
        publicClient: {
          getTransaction: vi.fn(),
          getTransactionReceipt: vi.fn().mockResolvedValue(receipt),
          getBlockNumber: vi.fn().mockResolvedValue(23n),
          getLogs: vi.fn().mockResolvedValue([]),
        },
        aggregatorAddress: AGGREGATOR,
        ephemeralKey,
        confirmations: CONFIRMATIONS,
        txHash,
      }),
    ).resolves.toBe(true);

    expect(findNoteInReceipt(receipt, ephemeralKey, AGGREGATOR)).toEqual({
      noteId: 202n,
      netAmount: 1_800n,
      token: 8n,
    });
  });
});
