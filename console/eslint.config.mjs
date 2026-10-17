import js from "@eslint/js";
import tseslint from "typescript-eslint";
import lingui from "eslint-plugin-lingui";
import hooks from "eslint-plugin-react-hooks";
import { defineConfig } from "eslint/config";
export default defineConfig(
  {
    ignores: [
      "dist/**",
      "src/locales/**",
      ".preview/**",
      "coverage/**",
      "test-results/**",
      "playwright-report/**",
      "node_modules/**",
    ],
  },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["src/web/**/*.{ts,tsx}", "src/plugins/**/*.tsx"],
    extends: [hooks.configs.flat.recommended],
    plugins: { lingui },
    rules: {
      "lingui/no-unlocalized-strings": [
        "error",
        {
          ignore: ["^[^\\u4e00-\\u9fff]*$", "^中文$"],
          ignoreNames: ["console.error", "Error"],
        },
      ],
      "lingui/no-trans-inside-trans": "error",
      "lingui/no-single-variables-to-translate": "error",
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "JSXOpeningElement[name.type='JSXIdentifier'][name.name=/^(button|input|select|textarea|table|dialog|progress|meter)$/]",
          message: "Use Ant Design controls. Keep one shared component system.",
        },
      ],
    },
  },
  {
    files: ["*.mjs"],
    extends: [js.configs.recommended],
    languageOptions: { globals: { process: "readonly" } },
  },
);
