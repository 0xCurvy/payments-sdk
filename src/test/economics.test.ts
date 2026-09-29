import { getAddress } from "viem";
import { type ChainFees, feeBreakdown, minimumPaymentAmount, quotePayment, readChainFees } from "../economics";

// Local devnet values: 10 bps, portal deployment 50, pending-note commitment 100 (6-decimal USDC).
const FEES: ChainFees = { depositFeeBps: 10n, portalDeployment: 50n, pendingNoteCommitment: 100n };
const VAULT = getAddress("0x00000000000000000000000000000000000000Aa");
const TOKEN = getAddress("0x00000000000000000000000000000000000000Bb");

const net = (grossAmount: bigint, rail: "portal" | "direct") =>
  BigInt(quotePayment({ grossAmount, fees: FEES, rail }).netAmount);

describe("feeBreakdown / quotePayment", () => {
  it("splits a $0.01 portal payment into fees and net", () => {
    expect(feeBreakdown(10_000n, 10n, 50n, 100n)).toEqual({
      depositFeeBps: "10",
      percentageFee: "10",
      portalDeployment: "50",
      pendingNoteCommitment: "100",
      totalFees: "160",
      netAmount: "9840",
    });
  });

  it("charges the portal deployment fee only on the portal rail", () => {
    expect(quotePayment({ grossAmount: 10_000n, fees: FEES, rail: "portal" }).totalFees).toBe("160");
    expect(quotePayment({ grossAmount: 10_000n, fees: FEES, rail: "direct" }).totalFees).toBe("110");
  });
});

describe("minimumPaymentAmount", () => {
  it.each(["portal", "direct"] as const)("returns the exact floor on the %s rail", (rail) => {
    for (const minNetAmount of [1n, 9_999n, 10_000n, 1_000_000n]) {
      const floor = minimumPaymentAmount({ fees: FEES, rail, minNetAmount });
      expect(net(floor, rail)).toBeGreaterThanOrEqual(minNetAmount);
      expect(net(floor - 1n, rail)).toBeLessThan(minNetAmount);
    }
  });

  it("is just the fixed fees plus one unit when there is no percentage fee", () => {
    const fees = { ...FEES, depositFeeBps: 0n };
    expect(minimumPaymentAmount({ fees, rail: "portal" })).toBe(151n);
    expect(minimumPaymentAmount({ fees, rail: "direct" })).toBe(101n);
  });

  it("rejects a deposit fee of 100% or more", () => {
    expect(() => minimumPaymentAmount({ fees: { ...FEES, depositFeeBps: 10_000n }, rail: "portal" })).toThrow();
  });
});

describe("readChainFees", () => {
  it("resolves the token id and reads fees from the vault", async () => {
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === "getTokenId") return 3n;
      if (functionName === "depositFee") return 10n;
      if (functionName === "perTokenGasFees")
        return { tokenId: 3n, portalDeployment: 50n, pendingNoteCommitment: 100n, withdrawal: 50n };
      throw new Error(`unexpected ${functionName}`);
    });
    // biome-ignore lint/suspicious/noExplicitAny: minimal readContract stub
    const fees = await readChainFees({ publicClient: { readContract } as any, vaultAddress: VAULT, token: TOKEN });
    expect(fees).toEqual(FEES);
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "getTokenId", args: [TOKEN] }));
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "perTokenGasFees", args: [3n] }));
  });

  it("rejects tokens the vault does not know", async () => {
    const readContract = vi.fn().mockResolvedValue(0n);
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: minimal readContract stub
      readChainFees({ publicClient: { readContract } as any, vaultAddress: VAULT, token: TOKEN }),
    ).rejects.toThrow(/not registered/);
  });
});
