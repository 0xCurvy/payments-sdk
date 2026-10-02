/**
 * The exact-scheme integration surface: `createX402Merchant` (server) and `createX402Payer` (agent),
 * wired to each other through a mocked facilitator and a mocked public client. No HTTP framework.
 */
import {
  type Address,
  encodeAbiParameters,
  encodeEventTopics,
  erc20Abi,
  getAddress,
  type Hex,
  keccak256,
  recoverTypedDataAddress,
  type TransactionReceipt,
  toHex,
  zeroHash,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { encodeReceivingKeys } from "../merchant/keys";
import {
  CURVY_BROADCASTER_URL,
  CURVY_FACILITATOR_URL,
  createBroadcasterClient,
  createExactPayment,
  createFacilitatorClient,
  createTransferPayment,
  createX402Payer,
  decodePaymentRequired,
  decodePaymentResponse,
  eip3009Domain,
  encodeBase64Json,
  encodePaymentSignature,
  type FacilitatorClient,
  NO_RECOVERY_ADDRESS,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  parseExactPayload,
  selectExactRequirements,
  selectTransferRequirements,
  transferWithAuthorizationTypes,
  type X402PaymentRequired,
  type X402PaymentRequirements,
  type X402SupportedResponse,
} from "../x402";
import {
  createMemoryPaymentStore,
  createX402Merchant,
  toResponse,
  type X402Merchant,
  type X402PaymentEvent,
} from "../x402/merchant";
import { computeNoteId, pendingNotesLog, shieldPortalDeployedLog } from "./verifyPaymentFixtures";

const TOKEN = getAddress("0x0000000000000000000000000000000000000003");
const USDT = getAddress("0x0000000000000000000000000000000000000023");
const AGGREGATOR = getAddress("0x0000000000000000000000000000000000000004");
const VAULT = getAddress("0x0000000000000000000000000000000000000005");
const PORTAL_FACTORY = getAddress("0x0000000000000000000000000000000000000006");
const SUBMITTER = getAddress("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
const CHAIN_ID = 31_337;
const NETWORK = "eip155:31337";
const PRICE = 10_000n;
const RECIPIENT = {
  S: "18841156662615403723520443807716409278140486251221355574263061434503921265588.98357793752770194678499426326386336085357653965912017495890904868125096440617",
  V: "1760020198064161165795911805578555709740706783603233189380229091027759021973.19520756004562638043874842910851983303596751292314679321770725659462577589821",
  babyJubjubPublicKey:
    "5509359784107808046541889973707062912186356978136525798140528612444721440004.5125768395023217094469327424244994953312297627197683956739233494456001838760",
};
const PAYER = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const SHIELD_TX = `0x${"ab".repeat(32)}` as Hex;

/** Deterministic stand-in for `PortalFactory.getEntryPortalAddress(ownerHash, recovery)`. */
function portalFor(ownerHash: bigint, recovery: string) {
  return getAddress(`0x${keccak256(toHex(`${ownerHash}:${recovery.toLowerCase()}`)).slice(-40)}`);
}

/**
 * A shield receipt's logs as the chain emits them for this note: the aggregator's PendingNotes slot, whose note
 * id commits to the owner, token and net amount (so the hardened check can match it), and the portal factory's
 * ShieldPortalDeployed, which makes the portal fee part of the expected net amount (10 000 - 10 - 100 - 50).
 */
async function shieldLogs(
  note: { ownerHash: string; ephemeralKey: readonly [string, string]; viewTag: number },
  transactionHash: Hex = SHIELD_TX,
  netAmount = 9_840n,
  tokenId = 3n,
): Promise<TransactionReceipt["logs"]> {
  const location = { blockNumber: 12n, transactionHash };
  const ephemeralKey = [BigInt(note.ephemeralKey[0]), BigInt(note.ephemeralKey[1])] as const;
  const noteId = await computeNoteId(note.ownerHash, netAmount, tokenId);

  return [
    pendingNotesLog(
      AGGREGATOR,
      [{ noteId, ephemeralKey, viewTag: note.viewTag, token: tokenId, amount: netAmount }],
      location,
    ),
    shieldPortalDeployedLog(PORTAL_FACTORY, note.ownerHash, { ...location, logIndex: 1 }),
  ] as TransactionReceipt["logs"];
}

function supportedResponse(
  extra: Record<string, unknown> | null = {
    curvy: { aggregator: AGGREGATOR, portalFactory: PORTAL_FACTORY, vault: VAULT },
  },
): X402SupportedResponse {
  return {
    kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK, ...(extra ? { extra } : {}) }],
    extensions: [],
    signers: { "eip155:*": [SUBMITTER] },
  };
}

interface Harness {
  facilitator: FacilitatorClient & {
    verify: ReturnType<typeof vi.fn>;
    settle: ReturnType<typeof vi.fn>;
  };
  broadcaster: {
    url: string;
    network: ReturnType<typeof vi.fn>;
    registerPayment: ReturnType<typeof vi.fn>;
    status: ReturnType<typeof vi.fn>;
  };
  /** Portal states the broadcaster mock reports, by lowercase address. */
  portals: Map<string, { state: string; txHash?: Hex; error?: string; portalAddress?: Address }>;
  publicClient: {
    getChainId: ReturnType<typeof vi.fn>;
    readContract: ReturnType<typeof vi.fn>;
    getTransactionReceipt: ReturnType<typeof vi.fn>;
    getTransaction: ReturnType<typeof vi.fn>;
    getBlockNumber: ReturnType<typeof vi.fn>;
    getLogs: ReturnType<typeof vi.fn>;
  };
  events: X402PaymentEvent[];
  /** Receipt served for the shield transaction; set per test. */
  receipt: { logs: TransactionReceipt["logs"] };
}

function harness(supported = supportedResponse()): Harness {
  const receipt: Harness["receipt"] = { logs: [] };
  const facilitator = {
    url: "http://facilitator.test",
    supported: vi.fn(async () => supported),
    verify: vi.fn(async () => ({ isValid: true, payer: PAYER.address })),
    settle: vi.fn(async () => ({
      success: true,
      transaction: `0x${"cd".repeat(32)}`,
      network: NETWORK,
      payer: PAYER.address,
    })),
  };
  const portals = new Map<string, { state: string; txHash?: Hex; error?: string; portalAddress?: Address }>();
  const broadcaster = {
    url: "http://broadcaster.test",
    network: vi.fn(async (chainId: number) =>
      chainId === CHAIN_ID
        ? {
            chainId,
            aggregator: AGGREGATOR,
            portalFactory: PORTAL_FACTORY,
            vault: VAULT,
            currencies: [{ address: TOKEN, symbol: "USDC", decimals: 6, vaultTokenId: "3" }],
          }
        : undefined,
    ),
    registerPayment: vi.fn(async (registration: { ownerHash: string; recovery: string }) => ({
      state: "compliance_checking",
      // Like the real broadcaster: the portal address follows from the registration.
      portalAddress: portalFor(BigInt(registration.ownerHash), registration.recovery),
    })),
    status: vi.fn(async (address: Address) => {
      const portal = portals.get(address.toLowerCase());
      return portal ? { ...portal, portalAddress: portal.portalAddress ?? address } : undefined;
    }),
  };
  const publicClient = {
    getChainId: vi.fn(async () => CHAIN_ID),
    readContract: vi.fn(async (call: { functionName: string; args?: readonly unknown[] }) => {
      switch (call.functionName) {
        case "getTokenId":
          return call.args?.[0] === TOKEN ? 3n : call.args?.[0] === USDT ? 4n : 0n;
        case "name":
          return "Local USDC";
        case "symbol":
          return call.args === undefined && (call as { address?: string }).address === USDT ? "USDT" : "USDC";
        case "decimals":
          return 6;
        case "version":
          return "2";
        case "getEntryPortalAddress":
          return portalFor(call.args?.[0] as bigint, call.args?.[1] as string);
        case "balanceOf":
          // Portals are funded unless a test says otherwise.
          return PRICE;
        case "curvyVault":
          return VAULT;
        case "portalFactory":
          return PORTAL_FACTORY;
        case "depositFee":
          return 10n;
        case "perTokenGasFees":
          return { portalDeployment: 50n, pendingNoteCommitment: 100n, withdrawal: 50n };
        default:
          throw new Error(`unexpected readContract ${call.functionName}`);
      }
    }),
    getTransactionReceipt: vi.fn(async () => ({ status: "success", blockNumber: 12n, logs: receipt.logs })),
    getTransaction: vi.fn(),
    getBlockNumber: vi.fn(async () => 12n),
    getLogs: vi.fn(async () => []),
  };
  return { facilitator, broadcaster, portals, publicClient, events: [], receipt };
}

