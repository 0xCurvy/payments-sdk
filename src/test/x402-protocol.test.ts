import { decodeBase64Json, encodeBase64Json, parseX402Network, x402Network } from "../x402";

describe("x402 network ids", () => {
  it("round-trips CAIP-2 eip155 ids", () => {
    expect(x402Network(8453)).toBe("eip155:8453");
    expect(parseX402Network("eip155:31337")).toBe(31337);
  });

  it("rejects non-EVM or malformed ids", () => {
    expect(() => parseX402Network("solana:mainnet")).toThrow();
    expect(() => parseX402Network("eip155:0")).toThrow();
    expect(() => x402Network(0)).toThrow();
  });
});

describe("base64 JSON header codec", () => {
  it("round-trips UTF-8 payloads", () => {
    const value = { scheme: "exact", memo: "Zürich ✓", amount: "10000" };
    expect(decodeBase64Json(encodeBase64Json(value))).toEqual(value);
  });

  it("matches Node's Buffer encoding and accepts the URL-safe alphabet", () => {
    const value = { a: "~~~>>>???" };
    const encoded = encodeBase64Json(value);
    expect(encoded).toBe(Buffer.from(JSON.stringify(value), "utf8").toString("base64"));
    const urlSafe = encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(decodeBase64Json(urlSafe)).toEqual(value);
  });
});
