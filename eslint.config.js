import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["examples/reef-runner/**/*.js"],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      // Empty catch blocks are a deliberate pattern here (absent files are
      // valid states), but they must carry an explanatory comment.
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
);
