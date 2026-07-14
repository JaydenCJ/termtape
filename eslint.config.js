// ESLint flat config: typescript-eslint recommended rules over src/ and
// test/, plus plain JS rules for the scripts/ helpers.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "coverage/"] },
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    rules: {
      // Allow intentionally unused values when they are prefixed with an
      // underscore (used for ignored callback arguments).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["scripts/**/*.mjs"],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: { console: "readonly", process: "readonly" },
    },
  },
);
