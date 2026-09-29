import { defineConfig, type Options } from "tsup";

const entries = {
  index: "src/index.ts",
  "chain/index": "src/chain/index.ts",
  "contracts/index": "src/contracts/index.ts",
  "economics/index": "src/economics/index.ts",
  "intent/index": "src/intent/index.ts",
  "merchant/index": "src/merchant/index.ts",
  "merchant/keys/index": "src/merchant/keys/index.ts",
  "transport/index": "src/transport/index.ts",
  "x402/index": "src/x402/index.ts",
  "x402/merchant/index": "src/x402/merchant/index.ts",
};

export default defineConfig(() => {
  const buildPass = process.env.CURVY_PAYMENTS_PASS;
  const selectPasses = (js: Options[], dts: Options[]): Options[] => {
    if (buildPass === "js") {
      return js;
    }
    if (buildPass === "dts") {
      return dts;
    }
    return [...js, ...dts];
  };

  const shared: Options = {
    entry: entries,
    target: "es2022",
    platform: "neutral",
    bundle: true,
    treeshake: "recommended",
    sourcemap: true,
    clean: false,
    // Keep viem as the normal public dependency so browser import maps can share
    // their existing vendored viem/noble graph instead of downloading a second crypto stack.
    external: ["viem", "viem/utils", "@0xcurvy/rs-core-wasm", "node:fs/promises"],
  };

  const esm: Options = {
    ...shared,
    format: ["esm"],
    outDir: "dist/_esm",
    splitting: false,
    dts: false,
  };

  const esmDts: Options = {
    ...shared,
    format: ["esm"],
    outDir: "dist/_types",
    dts: { only: true },
  };

  // Default = ESM-only (JS + .d.ts). That is everything internal consumers need,
  // and it skips the CJS bundle + the second (CJS) DTS rollup — the slow part of
  // the build. The npm-published package must keep CJS + .d.cts for external
  // `require` consumers, so the publish build (CURVY_PAYMENTS_PUBLISH=1, via
  // `pnpm run build:publish`) adds them back. CURVY_PAYMENTS_PASS lets package
  // scripts run JS and DTS separately so declaration bundling gets its own heap.
  if (!process.env.CURVY_PAYMENTS_PUBLISH) {
    return selectPasses([esm], [esmDts]);
  }

  const publishFormat = process.env.CURVY_PAYMENTS_FORMAT;
  if (publishFormat === "esm") {
    return selectPasses([esm], [esmDts]);
  }

  const cjs: Options = {
    ...shared,
    format: ["cjs"],
    outDir: "dist/_cjs",
    splitting: false,
    dts: false,
    // rs-core's generated glue is ESM-only. Bundle that glue for require()
    // consumers while its packaged WASM remains resolved from the peer.
    external: ["viem", "viem/utils", "node:fs/promises"],
    noExternal: ["@0xcurvy/rs-core-wasm"],
  };

  const cjsDts: Options = {
    ...shared,
    format: ["cjs"],
    outDir: "dist/_types",
    dts: { only: true },
  };

  if (publishFormat === "cjs") {
    return selectPasses([cjs], [cjsDts]);
  }
  if (buildPass === "js") {
    return [esm, cjs];
  }
  if (buildPass === "dts") {
    return [esmDts, cjsDts];
  }

  return [esm, cjs, esmDts, cjsDts];
});
