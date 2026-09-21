import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  type Hex,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type TransactionReceipt,
  zeroHash,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildCheckoutUrl,
  buildMerchantKeySet,
  buildPaymentIntentTypedData,
  decodePaymentIntentFragment,
  findNoteInReceipt,
  parsePaymentIntent,
  pendingNotesAbi,
  signPaymentIntent,
  verifyPaymentIntent,
  verifyPayment,
  DEFAULT_PAYMENT_REQUEST_TTL_SECONDS,
} from "../index";
import { createPaymentRequest, initialize } from "../merchant";

const TOKEN = getAddress("0x0000000000000000000000000000000000000003");
const AGGREGATOR = getAddress("0x0000000000000000000000000000000000000004");
const OTHER = getAddress("0x0000000000000000000000000000000000000005");
const CONFIRMATIONS = 12;
const RECIPIENT = {
  S: "18841156662615403723520443807716409278140486251221355574263061434503921265588.98357793752770194678499426326386336085357653965912017495890904868125096440617",
  V: "1760020198064161165795911805578555709740706783603233189380229091027759021973.19520756004562638043874842910851983303596751292314679321770725659462577589821",
  babyJubjubPublicKey:
    "5509359784107808046541889973707062912186356978136525798140528612444721440004.5125768395023217094469327424244994953312297627197683956739233494456001838760",
};

