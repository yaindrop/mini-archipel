import { defineConfig } from "@lingui/conf";
import { formatter } from "@lingui/format-po";
export default defineConfig({
  locales: ["zh", "en"],
  sourceLocale: "zh",
  catalogs: [
    {
      path: "src/locales/{locale}/messages",
      include: ["src"],
      exclude: ["src/locales"],
    },
  ],
  format: formatter({ lineNumbers: false }),
  compileNamespace: "ts",
});
