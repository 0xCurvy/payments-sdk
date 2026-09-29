import initRustCore from "@0xcurvy/rs-core-wasm/core";

const RS_CORE_WASM = "@0xcurvy/rs-core-wasm/core/curvy_wasm_bg.wasm";

let initialization: Promise<void> | undefined;

async function readPackagedWasm(): Promise<Uint8Array<ArrayBuffer>> {
  const { readFile } = await import("node:fs/promises");
  const { createRequire } = process.getBuiltinModule("node:module");
  const resolveFrom = createRequire(import.meta.url);
  return Uint8Array.from(await readFile(resolveFrom.resolve(RS_CORE_WASM)));
}

/** Load rs-core's packaged WASM once per process. A failed load is retried on the next call. */
export async function ensureRustCore(): Promise<void> {
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
