// `pnpm test:e2e`: end-to-end tests against the local payments stack (`pnpm demo:payments` at the
// monorepo root: Anvil, x402 facilitator :4022, portal broadcaster :4035).
export default {
  test: {
    globals: true,
    include: ["src/test/**/*.e2e.test.ts"],
    testTimeout: 300_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
};
