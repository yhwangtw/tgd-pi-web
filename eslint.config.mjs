import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

const eslintConfig = [
  // E2E code needs @playwright/test, which is deliberately NOT in
  // package.json (offline installs must never try to fetch browser
  // binaries) — CI installs it --no-save before running the suite.
  {
    ignores: [
      "e2e/**",
      ".agents/skills/impeccable/**",
      "playwright.config.ts",
      ".next/**",
      ".worktrees/**",
      "coverage/**",
      "node_modules/**",
      "vendor/sprintf-js/index.cjs", // Licensed upstream source; security patch has regression coverage.
    ],
  },
  ...coreWebVitals,
  ...typescript,
  {
    rules: {
      "react-hooks/immutability": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
      // React Compiler is not enabled. Keep its optimization-preservation
      // diagnostics advisory; stable callbacks intentionally read live refs.
      "react-hooks/preserve-manual-memoization": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
];

export default eslintConfig;
