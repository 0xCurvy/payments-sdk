import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { CURVY_NETWORKS, getCurvyNetwork, getDefaultCurvyNetwork } from "../chain";
import { readChainFees } from "../economics";
import { signPaymentIntent } from "../intent";
import { initialize, verifyPayment } from "../merchant";
import { buildCheckoutUrl, CURVY_CHECKOUT_URL } from "../transport";

const RECIPIENT = {
  S: "18841156662615403723520443807716409278140486251221355574263061434503921265588.98357793752770194678499426326386336085357653965912017495890904868125096440617",
  V: "1760020198064161165795911805578555709740706783603233189380229091027759021973.19520756004562638043874842910851983303596751292314679321770725659462577589821",
  babyJubjubPublicKey:
    "5509359784107808046541889973707062912186356978136525798140528612444721440004.5125768395023217094469327424244994953312297627197683956739233494456001838760",
};
const SHOP = { recipient: RECIPIENT, merchantOrigin: "https://shop.example", confirmations: 12 };
const ARBITRUM_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const ARBITRUM_USDT = "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9";
const SEPOLIA_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const OTHER_TOKEN = getAddress("0x0000000000000000000000000000000000000003");

/** Deployments' metadata registries (`GET {apiBaseUrl}/networks`) serving Arbitrum One with the given vault, by origin. */
function registry(vaults: Record<string, string>) {
  return vi.fn(async (url: string | URL | Request) => {
    const { origin, pathname } = new URL(String(url));
    const vault = vaults[origin];
    if (pathname !== "/networks" || !vault) return new Response("not found", { status: 404 });
    return Response.json({
      data: [
        {
          chainId: "42161",
          aggregatorContractAddress: "0x0000000000000000000000000000000000000004",
          portalFactoryContractAddress: "0x0000000000000000000000000000000000000006",
          vaultContractAddress: vault,
        },
      ],
    });
  });
}

describe("Curvy's networks", () => {
  it("pins the production contracts and stablecoins of Arbitrum One and Ethereum Sepolia", () => {
    expect(getCurvyNetwork(42_161)).toMatchObject({
      testnet: false,
      aggregator: "0xE51924cEF003a654EC9735c4d97f5D4862cBcbB1",
      vault: "0xcC8d5c60A8fb15Aa3793647eF531f1bA7dF24f00",
      portalFactory: "0x4f32082C5647F8fE0f0Fb567b98F2a5516361389",
    });
    expect(getCurvyNetwork(11_155_111)).toMatchObject({
      testnet: true,
      aggregator: "0x5D4A04d6c9Bdf4613e7acD92E570539A5a6DBa84",
      vault: "0x4a817f82210F17b24577ebAd474E14333A1cB85d",
    });
    expect(CURVY_NETWORKS.flatMap((network) => network.currencies.map((currency) => currency.symbol))).toEqual([
      "USDC",
      "USDT",
      "USDC",
    ]);
    expect(getCurvyNetwork(31_337)).toBeUndefined();
  });

  it("cannot be changed at runtime", () => {
    const arbitrum = getCurvyNetwork(42_161);
    expect(() => {
      (arbitrum as { aggregator: string }).aggregator = OTHER_TOKEN;
    }).toThrow();
    expect(Object.isFrozen(arbitrum?.currencies[0])).toBe(true);
  });

  it("maps each environment to its network", () => {
    expect(getDefaultCurvyNetwork("mainnet").chainId).toBe(42_161);
    expect(getDefaultCurvyNetwork("testnet").chainId).toBe(11_155_111);
    // @ts-expect-error only mainnet and testnet exist
    expect(() => getDefaultCurvyNetwork("staging")).toThrow('environment must be "mainnet" or "testnet"');
  });
});

