import { randomBytes } from "node:crypto";
import { get_meta, new_meta, pubFromPrivateKey } from "@0xcurvy/rs-core-wasm/core";
import { getAddress } from "viem";
import { encodeReceivingKeys, parseReceivingKeys, RECEIVING_KEYS_VERSION } from "../index";
import { buildPaymentRequest, createPaymentRequest, initialize } from "../merchant";
import { ensureRustCore } from "../merchant/internal/rustCore";
import { receivingKeysChecksum } from "../merchant/keys/internal/receivingKeysFormat";
import type { PaymentRecipient } from "../types";
import { BN254_BASE_FIELD, BN254_SCALAR_FIELD } from "../utils/validation";

/** Public demo keys of the reference merchants (merchant-human-checkout, merchant-x402-exact, demo-merchant). */
const DEMO_RECIPIENT: PaymentRecipient = {
  S: "34425660951981420303167812872391094691547586659589451151075976013410385681821.806610510403824678846912967341488351987108012306201088471869202395516174953",
  V: "3138288937136477952496754217884071181681091922691402351949824891162477343760.20311927392260759430760573085495009592603662652153966275134251196877233715683",
  babyJubjubPublicKey:
    "6836771091714720133774728765624106109066404520451206204148327757650825810942.10689497836397479002820544740121152684377010288636029881751942865775640847559",
};
/** Known answer for DEMO_RECIPIENT. Pinned: a change here breaks every value users have already copied. */
const DEMO_RECEIVING_KEYS =
  "01Q1JLTBw7zXIY63DbssI_Ywka5-2EEOC3eu8zRgThuhO6XZ0ByIZ-qfs9b8-oNQAMVLC0r7CLQKtt0kRu-kJKb6UCaQbwNWZIWRKkfC2AFAaP7Yt1Baa6lQuwMUCZVkGa5jQQLOgkvCgqjIiUyJrVz89T3cPWrLwM8SIlIXgcDY5r-eMPHXmt16EaBlY50ak10mRDc5IfZwvJ__SHToghQTOT_heiCpc5qkEW5CT6mGl0osMOdpXSwDtu_uGjGyA77iTHkIf57Q";

const SECP256K1_FIELD = 2n ** 256n - 2n ** 32n - 977n;
const TOKEN = getAddress("0x0000000000000000000000000000000000000003");
const REQUEST = { amount: 10_000n, token: TOKEN, chainId: 31_337, merchantOrigin: "https://merchant.example" };

function coordinates(recipient: PaymentRecipient): bigint[] {
  return [recipient.S, recipient.V, recipient.babyJubjubPublicKey].flatMap((point) => point.split(".").map(BigInt));
}

/** Build a value from six coordinates with a VALID checksum, to reach the per-coordinate checks. */
function forge(values: readonly bigint[], version = RECEIVING_KEYS_VERSION): string {
  const keys = Uint8Array.from(
    Buffer.concat(values.map((value) => Buffer.from(value.toString(16).padStart(64, "0"), "hex"))),
  );
  const body = Buffer.concat([Buffer.from("CRK"), keys, receivingKeysChecksum(version, keys)]);
  return `${RECEIVING_KEYS_VERSION}${body.toString("base64url")}`;
}

function body(value: string): Buffer {
  return Buffer.from(value.slice(2), "base64url");
}

async function realRecipient(): Promise<PaymentRecipient> {
  await ensureRustCore();
  const [k, v, S, V] = new_meta();
  expect(get_meta(k as string, v as string)).toEqual([k, v, S, V]);
  // As the web app's keyring derives it: BabyJubjub public key from the spending private key.
  const [x, y] = pubFromPrivateKey(k as string);
  return { S: S as string, V: V as string, babyJubjubPublicKey: `${x}.${y}` };
}

