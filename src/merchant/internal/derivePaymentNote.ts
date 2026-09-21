import initRustCore, { ownerHash as domainAOwnerHash, send as domainASend } from "@0xcurvy/rs-core-wasm/core";
import type { PaymentRecipient } from "../../types";

const RS_CORE_WASM = "@0xcurvy/rs-core-wasm/core/curvy_wasm_bg.wasm";
const DECIMAL_FIELD = /^(0|[1-9][0-9]*)$/;
const HEX_BYTE = /^(?:0x)?[0-9a-f]{1,2}$/i;

interface DerivedPaymentNote {
  ownerHash: bigint;
  ephemeralKey: readonly [bigint, bigint];
  viewTag: bigint;
}

let initialization: Promise<void> | undefined;

async function readPackagedWasm(): Promise<Uint8Array<ArrayBuffer>> {
  const { readFile } = await import("node:fs/promises");
  const { createRequire } = process.getBuiltinModule("node:module");
  const resolveFrom = createRequire(import.meta.url);
  return Uint8Array.from(await readFile(resolveFrom.resolve(RS_CORE_WASM)));
}

async function ensureRustCore(): Promise<void> {
  if (!initialization) {
    initialization = readPackagedWasm()
      .then((bytes) => initRustCore({ module_or_path: bytes }))
      .then(() => undefined)
      .catch((error) => {
        initialization = undefined;
        throw error;
      });
  }
  return initialization;
}

function parsePoint(value: string, label: string): readonly [bigint, bigint] {
  const coordinates = value.split(".");
  if (coordinates.length !== 2 || !coordinates.every((coordinate) => DECIMAL_FIELD.test(coordinate))) {
    throw new Error(`${label} must be two unsigned decimal field elements separated by a dot`);
  }
  return [BigInt(coordinates[0]), BigInt(coordinates[1])];
}

function parseViewTag(value: string): bigint {
  if (!HEX_BYTE.test(value)) throw new Error("rs-core view tag must be one hexadecimal byte");
  return BigInt(value.startsWith("0x") ? value : `0x${value}`);
}

/** Derive the public note fields with rs-core's Domain A send/ownerHash primitives. */
export async function derivePaymentNote(recipient: PaymentRecipient): Promise<DerivedPaymentNote> {
  await ensureRustCore();

  const announcement = domainASend(recipient.S, recipient.V);
  if (announcement.length !== 4) throw new Error("rs-core Domain A send returned an invalid announcement");

  const ephemeralKey = parsePoint(announcement[1], "rs-core ephemeral key");
  const [sharedSecret] = parsePoint(announcement[3], "rs-core spending public key");
  const [ownerX, ownerY] = parsePoint(recipient.babyJubjubPublicKey, "recipient BabyJubjub public key");
  const viewTag = parseViewTag(announcement[2]);
  const ownerHash = BigInt(domainAOwnerHash(ownerX.toString(), ownerY.toString(), sharedSecret.toString()));

  return { ownerHash, ephemeralKey, viewTag };
}
