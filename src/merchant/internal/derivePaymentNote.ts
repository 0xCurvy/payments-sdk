import { ownerHash as domainAOwnerHash, send as domainASend } from "@0xcurvy/rs-core-wasm/core";
import type { PaymentRecipient } from "../../types";
import { viewTag as parseViewTag } from "../../utils/validation";
import { ensureRustCore } from "./rustCore";

const DECIMAL_FIELD = /^(0|[1-9][0-9]*)$/;

interface DerivedPaymentNote {
  ownerHash: bigint;
  ephemeralKey: readonly [bigint, bigint];
  /** Canonical `uint16`. */
  viewTag: number;
}

function parsePoint(value: string, label: string): readonly [bigint, bigint] {
  const coordinates = value.split(".");
  if (coordinates.length !== 2 || !coordinates.every((coordinate) => DECIMAL_FIELD.test(coordinate))) {
    throw new Error(`${label} must be two unsigned decimal field elements separated by a dot`);
  }
  return [BigInt(coordinates[0]), BigInt(coordinates[1])];
}

/** Derive the public note fields with rs-core's Domain A send/ownerHash primitives. */
export async function derivePaymentNote(recipient: PaymentRecipient): Promise<DerivedPaymentNote> {
  await ensureRustCore();

  const announcement = domainASend(recipient.S, recipient.V);
  if (announcement.length !== 4) throw new Error("rs-core Domain A send returned an invalid announcement");

  const ephemeralKey = parsePoint(announcement[1], "rs-core ephemeral key");
  const [sharedSecret] = parsePoint(announcement[3], "rs-core spending public key");
  const [ownerX, ownerY] = parsePoint(recipient.babyJubjubPublicKey, "recipient BabyJubjub public key");
  const viewTag = parseViewTag(announcement[2], "rs-core view tag", { hex: true });
  const ownerHash = BigInt(domainAOwnerHash(ownerX.toString(), ownerY.toString(), sharedSecret.toString()));

  return { ownerHash, ephemeralKey, viewTag };
}
