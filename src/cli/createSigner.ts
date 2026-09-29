import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateCheckoutSigningKey } from "../merchant/keys/generateCheckoutSigningKey";

export const DEFAULT_SIGNER_FILE = "curvy-checkout-signer.secret.json";

export interface CreateSignerResult {
  address: string;
  file: string;
}

/**
 * Generate a checkout signing key and write it to an owner-only file (mode 0600). Refuses to replace an
 * existing file, so a second run can never overwrite a key that is already published.
 */
export function createSigner(file = DEFAULT_SIGNER_FILE): CreateSignerResult {
  const path = resolve(file);
  const { privateKey, address } = generateCheckoutSigningKey();
  try {
    writeFileSync(path, `${JSON.stringify({ address, privateKey }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`${path} already exists. Move it into your secret store first, or pass another --out path.`);
    }
    throw error;
  }
  return { address, file: path };
}
