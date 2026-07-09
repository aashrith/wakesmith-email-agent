import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Flat config (ESLint 9). Kept intentionally small: type-aware linting
 * is skipped (tsc --noEmit already owns correctness) — this layer is for
 * dead code, unused vars, and the shadowing bug class we already hit
 * once by hand in llmOpenRouter.ts.
 */
export default tseslint.config(
  { ignores: ["dist", "node_modules", "coverage", "transcripts", "memory"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      "no-shadow": "off",
      "@typescript-eslint/no-shadow": "warn",
    },
  },
);
