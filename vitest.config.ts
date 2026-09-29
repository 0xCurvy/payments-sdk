export default {
  test: {
    globals: true,
    // Live end-to-end tests need the local payments stack; run them with `pnpm test:e2e`.
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.e2e.test.ts"],
  },
};