describe("receiving keys", () => {
  it("encodes the demo keys to the pinned known-answer vector", () => {
    const value = encodeReceivingKeys(DEMO_RECIPIENT);
    expect(value).toBe(DEMO_RECEIVING_KEYS);
    expect(value).toHaveLength(268);
    expect(value.slice(0, 2)).toBe("01");
    expect(RECEIVING_KEYS_VERSION).toBe("01");

    const decoded = body(value);
    expect(decoded).toHaveLength(199);
    expect(decoded.subarray(0, 3).toString("ascii")).toBe("CRK");
    expect(decoded.subarray(3, 195).toString("hex")).toBe(
      coordinates(DEMO_RECIPIENT)
        .map((coordinate) => coordinate.toString(16).padStart(64, "0"))
        .join(""),
    );
    expect(Buffer.from(receivingKeysChecksum("01", decoded.subarray(3, 195)))).toEqual(decoded.subarray(195));
    expect(parseReceivingKeys(DEMO_RECEIVING_KEYS)).toEqual(DEMO_RECIPIENT);
  });

  it("round-trips real rs-core keys (new_meta/get_meta, pubFromPrivateKey of k)", async () => {
    for (let index = 0; index < 25; index++) {
      const recipient = await realRecipient();
      const value = encodeReceivingKeys(recipient);
      expect(value).toMatch(/^01[A-Za-z0-9_-]{266}$/);
      expect(Buffer.from(value.slice(2), "base64url").toString("base64url")).toBe(value.slice(2));
      expect(parseReceivingKeys(value)).toEqual(recipient);
    }
  });

  it("binds the version digits into the checksum", () => {
    const keys = body(DEMO_RECEIVING_KEYS).subarray(3, 195);
    expect(Buffer.from(receivingKeysChecksum("02", keys))).not.toEqual(Buffer.from(receivingKeysChecksum("01", keys)));
    // A body checksummed for another version does not pass as "01".
    expect(() => parseReceivingKeys(forge(coordinates(DEMO_RECIPIENT), "02"))).toThrow("checksum does not match");
  });

  it("refuses a malformed version", () => {
    expect(() => parseReceivingKeys(1 as unknown as string)).toThrow("receiving keys must be a string");
    for (const value of ["", "1", `0A${DEMO_RECEIVING_KEYS.slice(2)}`, `g1${DEMO_RECEIVING_KEYS.slice(2)}`, " 01"]) {
      expect(() => parseReceivingKeys(value)).toThrow("must start with two lowercase hexadecimal version digits");
    }
    expect(() => parseReceivingKeys(`00${DEMO_RECEIVING_KEYS.slice(2)}`)).toThrow("version 00 is not valid");
    for (const version of ["02", "ff"]) {
      expect(() => parseReceivingKeys(`${version}${DEMO_RECEIVING_KEYS.slice(2)}`)).toThrow(
        new RegExp(`version ${version} is not supported.*upgrade @0xcurvy/payments-sdk`),
      );
    }
  });

  it("refuses characters outside base64url, padding and non-canonical encodings", () => {
    const withCharacter = (character: string) =>
      `${DEMO_RECEIVING_KEYS.slice(0, 40)}${character}${DEMO_RECEIVING_KEYS.slice(41)}`;
    for (const value of [
      withCharacter("+"),
      withCharacter("/"),
      withCharacter(" "),
      `${DEMO_RECEIVING_KEYS}==`,
      `${DEMO_RECEIVING_KEYS}\n`,
      // Last character Q -> R sets an unused trailing bit: same bytes, second spelling.
      `${DEMO_RECEIVING_KEYS.slice(0, -1)}R`,
      // A length of 1 mod 4 cannot be base64.
      `${DEMO_RECEIVING_KEYS}AAA`,
    ]) {
      expect(() => parseReceivingKeys(value)).toThrow("base64url characters");
    }
  });

  it("refuses a value that is not Curvy receiving keys or has the wrong length", () => {
    expect(() => parseReceivingKeys("01")).toThrow("not a Curvy receiving-keys value");
    const random = `01${randomBytes(199).toString("base64url")}`;
    expect(() => parseReceivingKeys(random)).toThrow("not a Curvy receiving-keys value");

    const decoded = body(DEMO_RECEIVING_KEYS);
    for (const bytes of [
      decoded.subarray(0, 195),
      decoded.subarray(0, 198),
      Buffer.concat([decoded, Buffer.from([0])]),
    ]) {
      expect(() => parseReceivingKeys(`01${bytes.toString("base64url")}`)).toThrow(
        `must decode to 199 bytes, got ${bytes.length}`,
      );
    }
  });

  it("refuses a checksum mismatch", () => {
    const decoded = Buffer.from(body(DEMO_RECEIVING_KEYS));
    decoded[100] = (decoded[100] as number) ^ 1;
    expect(() => parseReceivingKeys(`01${decoded.toString("base64url")}`)).toThrow("checksum does not match");
    const checksum = Buffer.from(body(DEMO_RECEIVING_KEYS));
    checksum[198] = (checksum[198] as number) ^ 0x80;
    expect(() => parseReceivingKeys(`01${checksum.toString("base64url")}`)).toThrow("checksum does not match");
  });

  it("refuses zero, out-of-field and off-curve coordinates", () => {
    const valid = coordinates(DEMO_RECIPIENT);
    const replace = (index: number, value: bigint) =>
      valid.map((coordinate, at) => (at === index ? value : coordinate));
    const cases: [number, bigint, string][] = [
      [0, 0n, "S.x must be nonzero and below the secp256k1 field modulus"],
      [1, SECP256K1_FIELD, "S.y must be nonzero and below the secp256k1 field modulus"],
      [2, 0n, "V.x must be nonzero and below the BN254 G1 field modulus"],
      [3, BN254_BASE_FIELD, "V.y must be nonzero and below the BN254 G1 field modulus"],
      [4, BN254_SCALAR_FIELD, "babyJubjubPublicKey.x must be nonzero and below the BabyJubjub field modulus"],
      [5, 0n, "babyJubjubPublicKey.y must be nonzero and below the BabyJubjub field modulus"],
      [1, (valid[1] as bigint) + 1n, "S is not a point on secp256k1"],
      [3, (valid[3] as bigint) + 1n, "V is not a point on BN254 G1"],
      [5, (valid[5] as bigint) + 1n, "babyJubjubPublicKey is not a point on BabyJubjub"],
      // BN254 coordinates as secp256k1 and vice versa: in field, off curve.
      [0, valid[2] as bigint, "S is not a point on secp256k1"],
    ];
    for (const [index, value, message] of cases) {
      expect(() => parseReceivingKeys(forge(replace(index, value)))).toThrow(`receiving keys ${message}`);
    }
  });

  it("refuses to encode keys that are not canonical points on their curves", () => {
    expect(() => encodeReceivingKeys({ ...DEMO_RECIPIENT, S: DEMO_RECIPIENT.V })).toThrow(
      "recipient S is not a point on secp256k1",
    );
    expect(() => encodeReceivingKeys({ ...DEMO_RECIPIENT, V: `0${DEMO_RECIPIENT.V}` })).toThrow(
      "recipient V must be two canonical unsigned decimal coordinates",
    );
    expect(() => encodeReceivingKeys({ S: DEMO_RECIPIENT.S, V: DEMO_RECIPIENT.V } as PaymentRecipient)).toThrow(
      "recipient babyJubjubPublicKey must be a string",
    );
    expect(() => encodeReceivingKeys({ ...DEMO_RECIPIENT, babyJubjubPublicKey: "0.1" })).toThrow(
      "recipient babyJubjubPublicKey.x must be nonzero",
    );
  });
});

