import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

function run(command, env = {}) {
  execSync(command, {
    stdio: "inherit",
    env: { ...process.env, ...env },
    shell: true,
  });
}

run("node scripts/build.mjs --publish");
run("publint --strict");
run("attw --pack --profile node16", {
  CURVY_PAYMENTS_SKIP_PREPARE: "1",
  npm_config_cache: "/tmp/curvy-payments-sdk-npm-cache",
});
