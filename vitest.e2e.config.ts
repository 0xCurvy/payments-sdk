// `pnpm test:e2e`: end-to-end tests against the local payments stack (`pnpm demo:payments` at the
// monorepo root: Anvil :8545, portal broadcaster :4035 serving the x402 facilitator under /portal/x402).
export default {
  test: {
    globals: true,
    include: ["src/test/**/*.e2e.test.ts"],
    testTimeout: 300_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
};
