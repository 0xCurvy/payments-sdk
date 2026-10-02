import { getAddress, type Hex } from "viem";
import type { SignedPaymentIntent } from "../index";
import {
  PAYMENT_RECORD_VERSION,
  type PaymentRecord,
  type PaymentVerification,
  parsePaymentRecord,
  serializePaymentRecord,
  type VerifiedPayment,
} from "../merchant";

const PAYMENT: SignedPaymentIntent = {
  intent: {
    token: getAddress("0x0000000000000000000000000000000000000003"),
    amount: "25000000",
    chainId: 31_337,
    ownerHash: "123456789",
    ephemeralKeyX: "11",
    ephemeralKeyY: "22",
    viewTag: 258,
    merchantOrigin: "https://merchant.example",
    checkoutCompletePath: "/checkout/complete",
    expiry: 1_900_000_000,
  },
  signature: `0x${"ab".repeat(65)}` as Hex,
};

/** Above Number.MAX_SAFE_INTEGER, so a lossy bigint round trip would show. */
const BIG = (1n << 200n) + 7n;

const VERIFIED: VerifiedPayment = {
  txHash: `0x${"12".repeat(32)}`,
  blockNumber: 9_007_199_254_740_993n,
  confirmations: 12n,
  noteId: BIG,
  vaultTokenId: 2n,
  token: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  netAmount: 24_975_000n,
  minimumNetAmount: 24_975_000n,
  shortfall: 0n,
  portalShield: true,
  committed: false,
  siblingNoteIds: [BIG + 1n, 3n],
};

const PAID: PaymentVerification = { status: "paid", payment: VERIFIED };

function stored(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ...JSON.parse(serializePaymentRecord({ payment: PAYMENT, fromBlock: 5n, verification: PAID })),
    ...overrides,
  });
}

describe("payment records", () => {
  it("round-trips the signed package, fromBlock and the latest verification, bigints included", () => {
    const records: PaymentRecord[] = [
      { payment: PAYMENT, fromBlock: 0n, verification: null },
      { payment: PAYMENT, fromBlock: 17n, verification: { status: "not_found", payment: null } },
      { payment: PAYMENT, fromBlock: BIG, verification: PAID },
      {
        payment: PAYMENT,
        fromBlock: 1n,
        verification: { status: "underpaid", payment: { ...VERIFIED, siblingNoteIds: [] } },
      },
      // A paidWhen: "committed" verification: confirming while uncommitted, paid once committed.
      { payment: PAYMENT, fromBlock: 2n, verification: { status: "confirming", payment: VERIFIED } },
      {
        payment: PAYMENT,
        fromBlock: 2n,
        verification: { status: "paid", payment: { ...VERIFIED, committed: true } },
      },
    ];
    for (const paymentRecord of records) {
      const value = serializePaymentRecord(paymentRecord);
      expect(typeof value).toBe("string");
      expect(parsePaymentRecord(value)).toEqual(paymentRecord);
    }
  });

  it("writes one JSON value with an explicit version and decimal-string bigints", () => {
    const value = JSON.parse(serializePaymentRecord({ payment: PAYMENT, fromBlock: BIG, verification: PAID }));
    expect(PAYMENT_RECORD_VERSION).toBe(1);
    expect(value.version).toBe(1);
    expect(Object.keys(value).sort()).toEqual(["fromBlock", "payment", "verification", "version"]);
    expect(value.payment).toEqual(PAYMENT);
    expect(value.fromBlock).toBe(BIG.toString());
    expect(value.verification.payment.noteId).toBe(BIG.toString());
    expect(value.verification.payment.blockNumber).toBe("9007199254740993");
    expect(value.verification.payment.siblingNoteIds).toEqual([(BIG + 1n).toString(), "3"]);
  });

  it("refuses unknown and missing versions", () => {
    for (const version of [0, 2, "1", null, undefined]) {
      expect(() => parsePaymentRecord(stored({ version }))).toThrow("unsupported payment record version");
    }
  });

  it("parses strictly", () => {
    const valid = JSON.parse(stored());
    const rejected: [unknown, string][] = [
      [{ ...valid, extra: 1 }, "payment record must contain exactly"],
      [{ ...valid, fromBlock: 5 }, "payment record.fromBlock"],
      [{ ...valid, fromBlock: "-1" }, "payment record.fromBlock"],
      [{ ...valid, fromBlock: "05" }, "payment record.fromBlock"],
      [{ ...valid, payment: { ...valid.payment, signature: "0x12" } }, "payment package.signature"],
      [{ ...valid, payment: { ...valid.payment, intent: { ...PAYMENT.intent, viewTag: "0x0102" } } }, "intent.viewTag"],
      [{ ...valid, payment: { ...valid.payment, intent: { ...PAYMENT.intent, extra: 1 } } }, "intent must not contain"],
      [{ ...valid, verification: { status: "settled", payment: null } }, "verification.status"],
      [{ ...valid, verification: { status: "not_found", payment: valid.verification.payment } }, "must be null"],
      [{ ...valid, verification: { status: "paid", payment: null } }, "verification.payment must be an object"],
      [{ ...valid, verification: { ...valid.verification, extra: 1 } }, "verification must contain exactly"],
      [
        { ...valid, verification: { ...valid.verification, payment: { ...valid.verification.payment, noteId: 5 } } },
        "verification.payment.noteId",
      ],
      [
        {
          ...valid,
          verification: { ...valid.verification, payment: { ...valid.verification.payment, committed: "false" } },
        },
        "verification.payment.committed",
      ],
      [
        {
          ...valid,
          verification: { ...valid.verification, payment: { ...valid.verification.payment, txHash: "0x12" } },
        },
        "verification.payment.txHash",
      ],
      [
        {
          ...valid,
          verification: { ...valid.verification, payment: { ...valid.verification.payment, siblingNoteIds: ["x"] } },
        },
        "verification.payment.siblingNoteIds[0]",
      ],
    ];
    for (const [value, message] of rejected) {
      expect(() => parsePaymentRecord(JSON.stringify(value))).toThrow(message);
    }
    expect(() => parsePaymentRecord("{")).toThrow("payment record must be JSON");
    expect(() => parsePaymentRecord(JSON.parse(stored()))).toThrow("payment record must be a string");
    expect(() => parsePaymentRecord("[]")).toThrow("payment record must be an object");
  });

  it("reads records saved before shortfall and token were added", () => {
    const valid = JSON.parse(stored());
    const { shortfall: _shortfall, token: _token, ...older } = valid.verification.payment;
    const record = parsePaymentRecord(
      JSON.stringify({ ...valid, verification: { ...valid.verification, payment: older } }),
    );
    expect(record.verification?.payment).toMatchObject({ shortfall: 0n, token: null });
  });

  it("refuses to serialize a record it could not parse back", () => {
    expect(() => serializePaymentRecord({ payment: PAYMENT, fromBlock: -1n, verification: null })).toThrow(
      "payment record.fromBlock",
    );
    expect(() =>
      serializePaymentRecord({
        payment: { ...PAYMENT, intent: { ...PAYMENT.intent, viewTag: 65_536 } },
        fromBlock: 1n,
        verification: null,
      }),
    ).toThrow("intent.viewTag");
  });
});
