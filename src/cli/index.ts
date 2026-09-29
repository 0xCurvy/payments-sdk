import { parseArgs } from "node:util";
import { createSigner, DEFAULT_SIGNER_FILE } from "./createSigner";

const USAGE = `Usage: npx @0xcurvy/payments-sdk create-signer [--out <file>]

  create-signer   Generate a checkout signing key. The private key is written to an
                  owner-only file (default ${DEFAULT_SIGNER_FILE}); only the public
                  address is printed.`;

function main(argv: string[]): number {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { out: { type: "string" }, help: { type: "boolean", short: "h" } },
  });
  if (values.help || positionals[0] !== "create-signer" || positionals.length > 1) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }

  const { address, file } = createSigner(values.out);
  console.log(`Public signing address: ${address}`);
  console.log(`Private key written to ${file} (readable only by you).`);
  console.log("Move the key into your backend's secret store as MERCHANT_INTENT_SIGNING_KEY, then delete the file.");
  console.log("Publish the address in /.well-known/curvy-payments.json with buildMerchantKeySet.");
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
