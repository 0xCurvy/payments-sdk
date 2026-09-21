import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Run from the package root regardless of where the script is invoked.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

// Mark the CJS output as CommonJS. The root package.json is `"type": "module"`,
// so dist/_esm needs no marker.
// The default (internal) build is ESM-only and has no dist/_cjs — only the
// publish build (CURVY_PAYMENTS_PUBLISH=1) emits it.
if (existsSync("dist/_cjs")) {
  writeFileSync("dist/_cjs/package.json", '{"type":"commonjs"}\n');
}
