/**
 * End-to-end: a standard x402 agent client (`@x402/fetch` + `@x402/evm`, the stack Coinbase's AgentKit
 * builds on) pays a merchant built on `createX402Merchant`. Curvy's facilitator, served by the portal
 * broadcaster under `/portal/x402` (the SDK's default), settles the EIP-3009 authorization, the broadcaster
 * shields the one-time portal, and the merchant confirms its own payment reference on chain. A second leg pays
 * by plain transfer (`curvy-transfer`) with no facilitator at all.
 *
 * Needs the local payments stack from the monorepo root: `pnpm demo:payments` (Anvil :8545, broadcaster :4035
 * with PORTAL_MIN_USD_VALUE ≤ the price and X402_FACILITATOR_PRIVATE_KEY set). Run with `pnpm test:e2e`;
 * skipped when the stack is not reachable. Env: RPC_URL, PORTAL_BROADCASTER_URL, X402_PAYER_KEY.
 */
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { type Address, createPublicClient, createWalletClient, getAddress, type Hex, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { quotePayment, readChainFees } from "../economics";
import {
  createX402Payer,
  EXACT_SCHEME,
  NO_RECOVERY_ADDRESS,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  parsePaymentRequired,
  TRANSFER_SCHEME,
} from "../x402";
import { decodeBase64Json } from "../x402/header";
import { createX402Merchant, type X402Merchant, type X402PaymentEvent } from "../x402/merchant";

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const BROADCASTER_URL = process.env.PORTAL_BROADCASTER_URL ?? "http://127.0.0.1:4035";
/** Anvil account #1: the paying agent. */
const PAYER_KEY = (process.env.X402_PAYER_KEY ??
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d") as Hex;
const PRICE = 10_000n;
const RECIPIENT = {
  S: "18841156662615403723520443807716409278140486251221355574263061434503921265588.98357793752770194678499426326386336085357653965912017495890904868125096440617",
  V: "1760020198064161165795911805578555709740706783603233189380229091027759021973.19520756004562638043874842910851983303596751292314679321770725659462577589821",
  babyJubjubPublicKey:
    "5509359784107808046541889973707062912186356978136525798140528612444721440004.5125768395023217094469327424244994953312297627197683956739233494456001838760",
};
const tokenAbi = parseAbi([
  "function mockMint(address account, uint256 amount)",
  "function balanceOf(address account) view returns (uint256)",
  "function transfer(address to, uint256 value) returns (bool)",
]);

async function reachable(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(1_500) })).ok;
  } catch {
    return false;
  }
}

const stackUp = await reachable(`${BROADCASTER_URL}/health`);

/** Local devnet token from the contracts deployment, unless X402_TOKEN_ADDRESS is set. */
function devnetToken(): Address {
  if (process.env.X402_TOKEN_ADDRESS) return getAddress(process.env.X402_TOKEN_ADDRESS);
  const here = dirname(fileURLToPath(import.meta.url));
  const file = resolve(here, "../../../../contracts/evm/ignition/deployments/local_anvil/deployed_addresses.json");
  const deployed = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
  const token = deployed["Devenv#EIP3009TokenMock"];
  if (!token) throw new Error(`Devenv#EIP3009TokenMock missing in ${file}`);
  return getAddress(token);
}

