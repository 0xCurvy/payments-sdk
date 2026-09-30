import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress, type Hex } from "viem";
import { privateKeyToAccount, privateKeyToAddress } from "viem/accounts";
import { createSigner } from "../cli/createSigner";
import {
  buildMerchantKeySet,
  buildPaymentIntentTypedData,
  encodeReceivingKeys,
  MAX_PAYMENT_REQUEST_TTL_SECONDS,
  parseMerchantKeySet,
  parseReceivingKeys,
  RECEIVING_KEYS_VERSION,
  verifyPaymentIntent,
} from "../index";
import { generateCheckoutSigningKey } from "../merchant/keys";
import type { PaymentRecipient } from "../types";

/** Public demo keys of the reference merchants. */
const DEMO_RECIPIENT: PaymentRecipient = {
  S: "34425660951981420303167812872391094691547586659589451151075976013410385681821.806610510403824678846912967341488351987108012306201088471869202395516174953",
  V: "3138288937136477952496754217884071181681091922691402351949824891162477343760.20311927392260759430760573085495009592603662652153966275134251196877233715683",
  babyJubjubPublicKey:
    "6836771091714720133774728765624106109066404520451206204148327757650825810942.10689497836397479002820544740121152684377010288636029881751942865775640847559",
};
/** Known answer for DEMO_RECIPIENT. Pinned: a change here breaks every value users have already copied. */
const DEMO_RECEIVING_KEYS =
  "01Q1JLTBw7zXIY63DbssI_Ywka5-2EEOC3eu8zRgThuhO6XZ0ByIZ-qfs9b8-oNQAMVLC0r7CLQKtt0kRu-kJKb6UCaQbwNWZIWRKkfC2AFAaP7Yt1Baa6lQuwMUCZVkGa5jQQLOgkvCgqjIiUyJrVz89T3cPWrLwM8SIlIXgcDY5r-eMPHXmt16EaBlY50ak10mRDc5IfZwvJ__SHToghQTOT_heiCpc5qkEW5CT6mGl0osMOdpXSwDtu_uGjGyA77iTHkIf57Q";

const TOKEN = getAddress("0x0000000000000000000000000000000000000003");

describe("receiving keys", () => {
  it("encodes the demo keys to the pinned value and parses it back", () => {
    expect(RECEIVING_KEYS_VERSION).toBe("01");
    expect(encodeReceivingKeys(DEMO_RECIPIENT)).toBe(DEMO_RECEIVING_KEYS);
    expect(DEMO_RECEIVING_KEYS).toHaveLength(268);
    expect(parseReceivingKeys(DEMO_RECEIVING_KEYS)).toEqual(DEMO_RECIPIENT);
  });

  it("refuses a mistyped, cut-off or foreign value instead of paying the wrong keys", () => {
    const typo = `${DEMO_RECEIVING_KEYS.slice(0, 100)}${DEMO_RECEIVING_KEYS[100] === "A" ? "B" : "A"}${DEMO_RECEIVING_KEYS.slice(101)}`;
    expect(() => parseReceivingKeys(typo)).toThrow();
    expect(() => parseReceivingKeys(DEMO_RECEIVING_KEYS.slice(0, -8))).toThrow();
    expect(() => parseReceivingKeys(`02${DEMO_RECEIVING_KEYS.slice(2)}`)).toThrow("version 02 is not supported");
  });

  it("refuses keys that are not curve points", () => {
    expect(() => encodeReceivingKeys({ ...DEMO_RECIPIENT, babyJubjubPublicKey: "1.2" })).toThrow();
  });
});

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

describe("payment intent lifetime", () => {
  it("rejects an intent that lasts longer than 24 hours", async () => {
    const { privateKey, address } = generateCheckoutSigningKey();
    const signer = privateKeyToAccount(privateKey);
    const now = 1_000_000;
    const intent = (expiry: number) => ({
      token: TOKEN,
      amount: "1",
      chainId: 1,
      ownerHash: "2",
      ephemeralKeyX: "3",
      ephemeralKeyY: "4",
      viewTag: 5,
      merchantOrigin: "https://merchant.example",
      checkoutCompletePath: "/checkout/complete",
      expiry,
    });
    const keySet = buildMerchantKeySet([
      { address, notAfter: new Date((now + 3 * MAX_PAYMENT_REQUEST_TTL_SECONDS) * 1_000) },
    ]);
    const verify = async (expiry: number) => {
      const signature = (await signer.signTypedData(buildPaymentIntentTypedData(intent(expiry)))) as Hex;
      return verifyPaymentIntent(
        { intent: intent(expiry), signature },
        { keySet, expectedChainId: 1, expectedToken: TOKEN, nowSeconds: now },
      );
    };

    await expect(verify(now + MAX_PAYMENT_REQUEST_TTL_SECONDS)).resolves.toMatchObject({ signer: address });
    await expect(verify(now + 2 * MAX_PAYMENT_REQUEST_TTL_SECONDS)).rejects.toThrow("lifetime exceeds 24 hours");
  });
});

describe("merchant key set icon", () => {
  const signer = {
    address: getAddress("0x0000000000000000000000000000000000000001"),
    notAfter: "2030-01-01T00:00:00.000Z",
  };
  const keySet = (icon: unknown) =>
    parseMerchantKeySet({ version: 1, signers: [{ ...signer, alg: "eip712-secp256k1" }], icon });

  test("is optional and kept when it is a PNG or WebP path on the merchant origin", () => {
    expect(buildMerchantKeySet([signer])).not.toHaveProperty("icon");
    expect(buildMerchantKeySet([signer], { icon: "/brand/curvy-icon.png" }).icon).toBe("/brand/curvy-icon.png");
    expect(keySet("/icon.WEBP").icon).toBe("/icon.WEBP");
  });

  test.each([
    "https://cdn.example/icon.png",
    "//cdn.example/icon.png",
    "icon.png",
    "/icon.svg",
    "/icon.png?v=2",
    "/icon.png#x",
    "/a\\b.png",
    "/a b.png",
    `/${"a".repeat(260)}.png`,
    42,
  ])("rejects %s", (icon) => {
    expect(() => keySet(icon)).toThrow("merchant key set icon");
  });

  test("carries an optional shop name, as plain text of at most 60 characters", () => {
    const named = (name: unknown) =>
      parseMerchantKeySet({ version: 1, signers: [{ ...signer, alg: "eip712-secp256k1" }], name });

    expect(buildMerchantKeySet([signer])).not.toHaveProperty("name");
    expect(buildMerchantKeySet([signer], { name: "Overprint", icon: "/icon.png" })).toMatchObject({
      name: "Overprint",
      icon: "/icon.png",
    });
    expect(named("Café Ümlaut & Co.").name).toBe("Café Ümlaut & Co.");

    for (const bad of ["", " Overprint", "Overprint ", "a".repeat(61), "Over\nprint", "\u202eevil", 42]) {
      expect(() => named(bad)).toThrow("merchant key set name");
    }
  });

  test("still rejects unknown keys", () => {
    expect(() =>
      parseMerchantKeySet({ version: 1, signers: [{ ...signer, alg: "eip712-secp256k1" }], logo: "/icon.png" }),
    ).toThrow("must not contain logo");
  });
});
