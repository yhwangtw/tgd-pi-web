import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./test/setup.ts"],
    // Playwright specs live in e2e/ and run via `npm run test:e2e`
    exclude: ["e2e/**", "node_modules/**", ".next/**", ".worktrees/**"],
  },
});
