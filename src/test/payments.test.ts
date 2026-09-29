import { encodeAbiParameters, encodeEventTopics, getAddress, type Hex, type TransactionReceipt, zeroHash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildCheckoutCompleteUrl,
  buildCheckoutRetryUrl,
  buildCheckoutUrl,
  buildMerchantKeySet,
  buildPaymentIntentTypedData,
  DEFAULT_PAYMENT_REQUEST_TTL_SECONDS,
  decodePaymentIntentFragment,
  findNoteInReceipt,
  MAX_PAYMENT_REQUEST_TTL_SECONDS,
  parsePaymentIntent,
  pendingNotesAbi,
  signPaymentIntent,
  verifyPaymentIntent,
} from "../index";
import { buildPaymentRequest, createPaymentRequest, initialize } from "../merchant";
import { viewTag } from "../utils/validation";

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

  it("caps ttlSeconds at 24 hours in createPaymentRequest, buildPaymentRequest and initialize", async () => {
    expect(MAX_PAYMENT_REQUEST_TTL_SECONDS).toBe(86_400);
    const base = {
      recipient: RECIPIENT,
      amount: 10_000n,
      token: TOKEN,
      chainId: 31_337,
      merchantOrigin: "https://merchant.example",
    };
    for (const ttlSeconds of [MAX_PAYMENT_REQUEST_TTL_SECONDS + 1, 7 * 86_400]) {
      await expect(createPaymentRequest({ ...base, ttlSeconds })).rejects.toThrow("ttlSeconds must be at most 86400");
      await expect(buildPaymentRequest({ ...base, ttlSeconds })).rejects.toThrow("ttlSeconds must be at most 86400");
      expect(() =>
        initialize({
          recipient: RECIPIENT,
          chainId: 31_337,
          merchantOrigin: "https://merchant.example",
          confirmations: CONFIRMATIONS,
          ttlSeconds,
        }),
      ).toThrow("ttlSeconds must be at most 86400");
    }
    for (const ttlSeconds of [0, -1, 1.5]) {
      await expect(createPaymentRequest({ ...base, ttlSeconds })).rejects.toThrow("ttlSeconds must be a positive");
    }

    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));
    const atCap = await createPaymentRequest({ ...base, ttlSeconds: MAX_PAYMENT_REQUEST_TTL_SECONDS });
    const sdk = initialize({
      recipient: RECIPIENT,
      chainId: 31_337,
      merchantOrigin: "https://merchant.example",
      confirmations: CONFIRMATIONS,
      ttlSeconds: MAX_PAYMENT_REQUEST_TTL_SECONDS,
    });
    const fromSdk = await sdk.createPaymentRequest({ amount: 10_000n, token: TOKEN });
    vi.useRealTimers();
    expect(atCap.expiry).toBe(1_000 + 86_400);
    expect(fromSdk.expiry).toBe(1_000 + 86_400);
  });

  it("parses viewTag to one canonical uint16", () => {
    // Numbers: the intent's wire form.
    expect(viewTag(0, "tag")).toBe(0);
    expect(viewTag(65_535, "tag")).toBe(65_535);
    for (const rejected of [65_536, -1, 1.5, "5", "0x05", null]) {
      expect(() => viewTag(rejected, "tag")).toThrow("tag");
    }
    // Strings only with { hex: true }, always read as hex (rs-core `send` returns a bare byte).
    expect(viewTag("0a", "tag", { hex: true })).toBe(10);
    expect(viewTag("0x0a", "tag", { hex: true })).toBe(10);
    expect(viewTag("0X0A", "tag", { hex: true })).toBe(10);
    expect(viewTag("10", "tag", { hex: true })).toBe(16);
    expect(viewTag("ffff", "tag", { hex: true })).toBe(65_535);
    expect(viewTag(10, "tag", { hex: true })).toBe(10);
    for (const rejected of ["", "0x", "1ffff", "0x10000", "-1", "0xg1", " 0a"]) {
      expect(() => viewTag(rejected, "tag", { hex: true })).toThrow("tag");
    }
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

  it("returns buyers to the merchant's completion page with a receipt hint or a retry request", () => {
    const intent = {
      token: TOKEN,
      amount: "1",
      chainId: 1,
      ownerHash: "2",
      ephemeralKeyX: "3",
      ephemeralKeyY: "4",
      viewTag: 5,
      merchantOrigin: "https://merchant.example",
      checkoutCompletePath: "/orders/done",
      expiry: 6,
    };
    const txHash = `0x${"ab".repeat(32)}` as Hex;

    expect(buildCheckoutCompleteUrl(intent, txHash)).toBe(`https://merchant.example/orders/done#txHash=${txHash}`);
    expect(buildCheckoutRetryUrl(intent)).toBe("https://merchant.example/orders/done#retry=3");
    expect(() => buildCheckoutRetryUrl({ ...intent, checkoutCompletePath: "//evil.example/done" })).toThrow();
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

  it("range-checks numeric intent fields", async () => {
    const valid = {
      token: TOKEN,
      amount: "1",
      chainId: 1,
      ownerHash: "2",
      ephemeralKeyX: "3",
      ephemeralKeyY: "4",
      viewTag: 5,
      merchantOrigin: "https://merchant.example",
      expiry: 6,
    };
    const scalarField = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
    const baseField = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
    const rejected: [string, Record<string, unknown>][] = [
      ["intent.amount", { amount: "0" }],
      ["intent.amount", { amount: (1n << 256n).toString() }],
      ["intent.amount", { amount: "010" }],
      ["intent.ownerHash", { ownerHash: "0" }],
      ["intent.ownerHash", { ownerHash: scalarField.toString() }],
      ["intent.ephemeralKeyX", { ephemeralKeyX: baseField.toString() }],
      ["intent.ephemeralKeyY", { ephemeralKeyY: baseField.toString() }],
      ["intent.viewTag", { viewTag: 65_536 }],
      ["intent.viewTag", { viewTag: -1 }],
      // The intent carries viewTag as a JSON number; the hex form rs-core returns is not accepted here.
      ["intent.viewTag", { viewTag: "5" }],
      ["intent.viewTag", { viewTag: "0x05" }],
      ["intent.chainId", { chainId: 0 }],
      ["intent.expiry", { expiry: 0 }],
      ["intent.expiry", { expiry: 1.5 }],
    ];
    for (const [label, override] of rejected) {
      expect(() => parsePaymentIntent({ ...valid, ...override })).toThrow(label);
    }
    // Upper bounds are exclusive; R coordinates may exceed the scalar field (they live in the base field).
    expect(() =>
      parsePaymentIntent({
        ...valid,
        amount: ((1n << 256n) - 1n).toString(),
        ownerHash: (scalarField - 1n).toString(),
        ephemeralKeyX: scalarField.toString(),
        ephemeralKeyY: (baseField - 1n).toString(),
        viewTag: 65_535,
      }),
    ).not.toThrow();
    // Real requests always parse.
    const intent = await createPaymentRequest({
      recipient: RECIPIENT,
      amount: 1n,
      token: TOKEN,
      chainId: 31_337,
      merchantOrigin: "https://merchant.example",
    });
    expect(parsePaymentIntent(intent)).toEqual(intent);
  });

  it("scans every PendingNotes slot and pins the emitting aggregator", () => {
    const receipt = { logs: [pendingLog(OTHER), pendingLog(AGGREGATOR)] };
    expect(findNoteInReceipt(receipt, [22n, 44n], AGGREGATOR)).toEqual({
      noteId: 202n,
      netAmount: 1_800n,
      token: 8n,
    });
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

  it("refuses to sign or verify an intent that lives longer than 24 hours", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));
    const signer = privateKeyToAccount(`0x${"33".repeat(32)}`);
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
      expiry: 1_000 + MAX_PAYMENT_REQUEST_TTL_SECONDS,
    };
    const sign = (value: typeof intent) => signPaymentIntent(value, (typedData) => signer.signTypedData(typedData));
    await expect(sign(intent)).resolves.toMatchObject({ intent });
    await expect(sign({ ...intent, expiry: intent.expiry + 1 })).rejects.toThrow(
      "payment intent expiry must be at most 86400 seconds (24 hours) away",
    );
    await expect(sign({ ...intent, expiry: 1_000 + 365 * 86_400 })).rejects.toThrow("at most 86400 seconds");
    vi.useRealTimers();

    // A hand-signed intent (or one from an older SDK) is refused by the verifier, with 5 min of clock skew.
    const keySet = buildMerchantKeySet([{ address: signer.address, notAfter: "2030-01-01T00:00:00.000Z" }]);
    const verify = async (expiry: number) => {
      const unchecked = { ...intent, expiry };
      const signature = (await signer.signTypedData(buildPaymentIntentTypedData(unchecked))) as Hex;
      return verifyPaymentIntent(
        { intent: unchecked, signature },
        { keySet, expectedChainId: 1, expectedToken: TOKEN, nowSeconds: 1_000 },
      );
    };
    const withSkew = 1_000 + MAX_PAYMENT_REQUEST_TTL_SECONDS + 300;
    await expect(verify(withSkew)).resolves.toMatchObject({ signer: signer.address });
    await expect(verify(withSkew + 1)).rejects.toThrow("payment intent lifetime exceeds 24 hours");
    await expect(verify(1_000 + 365 * 86_400)).rejects.toThrow("lifetime exceeds 24 hours");
  });
});