function pendingLog(address: `0x${string}`): TransactionReceipt["logs"][number] {
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
        [101n, 202n],
        [
          [11n, 22n],
          [33n, 44n],
        ],
        [1, 2],
        [7n, 8n],
        [900n, 1_800n],
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

function committedLog(address: `0x${string}`, noteIds: readonly bigint[]): TransactionReceipt["logs"][number] {
  return {
    address,
    blockHash: zeroHash,
    blockNumber: 15n,
    data: encodeAbiParameters([{ type: "uint256[]" }], [noteIds]),
    logIndex: 4,
    removed: false,
    topics: encodeEventTopics({
      abi: pendingNotesAbi,
      eventName: "CommittedNotes",
      args: { batchIndex: 1n },
    }) as [Hex, ...Hex[]],
    transactionHash: `0x${"13".repeat(32)}`,
    transactionIndex: 2,
  };
}

function receiptClient(overrides: {
  getTransactionReceipt?: ReturnType<typeof vi.fn>;
  getTransaction?: ReturnType<typeof vi.fn>;
  getBlockNumber?: ReturnType<typeof vi.fn>;
  getLogs?: ReturnType<typeof vi.fn>;
}) {
  return {
    getTransaction: overrides.getTransaction ?? vi.fn(),
    getTransactionReceipt: overrides.getTransactionReceipt ?? vi.fn(),
    getBlockNumber: overrides.getBlockNumber ?? vi.fn().mockResolvedValue(23n),
    getLogs: overrides.getLogs ?? vi.fn().mockResolvedValue([]),
  };
}

describe("payments", () => {
  it("derives with rs-core Domain A primitives, signs, encodes, and verifies", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));
    const signer = privateKeyToAccount(`0x${"11".repeat(32)}`);
    const intent = await createPaymentRequest({
      recipient: RECIPIENT,
      amount: 10_000n,
      token: TOKEN,
      chainId: 31_337,
      merchantOrigin: "https://merchant.example",
      ttlSeconds: 600,
    });
    vi.useRealTimers();
    expect(intent.checkoutCompletePath).toBe("/checkout/complete");
    const payment = await signPaymentIntent(intent, (typedData) => signer.signTypedData(typedData));
    const url = buildCheckoutUrl("https://checkout.example/pay", payment);
    const decoded = decodePaymentIntentFragment(new URL(url).hash);
    expect(decoded).toEqual(payment);
    const keySet = buildMerchantKeySet([{ address: signer.address, notAfter: "2030-01-01T00:00:00.000Z" }]);
    await expect(
      verifyPaymentIntent(decoded, {
        keySet,
        expectedChainId: 31_337,
        expectedToken: TOKEN,
        nowSeconds: 1_001,
      }),
    ).resolves.toEqual({ intent, signer: signer.address });
  });

  it("defaults omitted ttlSeconds on standalone createPaymentRequest", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));
    const intent = await createPaymentRequest({
      recipient: RECIPIENT,
      amount: 10_000n,
      token: TOKEN,
      chainId: 31_337,
      merchantOrigin: "https://merchant.example",
    });
    vi.useRealTimers();
    expect(intent.expiry).toBe(1_000 + DEFAULT_PAYMENT_REQUEST_TTL_SECONDS);
  });

  it("creates payment requests from an initialized SDK client", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));
    const sdk = initialize({
      recipient: RECIPIENT,
      chainId: 31_337,
      merchantOrigin: "https://merchant.example",
      confirmations: CONFIRMATIONS,
      ttlSeconds: 900,
    });
    const intent = await sdk.createPaymentRequest({
      amount: 10_000n,
      token: TOKEN,
    });
    vi.useRealTimers();
    expect(intent.expiry).toBe(1_900);
    expect(intent.merchantOrigin).toBe("https://merchant.example");
  });

  it("uses the init default TTL when omitted from SDK config", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2_000_000));
    const sdk = initialize({
      recipient: RECIPIENT,
      chainId: 31_337,
      merchantOrigin: "https://merchant.example",
      confirmations: CONFIRMATIONS,
    });
    const intent = await sdk.createPaymentRequest({
      amount: 10_000n,
      token: TOKEN,
    });
    vi.useRealTimers();
    expect(intent.expiry).toBe(2_000 + DEFAULT_PAYMENT_REQUEST_TTL_SECONDS);
  });

  it("binds confirmations from init on sdk.verifyPayment", async () => {
    const txHash = `0x${"ab".repeat(32)}` as Hex;
    const getBlockNumber = vi.fn().mockResolvedValue(20n);
    const sdk = initialize({
      recipient: RECIPIENT,
      chainId: 31_337,
      merchantOrigin: "https://merchant.example",
      confirmations: CONFIRMATIONS,
    });

    await expect(
      sdk.verifyPayment({
        publicClient: receiptClient({
          getTransactionReceipt: vi.fn().mockResolvedValue({
            status: "success",
            blockNumber: 12n,
            logs: [pendingLog(AGGREGATOR)],
          }),
          getBlockNumber,
        }),
        aggregatorAddress: AGGREGATOR,
        ephemeralKey: [22n, 44n],
        txHash,
      }),
    ).resolves.toBe(false);
    expect(getBlockNumber).toHaveBeenCalled();
  });

  it("defaults omitted checkoutCompletePath and accepts a custom path", async () => {
    expect(
      parsePaymentIntent({
        token: TOKEN,
        amount: "1",
        chainId: 1,
        ownerHash: "2",
        ephemeralKeyX: "3",
        ephemeralKeyY: "4",
        viewTag: 5,
        merchantOrigin: "https://merchant.example",
        expiry: 6,
      }).checkoutCompletePath,
    ).toBe("/checkout/complete");
  });

  it("rejects removed and unknown intent fields", () => {
    expect(() =>
      parsePaymentIntent({
        token: TOKEN,
        amount: "1",
        chainId: 1,
        ownerHash: "2",
        ephemeralKeyX: "3",
        ephemeralKeyY: "4",
        viewTag: 5,
        merchantOrigin: "https://merchant.example",
        expiry: 6,
        paymentId: zeroHash,
      }),
    ).toThrow("must not contain paymentId");
  });

  it("scans every PendingNotes slot and pins the emitting aggregator", () => {
    const receipt = { logs: [pendingLog(OTHER), pendingLog(AGGREGATOR)] };
    expect(findNoteInReceipt(receipt, [22n, 44n], AGGREGATOR)).toEqual({
      noteId: 202n,
      netAmount: 1_800n,
      token: 8n,
    });
  });

  it("returns true when the payment is confirmed with enough block confirmations", async () => {
    const txHash = `0x${"ab".repeat(32)}` as Hex;
    await expect(
      verifyPayment({
        publicClient: receiptClient({
          getTransactionReceipt: vi.fn().mockResolvedValue({
            status: "success",
            blockNumber: 12n,
            logs: [pendingLog(OTHER), pendingLog(AGGREGATOR)],
          }),
        }),
        aggregatorAddress: AGGREGATOR,
        ephemeralKey: [22n, 44n],
        confirmations: CONFIRMATIONS,
        txHash,
      }),
    ).resolves.toBe(true);
  });

  it("returns true when the note is batch-committed", async () => {
    const txHash = `0x${"ac".repeat(32)}` as Hex;
    await expect(
      verifyPayment({
        publicClient: receiptClient({
          getTransactionReceipt: vi.fn().mockResolvedValue({
            status: "success",
            blockNumber: 12n,
            logs: [pendingLog(AGGREGATOR)],
          }),
          getLogs: vi.fn().mockResolvedValue([committedLog(AGGREGATOR, [202n])]),
        }),
        aggregatorAddress: AGGREGATOR,
        ephemeralKey: [22n, 44n],
        confirmations: CONFIRMATIONS,
        txHash,
      }),
    ).resolves.toBe(true);
  });

  it("returns false when the receipt contains PendingNotes for another ephemeral key", async () => {
    await expect(
      verifyPayment({
        publicClient: receiptClient({
          getTransactionReceipt: vi.fn().mockResolvedValue({
            status: "success",
            blockNumber: 12n,
            logs: [pendingLog(AGGREGATOR)],
          }),
        }),
        aggregatorAddress: AGGREGATOR,
        ephemeralKey: [99n, 99n],
        confirmations: CONFIRMATIONS,
        txHash: `0x${"cd".repeat(32)}`,
      }),
    ).resolves.toBe(false);
  });

  it("returns false when confirmations are insufficient", async () => {
    await expect(
      verifyPayment({
        publicClient: receiptClient({
          getTransactionReceipt: vi.fn().mockResolvedValue({
            status: "success",
            blockNumber: 12n,
            logs: [pendingLog(AGGREGATOR)],
          }),
          getBlockNumber: vi.fn().mockResolvedValue(20n),
        }),
        aggregatorAddress: AGGREGATOR,
        ephemeralKey: [22n, 44n],
        confirmations: CONFIRMATIONS,
        txHash: `0x${"03".repeat(32)}`,
      }),
    ).resolves.toBe(false);
  });

  it("throws when the shield transaction reverted", async () => {
    await expect(
      verifyPayment({
        publicClient: receiptClient({
          getTransactionReceipt: vi.fn().mockResolvedValue({
            status: "reverted",
            blockNumber: 12n,
            logs: [],
          }),
        }),
        aggregatorAddress: AGGREGATOR,
        ephemeralKey: [22n, 44n],
        confirmations: CONFIRMATIONS,
        txHash: `0x${"ee".repeat(32)}`,
      }),
    ).rejects.toThrow("shield transaction reverted");
  });

  it("throws when the receipt is not a Curvy shield payment", async () => {
    await expect(
      verifyPayment({
        publicClient: receiptClient({
          getTransactionReceipt: vi.fn().mockResolvedValue({
            status: "success",
            blockNumber: 12n,
            logs: [],
          }),
        }),
        aggregatorAddress: AGGREGATOR,
        ephemeralKey: [22n, 44n],
        confirmations: CONFIRMATIONS,
        txHash: `0x${"ef".repeat(32)}`,
      }),
    ).rejects.toThrow("transaction is not a valid Curvy shield payment");
  });

  it("throws when the transaction hash is unknown", async () => {
    await expect(
      verifyPayment({
        publicClient: receiptClient({
          getTransactionReceipt: vi.fn().mockRejectedValue(new TransactionReceiptNotFoundError({ hash: `0x${"f0".repeat(32)}` as Hex })),
          getTransaction: vi.fn().mockRejectedValue(new TransactionNotFoundError({ hash: `0x${"f0".repeat(32)}` as Hex })),
        }),
        aggregatorAddress: AGGREGATOR,
        ephemeralKey: [22n, 44n],
        confirmations: CONFIRMATIONS,
        txHash: `0x${"f0".repeat(32)}`,
      }),
    ).rejects.toThrow("transaction is not a valid Curvy shield payment");
  });

  it("throws when txHash is malformed", async () => {
    await expect(
      verifyPayment({
        publicClient: receiptClient({}),
        aggregatorAddress: AGGREGATOR,
        ephemeralKey: [22n, 44n],
        confirmations: CONFIRMATIONS,
        txHash: "0x1234" as Hex,
      }),
    ).rejects.toThrow("txHash must be a 32-byte hex string");
  });

  it("returns true without txHash when the note is batch-committed", async () => {
    await expect(
      verifyPayment({
        publicClient: receiptClient({
          getLogs: vi
            .fn()
            .mockResolvedValueOnce([pendingLog(AGGREGATOR)])
            .mockResolvedValueOnce([committedLog(AGGREGATOR, [202n])]),
        }),
        aggregatorAddress: AGGREGATOR,
        ephemeralKey: [22n, 44n],
        confirmations: CONFIRMATIONS,
      }),
    ).resolves.toBe(true);
  });

  it("rejects expired intents and signers", async () => {
    const signer = privateKeyToAccount(`0x${"22".repeat(32)}`);
    const intent = {
      token: TOKEN,
      amount: "1",
      chainId: 1,
      ownerHash: "2",
      ephemeralKeyX: "3",
      ephemeralKeyY: "4",
      viewTag: 5,
      merchantOrigin: "https://merchant.example",
      checkoutCompletePath: "/checkout/complete",
      expiry: 10,
    };
    const signature = (await signer.signTypedData(buildPaymentIntentTypedData(intent))) as Hex;
    const keySet = buildMerchantKeySet([{ address: signer.address, notAfter: new Date(20_000) }]);
    await expect(
      verifyPaymentIntent({ intent, signature }, { keySet, expectedChainId: 1, expectedToken: TOKEN, nowSeconds: 10 }),
    ).rejects.toThrow("expired");
  });
});