describe.skipIf(!stackUp)("x402 e2e: @x402/fetch agent → createX402Merchant, broadcaster facilitator + shield", () => {
  const account = privateKeyToAccount(PAYER_KEY);
  const publicClient = createPublicClient({ chain: foundry, transport: http(RPC_URL) });
  const walletClient = createWalletClient({ account, chain: foundry, transport: http(RPC_URL) });
  const events: X402PaymentEvent[] = [];
  let merchant: X402Merchant;
  let server: Server;
  let baseUrl: string;
  let token: Address;

  beforeAll(async () => {
    token = devnetToken();
    // The standard client dates its authorization from Date.now(), and the token compares it with
    // block.timestamp. A local Anvil that was time-warped (the demo e2e's rug scenario) runs hours ahead,
    // so align this process's clock with the chain; on a real network the skew is seconds.
    const chainNow = Number((await publicClient.getBlock()).timestamp);
    const skewSeconds = chainNow - Math.floor(Date.now() / 1_000);
    if (Math.abs(skewSeconds) > 30) {
      console.warn(`chain clock is ${skewSeconds}s from the wall clock; aligning Date.now() with the chain`);
      vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
      vi.setSystemTime(Date.now() + skewSeconds * 1_000);
    }
    // The broadcaster's own facilitator must serve this chain, or the merchant refuses to start.
    const supported = (await (await fetch(`${BROADCASTER_URL}/portal/x402/supported`)).json()) as {
      kinds: { network: string }[];
    };
    expect(supported.kinds.map((kind) => kind.network)).toContain(`eip155:${await publicClient.getChainId()}`);

    // No facilitator configured: the SDK uses the one the broadcaster serves under /portal/x402.
    merchant = await createX402Merchant({
      broadcaster: BROADCASTER_URL,
      rpcUrl: RPC_URL,
      recipient: RECIPIENT,
      token,
      confirmations: 1,
      confirmPollMs: 500,
      onEvent: (event) => events.push(event),
    });
    expect(merchant.recovery).toBe(NO_RECOVERY_ADDRESS);
    expect(merchant.facilitator?.url).toBe(`${BROADCASTER_URL}/portal/x402`);
    expect(merchant.schemes).toEqual([EXACT_SCHEME, TRANSFER_SCHEME]);

    // The merchant under test: one paid route on a plain Node server.
    server = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/api/quote") {
        response.writeHead(404).end();
        return;
      }
      try {
        const result = await merchant.charge(
          { method: request.method, url: url.pathname + url.search, headers: request.headers },
          { price: PRICE, description: "one quote" },
        );
        if (result.status === "payment-required") {
          response.writeHead(402, result.response.headers).end(JSON.stringify(result.response.body));
          return;
        }
        response.writeHead(200, { ...result.headers, "content-type": "application/json" }).end(
          JSON.stringify({
            quote: "The best way to predict the future is to invent it.",
            payTo: result.payment.payTo,
          }),
        );
      } catch (error) {
        response.writeHead(500).end(String(error));
      }
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind a port");
    baseUrl = `http://127.0.0.1:${address.port}`;

    // Fund the agent with the devnet token if it is short.
    const balance = await publicClient.readContract({
      address: token,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [account.address],
    });
    if (balance < PRICE * 3n) {
      const hash = await walletClient.writeContract({
        address: token,
        abi: tokenAbi,
        functionName: "mockMint",
        args: [account.address, PRICE * 3n],
      });
      await publicClient.waitForTransactionReceipt({ hash });
    }
  });

  afterAll(async () => {
    vi.useRealTimers();
    merchant?.close();
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  });

  it("offers exact and curvy-transfer, and the standard client picks exact", async () => {
    const unpaid = await fetch(`${baseUrl}/api/quote`);
    expect(unpaid.status).toBe(402);
    const required = parsePaymentRequired(decodeBase64Json(unpaid.headers.get(PAYMENT_REQUIRED_HEADER) ?? ""));
    expect(required.accepts.map((row) => row.scheme)).toEqual([EXACT_SCHEME, TRANSFER_SCHEME]);
    expect(required.accepts[0]?.payTo).toBe(required.accepts[1]?.payTo);
    expect(required.accepts[0]?.extra).toMatchObject({
      name: merchant.tokenDomain.name,
      version: merchant.tokenDomain.version,
    });
  });

  it("pays with @x402/fetch, is refused on replay, and the payment is shielded by the broadcaster and confirmed", async () => {
    const client = new x402Client().register(merchant.network, new ExactEvmScheme(account));
    const fetchWithPayment = wrapFetchWithPayment(fetch, client);

    const paid = await fetchWithPayment(`${baseUrl}/api/quote`);
    expect(paid.status, await paid.clone().text()).toBe(200);
    const body = (await paid.json()) as { quote: string; payTo: Address };
    expect(body.quote).toMatch(/predict the future/);
    const settlement = decodePaymentResponseHeader(paid.headers.get("PAYMENT-RESPONSE") ?? "");
    expect(settlement.success).toBe(true);
    expect(settlement.payer?.toLowerCase()).toBe(account.address.toLowerCase());
    expect(settlement.network).toBe(merchant.network);

    const record = await merchant.getPayment(body.payTo);
    expect(record?.status).toMatch(/settled|shielded|confirmed/);
    expect(record?.payer).toBe(account.address);
    expect(record?.settleTxHash).toBe(settlement.transaction);

    // The same PAYMENT-SIGNATURE must not buy a second quote. Replay it verbatim.
    const challenge = await fetch(`${baseUrl}/api/quote`);
    const required = client
      ? parsePaymentRequired(decodeBase64Json(challenge.headers.get(PAYMENT_REQUIRED_HEADER) ?? ""))
      : undefined;
    expect(required?.accepts[0]?.payTo).not.toBe(body.payTo);
    const replayed = await fetch(`${baseUrl}/api/quote`, {
      headers: { [PAYMENT_SIGNATURE_HEADER]: await signedHeaderFor(body.payTo) },
    });
    expect(replayed.status).toBe(402);
    const replayBody = (await replayed.json()) as { error?: string };
    expect(replayBody.error).toMatch(/payment challenge is (being settled|settled|shielded|confirmed)/);

    // Broadcaster, not facilitator, shields; then the merchant's own confirmation.
    const deadline = Date.now() + 240_000;
    let confirmed = await merchant.getPayment(body.payTo);
    while (Date.now() < deadline && confirmed?.status !== "confirmed") {
      await new Promise((r) => setTimeout(r, 1_000));
      confirmed = await merchant.getPayment(body.payTo);
    }
    expect(confirmed?.status, JSON.stringify(confirmed)).toBe("confirmed");
    expect(confirmed?.portalState).toBe("shielded");
    expect(confirmed?.shieldTxHash).toMatch(/^0x[0-9a-f]{64}$/i);

    const fees = await readChainFees({ publicClient, vaultAddress: merchant.addresses.vault, token });
    expect(confirmed?.netAmount).toBe(quotePayment({ grossAmount: PRICE, fees, rail: "portal" }).netAmount);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["challenged", "settled", "shielded", "confirmed"]),
    );

    /** Re-sign the same requirements the client already paid, i.e. a fresh authorization for a used portal. */
    async function signedHeaderFor(payTo: Address): Promise<string> {
      const used = (await merchant.getPayment(payTo))?.accepts[0];
      if (!used) throw new Error("missing payment");
      const httpClient = new (await import("@x402/core/client")).x402HTTPClient(client);
      const payload = await httpClient.createPaymentPayload({
        x402Version: 2,
        resource: { url: `${baseUrl}/api/quote` },
        accepts: [{ ...used, network: used.network as `${string}:${string}` }],
      });
      return httpClient.encodePaymentSignatureHeader(payload)["PAYMENT-SIGNATURE"] ?? "";
    }
  });

  it("pays by plain transfer with no facilitator involved, shielded by the broadcaster", async () => {
    const payer = createX402Payer({
      maxAmount: PRICE,
      send: ({ token: t, to, amount }) =>
        walletClient.writeContract({ address: t, abi: tokenAbi, functionName: "transfer", args: [to, amount] }),
    });
    const paid = await payer.fetch(`${baseUrl}/api/quote`);
    expect(paid.status, await paid.clone().text()).toBe(200);
    const body = (await paid.json()) as { payTo: Address };
    const record = await merchant.getPayment(body.payTo);
    expect(record?.payer).toBe(account.address);
    expect(record?.settleTxHash).toMatch(/^0x[0-9a-f]{64}$/i);

    const deadline = Date.now() + 240_000;
    let confirmed = record;
    while (Date.now() < deadline && confirmed?.status !== "confirmed") {
      await new Promise((r) => setTimeout(r, 1_000));
      confirmed = await merchant.getPayment(body.payTo);
    }
    expect(confirmed?.status, JSON.stringify(confirmed)).toBe("confirmed");
    expect(confirmed?.portalState).toBe("shielded");
  });
});
