import { defineConfig } from "@lingui/conf";
import { formatter } from "@lingui/format-po";
export default defineConfig({
  locales: ["zh", "en"],
  sourceLocale: "zh",
  catalogs: [
    {
      path: "src/locales/{locale}/messages",
      include: [
        "src",
        "../plugins/automation/console/src",
        "../plugins/screen-recording/console/src",
        "../plugins/fan-control/console/src",
        "../plugins/proxy/console/src",
        "../plugins/runners/console/src",
      ],
      exclude: ["src/locales"],
    },
  ],
  format: formatter({ lineNumbers: false }),
  compileNamespace: "ts",
});
