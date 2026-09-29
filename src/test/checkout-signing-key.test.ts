import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hex } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { createSigner } from "../cli/createSigner";
import { generateCheckoutSigningKey } from "../merchant/keys";

describe("checkout signing key", () => {
  it("creates a fresh random key and its matching public address", () => {
    const first = generateCheckoutSigningKey();
    const second = generateCheckoutSigningKey();
    expect(first.privateKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(first.address).toBe(privateKeyToAddress(first.privateKey));
    expect(first.privateKey).not.toBe(second.privateKey);
  });

  it("writes the key to an owner-only file and never replaces an existing one", () => {
    const directory = mkdtempSync(join(tmpdir(), "curvy-signer-"));
    try {
      const file = join(directory, "signer.secret.json");
      const { address } = createSigner(file);
      const saved = JSON.parse(readFileSync(file, "utf8")) as { address: string; privateKey: Hex };
      expect(saved.address).toBe(address);
      expect(privateKeyToAddress(saved.privateKey)).toBe(address);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(() => createSigner(file)).toThrow("already exists");
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(saved);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