async function merchantFor(h: Harness, overrides: Record<string, unknown> = {}): Promise<X402Merchant> {
  return createX402Merchant({
    facilitator: h.facilitator,
    broadcaster: h.broadcaster,
    publicClient: h.publicClient as never,
    recipient: RECIPIENT,
    tokens: [TOKEN],
    confirmations: 1,
    autoShield: false,
    settleTimeoutMs: 50,
    confirmPollMs: 10,
    onEvent: (event) => h.events.push(event),
    ...overrides,
  });
}

const request = (headers: Record<string, string> = {}) => ({
  method: "GET",
  url: "http://api.test/on-this-day?date=07-20",
  headers,
});

describe("createX402Merchant", () => {
  it("discovers the deployment, signer and token domain and answers 402 with one exact option", async () => {
    const h = harness();
    const merchant = await merchantFor(h);
    expect(merchant.network).toBe(NETWORK);
    expect(merchant.tokens).toEqual([
      { address: TOKEN, symbol: "USDC", decimals: 6, vaultTokenId: 3n, domain: { name: "Local USDC", version: "2" } },
    ]);
    expect(merchant.addresses).toEqual({ aggregator: AGGREGATOR, portalFactory: PORTAL_FACTORY, vault: VAULT });
    expect(merchant.recovery).toBe(NO_RECOVERY_ADDRESS);
    expect(merchant.schemes).toEqual(["exact", "curvy-transfer"]);
    expect(h.broadcaster.network).toHaveBeenCalledWith(CHAIN_ID);

    const result = await merchant.charge(request(), { price: PRICE, description: "one lookup" });
    expect(result.status).toBe("payment-required");
    if (result.status !== "payment-required") throw new Error("unreachable");
    expect(result.response.status).toBe(402);
    expect(result.response.headers["content-type"]).toBe("application/json");
    const required = decodePaymentRequired(result.response.headers[PAYMENT_REQUIRED_HEADER] as string);
    expect(required).toEqual(result.response.body);
    expect(required.resource).toEqual({
      url: "http://api.test/on-this-day?date=07-20",
      description: "one lookup",
      mimeType: "application/json",
    });
    expect(required.accepts).toHaveLength(2);
    const [accepted] = required.accepts as [X402PaymentRequirements];
    expect(accepted).toMatchObject({
      scheme: "exact",
      network: NETWORK,
      asset: TOKEN,
      amount: PRICE.toString(),
      maxTimeoutSeconds: 300,
      extra: { name: "Local USDC", version: "2", assetTransferMethod: "eip3009" },
    });
    // payTo is the portal for this note with the no-recovery sentinel as recovery.
    expect(accepted.payTo).toBe(portalFor(BigInt(result.payment.note.ownerHash), NO_RECOVERY_ADDRESS));
    expect(result.payment.status).toBe("pending");
    expect(h.events.map((event) => event.type)).toEqual(["challenged"]);

    const response = toResponse(result.response);
    expect(response.status).toBe(402);
    expect(response.headers.get(PAYMENT_REQUIRED_HEADER)).toBe(result.response.headers[PAYMENT_REQUIRED_HEADER]);
  });

  it("verifies, settles, shields and confirms a payment signed by the payer helper", async () => {
    const h = harness();
    const merchant = await merchantFor(h);
    const challenge = await merchant.charge(request(), { price: PRICE });
    if (challenge.status !== "payment-required") throw new Error("expected a challenge");
    const required = decodePaymentRequired(challenge.response.headers[PAYMENT_REQUIRED_HEADER] as string);

    const payload = await createExactPayment(required, PAYER);
    const exact = parseExactPayload(payload.payload);
    expect(exact.authorization).toMatchObject({
      from: PAYER.address,
      to: challenge.payment.payTo,
      value: PRICE.toString(),
      validAfter: "0",
    });
    expect(BigInt(exact.authorization.validBefore)).toBeGreaterThan(BigInt(Math.floor(Date.now() / 1_000)));
    const signer = await recoverTypedDataAddress({
      domain: eip3009Domain({ chainId: CHAIN_ID, token: TOKEN, name: "Local USDC", version: "2" }),
      types: transferWithAuthorizationTypes,
      primaryType: "TransferWithAuthorization",
      message: {
        from: exact.authorization.from,
        to: exact.authorization.to,
        value: BigInt(exact.authorization.value),
        validAfter: BigInt(exact.authorization.validAfter),
        validBefore: BigInt(exact.authorization.validBefore),
        nonce: exact.authorization.nonce,
      },
      signature: exact.signature,
    });
    expect(signer).toBe(PAYER.address);

    const paid = await merchant.charge(request({ [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignature(payload) }), {
      price: PRICE,
    });
    expect(paid.status).toBe("paid");
    if (paid.status !== "paid") throw new Error("unreachable");
    expect(paid.payment.status).toBe("settled");
    expect(paid.payment.payer).toBe(PAYER.address);
    expect(paid.payment.settleTxHash).toBe(`0x${"cd".repeat(32)}`);
    expect(decodePaymentResponse(paid.headers[PAYMENT_RESPONSE_HEADER] as string)).toMatchObject({
      success: true,
      network: NETWORK,
    });
    // The facilitator is asked about the requirements the merchant issued, not whatever the payer echoed.
    expect(h.facilitator.verify).toHaveBeenCalledWith(payload, challenge.payment.accepts[0]);
    expect(h.facilitator.settle).toHaveBeenCalledWith(payload, challenge.payment.accepts[0]);

    // Shielding: the funded portal is registered with the broadcaster and followed until shielded.
    const registered = await merchant.shield(paid.payment.payTo);
    expect(registered.status).toBe("settled");
    expect(registered.portalState).toBe("compliance_checking");
    expect(h.broadcaster.registerPayment).toHaveBeenCalledWith({
      ownerHash: paid.payment.note.ownerHash,
      ephemeralKeyX: paid.payment.note.ephemeralKey[0],
      ephemeralKeyY: paid.payment.note.ephemeralKey[1],
      viewTag: paid.payment.note.viewTag,
      recovery: NO_RECOVERY_ADDRESS,
      expectedAmount: PRICE.toString(),
      expiry: expect.any(Number),
      chainId: CHAIN_ID,
      token: TOKEN,
    });
    h.portals.set(paid.payment.payTo.toLowerCase(), { state: "shielded", txHash: SHIELD_TX });
    const shielded = await merchant.shield(paid.payment.payTo);
    expect(shielded.status).toBe("shielded");
    expect(shielded.shieldTxHash).toBe(SHIELD_TX);
    expect(h.broadcaster.registerPayment).toHaveBeenCalledTimes(1);

    // A shield transaction that carries someone else's note only is refused, and the payment stays shielded.
    h.receipt.logs = await shieldLogs({ ownerHash: "1", ephemeralKey: ["11", "22"], viewTag: 1 });
    await expect(merchant.confirm(paid.payment.payTo)).rejects.toThrow("does not pay this request");
    expect((await merchant.getPayment(paid.payment.payTo))?.status).toBe("shielded");
    h.receipt.logs = await shieldLogs(paid.payment.note);
    const confirmed = await merchant.confirm(paid.payment.payTo);
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.noteId).toBe((await computeNoteId(paid.payment.note.ownerHash, 9_840n, 3n)).toString());
    expect(confirmed.netAmount).toBe("9840");
    expect(h.events.map((event) => event.type)).toEqual(["challenged", "settled", "shielded", "confirmed"]);

    // Replaying the same PAYMENT-SIGNATURE gets a fresh challenge, never a second settlement.
    const replay = await merchant.charge(request({ [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignature(payload) }), {
      price: PRICE,
    });
    expect(replay.status).toBe("payment-required");
    if (replay.status !== "payment-required") throw new Error("unreachable");
    expect(replay.error).toMatch(/payment challenge is confirmed/);
    expect(replay.payment.payTo).not.toBe(paid.payment.payTo);
    expect(h.facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it("resolves a relative request URL against merchantOrigin or the Host header", async () => {
    const h = harness();
    const merchant = await merchantFor(h);
    const viaHost = await merchant.charge(
      { method: "GET", url: "/api/thing?x=1", headers: { host: "api.test:8080", "x-forwarded-proto": "https" } },
      { price: PRICE },
    );
    if (viaHost.status !== "payment-required") throw new Error("expected a challenge");
    expect(viaHost.response.body.resource.url).toBe("https://api.test:8080/api/thing?x=1");
    await expect(merchant.charge({ method: "GET", url: "/api/thing", headers: {} }, { price: PRICE })).rejects.toThrow(
      /relative and no merchantOrigin/,
    );
    const pinned = await merchantFor(h, { merchantOrigin: "https://shop.example" });
    const viaOrigin = await pinned.charge(
      { method: "GET", url: "/api/thing", headers: { host: "ignored" } },
      { price: PRICE },
    );
    if (viaOrigin.status !== "payment-required") throw new Error("expected a challenge");
    expect(viaOrigin.response.body.resource.url).toBe("https://shop.example/api/thing");
  });

  it("rejects tampered requirements, unknown challenges and wrong prices without touching the facilitator", async () => {
    const h = harness();
    const merchant = await merchantFor(h);
    const challenge = await merchant.charge(request(), { price: PRICE });
    if (challenge.status !== "payment-required") throw new Error("expected a challenge");
    const required = decodePaymentRequired(challenge.response.headers[PAYMENT_REQUIRED_HEADER] as string);

    // The payer lowers the amount in `accepted`.
    const cheaper: X402PaymentRequired = {
      ...required,
      accepts: [{ ...(required.accepts[0] as X402PaymentRequirements), amount: "1" }],
    };
    const tampered = await createExactPayment(cheaper, PAYER);
    const mismatch = await merchant.charge(request({ [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignature(tampered) }), {
      price: PRICE,
    });
    if (mismatch.status !== "payment-required") throw new Error("expected rejection");
    expect(mismatch.error).toMatch(/do not match/);
    // The same challenge is re-offered, since it is still valid.
    expect(mismatch.payment.payTo).toBe(challenge.payment.payTo);

    // A payTo nobody issued.
    const foreign: X402PaymentRequired = {
      ...required,
      accepts: [{ ...(required.accepts[0] as X402PaymentRequirements), payTo: SUBMITTER }],
    };
    const unknown = await merchant.charge(
      request({ [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignature(await createExactPayment(foreign, PAYER)) }),
      { price: PRICE },
    );
    if (unknown.status !== "payment-required") throw new Error("expected rejection");
    expect(unknown.error).toMatch(/unknown payment challenge/);

    // The merchant now charges more than the challenge said.
    const honest = await createExactPayment(required, PAYER);
    const repriced = await merchant.charge(request({ [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignature(honest) }), {
      price: PRICE * 2n,
    });
    if (repriced.status !== "payment-required") throw new Error("expected rejection");
    expect(repriced.error).toMatch(/price of this resource changed/);
    expect(BigInt(repriced.payment.amount)).toBe(PRICE * 2n);

    // Garbage header.
    const garbage = await merchant.charge(request({ [PAYMENT_SIGNATURE_HEADER]: "not-base64!" }), { price: PRICE });
    if (garbage.status !== "payment-required") throw new Error("expected rejection");
    expect(garbage.error).toMatch(/invalid PAYMENT-SIGNATURE/);

    expect(h.facilitator.verify).not.toHaveBeenCalled();
    expect(h.facilitator.settle).not.toHaveBeenCalled();
  });

  it("re-offers the challenge when verification fails and burns it when settlement fails", async () => {
    const h = harness();
    h.facilitator.verify.mockResolvedValueOnce({ isValid: false, invalidReason: "insufficient_funds" });
    const merchant = await merchantFor(h);
    const challenge = await merchant.charge(request(), { price: PRICE });
    if (challenge.status !== "payment-required") throw new Error("expected a challenge");
    const required = decodePaymentRequired(challenge.response.headers[PAYMENT_REQUIRED_HEADER] as string);
    const header = encodePaymentSignature(await createExactPayment(required, PAYER));

    const broke = await merchant.charge(request({ [PAYMENT_SIGNATURE_HEADER]: header }), { price: PRICE });
    if (broke.status !== "payment-required") throw new Error("expected rejection");
    expect(broke.error).toMatch(/insufficient_funds/);
    expect(broke.payment.payTo).toBe(challenge.payment.payTo);
    expect((await merchant.getPayment(challenge.payment.payTo))?.status).toBe("pending");

    h.facilitator.settle.mockResolvedValueOnce({
      success: false,
      transaction: "",
      network: NETWORK,
      errorReason: "nonce_used",
    });
    // A refused settle on a portal that did receive the funds (lost reply, then "nonce used") still counts as paid.
    const recovered = await merchant.charge(request({ [PAYMENT_SIGNATURE_HEADER]: header }), { price: PRICE });
    expect(recovered.status).toBe("paid");
    expect((await merchant.getPayment(challenge.payment.payTo))?.status).toBe("settled");

    // A refused settle on an empty portal burns the challenge.
    const { challenge: second, header: secondHeader } = await (async () => {
      const c = await merchant.charge(request(), { price: PRICE });
      if (c.status !== "payment-required") throw new Error("expected a challenge");
      const r = decodePaymentRequired(c.response.headers[PAYMENT_REQUIRED_HEADER] as string);
      return { challenge: c, header: encodePaymentSignature(await createExactPayment(r, PAYER)) };
    })();
    h.facilitator.settle.mockResolvedValueOnce({
      success: false,
      transaction: "",
      network: NETWORK,
      errorReason: "nonce_used",
    });
    const base = harness().publicClient.readContract as (c: unknown) => Promise<unknown>;
    h.publicClient.readContract.mockImplementation(async (call: { functionName: string }) =>
      call.functionName === "balanceOf" ? 0n : base(call),
    );
    const failed = await merchant.charge(request({ [PAYMENT_SIGNATURE_HEADER]: secondHeader }), { price: PRICE });
    if (failed.status !== "payment-required") throw new Error("expected rejection");
    expect(failed.error).toMatch(/settlement failed: nonce_used/);
    expect(failed.payment.payTo).not.toBe(second.payment.payTo);
    expect((await merchant.getPayment(second.payment.payTo))?.status).toBe("failed");
    expect(h.events.filter((event) => event.type === "failed")).toHaveLength(1);
  });

  it("consumes a challenge once even when two paid retries race", async () => {
    const h = harness();
    const merchant = await merchantFor(h);
    const challenge = await merchant.charge(request(), { price: PRICE });
    if (challenge.status !== "payment-required") throw new Error("expected a challenge");
    const required = decodePaymentRequired(challenge.response.headers[PAYMENT_REQUIRED_HEADER] as string);
    const header = encodePaymentSignature(await createExactPayment(required, PAYER));

    const [first, second] = await Promise.all([
      merchant.charge(request({ [PAYMENT_SIGNATURE_HEADER]: header }), { price: PRICE }),
      merchant.charge(request({ [PAYMENT_SIGNATURE_HEADER]: header }), { price: PRICE }),
    ]);
    expect([first.status, second.status].sort()).toEqual(["paid", "payment-required"]);
    expect(h.facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it("expires unpaid challenges and refuses prices below the on-chain floor", async () => {
    const h = harness();
    const merchant = await merchantFor(h, { challengeTtlSeconds: 1 });
    vi.useFakeTimers();
    try {
      const challenge = await merchant.charge(request(), { price: PRICE });
      if (challenge.status !== "payment-required") throw new Error("expected a challenge");
      const required = decodePaymentRequired(challenge.response.headers[PAYMENT_REQUIRED_HEADER] as string);
      const header = encodePaymentSignature(await createExactPayment(required, PAYER));
      vi.advanceTimersByTime(1_500);
      const late = await merchant.charge(request({ [PAYMENT_SIGNATURE_HEADER]: header }), { price: PRICE });
      if (late.status !== "payment-required") throw new Error("expected rejection");
      expect(late.error).toMatch(/payment challenge is expired/);
    } finally {
      vi.useRealTimers();
    }

    // Fees: 10 bps + 50 portal + 100 commitment → 151 base units is the smallest gross that credits 1.
    expect(await merchant.minimumPrice()).toBe(151n);
    await expect(merchant.charge(request(), { price: 150n })).rejects.toThrow(/below the minimum of 151/);
    expect(await merchant.quote(PRICE)).toMatchObject({ netAmount: "9840" });
  });

  it("requires the broadcaster to serve the chain, or explicit addresses", async () => {
    const h = harness();
    h.broadcaster.network.mockResolvedValueOnce(undefined);
    await expect(merchantFor(h)).rejects.toThrow(/addresses\.aggregator is required/);
    h.broadcaster.network.mockResolvedValueOnce(undefined);
    const pinned = await merchantFor(h, {
      addresses: { aggregator: AGGREGATOR, portalFactory: PORTAL_FACTORY, vault: VAULT },
    });
    expect(pinned.addresses.vault).toBe(VAULT);
    await expect(
      merchantFor(
        harness({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} }),
      ),
    ).rejects.toThrow(/does not support x402 v2 "exact" on eip155:31337/);
  });

  it("defaults to Curvy's broadcaster and to the facilitator that broadcaster serves", async () => {
    const h = harness();
    // Explicit broadcaster URL: the facilitator follows it to <broadcaster>/portal/x402.
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path === "/portal/x402/supported") return Response.json(supportedResponse());
      if (path === "/portal/networks/31337") {
        return Response.json({
          data: {
            chainId: CHAIN_ID,
            aggregator: AGGREGATOR,
            portalFactory: PORTAL_FACTORY,
            vault: VAULT,
            minPortalUsd: 0,
            currencies: [{ address: TOKEN, symbol: "USDC", decimals: 6, vaultTokenId: "3" }],
          },
        });
      }
      return new Response("not found", { status: 404 });
    });
    const merchant = await createX402Merchant({
      broadcaster: "http://broadcaster.test/",
      publicClient: h.publicClient as never,
      recipient: RECIPIENT,
      tokens: [TOKEN],
      autoShield: false,
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(merchant.broadcaster.url).toBe("http://broadcaster.test");
    expect(merchant.facilitator?.url).toBe("http://broadcaster.test/portal/x402");
    expect(merchant.schemes).toEqual(["exact", "curvy-transfer"]);
    merchant.close();

    // Nothing configured: production Curvy endpoints.
    const production = await createX402Merchant({
      publicClient: h.publicClient as never,
      recipient: RECIPIENT,
      tokens: [TOKEN],
      autoShield: false,
      fetch: (async (url: string | URL | Request) => {
        const parsed = new URL(String(url));
        expect(parsed.origin).toBe("https://api.curvy.box");
        return fetchMock(`http://broadcaster.test${parsed.pathname}`);
      }) as unknown as typeof fetch,
    });
    expect(production.broadcaster.url).toBe(CURVY_BROADCASTER_URL);
    expect(production.facilitator?.url).toBe(CURVY_FACILITATOR_URL);
    expect(production.facilitator?.url).toBe("https://api.curvy.box/portal/x402");
    production.close();
    expect(createBroadcasterClient().url).toBe("https://api.curvy.box");
    expect(createFacilitatorClient().url).toBe("https://api.curvy.box/portal/x402");
  });
});

describe("createX402Merchant: receiving keys", () => {
  it("takes the one receiving-keys value from the web app, or the same keys as three strings", async () => {
    const h = harness();
    const merchant = await merchantFor(h, { recipient: undefined, receivingKeys: encodeReceivingKeys(RECIPIENT) });
    const result = await merchant.charge(request(), { price: PRICE });
    expect(result.status).toBe("payment-required");
  });

  it("refuses both, neither or a damaged value before calling any service", async () => {
    const h = harness();
    const exactlyOne = "pass exactly one of receivingKeys (preferred) or recipient";
    await expect(merchantFor(h, { receivingKeys: encodeReceivingKeys(RECIPIENT) })).rejects.toThrow(exactlyOne);
    await expect(merchantFor(h, { recipient: undefined })).rejects.toThrow(exactlyOne);
    await expect(
      merchantFor(h, { recipient: undefined, receivingKeys: `${encodeReceivingKeys(RECIPIENT).slice(0, -1)}A` }),
    ).rejects.toThrow("receiving keys");
    expect(h.broadcaster.network).not.toHaveBeenCalled();
  });
});

describe("createX402Merchant: broadcaster minimum", () => {
  it("raises the minimum price to the broadcaster's USD floor for a USD token", async () => {
    const h = harness();
    h.broadcaster.network.mockResolvedValue({
      chainId: CHAIN_ID,
      aggregator: AGGREGATOR,
      portalFactory: PORTAL_FACTORY,
      vault: VAULT,
      minPortalUsd: 0.5,
      currencies: [{ address: TOKEN, symbol: "USDC", decimals: 6, vaultTokenId: "3" }],
    });
    const merchant = await merchantFor(h);
    expect(merchant.minimumPortalUsd).toBe(0.5);
    expect(await merchant.minimumPrice()).toBe(500_000n);
    await expect(merchant.charge(request(), { price: PRICE })).rejects.toThrow(/broadcaster's 0.5 USD per portal/);
    const lenient = await merchantFor(h, { enforceBroadcasterMinimum: false });
    expect(await lenient.minimumPrice()).toBe(151n);
  });
});

describe("createX402Merchant: failure modes and stores", () => {
  /** A store that hands out copies and has no atomic claim, like a naive JSON/SQL adapter. */
  function copyingStore() {
    const rows = new Map<string, string>();
    return {
      get: async (payTo: string) => {
        const row = rows.get(payTo.toLowerCase());
        return row ? (JSON.parse(row) as import("../x402/merchant").X402Payment) : undefined;
      },
      put: async (payment: import("../x402/merchant").X402Payment) => {
        rows.set(payment.payTo.toLowerCase(), JSON.stringify(payment));
      },
      list: async () => [...rows.values()].map((row) => JSON.parse(row) as import("../x402/merchant").X402Payment),
    };
  }

  async function challengeAndHeader(merchant: X402Merchant) {
    const challenge = await merchant.charge(request(), { price: PRICE });
    if (challenge.status !== "payment-required") throw new Error("expected a challenge");
    const required = decodePaymentRequired(challenge.response.headers[PAYMENT_REQUIRED_HEADER] as string);
    return { challenge, header: encodePaymentSignature(await createExactPayment(required, PAYER)) };
  }

  it("settles once under concurrent retries even with a copying store without claim()", async () => {
    const h = harness();
    const merchant = await merchantFor(h, { store: copyingStore() });
    const { header } = await challengeAndHeader(merchant);
    const results = await Promise.all(
      [1, 2, 3].map(() => merchant.charge(request({ [PAYMENT_SIGNATURE_HEADER]: header }), { price: PRICE })),
    );
    expect(results.filter((r) => r.status === "paid")).toHaveLength(1);
    expect(h.facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it("keeps a challenge settling when the settle reply is lost, and finishes it on the same header", async () => {
    const h = harness();
    h.facilitator.settle.mockRejectedValueOnce(new Error("socket hang up"));
    const merchant = await merchantFor(h);
    const { challenge, header } = await challengeAndHeader(merchant);

    const lost = await merchant.charge(request({ [PAYMENT_SIGNATURE_HEADER]: header }), { price: PRICE });
    if (lost.status !== "payment-required") throw new Error("expected a 402");
    expect(lost.error).toMatch(/retry the same payment/);
    expect(lost.payment.payTo).toBe(challenge.payment.payTo);
    expect((await merchant.getPayment(challenge.payment.payTo))?.status).toBe("settling");
    expect(h.events.map((e) => e.type)).toEqual(["challenged", "error"]);

    // The facilitator dedupes by payer + nonce, so settling again is safe; verify is not repeated.
    const retry = await merchant.charge(request({ [PAYMENT_SIGNATURE_HEADER]: header }), { price: PRICE });
    expect(retry.status).toBe("paid");
    expect(h.facilitator.verify).toHaveBeenCalledTimes(1);
    expect(h.facilitator.settle).toHaveBeenCalledTimes(2);
  });

  it("reconciles a settling payment from the portal balance before shielding", async () => {
    const h = harness();
    h.facilitator.settle.mockRejectedValueOnce(new Error("timeout"));
    const merchant = await merchantFor(h);
    const { challenge, header } = await challengeAndHeader(merchant);
    await merchant.charge(request({ [PAYMENT_SIGNATURE_HEADER]: header }), { price: PRICE });

    // Portal still empty: nothing to shield.
    h.publicClient.readContract.mockImplementationOnce(async () => 0n);
    await expect(merchant.shield(challenge.payment.payTo)).rejects.toThrow(/portal holds no funds yet/);
    // Funds arrived after all: the portal is registered with the broadcaster and then reported shielded.
    h.publicClient.readContract.mockImplementationOnce(async () => PRICE);
    const registered = await merchant.shield(challenge.payment.payTo);
    expect(registered.status).toBe("settled");
    expect(registered.portalState).toBe("compliance_checking");
    h.portals.set(challenge.payment.payTo.toLowerCase(), { state: "shielded", txHash: SHIELD_TX });
    expect((await merchant.shield(challenge.payment.payTo)).status).toBe("shielded");
  });

  it("re-offers the same challenge when the facilitator is unreachable during verify", async () => {
    const h = harness();
    h.facilitator.verify.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const merchant = await merchantFor(h);
    const { challenge, header } = await challengeAndHeader(merchant);
    const down = await merchant.charge(request({ [PAYMENT_SIGNATURE_HEADER]: header }), { price: PRICE });
    if (down.status !== "payment-required") throw new Error("expected a 402");
    expect(down.error).toMatch(/facilitator unavailable/);
    expect(down.payment.payTo).toBe(challenge.payment.payTo);
    expect((await merchant.getPayment(challenge.payment.payTo))?.status).toBe("pending");
    expect((await merchant.charge(request({ [PAYMENT_SIGNATURE_HEADER]: header }), { price: PRICE })).status).toBe(
      "paid",
    );
  });

  it("does not leak the facilitator's settle error to the payer and tolerates a non-address payer", async () => {
    const h = harness();
    h.facilitator.settle.mockResolvedValueOnce({
      success: false,
      transaction: "",
      network: NETWORK,
      errorReason: "insufficient_funds",
      errorMessage: "The contract function reverted with 0xdeadbeef and a very long dump",
    });
    const merchant = await merchantFor(h);
    const { header } = await challengeAndHeader(merchant);
    const base = harness().publicClient.readContract as (c: unknown) => Promise<unknown>;
    h.publicClient.readContract.mockImplementationOnce(async (call: { functionName: string }) =>
      call.functionName === "balanceOf" ? 0n : base(call),
    );
    const failed = await merchant.charge(request({ [PAYMENT_SIGNATURE_HEADER]: header }), { price: PRICE });
    if (failed.status !== "payment-required") throw new Error("expected a 402");
    expect(failed.error).toBe("settlement failed: insufficient_funds");
    expect(h.events.find((e) => e.type === "failed")?.payment.error).toMatch(/very long dump/);

    h.facilitator.settle.mockResolvedValueOnce({
      success: true,
      transaction: "sig-not-hex",
      network: NETWORK,
      payer: "solana:abc",
    });
    const { header: second } = await challengeAndHeader(merchant);
    const paid = await merchant.charge(request({ [PAYMENT_SIGNATURE_HEADER]: second }), { price: PRICE });
    expect(paid.status).toBe("paid");
    if (paid.status !== "paid") throw new Error("unreachable");
    expect(paid.payment.settleTxHash).toBeUndefined();
  });

  it("reads the header case-insensitively and accepts URL-safe base64", async () => {
    const h = harness();
    const merchant = await merchantFor(h);
    const { header } = await challengeAndHeader(merchant);
    const urlSafe = header.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const paid = await merchant.charge(request({ "payment-signature": urlSafe }), { price: PRICE });
    expect(paid.status).toBe("paid");
    const viaHeaders = await merchant.charge(
      { method: "GET", url: "http://api.test/x", headers: new Headers({ "Payment-Signature": header }) },
      { price: PRICE },
    );
    if (viaHeaders.status !== "payment-required") throw new Error("expected a 402");
    expect(viaHeaders.error).toMatch(/payment challenge is (settled|shielded)/);
  });

  it("finishes confirmation in the background despite a transient RPC error", async () => {
    const h = harness();
    const merchant = await merchantFor(h, { autoShield: true, confirmPollMs: 5, confirmTimeoutMs: 5_000 });
    const { challenge, header } = await challengeAndHeader(merchant);
    h.receipt.logs = await shieldLogs(challenge.payment.note);
    h.portals.set(challenge.payment.payTo.toLowerCase(), { state: "shielded", txHash: SHIELD_TX });
    h.publicClient.getTransactionReceipt.mockRejectedValueOnce(new Error("fetch failed"));
    const paid = await merchant.charge(request({ [PAYMENT_SIGNATURE_HEADER]: header }), { price: PRICE });
    expect(paid.status).toBe("paid");
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && (await merchant.getPayment(challenge.payment.payTo))?.status !== "confirmed") {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect((await merchant.getPayment(challenge.payment.payTo))?.status).toBe("confirmed");
    expect(h.events.map((e) => e.type)).toContain("error");
    merchant.close();
    await expect(merchant.charge(request(), { price: PRICE })).rejects.toThrow(/closed/);
  });

  it("never evicts payments with funds in flight from the memory store", async () => {
    const h = harness();
    const merchant = await merchantFor(h, { store: createMemoryPaymentStore({ maxEntries: 3 }) });
    const { challenge, header } = await challengeAndHeader(merchant);
    await merchant.charge(request({ [PAYMENT_SIGNATURE_HEADER]: header }), { price: PRICE });
    for (let i = 0; i < 6; i += 1) await merchant.charge(request(), { price: PRICE });
    const payments = await merchant.listPayments();
    expect(payments.length).toBeLessThanOrEqual(3);
    expect(payments.find((p) => p.payTo === challenge.payment.payTo)?.status).toBe("settled");
  });
});

describe("createX402Merchant: broadcaster mode", () => {
  const SHIELD_VIA_BROADCASTER = `0x${"bb".repeat(32)}` as Hex;
  const TRANSFER_TX = `0x${"cc".repeat(32)}` as Hex;

  /** A receipt for a plain ERC-20 transfer of PRICE from PAYER to `to`. */
  function transferReceipt(to: Address) {
    return {
      status: "success",
      from: PAYER.address,
      blockNumber: 12n,
      logs: [
        {
          address: TOKEN,
          topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: PAYER.address, to } }) as [
            Hex,
            ...Hex[],
          ],
          data: encodeAbiParameters([{ type: "uint256" }], [PRICE]),
          blockHash: zeroHash,
          blockNumber: 12n,
          logIndex: 0,
          removed: false,
          transactionHash: TRANSFER_TX,
          transactionIndex: 0,
        },
      ],
    };
  }

  async function broadcasterMerchant(
    h: Harness,
    b: { client: Harness["broadcaster"] },
    overrides: Record<string, unknown> = {},
  ) {
    return createX402Merchant({
      facilitator: h.facilitator,
      broadcaster: b.client,
      publicClient: h.publicClient as never,
      recipient: RECIPIENT,
      tokens: [TOKEN],
      confirmations: 1,
      autoShield: false,
      onEvent: (event) => h.events.push(event),
      ...overrides,
    });
  }

  it("offers exact and curvy-transfer on one portal derived with the no-recovery sentinel", async () => {
    const h = harness();
    const b = { portals: h.portals, client: h.broadcaster };
    const merchant = await broadcasterMerchant(h, b);
    expect(merchant.schemes).toEqual(["exact", "curvy-transfer"]);
    expect(merchant.recovery).toBe(NO_RECOVERY_ADDRESS);

    const result = await merchant.charge(request(), { price: PRICE });
    if (result.status !== "payment-required") throw new Error("expected a challenge");
    const [exact, transfer] = result.response.body.accepts;
    expect(exact).toMatchObject({ scheme: "exact", extra: { assetTransferMethod: "eip3009", name: "Local USDC" } });
    expect(transfer).toMatchObject({ scheme: "curvy-transfer", extra: { assetTransferMethod: "erc20-transfer" } });
    expect(transfer?.payTo).toBe(exact?.payTo);
    expect(exact?.payTo).toBe(portalFor(BigInt(result.payment.note.ownerHash), NO_RECOVERY_ADDRESS));
  });

  it("settles a curvy-transfer from the portal balance and shields through the broadcaster", async () => {
    const h = harness();
    const b = { portals: h.portals, client: h.broadcaster };
    const merchant = await broadcasterMerchant(h, b, { settleTimeoutMs: 50, confirmPollMs: 10 });
    const challenge = await merchant.charge(request(), { price: PRICE });
    if (challenge.status !== "payment-required") throw new Error("expected a challenge");
    const required = decodePaymentRequired(challenge.response.headers[PAYMENT_REQUIRED_HEADER] as string);
    const payTo = challenge.payment.payTo;

    // The agent sends the tokens itself.
    const send = vi.fn(async () => TRANSFER_TX);
    const payload = await createTransferPayment(required, send);
    expect(send).toHaveBeenCalledWith({ chainId: CHAIN_ID, token: TOKEN, to: payTo, amount: PRICE });
    const header = encodePaymentSignature(payload);

    // Not mined yet and the portal is empty: re-offer the same challenge.
    h.publicClient.getTransactionReceipt.mockRejectedValueOnce(new Error("not found"));
    h.publicClient.readContract.mockImplementation(async (call: { functionName: string }) =>
      call.functionName === "balanceOf"
        ? 0n
        : (harness().publicClient.readContract as (c: unknown) => Promise<unknown>)(call),
    );
    const early = await merchant.charge(request({ [PAYMENT_SIGNATURE_HEADER]: header }), { price: PRICE });
    if (early.status !== "payment-required") throw new Error("expected a 402");
    expect(early.error).toMatch(/holds 0 of the 10000/);
    expect(early.payment.payTo).toBe(payTo);
    expect(h.facilitator.verify).not.toHaveBeenCalled();

    // Mined and funded.
    h.publicClient.getTransactionReceipt.mockImplementation(async () => transferReceipt(payTo));
    h.publicClient.readContract.mockImplementation(async (call: { functionName: string }) =>
      call.functionName === "balanceOf"
        ? PRICE
        : (harness().publicClient.readContract as (c: unknown) => Promise<unknown>)(call),
    );
    const paid = await merchant.charge(request({ [PAYMENT_SIGNATURE_HEADER]: header }), { price: PRICE });
    expect(paid.status).toBe("paid");
    if (paid.status !== "paid") throw new Error("unreachable");
    expect(paid.payment.status).toBe("settled");
    expect(paid.payment.payer).toBe(PAYER.address);
    expect(paid.payment.settleTxHash).toBe(TRANSFER_TX);
    expect(decodePaymentResponse(paid.headers[PAYMENT_RESPONSE_HEADER] as string)).toMatchObject({
      success: true,
      transaction: TRANSFER_TX,
    });
    expect(h.facilitator.settle).not.toHaveBeenCalled();

    // Shielding: registered with the broadcaster, then followed until shielded.
    const inProgress = await merchant.shield(payTo);
    expect(inProgress.status).toBe("settled");
    expect(inProgress.portalState).toBe("compliance_checking");
    expect(b.client.registerPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        recovery: NO_RECOVERY_ADDRESS,
        expectedAmount: PRICE.toString(),
        chainId: CHAIN_ID,
        token: TOKEN,
      }),
    );
    b.portals.set(payTo.toLowerCase(), { state: "shielded", txHash: SHIELD_VIA_BROADCASTER });
    const shielded = await merchant.shield(payTo);
    expect(shielded.status).toBe("shielded");
    expect(shielded.shieldTxHash).toBe(SHIELD_VIA_BROADCASTER);
    expect(b.client.registerPayment).toHaveBeenCalledTimes(1);

    const logs = await shieldLogs(paid.payment.note, SHIELD_VIA_BROADCASTER);
    h.publicClient.getTransactionReceipt.mockImplementation(async () => ({
      status: "success",
      blockNumber: 12n,
      logs,
    }));
    expect((await merchant.confirm(payTo)).status).toBe("confirmed");
  });

  it("settles exact through any facilitator and stops on a broadcaster refusal", async () => {
    const h = harness();
    const b = { portals: h.portals, client: h.broadcaster };
    const merchant = await broadcasterMerchant(h, b, { schemes: ["exact"] });
    const challenge = await merchant.charge(request(), { price: PRICE });
    if (challenge.status !== "payment-required") throw new Error("expected a challenge");
    expect(challenge.response.body.accepts.map((row) => row.scheme)).toEqual(["exact"]);
    const required = decodePaymentRequired(challenge.response.headers[PAYMENT_REQUIRED_HEADER] as string);
    const header = encodePaymentSignature(await createExactPayment(required, PAYER));
    const paid = await merchant.charge(request({ [PAYMENT_SIGNATURE_HEADER]: header }), { price: PRICE });
    expect(paid.status).toBe("paid");
    expect(h.facilitator.settle).toHaveBeenCalledTimes(1);

    b.portals.set(challenge.payment.payTo.toLowerCase(), { state: "compliance_failed", error: "sanctioned origin" });
    await expect(merchant.shield(challenge.payment.payTo)).rejects.toThrow(
      /portal compliance_failed: sanctioned origin/,
    );
    const record = await merchant.getPayment(challenge.payment.payTo);
    expect(record?.status).toBe("settled");
    expect(record?.error).toMatch(/shield refused/);
  });

  it("works without any facilitator when only curvy-transfer is offered", async () => {
    const h = harness();
    const merchant = await createX402Merchant({
      broadcaster: h.broadcaster,
      facilitator: false,
      publicClient: h.publicClient as never,
      recipient: RECIPIENT,
      tokens: [TOKEN],
      confirmations: 1,
      autoShield: false,
    });
    expect(merchant.facilitator).toBeUndefined();
    expect(merchant.schemes).toEqual(["curvy-transfer"]);
    const result = await merchant.charge(request(), { price: PRICE });
    if (result.status !== "payment-required") throw new Error("expected a challenge");
    expect(result.response.body.accepts).toHaveLength(1);
    await expect(
      createX402Merchant({
        broadcaster: h.broadcaster,
        facilitator: false,
        publicClient: h.publicClient as never,
        recipient: RECIPIENT,
        tokens: [TOKEN],
        schemes: ["exact"],
      }),
    ).rejects.toThrow(/needs a facilitator/);
  });
});

describe("createX402Merchant: broadcaster mode edge cases", () => {
  const TRANSFER_TX = `0x${"ee".repeat(32)}` as Hex;

  async function merchantWith(
    h: Harness,
    b: { client: Harness["broadcaster"] },
    overrides: Record<string, unknown> = {},
  ) {
    return createX402Merchant({
      facilitator: h.facilitator,
      broadcaster: b.client,
      publicClient: h.publicClient as never,
      recipient: RECIPIENT,
      tokens: [TOKEN],
      confirmations: 1,
      autoShield: false,
      settleTimeoutMs: 50,
      confirmPollMs: 10,
      onEvent: (event) => h.events.push(event),
      ...overrides,
    });
  }

  function fundedPortal(h: Harness, funded: boolean) {
    const base = harness().publicClient.readContract as (c: unknown) => Promise<unknown>;
    h.publicClient.readContract.mockImplementation(async (call: { functionName: string }) =>
      call.functionName === "balanceOf" ? (funded ? PRICE : 0n) : base(call),
    );
  }

  it("honours a transfer that lands after the challenge expired", async () => {
    const h = harness();
    const b = { portals: h.portals, client: h.broadcaster };
    const merchant = await merchantWith(h, b, { challengeTtlSeconds: 1 });
    vi.useFakeTimers();
    try {
      const challenge = await merchant.charge(request(), { price: PRICE });
      if (challenge.status !== "payment-required") throw new Error("expected a challenge");
      const required = decodePaymentRequired(challenge.response.headers[PAYMENT_REQUIRED_HEADER] as string);
      const header = encodePaymentSignature(await createTransferPayment(required, async () => TRANSFER_TX));
      vi.advanceTimersByTime(1_500);
      fundedPortal(h, true);
      h.publicClient.getTransactionReceipt.mockImplementation(async () => ({
        status: "success",
        from: PAYER.address,
        blockNumber: 12n,
        logs: [],
      }));
      const late = await merchant.charge(request({ [PAYMENT_SIGNATURE_HEADER]: header }), { price: PRICE });
      expect(late.status).toBe("paid");
      expect((await merchant.getPayment(challenge.payment.payTo))?.status).toBe("settled");
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a reverted or unmined transfer and a header without a hash on an empty portal", async () => {
    const h = harness();
    const b = { portals: h.portals, client: h.broadcaster };
    const merchant = await merchantWith(h, b);
    const challenge = await merchant.charge(request(), { price: PRICE });
    if (challenge.status !== "payment-required") throw new Error("expected a challenge");
    const required = decodePaymentRequired(challenge.response.headers[PAYMENT_REQUIRED_HEADER] as string);
    fundedPortal(h, false);

    h.publicClient.getTransactionReceipt.mockImplementation(async () => ({
      status: "reverted",
      blockNumber: 12n,
      logs: [],
    }));
    const reverted = await merchant.charge(
      request({
        [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignature(
          await createTransferPayment(required, async () => TRANSFER_TX),
        ),
      }),
      { price: PRICE },
    );
    if (reverted.status !== "payment-required") throw new Error("expected a 402");
    expect(reverted.error).toMatch(/reverted/);

    h.publicClient.getTransactionReceipt.mockRejectedValue(new Error("not found"));
    const unmined = await merchant.charge(
      request({
        [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignature(
          await createTransferPayment(required, async () => TRANSFER_TX),
        ),
      }),
      { price: PRICE },
    );
    if (unmined.status !== "payment-required") throw new Error("expected a 402");
    expect(unmined.error).toMatch(/not found; retry once it is mined/);
    expect(unmined.payment.payTo).toBe(challenge.payment.payTo);

    const noHash = encodeBase64Json({ x402Version: 2, accepted: required.accepts[1], payload: {} });
    const empty = await merchant.charge(request({ [PAYMENT_SIGNATURE_HEADER]: noHash }), { price: PRICE });
    if (empty.status !== "payment-required") throw new Error("expected a 402");
    expect(empty.error).toMatch(/holds 0 of the 10000/);
    expect((await merchant.getPayment(challenge.payment.payTo))?.status).toBe("pending");
  });

  it("treats a shielded portal without a hash as shielded and rejects a status for another portal", async () => {
    const h = harness();
    const b = { portals: h.portals, client: h.broadcaster };
    const merchant = await merchantWith(h, b);
    const challenge = await merchant.charge(request(), { price: PRICE });
    if (challenge.status !== "payment-required") throw new Error("expected a challenge");
    const required = decodePaymentRequired(challenge.response.headers[PAYMENT_REQUIRED_HEADER] as string);
    fundedPortal(h, true);
    const paid = await merchant.charge(
      request({ [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignature(await createExactPayment(required, PAYER)) }),
      { price: PRICE },
    );
    expect(paid.status).toBe("paid");
    const payTo = challenge.payment.payTo;

    b.portals.set(payTo.toLowerCase(), { state: "shielding", portalAddress: SUBMITTER });
    await expect(merchant.shield(payTo)).rejects.toThrow(/answered for portal/);
    b.portals.set(payTo.toLowerCase(), { state: "shielded" });
    const shielded = await merchant.shield(payTo);
    expect(shielded.status).toBe("shielded");
    expect(shielded.shieldTxHash).toBeUndefined();
    // Confirmation then scans the aggregator for the payment reference instead of a receipt.
    h.publicClient.getLogs.mockResolvedValue([]);
    expect((await merchant.confirm(payTo)).status).toBe("shielded");
  });

  it("does not serve an exact payment the facilitator settled but the portal never received", async () => {
    const h = harness();
    const b = { portals: h.portals, client: h.broadcaster };
    const merchant = await merchantWith(h, b);
    const challenge = await merchant.charge(request(), { price: PRICE });
    if (challenge.status !== "payment-required") throw new Error("expected a challenge");
    const required = decodePaymentRequired(challenge.response.headers[PAYMENT_REQUIRED_HEADER] as string);
    fundedPortal(h, false);
    const lying = await merchant.charge(
      request({ [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignature(await createExactPayment(required, PAYER)) }),
      { price: PRICE },
    );
    if (lying.status !== "payment-required") throw new Error("expected a 402");
    expect(lying.error).toMatch(/not visible on chain/);
    expect((await merchant.getPayment(challenge.payment.payTo))?.status).toBe("settling");
  });
});

describe("createX402Payer: fetch with a pending transfer", () => {
  it("retries the same header while the merchant re-offers the same portal, and never sends twice", async () => {
    const row: X402PaymentRequirements = {
      scheme: "curvy-transfer",
      network: NETWORK,
      asset: TOKEN,
      amount: PRICE.toString(),
      payTo: SUBMITTER,
      maxTimeoutSeconds: 300,
      extra: { assetTransferMethod: "erc20-transfer" },
    };
    const required: X402PaymentRequired = { x402Version: 2, resource: { url: "http://api.test/x" }, accepts: [row] };
    const header402 = { [PAYMENT_REQUIRED_HEADER]: Buffer.from(JSON.stringify(required)).toString("base64") };
    let paidCalls = 0;
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const signature = new Headers(init?.headers).get(PAYMENT_SIGNATURE_HEADER);
      if (!signature) return new Response("", { status: 402, headers: header402 });
      paidCalls += 1;
      // First two paid retries: "not mined yet", same portal re-offered. Third: paid.
      if (paidCalls < 3)
        return new Response(JSON.stringify({ error: "retry once it is mined" }), { status: 402, headers: header402 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const send = vi.fn(async () => `0x${"ff".repeat(32)}` as Hex);
    const payer = createX402Payer({
      send,
      maxAmount: PRICE,
      fetch: fetchMock as unknown as typeof fetch,
      retryEveryMs: 1,
    });
    const response = await payer.fetch("http://api.test/x");
    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    expect(paidCalls).toBe(3);

    // A later call for the same URL after a failed run reuses the outstanding transfer instead of paying again.
    paidCalls = 0;
    fetchMock.mockImplementation(async (_input, init) => {
      const signature = new Headers(init?.headers).get(PAYMENT_SIGNATURE_HEADER);
      if (!signature) return new Response("", { status: 402, headers: header402 });
      paidCalls += 1;
      return new Response("", { status: 402, headers: header402 });
    });
    const stuck = createX402Payer({
      send,
      maxAmount: PRICE,
      fetch: fetchMock as unknown as typeof fetch,
      retryEveryMs: 1,
      retryForMs: 5,
    });
    expect((await stuck.fetch("http://api.test/y")).status).toBe(402);
    expect((await stuck.fetch("http://api.test/y")).status).toBe(402);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("createX402Payer: curvy-transfer", () => {
  it("prefers exact when it can sign, and falls back to sending a transfer", async () => {
    const transferRow: X402PaymentRequirements = {
      scheme: "curvy-transfer",
      network: NETWORK,
      asset: TOKEN,
      amount: PRICE.toString(),
      payTo: SUBMITTER,
      maxTimeoutSeconds: 300,
      extra: { assetTransferMethod: "erc20-transfer" },
    };
    const exactRow: X402PaymentRequirements = {
      ...transferRow,
      scheme: "exact",
      extra: { name: "Local USDC", version: "2", assetTransferMethod: "eip3009" },
    };
    const both: X402PaymentRequired = {
      x402Version: 2,
      resource: { url: "http://api.test/x" },
      accepts: [exactRow, transferRow],
    };
    const transferOnly: X402PaymentRequired = { ...both, accepts: [transferRow] };
    const send = vi.fn(async () => `0x${"dd".repeat(32)}` as Hex);

    const payer = createX402Payer({ signer: PAYER, send, maxAmount: PRICE });
    const viaExact = JSON.parse(Buffer.from(await payer.pay(both), "base64").toString());
    expect(viaExact.accepted.scheme).toBe("exact");
    expect(send).not.toHaveBeenCalled();
    const viaTransfer = JSON.parse(Buffer.from(await payer.pay(transferOnly), "base64").toString());
    expect(viaTransfer.accepted.scheme).toBe("curvy-transfer");
    expect(viaTransfer.payload.txHash).toBe(`0x${"dd".repeat(32)}`);

    const signOnly = createX402Payer({ signer: PAYER, maxAmount: PRICE });
    await expect(signOnly.pay(transferOnly)).rejects.toThrow(/no exact EIP-3009/);
    expect(() => createX402Payer({ maxAmount: PRICE })).toThrow(/signer .* or a send function/);
    expect(() => selectTransferRequirements(transferOnly, { maxAmount: 1n })).toThrow(/exceeds the payer's maxAmount/);
  });
});

describe("createFacilitatorClient", () => {
  const requirements: X402PaymentRequirements = {
    scheme: "exact",
    network: NETWORK,
    asset: TOKEN,
    amount: "1",
    payTo: SUBMITTER,
    maxTimeoutSeconds: 30,
    extra: {},
  };
  const payload = { x402Version: 2, accepted: requirements, payload: {} };

  it("passes rejected verify/settle bodies through and wraps other failures", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      calls.push(path);
      if (path === "/verify")
        return Response.json({ isValid: false, invalidReason: "insufficient_funds" }, { status: 400 });
      if (path === "/settle") return new Response("bad gateway", { status: 502 });
      if (path === "/exact/shield")
        return Response.json({ success: false, error: "payTo does not match" }, { status: 400 });
      return Response.json({ kinds: [], extensions: [], signers: {} });
    });
    const client = createFacilitatorClient({
      url: "http://facilitator.test/",
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(client.url).toBe("http://facilitator.test");
    expect(await client.verify(payload, requirements)).toEqual({ isValid: false, invalidReason: "insufficient_funds" });
    await expect(client.settle(payload, requirements)).rejects.toMatchObject({ name: "FacilitatorError", status: 502 });
    expect(calls).toEqual(["/verify", "/settle"]);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body).toMatchObject({ x402Version: 2, paymentPayload: payload, paymentRequirements: requirements });
  });
});

describe("createX402Payer", () => {
  const requirements: X402PaymentRequirements = {
    scheme: "exact",
    network: NETWORK,
    asset: TOKEN,
    amount: PRICE.toString(),
    payTo: SUBMITTER,
    maxTimeoutSeconds: 300,
    extra: { name: "Local USDC", version: "2", assetTransferMethod: "eip3009" },
  };
  const required: X402PaymentRequired = {
    x402Version: 2,
    resource: { url: "http://api.test/x" },
    accepts: [requirements],
  };

  it("selects only exact EIP-3009 options within the payer's limits", () => {
    expect(selectExactRequirements(required)).toBe(requirements);
    // A multi-chain 402 (Solana first) still decodes and the EVM option is picked.
    const solana = {
      ...requirements,
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      payTo: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
    };
    const multi = decodePaymentRequired(
      Buffer.from(JSON.stringify({ ...required, accepts: [solana, requirements] })).toString("base64"),
    );
    expect(selectExactRequirements(multi)).toEqual(requirements);
    expect(() => selectExactRequirements({ ...required, accepts: [solana] })).toThrow(/no exact EIP-3009/);
    expect(() => selectExactRequirements(required, { maxAmount: 9_999n })).toThrow(/exceeds the payer's maxAmount/);
    expect(() => selectExactRequirements(required, { network: "eip155:8453" })).toThrow(/no exact EIP-3009/);
    const permit2 = {
      ...required,
      accepts: [{ ...requirements, extra: { ...requirements.extra, assetTransferMethod: "permit2" } }],
    };
    expect(() => selectExactRequirements(permit2)).toThrow(/no exact EIP-3009/);
    const batch = { ...required, accepts: [{ ...requirements, scheme: "some-other-scheme" }, requirements] };
    expect(selectExactRequirements(batch)).toBe(requirements);
  });

  it("pays a 402 once and returns the paid response", async () => {
    const seen: Array<{ url: string; signature: string | null }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const signature = headers.get(PAYMENT_SIGNATURE_HEADER);
      seen.push({ url: String(input), signature });
      if (!signature) {
        return new Response(JSON.stringify(required), {
          status: 402,
          headers: { [PAYMENT_REQUIRED_HEADER]: Buffer.from(JSON.stringify(required)).toString("base64") },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          [PAYMENT_RESPONSE_HEADER]: Buffer.from(
            JSON.stringify({
              success: true,
              transaction: `0x${"11".repeat(32)}`,
              network: NETWORK,
              payer: PAYER.address,
            }),
          ).toString("base64"),
        },
      });
    });
    const payer = createX402Payer({ signer: PAYER, fetch: fetchMock as unknown as typeof fetch, maxAmount: PRICE });
    const response = await payer.fetch("http://api.test/x", { headers: { accept: "application/json" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(seen).toHaveLength(2);
    const payload = parseExactPayload(
      JSON.parse(Buffer.from(seen[1]?.signature as string, "base64").toString()).payload as unknown,
    );
    expect(payload.authorization.to).toBe(SUBMITTER);
    expect(payload.authorization.value).toBe(PRICE.toString());

    // A custom clock moves validBefore with it.
    const skewed = createX402Payer({
      signer: PAYER,
      maxAmount: PRICE,
      fetch: fetchMock as unknown as typeof fetch,
      now: () => 2_000_000_000,
    });
    const header = await skewed.pay(required);
    const validBefore = parseExactPayload(JSON.parse(Buffer.from(header, "base64").toString()).payload as unknown)
      .authorization.validBefore;
    expect(validBefore).toBe(String(2_000_000_000 + 300));

    // Non-402 responses pass through untouched.
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 404 }));
    expect((await payer.fetch("http://api.test/missing")).status).toBe(404);
  });
});

describe("createX402Merchant: several tokens and other networks", () => {
  it("offers each token, and counts a payment in the one the payer chose", async () => {
    const h = harness();
    const merchant = await merchantFor(h, { tokens: [TOKEN, USDT] });
    const challenge = await merchant.charge(request(), { price: PRICE });
    if (challenge.status !== "payment-required") throw new Error("expected a challenge");
    const required = decodePaymentRequired(challenge.response.headers[PAYMENT_REQUIRED_HEADER] as string);

    expect(required.accepts.map((row) => [row.scheme, row.asset])).toEqual([
      ["exact", TOKEN],
      ["curvy-transfer", TOKEN],
      ["exact", USDT],
      ["curvy-transfer", USDT],
    ]);
    expect(new Set(required.accepts.map((row) => row.payTo)).size).toBe(1);

    const payload = await createExactPayment(required, PAYER, { asset: USDT });
    const paid = await merchant.charge(request({ [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignature(payload) }), {
      price: PRICE,
    });
    if (paid.status !== "paid") throw new Error("expected a payment");
    expect(paid.payment).toMatchObject({ token: USDT });
    expect(paid.payment.paidOn).toBeUndefined();

    await merchant.shield(paid.payment.payTo);
    expect(h.broadcaster.registerPayment).toHaveBeenCalledWith(expect.objectContaining({ token: USDT }));
    h.portals.set(paid.payment.payTo.toLowerCase(), { state: "shielded", txHash: SHIELD_TX });
    await merchant.shield(paid.payment.payTo);
    h.receipt.logs = await shieldLogs(paid.payment.note, SHIELD_TX, 9_840n, 4n);
    expect((await merchant.confirm(paid.payment.payTo)).status).toBe("confirmed");
  });

  describe("on Arbitrum One with other networks", () => {
    const BASE = "eip155:8453";
    const BASE_USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");

    /** A merchant on Arbitrum One taking USDC on Base too, against the mocked deployment. */
    async function onArbitrum(toAmountMin: bigint) {
      const h = harness({
        kinds: [
          { x402Version: 2, scheme: "exact", network: "eip155:42161" },
          { x402Version: 2, scheme: "exact", network: BASE },
        ],
        extensions: [],
        signers: { "eip155:*": [SUBMITTER] },
      });
      h.publicClient.getChainId.mockResolvedValue(42_161);
      const estimateBridge = vi.fn(async () => ({ toAmount: toAmountMin + 10n, toAmountMin }));
      const merchant = await merchantFor(h, {
        broadcaster: { ...h.broadcaster, estimateBridge },
        addresses: { aggregator: AGGREGATOR, portalFactory: PORTAL_FACTORY, vault: VAULT },
        otherNetworks: [8453],
      });
      return { h, merchant, estimateBridge };
    }

    it("offers USDC on Base only while its bridge is quoted under 3% of the price", async () => {
      const cheap = await onArbitrum(9_900n);
      const offered = await cheap.merchant.charge(request(), { price: PRICE });
      if (offered.status !== "payment-required") throw new Error("expected a challenge");
      const base = offered.payment.accepts.find((row) => row.network === BASE);

      expect(base).toMatchObject({ scheme: "exact", asset: BASE_USDC, amount: "10000", extra: { name: "USD Coin" } });
      expect(base?.payTo).toBe(offered.payment.accepts[0]?.payTo);
      expect(cheap.estimateBridge).toHaveBeenCalledWith(
        expect.objectContaining({ fromChainId: 8453, toChainId: 42_161, fromToken: BASE_USDC, toToken: TOKEN }),
      );

      const dear = await onArbitrum(9_600n);
      const refused = await dear.merchant.charge(request(), { price: PRICE });
      if (refused.status !== "payment-required") throw new Error("expected a challenge");
      expect(refused.payment.accepts.some((row) => row.network === BASE)).toBe(false);
    });

    it("serves on the facilitator's settlement there, and confirms it bridged and a little short", async () => {
      const { h, merchant } = await onArbitrum(9_900n);
      // Nothing at the address on Arbitrum One: the money is on Base until Curvy bridges it.
      h.publicClient.readContract.mockImplementation(async (call: { functionName: string; args?: unknown[] }) =>
        call.functionName === "balanceOf" ? 0n : harness().publicClient.readContract(call),
      );
      const challenge = await merchant.charge(request(), { price: PRICE });
      if (challenge.status !== "payment-required") throw new Error("expected a challenge");
      const required = decodePaymentRequired(challenge.response.headers[PAYMENT_REQUIRED_HEADER] as string);
      const payload = await createExactPayment(required, PAYER, { network: BASE });

      const paid = await merchant.charge(request({ [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignature(payload) }), {
        price: PRICE,
      });
      if (paid.status !== "paid") throw new Error("expected a payment");
      expect(paid.payment).toMatchObject({ token: TOKEN, paidOn: BASE });

      await merchant.shield(paid.payment.payTo);
      expect(h.broadcaster.registerPayment).toHaveBeenCalledWith(
        expect.objectContaining({ chainId: 42_161, token: TOKEN, expectedAmount: "10000" }),
      );
      h.portals.set(paid.payment.payTo.toLowerCase(), { state: "shielded", txHash: SHIELD_TX });
      await merchant.shield(paid.payment.payTo);

      // 2% went to the bridge: 9 800 arrived, so 9 800 - 9 - 150 reached the note.
      h.receipt.logs = await shieldLogs(paid.payment.note, SHIELD_TX, 9_641n);
      expect((await merchant.confirm(paid.payment.payTo)).status).toBe("confirmed");
    });

    it("refuses other networks it can't take", async () => {
      const h = harness();
      await expect(merchantFor(h, { otherNetworks: [8453] })).rejects.toThrow("needs a merchant on Arbitrum One");

      const arbitrum = harness({
        kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:42161" }],
        extensions: [],
        signers: { "eip155:*": [SUBMITTER] },
      });
      arbitrum.publicClient.getChainId.mockResolvedValue(42_161);
      const addresses = { aggregator: AGGREGATOR, portalFactory: PORTAL_FACTORY, vault: VAULT };
      const broadcaster = { ...arbitrum.broadcaster, estimateBridge: vi.fn() };
      await expect(merchantFor(arbitrum, { broadcaster, addresses, otherNetworks: [56] })).rejects.toThrow(
        "chain 56 has no token with signed transfers like yours",
      );
      await expect(merchantFor(arbitrum, { broadcaster, addresses, otherNetworks: [8453] })).rejects.toThrow(
        'the facilitator does not settle "exact" on Base',
      );
    });
  });
});
