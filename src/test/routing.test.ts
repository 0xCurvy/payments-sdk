import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { ROUTED_PAYMENT_CHAIN_ID, ROUTED_PAYMENT_TOLERANCE_BPS } from "../chain";
import {
  acceptedTokens,
  buildPaymentIntentTypedData,
  parsePaymentIntent,
  signPaymentIntent,
  verifyPaymentIntent,
} from "../intent";
import { createPaymentRequest, verifyPayment } from "../merchant";
import { buildMerchantKeySet } from "../merchant/keys";
import type { PaymentIntent } from "../types";
import {
  AGGREGATOR,
  CHAIN_ID,
  computeNoteId,
  DEPOSIT_FEE_BPS,
  mockClient,
  OTHER_TOKEN,
  OTHER_TOKEN_ID,
  PENDING_NOTE_COMMITMENT_FEE,
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

const AMOUNT = 10_000_000n;
const UNREGISTERED = "0x0000000000000000000000000000000000000023";
const SHIELD_TX = txHashOf("cd");
const SHIELD_BLOCK = 90n;
const signer = privateKeyToAccount(`0x${"11".repeat(32)}`);
const keySet = buildMerchantKeySet([{ address: signer.address, notAfter: "2030-01-01T00:00:00.000Z" }]);
const sign = (typedData: Parameters<typeof signer.signTypedData>[0]) => signer.signTypedData(typedData);

const request = (overrides: { chainId?: number; tokens?: `0x${string}`[]; description?: string } = {}) =>
  createPaymentRequest({
    recipient: RECIPIENT,
    amount: AMOUNT,
    token: TOKEN,
    tokens: [TOKEN, OTHER_TOKEN],
    chainId: CHAIN_ID,
    merchantOrigin: "https://merchant.example",
    ...overrides,
  });

/** Net amount the vault credits for a portal shield of `gross`. */
const netOf = (gross: bigint) =>
  gross - (gross * DEPOSIT_FEE_BPS) / 10_000n - PENDING_NOTE_COMMITMENT_FEE - PORTAL_DEPLOYMENT_FEE;

async function shieldOf(intent: PaymentIntent, gross: bigint, tokenId = TOKEN_ID) {
  const location = { blockNumber: SHIELD_BLOCK, transactionHash: SHIELD_TX };
  const slot = {
    noteId: await computeNoteId(intent.ownerHash, netOf(gross), tokenId),
    ephemeralKey: [BigInt(intent.ephemeralKeyX), BigInt(intent.ephemeralKeyY)] as const,
    viewTag: intent.viewTag,
    token: tokenId,
    amount: netOf(gross),
  };
  return receiptOf(SHIELD_TX, SHIELD_BLOCK, [
    pendingNotesLog(AGGREGATOR, [slot], { ...location, logIndex: 0 }),
    shieldPortalDeployedLog(PORTAL_FACTORY, intent.ownerHash, { ...location, logIndex: 1 }),
  ]);
}

const verify = async (intent: PaymentIntent, gross: bigint, tokenId = TOKEN_ID) =>
  verifyPayment({
    publicClient: mockClient({ chainId: intent.chainId, receipts: [await shieldOf(intent, gross, tokenId)] }).client,
    aggregatorAddress: AGGREGATOR,
    request: intent,
    confirmations: 1,
    txHash: SHIELD_TX,
  });

describe("a request the shop takes in more than one token", () => {
  it("is signed as its own type, with every token and an always-present description", async () => {
    const single = await request({ tokens: [TOKEN] });
    const multi = await request();
    const described = await request({ description: "Order #1048" });

    expect(single.tokens).toBeUndefined();
    expect(buildPaymentIntentTypedData(single).primaryType).toBe("PaymentIntent");
    expect(acceptedTokens(single)).toEqual([TOKEN]);
    expect(buildPaymentIntentTypedData(multi)).toMatchObject({
      primaryType: "MultiTokenPaymentIntent",
      message: { token: TOKEN, tokens: [TOKEN, OTHER_TOKEN], description: "" },
    });
    expect(acceptedTokens(multi)).toEqual([TOKEN, OTHER_TOKEN]);
    expect(buildPaymentIntentTypedData(described).message).toMatchObject({ description: "Order #1048" });
  });

  it("can neither have a token added nor the list stripped on the way", async () => {
    const payment = await signPaymentIntent(await request(), sign);
    const check = (intent: PaymentIntent) =>
      verifyPaymentIntent({ ...payment, intent }, { keySet, expectedChainId: CHAIN_ID, expectedToken: TOKEN });

    await expect(check(payment.intent)).resolves.toMatchObject({ signer: signer.address });
    const { tokens: _stripped, ...withoutList } = payment.intent;
    await expect(check(withoutList)).rejects.toThrow("unknown payment intent signer");
    await expect(check({ ...payment.intent, tokens: [TOKEN, OTHER_TOKEN, UNREGISTERED] })).rejects.toThrow(
      "unknown payment intent signer",
    );
  });

  it("lists `token` first, each token once, and more than one", () => {
    const base = {
      token: TOKEN,
      amount: "10000000",
      chainId: CHAIN_ID,
      ownerHash: "2",
      ephemeralKeyX: "3",
      ephemeralKeyY: "4",
      viewTag: 5,
      merchantOrigin: "https://merchant.example",
      expiry: 6,
    };
    expect(parsePaymentIntent({ ...base, tokens: [TOKEN, OTHER_TOKEN.toLowerCase()] }).tokens).toEqual([
      TOKEN,
      OTHER_TOKEN,
    ]);
    expect(() => parsePaymentIntent({ ...base, tokens: [OTHER_TOKEN, TOKEN] })).toThrow("start with intent.token");
    expect(() => parsePaymentIntent({ ...base, tokens: [TOKEN, TOKEN] })).toThrow("must not list a token twice");
    expect(() => parsePaymentIntent({ ...base, tokens: [TOKEN] })).toThrow("intent.tokens must list 2 to 8");
    expect(() => parsePaymentIntent({ ...base, tokens: [TOKEN, "0x12"] })).toThrow("intent.tokens[1]");
  });

  it("is paid in any of its tokens, and says which", async () => {
    const intent = await request();

    expect(await verify(intent, AMOUNT, OTHER_TOKEN_ID)).toMatchObject({
      status: "paid",
      payment: { token: OTHER_TOKEN, vaultTokenId: OTHER_TOKEN_ID, shortfall: 0n },
    });
    expect(await verify(intent, AMOUNT)).toMatchObject({ status: "paid", payment: { token: TOKEN } });
    expect(await verify(await request({ tokens: [TOKEN] }), AMOUNT, OTHER_TOKEN_ID)).toMatchObject({
      status: "wrong_token",
      payment: { token: null },
    });
  });
});

describe("a payment bridged to the routed network", () => {
  const allowance = (AMOUNT * BigInt(ROUTED_PAYMENT_TOLERANCE_BPS)) / 10_000n;

  it("counts as paid up to the tolerance short, and reports what the shop absorbed", async () => {
    const intent = await request({ chainId: ROUTED_PAYMENT_CHAIN_ID });
    const bridgeCost = 180_000n;
    const verification = await verify(intent, AMOUNT - bridgeCost);

    expect(verification.status).toBe("paid");
    expect(verification.payment?.minimumNetAmount).toBe(netOf(AMOUNT - allowance));
    // The vault's percentage fee is on the smaller deposit, so the shortfall is the bridge cost less 0.1% of it.
    expect(verification.payment?.shortfall).toBe(netOf(AMOUNT) - netOf(AMOUNT - bridgeCost));
    expect((await verify(intent, AMOUNT - allowance - 1_000n)).status).toBe("underpaid");
  });

  it("wants the full amount when the caller says the payment can't have been bridged", async () => {
    const intent = await request({ chainId: ROUTED_PAYMENT_CHAIN_ID });
    const verification = await verifyPayment({
      publicClient: mockClient({ chainId: intent.chainId, receipts: [await shieldOf(intent, AMOUNT - 180_000n)] })
        .client,
      aggregatorAddress: AGGREGATOR,
      request: intent,
      confirmations: 1,
      txHash: SHIELD_TX,
      allowBridgeShortfall: false,
    });

    expect(verification).toMatchObject({ status: "underpaid", payment: { minimumNetAmount: netOf(AMOUNT) } });
  });

  it("still wants the full amount on any other network, where nothing is bridged", async () => {
    const intent = await request();

    expect((await verify(intent, AMOUNT - 1_000n)).status).toBe("underpaid");
    expect(await verify(intent, AMOUNT)).toMatchObject({ status: "paid", payment: { shortfall: 0n } });
  });
});