describe("receiving keys as a payment recipient", () => {
  const config = {
    environment: "testnet" as const,
    network: { chainId: 31_337 },
    merchantOrigin: "https://merchant.example",
    confirmations: 1,
  };

  it("initializes with receivingKeys or recipient", async () => {
    for (const sdk of [
      initialize({ ...config, receivingKeys: DEMO_RECEIVING_KEYS }),
      initialize({ ...config, recipient: DEMO_RECIPIENT }),
    ]) {
      const request = await sdk.createPaymentRequest({ amount: 10_000n, tokens: [TOKEN] });
      expect(request.amount).toBe("10000");
      expect(request.ownerHash).toMatch(/^[1-9]\d*$/);
    }
  });

  it("refuses both, neither, or an invalid receivingKeys at initialize", () => {
    expect(() =>
      // @ts-expect-error receivingKeys and recipient are exclusive
      initialize({ ...config, receivingKeys: DEMO_RECEIVING_KEYS, recipient: DEMO_RECIPIENT }),
    ).toThrow("pass exactly one of receivingKeys (preferred) or recipient");
    // @ts-expect-error one of receivingKeys or recipient is required
    expect(() => initialize(config)).toThrow("pass exactly one of receivingKeys (preferred) or recipient");
    expect(() => initialize({ ...config, receivingKeys: `${DEMO_RECEIVING_KEYS.slice(0, -1)}A` })).toThrow(
      "receiving keys",
    );
  });

  it("accepts receivingKeys in createPaymentRequest and buildPaymentRequest", async () => {
    await expect(createPaymentRequest({ ...REQUEST, receivingKeys: DEMO_RECEIVING_KEYS })).resolves.toMatchObject({
      amount: "10000",
    });
    await expect(
      buildPaymentRequest({ ...REQUEST, receivingKeys: DEMO_RECEIVING_KEYS, ttlSeconds: 60 }),
    ).resolves.toMatchObject({ amount: "10000" });

    await expect(
      // @ts-expect-error receivingKeys and recipient are exclusive
      createPaymentRequest({ ...REQUEST, receivingKeys: DEMO_RECEIVING_KEYS, recipient: DEMO_RECIPIENT }),
    ).rejects.toThrow("pass exactly one");
  });
});