describe("initialize with an environment", () => {
  it("pays into Arbitrum One in USDC or USDT on mainnet, with nothing else to configure", async () => {
    const sdk = initialize({ ...SHOP, environment: "mainnet" });
    expect(sdk).toMatchObject({
      chainId: 42_161,
      tokens: [ARBITRUM_USDC, ARBITRUM_USDT],
      // Curvy production, whose aggregator is read from its API on the first check.
      apiBaseUrl: "https://api.curvy.box",
      aggregatorAddress: undefined,
    });
    const request = await sdk.createPaymentRequest({ amount: 4_000_000n });
    expect(request).toMatchObject({
      chainId: 42_161,
      token: ARBITRUM_USDC,
      tokens: [ARBITRUM_USDC, ARBITRUM_USDT],
      amount: "4000000",
    });
  });

  it("pays into Ethereum Sepolia USDC on testnet", async () => {
    const sdk = initialize({ ...SHOP, environment: "testnet" });
    const request = await sdk.createPaymentRequest({ amount: 1_000_000n });
    expect(request).toMatchObject({ chainId: 11_155_111, token: SEPOLIA_USDC });
    // One token is just `token`: the request signs as it always did.
    expect(request.tokens).toBeUndefined();
  });

  it("takes fewer tokens by symbol or address, per request or for every request", async () => {
    const sdk = initialize({ ...SHOP, environment: "mainnet", tokens: ["usdt"] });
    expect(sdk.tokens).toEqual([ARBITRUM_USDT]);
    const usdtOnly = await sdk.createPaymentRequest({ amount: 1n });
    expect(usdtOnly.token).toBe(ARBITRUM_USDT);
    expect(usdtOnly.tokens).toBeUndefined();
    expect(await sdk.createPaymentRequest({ amount: 1n, tokens: ["USDT", "USDC"] })).toMatchObject({
      token: ARBITRUM_USDT,
      tokens: [ARBITRUM_USDT, ARBITRUM_USDC],
    });
    expect((await sdk.createPaymentRequest({ amount: 1n, tokens: [OTHER_TOKEN.toLowerCase()] })).token).toBe(
      OTHER_TOKEN,
    );
    await expect(sdk.createPaymentRequest({ amount: 1n, tokens: ["WETH"] })).rejects.toThrow(
      'token "WETH" is not a Curvy token on chain 42161; pass its address',
    );
    await expect(sdk.createPaymentRequest({ amount: 1n, tokens: ["USDC", "usdc"] })).rejects.toThrow(
      "tokens must not list a token twice",
    );
    expect(() => initialize({ ...SHOP, environment: "mainnet", tokens: [] })).toThrow(
      "tokens must list at least one token",
    );
    expect(() => initialize({ ...SHOP, environment: "testnet", tokens: ["USDT"] })).toThrow(
      'token "USDT" is not a Curvy token on chain 11155111',
    );
  });

  it("requires an environment", () => {
    // @ts-expect-error environment is required, so nobody takes real money or tests by accident
    expect(() => initialize({ ...SHOP })).toThrow('environment must be "mainnet" or "testnet"');
  });

  it("takes another network for staging or a local chain, but not one that contradicts the environment", async () => {
    const local = initialize({ ...SHOP, environment: "testnet", network: { chainId: 31_337 }, tokens: [OTHER_TOKEN] });
    expect(local).toMatchObject({ chainId: 31_337, tokens: [OTHER_TOKEN], aggregatorAddress: undefined });
    expect((await local.createPaymentRequest({ amount: 1n })).chainId).toBe(31_337);

    const aggregatorAddress = getAddress("0x70820c0becc2130c7e57540d09be4e115071be89");
    const staging = initialize({
      ...SHOP,
      environment: "testnet",
      network: { chainId: 11_155_111, aggregatorAddress },
    });
    expect(staging).toMatchObject({ chainId: 11_155_111, tokens: [SEPOLIA_USDC], aggregatorAddress });

    expect(() => initialize({ ...SHOP, environment: "mainnet", network: { chainId: 11_155_111 } })).toThrow(
      "chain 11155111 is a testnet network, not mainnet",
    );
    expect(() => initialize({ ...SHOP, environment: "testnet", network: { chainId: 0 } })).toThrow(
      "network.chainId must be a positive safe integer",
    );
  });

  it("reads the aggregator from the deployment's API before checking a payment", async () => {
    const fetch = registry({});
    const local = initialize({
      ...SHOP,
      environment: "testnet",
      network: { chainId: 31_337 },
      tokens: [OTHER_TOKEN],
      apiBaseUrl: "http://127.0.0.1:4035",
      fetch,
    });
    expect(local.apiBaseUrl).toBe("http://127.0.0.1:4035");
    const request = await local.createPaymentRequest({ amount: 1n });
    const publicClient = { getChainId: vi.fn().mockResolvedValue(31_337) };
    const parameters = { publicClient: publicClient as never, request, fromBlock: 1n };
    await expect(local.verifyPayment(parameters)).rejects.toThrow(
      "http://127.0.0.1:4035 has no Curvy contracts for chain 31337",
    );
    expect(String(fetch.mock.calls[0]?.[0])).toBe("http://127.0.0.1:4035/networks");
    await expect(verifyPayment({ ...parameters, confirmations: 1, fetch })).rejects.toThrow(
      "https://api.curvy.box has no Curvy contracts for chain 31337",
    );
  });
});

describe("defaults for Curvy's networks", () => {
  it("sends buyers to Curvy's production checkout unless a page is given", async () => {
    const sdk = initialize({ ...SHOP, environment: "mainnet" });
    const signer = privateKeyToAccount(`0x${"11".repeat(32)}`);
    const payment = await signPaymentIntent(await sdk.createPaymentRequest({ amount: 1_000_000n }), (typedData) =>
      signer.signTypedData(typedData),
    );
    expect(CURVY_CHECKOUT_URL).toBe("https://app.curvy.box/checkout");
    expect(buildCheckoutUrl(payment).startsWith("https://app.curvy.box/checkout#")).toBe(true);
    expect(
      buildCheckoutUrl("https://app.curvy.dev/checkout", payment).startsWith("https://app.curvy.dev/checkout#"),
    ).toBe(true);
  });

  it("reads fees from the vault the deployment's API names, production's by default", async () => {
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === "getTokenId") return 2n;
      if (functionName === "depositFee") return 10n;
      return { tokenId: 2n, portalDeployment: 50n, pendingNoteCommitment: 100n, withdrawal: 50n };
    });
    const fetch = registry({
      "https://api.curvy.box": "0xcC8d5c60A8fb15Aa3793647eF531f1bA7dF24f00",
      "https://api.curvy.dev": "0x25CD76612BFe4FddA794EFc416635B6D9a77CB7F",
    });
    const client = { readContract } as never;
    await readChainFees({ publicClient: client, chainId: 42_161, token: ARBITRUM_USDC, fetch });
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: "0xcC8d5c60A8fb15Aa3793647eF531f1bA7dF24f00", functionName: "getTokenId" }),
    );
    readContract.mockClear();
    const staging = { apiBaseUrl: "https://api.curvy.dev", fetch };
    await readChainFees({ publicClient: client, chainId: 42_161, token: ARBITRUM_USDC, ...staging });
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: "0x25CD76612BFe4FddA794EFc416635B6D9a77CB7F", functionName: "getTokenId" }),
    );
    await expect(readChainFees({ publicClient: client, chainId: 31_337, token: ARBITRUM_USDC, fetch })).rejects.toThrow(
      "https://api.curvy.box has no Curvy contracts for chain 31337",
    );
  });
});
