import type { MerchantKeySet, PublishedSigner } from "../../types";
import {
  address,
  exactKeys,
  merchantIconPath,
  merchantName,
  record,
  requiredAndOptionalKeys,
  string,
} from "../../utils/validation";

/** Parse and canonicalize a merchant's published signer set. */
export function parseMerchantKeySet(value: unknown): MerchantKeySet {
  const input = record(value, "merchant key set");
  requiredAndOptionalKeys(input, ["version", "signers"], ["icon", "name"], "merchant key set");
  if (input.version !== 1) throw new Error("merchant key set version must be 1");
  if (!Array.isArray(input.signers)) throw new Error("merchant key set signers must be an array");
  const signers = input.signers.map((value, index): PublishedSigner => {
    const label = `merchant key set signers[${index}]`;
    const signer = record(value, label);
    exactKeys(signer, ["address", "alg", "notAfter"], label);
    if (signer.alg !== "eip712-secp256k1") throw new Error(`${label}.alg is unsupported`);
    const notAfter = string(signer.notAfter, `${label}.notAfter`);
    if (!Number.isFinite(Date.parse(notAfter))) throw new Error(`${label}.notAfter must be an ISO timestamp`);
    return {
      address: address(signer.address, `${label}.address`),
      alg: "eip712-secp256k1",
      notAfter,
    };
  });
  return {
    version: 1,
    signers,
    ...(input.icon === undefined ? {} : { icon: merchantIconPath(input.icon, "merchant key set icon") }),
    ...(input.name === undefined ? {} : { name: merchantName(input.name, "merchant key set name") }),
  };
}
